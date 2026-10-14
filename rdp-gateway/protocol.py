"""Bounded Guacamole framing and a deliberately small .rdp import format."""
import asyncio
import codecs
import ipaddress
import re

MAX_FILE = 65536


def instruction(*parts):
    return ','.join(f'{len(str(part))}.{part}' for part in parts) + ';'


def parse_instruction(buffer):
    parts, offset = [], 0
    while True:
        dot = buffer.find('.', offset)
        if dot < 0:
            if len(buffer) - offset > 7:
                raise ValueError('Invalid instruction length')
            return None
        length = buffer[offset:dot]
        if not re.fullmatch(r'\d{1,7}', length) or int(length) > 131072:
            raise ValueError('Invalid instruction length')
        end = dot + 1 + int(length)
        if end >= len(buffer):
            return None
        parts.append(buffer[dot + 1:end])
        if len(parts) > 256:
            raise ValueError('Too many instruction arguments')
        delimiter = buffer[end]
        if delimiter == ';':
            return parts, end + 1
        if delimiter != ',':
            raise ValueError('Invalid instruction delimiter')
        offset = end + 1


class Reader:
    def __init__(self, stream):
        self.stream, self.buffer = stream, ''
        self.decoder = codecs.getincrementaldecoder('utf-8')()

    async def read(self):
        while True:
            parsed = parse_instruction(self.buffer)
            if parsed:
                parts, consumed = parsed
                self.buffer = self.buffer[consumed:]
                return parts
            data = await self.stream.read(16384)
            if not data:
                raise EOFError('Desktop connection closed')
            self.buffer += self.decoder.decode(data)
            if len(self.buffer) > 262144:
                raise ValueError('Instruction too large')


def hostname(value):
    value = value.strip()
    if not value or len(value) > 253 or any(c in value for c in '/\\@?#\x00\r\n'):
        raise ValueError('Enter a hostname or IP address without a URL or credentials')
    try:
        return str(ipaddress.ip_address(value.strip('[]')))
    except ValueError:
        if not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?', value):
            raise ValueError('Invalid hostname or IP address')
        return value


def address(value):
    value = value.strip()
    if value.startswith('['):
        match = re.fullmatch(r'\[([^]]+)\](?::(\d+))?', value)
        if not match:
            raise ValueError('Invalid IPv6 address')
        host, port = match[1], match[2] or '3389'
    elif value.count(':') == 1:
        host, port = value.rsplit(':', 1)
    else:
        host, port = value, '3389'
    if not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError('Invalid RDP port')
    return hostname(host), int(port)


def import_rdp(raw):
    if not raw or len(raw) > MAX_FILE:
        raise ValueError('Choose a .rdp file smaller than 64 KB')
    try:
        text = raw.decode('utf-16') if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else raw.decode('utf-8-sig')
    except UnicodeError:
        raise ValueError('The .rdp file must use UTF-8 or UTF-16 encoding') from None
    fields = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'([^:]+):([sib]):(.*)', line.strip())
        if not match:
            raise ValueError('Invalid .rdp file format')
        key = match[1].strip().lower()
        if key in fields:
            raise ValueError('Duplicate .rdp setting: ' + key)
        fields[key] = match[3].strip()
    host, port = address(fields.get('full address', ''))
    warnings, unsupported = [], []
    if fields.get('password 51') or fields.get('password'):
        warnings.append('The password in this file was not imported. Enter the Windows account password below.')
    if fields.get('gatewayhostname') and fields.get('gatewayusagemethod', '1') != '0':
        unsupported.append('RD Gateway')
    if fields.get('remoteapplicationmode', '0') != '0':
        unsupported.append('RemoteApp')
    if fields.get('loadbalanceinfo'):
        unsupported.append('RDS broker routing')
    if fields.get('enablerdsaadauth', '0') != '0' or fields.get('enablecredsspsupport') == '0':
        unsupported.append('This file’s authentication mode')
    username, domain = fields.get('username', ''), fields.get('domain', '')
    if '\\' in username and not domain:
        domain, username = username.split('\\', 1)
    imported = {'host': host, 'port': port, 'username': username,
                'domain': domain, 'security': 'nla', 'ignore_certificate': False}
    warnings.append('Display and device-redirection settings use StackPilot defaults. Review the connection before saving.')
    return {'connection': imported, 'warnings': warnings, 'unsupported': unsupported}


async def handshake(reader, writer, connection, password, width, height):
    writer.write(instruction('select', 'rdp').encode())
    await writer.drain()
    args = await reader.read()
    if not args or args[0] != 'args':
        raise ValueError('RDP bridge did not accept the protocol')
    values = {
        'hostname': connection['host'], 'port': str(connection['port']),
        'username': connection['username'], 'domain': connection['domain'], 'password': password,
        'security': connection['security'], 'ignore-cert': str(connection['ignore_certificate']).lower(),
        'resize-method': 'display-update', 'server-layout': connection['keyboard_layout'],
        'disable-audio': 'true', 'enable-audio-input': 'false', 'enable-drive': 'false',
        'enable-printing': 'false', 'disable-copy': 'true', 'disable-paste': 'true',
        'enable-wallpaper': 'false', 'enable-theming': 'false', 'color-depth': '24',
        'client-name': 'StackPilot', 'width': str(width), 'height': str(height),
    }
    # The first argument may be a protocol version. This bridge supports 1.0;
    # older handshake order remains compatible with current guacd.
    for key in args[1:]:
        if key.startswith('VERSION_'):
            values[key] = 'VERSION_1_0_0'
    for parts in [('size', width, height, 96), ('audio',), ('video',),
                  ('image', 'image/png', 'image/jpeg'), ('connect', *(values.get(key, '') for key in args[1:]))]:
        writer.write(instruction(*parts).encode())
    await writer.drain()
    ready = await reader.read()
    if ready[0] == 'error':
        raise ConnectionError(ready[-1])
    if ready[0] != 'ready':
        raise ValueError('RDP bridge handshake failed')
    return ready[1]
