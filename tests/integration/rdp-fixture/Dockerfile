# Test-owned, isolated RDP server. This is an XRDP protocol fixture, not Windows.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends xrdp xorgxrdp openbox xterm x11-utils xauth dbus-x11 fonts-dejavu-core pamtester && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash rdpfixture && adduser xrdp ssl-cert && \
    sed -i 's/^security_layer=.*/security_layer=tls/' /etc/xrdp/xrdp.ini && \
    printf '#!/bin/sh\nunset DBUS_SESSION_BUS_ADDRESS\nunset XDG_RUNTIME_DIR\nexec openbox-session\n' > /etc/xrdp/startwm.sh && \
    chmod +x /etc/xrdp/startwm.sh && mkdir -p /home/rdpfixture/.config/openbox && \
    printf 'xterm -geometry 100x30+20+20 -title StackPilot-RDP-fixture &\n' > /home/rdpfixture/.config/openbox/autostart && \
    chown -R rdpfixture:rdpfixture /home/rdpfixture && printf 'LANG=C.UTF-8\n' > /etc/default/locale
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3389
CMD ["/entrypoint.sh"]
