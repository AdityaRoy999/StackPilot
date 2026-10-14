import asyncio
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from protocol import Reader, address, hostname, import_rdp, instruction, parse_instruction, handshake


class RdpImportTests(unittest.TestCase):
    def test_utf16_ipv6_and_opaque_password(self):
        text = 'full address:s:[2001:db8::42]:3390\r\nusername:s:DOMAIN\\builder\r\npassword 51:b:private-opaque-value\r\n'
        result = import_rdp(text.encode('utf-16'))
        self.assertEqual(result['connection']['host'], '2001:db8::42')
        self.assertEqual(result['connection']['port'], 3390)
        self.assertEqual(result['connection']['username'], 'builder')
        self.assertEqual(result['connection']['domain'], 'DOMAIN')
        self.assertNotIn('private-opaque-value', str(result))
        self.assertNotIn('password', result['connection'])
        self.assertFalse(result['connection']['ignore_certificate'])

    def test_unsupported_routing_is_explicit(self):
        data = b'full address:s:vm.example.test\ngatewayhostname:s:gateway.example.test\nremoteapplicationmode:i:1\nloadbalanceinfo:s:routing-token'
        self.assertEqual(import_rdp(data)['unsupported'], ['RD Gateway', 'RemoteApp', 'RDS broker routing'])

    def test_rejects_ambiguous_duplicate_and_invalid_files(self):
        for data in [b'', b'x' * 65537, b'full address:s:https://bad.test', b'full address:s:host:0',
                     b'full address:s:one\nfull address:s:two', b'\x00\xff']:
            with self.subTest(data=data[:20]), self.assertRaises(ValueError):
                import_rdp(data)

    def test_address_and_hostname_are_not_command_or_url_inputs(self):
        self.assertEqual(address('vm.example.test:3391'), ('vm.example.test', 3391))
        self.assertEqual(address('192.168.1.2'), ('192.168.1.2', 3389))
        for value in ['host\nother', 'user@host', 'https://host', 'host;ls', 'a/b', '$(env)']:
            with self.assertRaises(ValueError):
                hostname(value)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_fragmented_unicode_and_delimiters(self):
        encoded = instruction('name', 'a,;😀é')
        for position in range(len(encoded)):
            self.assertIsNone(parse_instruction(encoded[:position]))
        self.assertEqual(parse_instruction(encoded)[0], ['name', 'a,;😀é'])
        for value in ['-1.x;', '99999999.x;', '1.a!', '1.a,1000000.b;']:
            with self.assertRaises(ValueError):
                parse_instruction(value)

    async def test_utf8_packet_boundaries(self):
        stream = asyncio.StreamReader()
        reader = Reader(stream)
        data = instruction('name', '😀').encode()
        for byte in data:
            stream.feed_data(bytes([byte]))
        self.assertEqual(await reader.read(), ['name', '😀'])

    async def test_handshake_secrets_only_to_private_bridge(self):
        stream = asyncio.StreamReader()
        stream.feed_data((instruction('args', 'VERSION_1_5_0', 'hostname', 'username', 'password', 'disable-copy', 'resize-method') + instruction('ready', '$fixture')).encode())
        class Writer:
            data = b''
            def write(self, data): self.data += data
            async def drain(self): pass
        writer = Writer()
        settings = {'host': 'vm', 'port': 3389, 'username': 'builder', 'domain': '', 'security': 'nla', 'ignore_certificate': False, 'keyboard_layout': 'en-us-qwerty'}
        self.assertEqual(await handshake(Reader(stream), writer, settings, 'private-secret', 1280, 720), '$fixture')
        buffer, messages = writer.data.decode(), []
        while buffer:
            values, consumed = parse_instruction(buffer)
            messages.append(values); buffer = buffer[consumed:]
        self.assertEqual(messages[-1], ['connect', 'VERSION_1_0_0', 'vm', 'builder', 'private-secret', 'true', 'display-update'])


class SecurityTests(unittest.TestCase):
    def test_authenticated_encryption_and_no_plaintext_listing(self):
        import app
        with patch.dict(os.environ, {'TOKEN_ENCRYPTION_KEY': 'test-key-' * 8}):
            value = app.encrypt('private-secret')
            self.assertNotIn('private-secret', value)
            self.assertEqual(app.decrypt(value), 'private-secret')
            with self.assertRaises(Exception):
                app.decrypt(value[:-2] + f'{int(value[-2:], 16) ^ 1:02x}')
        self.assertNotIn('password_encrypted', app.public({'password_encrypted': value, 'user_id': 'private', 'id': 'one'}))

    def test_origin_exact_match_and_schema_match(self):
        import app
        with patch.dict(os.environ, {'RDP_ALLOWED_ORIGINS': 'https://stack.example.test'}):
            self.assertTrue(app.origin_allowed('https://stack.example.test'))
            self.assertFalse(app.origin_allowed('https://stack.example.test.evil.test'))
            self.assertFalse(app.origin_allowed('null'))
        root = Path(__file__).resolve().parents[1]
        self.assertEqual((root/'sql/migrations/070_rdp_connections.sql').read_text(), Path(__file__).with_name('schema.sql').read_text())


class AccountSecurityTests(unittest.IsolatedAsyncioTestCase):
    def test_account_domain_normalization(self):
        import app
        settings = app.Connection(name='Windows', host='vm.example.test', username='DOMAIN\\builder', password='fixture')
        self.assertEqual((settings.domain, settings.username), ('DOMAIN', 'builder'))
        with self.assertRaises(ValueError):
            app.Connection(name='Windows', host='vm.example.test', username='DOMAIN\\builder', domain='OTHER')

    async def test_scoped_mcp_token_cannot_gain_desktop_authority(self):
        import app
        for headers in [{'authorization': 'Bearer STACKPILOT_mcp_test'}, {'cookie': 'token=STACKPILOT_mcp_test'}]:
            with self.assertRaises(app.HTTPException) as caught:
                await app.authenticate(headers)
            self.assertEqual(caught.exception.status_code, 403)


if __name__ == '__main__':
    unittest.main()
