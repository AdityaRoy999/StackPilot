#!/bin/sh
set -eu
: "${REMOTE_BROWSER_SSH_HOST:?Set the saved browser worker SSH host}"
: "${REMOTE_BROWSER_SSH_USER:?Set the saved browser worker SSH user}"
test -s /run/remote-browser-ssh/id_ed25519
test -s /run/remote-browser-ssh/known_hosts
# Keep screenshots and DOM replies on a separate TCP connection from video.
# Multiplexing both SSH channels stalls H.264 behind a large CDP image reply,
# then delivers bursts that overflow the viewer's dependency-safe frame queue.
# Neither tunnel publishes host ports; both retain the pinned host key and the
# same restricted forwarding key / loopback-only remote destinations.
tunnel() {
    exec ssh -NT -g \
    -i /run/remote-browser-ssh/id_ed25519 \
    -o UserKnownHostsFile=/run/remote-browser-ssh/known_hosts \
    -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes \
    -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
    -o LogLevel=ERROR \
    -p "${REMOTE_BROWSER_SSH_PORT:-22}" \
    -o Compression=no -o ControlMaster=no -o ControlPath=none \
    -L "$1" \
    "${REMOTE_BROWSER_SSH_USER}@${REMOTE_BROWSER_SSH_HOST}"
}

cdp_pid= media_pid=
cleanup() {
    [ -z "$cdp_pid" ] || kill "$cdp_pid" 2>/dev/null || true
    [ -z "$media_pid" ] || kill "$media_pid" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
tunnel 0.0.0.0:9222:127.0.0.1:9222 &
cdp_pid=$!
tunnel 0.0.0.0:8099:127.0.0.1:8099 &
media_pid=$!
# Restart the pair when either connection fails; never leave a half-ready worker.
while kill -0 "$cdp_pid" 2>/dev/null && kill -0 "$media_pid" 2>/dev/null; do
    sleep 1
done
exit 1
