import json
from pathlib import Path
import socket
import ssl
import sys
import unittest
from unittest.mock import patch, MagicMock
import urllib.error

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from service_connection import check, NoRedirect


class ServiceConnectionTests(unittest.TestCase):
    def setUp(self):
        self.dns=patch('service_connection.socket.getaddrinfo',return_value=[
            (socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',443))])
        self.dns.start();self.addCleanup(self.dns.stop)

    def test_private_http_values_headers_and_body_never_appear_in_result(self):
        response=MagicMock();response.__enter__.return_value.status=200
        with patch('service_connection.urllib.request.build_opener') as factory:
            factory.return_value.open.return_value=response
            result=check({'key':'API_URL','value':'https://example.com/private-value?token=private-value',
                'path':'/health','headers':{'apikey':'private-value'}})
            request=factory.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url,'https://example.com/health')
            self.assertEqual(request.headers['Apikey'],'private-value')
            response.read.assert_not_called()
        self.assertEqual(result['status'],'reachable')
        self.assertEqual(result['http_status'],200)
        self.assertFalse(result['verified'])
        self.assertNotIn('private-value',json.dumps(result))

    def test_failure_never_returns_exception_text_or_response_body(self):
        for exception,expected in [
            (urllib.error.HTTPError('https://private-value',401,'private-value',{},None),'authentication_rejected'),
            (urllib.error.URLError('private-value'),'connection_failure'),
            (ssl.SSLError('private-value'),'tls_failure'),
            (socket.gaierror('private-value'),'dns_failure')]:
            with patch('service_connection.urllib.request.build_opener') as factory:
                factory.return_value.open.side_effect=exception
                result=check({'key':'DATABASE_URL','value':'https://example.com/private-value'})
            self.assertEqual(result['status'],expected)
            self.assertNotIn('private-value',json.dumps(result))

    def test_local_private_and_compose_hosts_are_not_probed_in_control_plane(self):
        for value in ('postgres://postgres:private@postgres:5432/db','http://localhost/api',
                      'http://127.0.0.1/api','http://[::1]/api','http://host.docker.internal/api'):
            with patch('service_connection.socket.create_connection') as connect:
                if '127.0.0.1' in value:
                    with patch('service_connection.socket.getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',80))]):result=check({'key':'URL','value':value})
                else:result=check({'key':'URL','value':value})
            self.assertEqual(result['status'],'requires_runtime_probe',value)
            connect.assert_not_called()

    def test_database_tcp_connection_does_not_claim_authentication_or_readiness(self):
        with patch('service_connection.socket.create_connection') as connect:
            result=check({'key':'DATABASE_URL','value':'postgresql://user:private-value@db.example.com/db'})
            connect.assert_called_once_with(('db.example.com',5432),timeout=8)
        self.assertEqual(result['scope'],'tcp_connectivity')
        self.assertFalse(result['authentication_verified'])
        self.assertFalse(result['verified'])
        self.assertNotIn('private-value',json.dumps(result))

    def test_missing_unsupported_and_bad_requests(self):
        self.assertEqual(check({'key':'URL'})['status'],'not_configured')
        relative=check({'key':'URL','value':'/api'})
        self.assertEqual(relative['status'],'requires_runtime_probe')
        self.assertEqual(relative['scope'],'deployment_relative_endpoint')
        for changes in ({'path':'//another.example.com/'},{'headers':{'Host':'another.example.com'}},
                        {'headers':{'apikey':'private\r\nInjected: yes'}},{'value':'https://example.com:invalid/'}):
            self.assertEqual(check({'key':'URL','value':'https://example.com',**changes})['status'],'invalid_connection_request')
        self.assertIsNone(NoRedirect().redirect_request(None,None,302,'',{},'https://another.example.com'))
