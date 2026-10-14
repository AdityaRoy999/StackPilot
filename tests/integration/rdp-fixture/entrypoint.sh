#!/bin/sh
set -eu
# Random fixture password arrives through docker exec stdin into tmpfs.
while [ ! -s /run/fixture-password ]; do sleep 0.1; done
read -r fixture_password < /run/fixture-password
rm /run/fixture-password
printf 'rdpfixture:%s\n' "$fixture_password" | chpasswd
unset fixture_password
mkdir -p /run/xrdp /run/dbus
chown xrdp:xrdp /run/xrdp
/usr/sbin/xrdp-sesman --nodaemon &
exec /usr/sbin/xrdp --nodaemon
