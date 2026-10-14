"""Executor-only connection probe. Input is private; output contains no values.

This checks external reachability, not deployment readiness. Local dependencies
must be checked inside their deployment network, never against the control plane.
"""
import ipaddress
import json
from pathlib import Path
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KEY=re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,255}\Z')
HEADER=re.compile(r'[!#$%&\'*+.^_`|~0-9A-Za-z-]{1,128}\Z')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check(request):
    key=request.get('key','')
    result={'key':key if isinstance(key,str) and KEY.fullmatch(key) else '',
            'values_visible':False,'verified':False,'scope':'control_plane_external'}
    try:
        if not result['key']:raise ValueError('Invalid key')
        value=request.get('value','')
        if not isinstance(value,str) or not value:
            return {**result,'status':'not_configured'}
        if value.startswith('/') and not value.startswith('//') and not any(c in value for c in '\r\n\\\0'):
            return {**result,'status':'requires_runtime_probe','scope':'deployment_relative_endpoint'}
        url=urllib.parse.urlsplit(value)
        ports={'https':443,'http':80,'postgres':5432,'postgresql':5432,'mysql':3306,
               'redis':6379,'rediss':6380,'mongodb':27017}
        if url.scheme not in ports or not url.hostname:
            return {**result,'status':'unsupported_connection_format'}
        host=url.hostname
        # A localhost URL/Compose alias addresses the workload, not this broker.
        if host.lower() in {'localhost','host.docker.internal'} or '.' not in host and ':' not in host:
            return {**result,'status':'requires_runtime_probe','scope':'runtime_network'}
        try:literal=ipaddress.ip_address(host)
        except ValueError:literal=None
        if literal is not None and not literal.is_global:
            return {**result,'status':'requires_runtime_probe','scope':'runtime_network'}
        addresses=socket.getaddrinfo(host,url.port or ports[url.scheme],type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            return {**result,'status':'requires_runtime_probe','scope':'runtime_network'}
        if url.scheme not in {'http','https'}:
            with socket.create_connection((host,url.port or ports[url.scheme]),timeout=8):
                return {**result,'status':'reachable','scope':'tcp_connectivity','authentication_verified':False}
        if url.username or url.password:raise ValueError('HTTP userinfo unsupported')
        path=request.get('path')
        if path is not None:
            if not isinstance(path,str) or not path.startswith('/') or path.startswith('//') or any(c in path for c in '\r\n\\\0'):
                raise ValueError('Invalid health path')
            value=urllib.parse.urlunsplit((url.scheme,url.netloc,path,'',''))
        headers=request.get('headers',{})
        if not isinstance(headers,dict) or len(headers)>8:raise ValueError('Invalid headers')
        for name,entry in headers.items():
            if not isinstance(name,str) or not HEADER.fullmatch(name) or name.lower() in {'host','connection','content-length','transfer-encoding'}:
                raise ValueError('Invalid header')
            if not isinstance(entry,str) or any(c in entry for c in '\r\n\0'):raise ValueError('Invalid header value')
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        try:
            with opener.open(urllib.request.Request(value,headers=headers,method='GET'),timeout=8) as response:
                code=response.status
        except urllib.error.HTTPError as exc:
            code=exc.code
            exc.close()
        return {**result,'http_status':code,'status':('reachable' if 200<=code<300 else
            'authentication_rejected' if code in {401,403} else 'redirect' if 300<=code<400 else 'http_error')}
    except (ValueError,TypeError):
        return {**result,'status':'invalid_connection_request'}
    except socket.gaierror:
        return {**result,'status':'dns_failure'}
    except (TimeoutError,socket.timeout):
        return {**result,'status':'timeout'}
    except ssl.SSLError:
        return {**result,'status':'tls_failure'}
    except urllib.error.URLError as exc:
        return {**result,'status':'tls_failure' if isinstance(exc.reason,ssl.SSLError) else 'connection_failure'}
    except OSError:
        return {**result,'status':'connection_failure'}


def main(source,destination):
    start=time.monotonic()
    request=json.loads(Path(source).read_text())
    result=check(request)
    result['elapsed_ms']=round((time.monotonic()-start)*1000)
    target=Path(destination)
    with target.open('x',encoding='utf-8') as stream:json.dump(result,stream)
    target.chmod(0o600)


if __name__=='__main__':
    try:main(*sys.argv[1:])
    except Exception:
        # Do not print request values, URLs, headers, bodies or exception text.
        sys.exit(1)
