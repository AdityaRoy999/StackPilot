"""Routing must remain bound to the recorded, verified deployment identity."""
import importlib.util
import os
import hashlib
import http.server
import threading
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('stackpilot_runtime_gateway',ROOT/'runtime-gateway'/'app.py')
gateway=importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class RuntimeGateway(unittest.TestCase):
    def test_large_download_and_head_have_no_invented_body_and_post_keeps_its_length(self):
        from fastapi.testclient import TestClient
        payload=b'large-artifact-byte-block'*(1024*1024)
        requests=[]
        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                requests.append((self.command,self.headers.get('Transfer-Encoding'),self.headers.get('Content-Length')))
                self.send_response(200);self.send_header('Content-Length',str(len(payload)))
                self.send_header('Content-Disposition','attachment; filename=application.apk');self.end_headers()
                for offset in range(0,len(payload),65536):self.wfile.write(payload[offset:offset+65536])
            def do_HEAD(self):
                requests.append((self.command,self.headers.get('Transfer-Encoding'),self.headers.get('Content-Length')))
                self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.end_headers()
            def do_POST(self):
                requests.append((self.command,self.headers.get('Transfer-Encoding'),self.headers.get('Content-Length')))
                body=self.rfile.read(int(self.headers.get('Content-Length','0')))
                self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Upstream)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            upstream='http://127.0.0.1:'+str(server.server_address[1])
            with patch.object(gateway,'route',return_value=(upstream,7)),TestClient(gateway.app) as client:
                origin='http://00000000-0000-0000-0000-000000000001.preview.localhost'
                result=client.get(origin+'/artifacts/application.apk')
                self.assertEqual(result.status_code,200)
                self.assertEqual(hashlib.sha256(result.content).digest(),hashlib.sha256(payload).digest())
                self.assertEqual(result.headers['content-length'],str(len(payload)))
                self.assertIn('attachment',result.headers['content-disposition'])
                head=client.head(origin+'/artifacts/application.apk')
                self.assertEqual(head.content,b'');self.assertEqual(head.headers['content-length'],str(len(payload)))
                posted=client.post(origin+'/echo',content=b'abc')
                self.assertEqual(posted.content,b'abc')
            self.assertEqual(requests,[('GET',None,None),('HEAD',None,None),('POST',None,'3')])
        finally:
            server.shutdown();server.server_close();thread.join(timeout=5)

    def resolve(self, internal, *, name='stackpilot-local-fixture', provider='local_docker', port=3000):
        connection=MagicMock()
        cursor=connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value=('http://localhost:54321',7,name,
                                     {'deployment_plan':{'runtime_internal_url':internal,'port':port}},provider)
        with patch.dict(os.environ,{'DB_USER':'fixture','DB_PASSWORD':'fixture','DB_NAME':'fixture'}), \
             patch.object(gateway.psycopg2,'connect',return_value=connection):
            result=gateway.route('00000000-0000-0000-0000-000000000001')
        connection.close.assert_called_once()
        return result

    def test_verified_runtime_uses_internal_network_without_public_binding(self):
        self.assertEqual(self.resolve('http://stackpilot-local-fixture:3000'),
                         ('http://stackpilot-local-fixture:3000',7))
        self.assertEqual(self.resolve(None),('http://host.docker.internal:54321',7))

    def test_foreign_container_service_wrong_port_and_url_credentials_are_rejected(self):
        for url in ('http://postgres:5432','http://stackpilot-local-other:3000',
                    'http://stackpilot-local-fixture:8090','http://user@stackpilot-local-fixture:3000',
                    'http://stackpilot-local-fixture:3000/private','http://stackpilot-local-fixture:3000?x=1'):
            with self.subTest(url=url):self.assertIsNone(self.resolve(url))
        self.assertIsNone(self.resolve('http://stackpilot-local-fixture:3000',provider='remote_docker'))
