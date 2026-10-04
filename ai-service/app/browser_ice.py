"""Published UDP candidates for Docker's local WebRTC preview.

aiortc/aioice normally choose ephemeral UDP ports, which Docker does not publish.
Keep their ICE state machine, but bind the media socket inside a small published
range. This adapter targets the pinned aiortc 1.15 / aioice 0.10 API and is covered
by actual peer decoding tests. TURN remains available for hosted/NAT deployments.
"""
import asyncio
import ipaddress
import os
import socket
from types import MethodType

from aioice import Candidate
from aioice.ice import StunProtocol, candidate_foundation, candidate_priority


def published_udp(peer):
    advertised = os.getenv("BROWSER_RTC_ADVERTISED_IP", "")
    if not advertised:
        return
    ipaddress.IPv4Address(advertised)
    lower = int(os.getenv("BROWSER_RTC_UDP_MIN", "8011"))
    upper = int(os.getenv("BROWSER_RTC_UDP_MAX", "8026"))
    if not 1024 <= lower <= upper <= 65535 or upper - lower > 127:
        raise ValueError("Invalid published WebRTC UDP range")
    seen = set()
    for transceiver in peer.getTransceivers():
        connection = transceiver.sender.transport.transport.iceGatherer._connection
        if id(connection) in seen:
            continue
        seen.add(id(connection))
        original = connection.get_component_candidates

        async def gather(self, component, addresses, timeout=5, original=original):
            loop = asyncio.get_running_loop()
            protocol = None
            for port in range(lower, upper + 1):
                try:
                    transport, protocol = await loop.create_datagram_endpoint(
                        lambda: StunProtocol(self), local_addr=("0.0.0.0", port))
                    transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)
                    break
                except OSError:
                    continue
            if protocol is None:
                raise OSError("Published WebRTC port capacity reached")
            protocol.local_candidate = Candidate(
                foundation=candidate_foundation("host", "udp", advertised),
                component=component, transport="udp", priority=candidate_priority(component, "host"),
                host=advertised, port=port, type="host")
            self._protocols.append(protocol)
            candidates = [protocol.local_candidate]
            if self.stun_server or self.turn_server:
                candidates += await original(component, addresses, timeout)
            return candidates

        connection.get_component_candidates = MethodType(gather, connection)
