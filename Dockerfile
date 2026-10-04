# StackPilot backend image.
#
# Two-stage build. The Drogon base image (1.42GB) carries the full C++ toolchain
# and is only needed to compile; shipping it as the runtime made the final image
# 1.86GB. Drogon and Trantor link statically into the binary, so the runtime
# stage needs just the binary, a handful of shared libraries, and the CLIs the
# service actually shells out to.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM drogonframework/drogon:latest AS builder

ENV DEBIAN_FRONTEND=noninteractive
ARG STACKPILOT_BACKEND_BUILD_PARALLELISM=auto

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpqxx-dev \
    libspdlog-dev \
    libcurl4-openssl-dev \
    cmake \
    pkg-config \
    libjsoncpp-dev \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir tomli==2.2.1

WORKDIR /app
# Keep runtime helpers, migrations, qualification output and frontend changes
# from invalidating the expensive C++ compilation layer.
COPY CMakeLists.txt ./
COPY config ./config
COPY src ./src

# `auto` used to mean `--parallel` with no limit, i.e. one compile job per core.
# Each Drogon translation unit can peak near 1.5 GB, so on an 8-core / 8 GB Docker
# VM that reliably OOM-killed the build. Derive a job count from BOTH cores and
# available memory, leave a core free so the host stays responsive, and cap it so
# a big machine doesn't spike memory either.
RUN cmake -B build -S . && \
    if [ "$STACKPILOT_BACKEND_BUILD_PARALLELISM" = "auto" ]; then \
        cores="$(nproc)"; \
        mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"; \
        mem_jobs="$((mem_kb / 1572864))"; \
        if [ "$mem_jobs" -lt 1 ]; then mem_jobs=1; fi; \
        if [ "$cores" -gt 1 ]; then cpu_jobs="$((cores - 1))"; else cpu_jobs=1; fi; \
        jobs="$cpu_jobs"; \
        if [ "$mem_jobs" -lt "$jobs" ]; then jobs="$mem_jobs"; fi; \
        if [ "$jobs" -gt 4 ]; then jobs=4; fi; \
        echo "Backend build: ${jobs} parallel job(s) (cores=${cores}, memory allows ${mem_jobs})"; \
        cmake --build build --config Release --parallel "$jobs"; \
    else \
        cmake --build build --config Release --parallel "$STACKPILOT_BACKEND_BUILD_PARALLELISM"; \
    fi

# ---------------------------------------------------------------------------
# Stage 2 — unit tests (not part of the runtime image)
# ---------------------------------------------------------------------------
# Reuses the builder so the toolchain and dependencies are already present and
# already cached. Placed before the runtime stage on purpose: Docker treats the
# LAST stage as the default build target, and the default must stay `runtime`.
#
#   docker build --target unit-tests -t stackpilot-unit-tests .
#   docker run --rm stackpilot-unit-tests
FROM builder AS unit-tests

COPY tests/unit/cpp ./tests/unit/cpp
COPY deployment-runtime ./deployment-runtime
COPY ai-service/app/repository_discovery.py ./deployment-runtime/repository_discovery.py
COPY ai-service/app/repository_toolchains.py ./deployment-runtime/repository_toolchains.py

RUN cmake -B build-tests -S . -DSTACKPILOT_BUILD_TESTS=ON -DCMAKE_BUILD_TYPE=Debug && \
    cmake --build build-tests --target stackpilot_unit_tests --parallel 2

# No JWT_SECRET here on purpose: the JWT tests set their own throwaway key in
# a fixture, so the image carries nothing that looks like a credential.
CMD ["/app/build-tests/stackpilot_unit_tests"]

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
# Must match the builder's distro (Ubuntu 22.04) so the copied binary's glibc
# and library sonames resolve.
FROM ubuntu:22.04 AS runtime

LABEL org.opencontainers.image.title="StackPilot Backend" \
      org.opencontainers.image.description="C++ Drogon API, build worker, Kubernetes runtime controller, and MCP backend APIs for StackPilot." \
      org.opencontainers.image.vendor="StackPilot"

ENV DEBIAN_FRONTEND=noninteractive

# Runtime shared libraries (from `ldd` on the built binary) plus the CLIs the
# service shells out to: docker (141 call sites), kubectl (55), curl, git, ssh,
# tar, sshpass and redis-cli.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      gzip \
      libc-ares2 \
      libcurl4 \
      libfmt8 \
      libhiredis0.14 \
      libjsoncpp25 \
      libmariadb3 \
      libpq5 \
      libpqxx-6.4 \
      libspdlog1 \
      libsqlite3-0 \
      libssh-4 \
      libssl3 \
      libuuid1 \
      openssh-client \
      redis-tools \
      sshpass \
      tar \
      zlib1g \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
    && apt-get purge -y gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# A clean checkout must build without a machine-local binary. Pin the release
# and verify the upstream checksum for the target architecture.
ARG KUBECTL_VERSION=v1.37.1
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" -o /tmp/kubectl \
    && curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256" -o /tmp/kubectl.sha256 \
    && echo "$(cat /tmp/kubectl.sha256)  /tmp/kubectl" | sha256sum --check \
    && install -m 0755 /tmp/kubectl /usr/local/bin/kubectl \
    && rm /tmp/kubectl /tmp/kubectl.sha256

RUN curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb -o /tmp/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && rm /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends powershell nodejs npm python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir tomli==2.2.1

# Run as an unprivileged user instead of root. Note this does NOT neutralise the
# mounted docker socket — see docker-compose.yml, where group_add grants access to
# it. Dropping root still removes the ability to write system paths, install
# packages, or use root-only capabilities.
RUN groupadd --gid 10001 stackpilot \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin stackpilot

WORKDIR /app

COPY --from=builder --chown=10001:10001 /app/build/stackpilot-platform ./build/stackpilot-platform
COPY --chown=10001:10001 sql ./sql
COPY --chown=10001:10001 config.json ./config.json
COPY --chown=10001:10001 deployment-runtime ./deployment-runtime
COPY --chown=10001:10001 ai-service/app/repository_discovery.py ./deployment-runtime/repository_discovery.py
COPY --chown=10001:10001 ai-service/app/repository_toolchains.py ./deployment-runtime/repository_toolchains.py

# `static` is an intentionally empty document_root. Drogon serves unmatched
# paths from it, so it must NOT be /app — that exposed uploads/builds (cloned
# user repositories) and the source tree to unauthenticated GETs.
RUN mkdir -p logs uploads/builds uploads/source-artifacts static \
    && chown -R 10001:10001 /app

USER 10001:10001

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8090/api/v1/health >/dev/null || exit 1

CMD ["./build/stackpilot-platform"]
