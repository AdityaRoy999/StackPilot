FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    openbox \
    ffmpeg \
    libxcomposite1 \
    libxfixes3 \
    libxdamage1 \
    python3 \
    python3-websockets \
    libgl1-mesa-dri \
    procps \
    ca-certificates \
    curl \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-color-emoji \
    fonts-roboto \
    fonts-dejavu-core \
    fontconfig \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*


COPY streamer.py /usr/local/bin/streamer.py
RUN chmod +x /usr/local/bin/streamer.py

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 9222 8099

ENTRYPOINT ["/entrypoint.sh"]
