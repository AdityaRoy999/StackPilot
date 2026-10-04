FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /bin/sh tunnel
COPY entrypoint.sh /usr/local/bin/remote-browser-tunnel
# Windows checkouts can contain CRLF; Linux scripts must have LF shebangs.
RUN sed -i 's/\r$//' /usr/local/bin/remote-browser-tunnel && chmod 755 /usr/local/bin/remote-browser-tunnel
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/remote-browser-tunnel"]
