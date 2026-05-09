# DOKSCP backend image.
# The Drogon base image keeps the C++ framework and runtime ABI aligned.
FROM drogonframework/drogon:latest

LABEL org.opencontainers.image.title="DOKSCP Backend" \
      org.opencontainers.image.description="C++ Drogon API, build worker, Kubernetes runtime controller, and MCP backend APIs for DOKSCP." \
      org.opencontainers.image.vendor="DOKSCP"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpqxx-dev \
    libspdlog-dev \
    libcurl4-openssl-dev \
    cmake \
    pkg-config \
    libjsoncpp-dev \
    git \
    docker.io \
    redis-tools \
    curl \
    ca-certificates \
    openssh-client \
    tar \
    gzip \
    sshpass \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

WORKDIR /app

COPY . .

RUN cmake -B build -S . && \
    cmake --build build --config Release --parallel

RUN mkdir -p logs uploads/builds uploads/source-artifacts

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8090/api/v1/health >/dev/null || exit 1

CMD ["./build/dokscp-platform"]
