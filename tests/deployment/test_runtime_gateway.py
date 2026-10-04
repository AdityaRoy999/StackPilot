"""Routing must remain bound to the recorded, verified deployment identity."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('stackpilot_runtime_gateway',ROOT/'runtime-gateway'/'app.py')
gateway=importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class RuntimeGateway(unittest.TestCase):
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
