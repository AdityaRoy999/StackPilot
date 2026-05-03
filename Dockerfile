# Use the official Drogon image for both building and running
# This ensures a 100% matching environment and solves all library issues
FROM drogonframework/drogon:latest

# Install database and logging dependencies
RUN apt-get update && apt-get install -y \
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
    sshpass \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

WORKDIR /app

# Copy source code
COPY . .

# Build the project
RUN cmake -B build -S . && \
    cmake --build build --config Release

RUN mkdir -p logs uploads/builds

EXPOSE 8090

# Start the application
# We use the full path to the compiled binary
CMD ["./build/aids-platform"]
