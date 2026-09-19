# StackPilot Browser Sandbox — GPU Deployment Guide

## Quick Start (AWS EC2 with GPU)

### Prerequisites
- AWS CLI v2 configured (`aws configure`)
- AWS credits available
- SSH client

### 1. Deploy the EC2 Instance

```bash
cd browser-sandbox

# Option A: On-demand g4dn.xlarge (~$0.53/hr)
bash deploy.sh --instance g4dn.xlarge --region us-east-1

# Option B: Spot instance (~$0.16/hr, 70% cheaper)
bash deploy.sh --instance g4dn.xlarge --region us-east-1 --spot
```

The script will:
- Find the latest Ubuntu 22.04 GPU AMI
- Create a security group (ports 22, 9222, 8099 locked to your IP)
- Generate an SSH key pair
- Launch the instance with Docker + NVIDIA toolkit auto-setup
- Print connection details

### 2. Deploy the Sandbox Container

After the instance is ready (~5 minutes):

```bash
# Copy sandbox files to EC2
scp -i stackpilot-sandbox.pem -r . ubuntu@<EC2_IP>:/opt/stackpilot-sandbox/

# SSH in
ssh -i stackpilot-sandbox.pem ubuntu@<EC2_IP>

# Build and start
cd /opt/stackpilot-sandbox
docker compose -f docker-compose.gpu.yml up -d --build
```

### 3. Connect Your Local Stack

Update your local `.env` or `docker-compose.yml` environment:

```env
BROWSER_SANDBOX_URL=ws://<EC2_IP>:9222
BROWSER_STREAM_HOST=<EC2_IP>
BROWSER_STREAM_PORT=8099
```

Restart the AI service:
```bash
docker restart stackpilot-ai-service
```

### 4. Verify

Open StackPilot → AI Dashboard → Browser Canvas. You should see:
- **60 FPS** in the canvas FPS counter
- Smooth scrolling and CSS animations
- Low latency indicator

### 5. Tear Down

```bash
bash deploy.sh --terminate --region us-east-1
```

---

## Architecture

```
┌─────────────────────────────┐     ┌──────────────────────────┐
│  AWS EC2 (g4dn.xlarge)      │     │  Your Machine (local)    │
│                             │     │                          │
│  Xvfb 1920x1080             │     │  Frontend :3000          │
│  Chromium (GPU EGL)         │◄────│  AI Service :8010        │
│  FFmpeg h264_nvenc 60fps    │────►│  Backend :8090           │
│  streamer.py TCP :8099      │     │  PostgreSQL :5432        │
│  CDP Proxy :9222            │     │  Redis :6379             │
└─────────────────────────────┘     └──────────────────────────┘
        H.264 stream ──────────────────► WebSocket → Canvas
        CDP commands ◄─────────────────── AI Service
```

## Instance Recommendations

| Use Case | Instance | GPU | Cost/hr | Notes |
|----------|----------|-----|---------|-------|
| Dev/Demo | g4dn.xlarge (spot) | T4 | ~$0.16 | Best value |
| Production | g4dn.xlarge | T4 | $0.526 | Reliable |
| High quality | g5.xlarge | A10G | $1.006 | 4K capable |
| Budget | c6i.xlarge | None | $0.17 | CPU-only, 30-45fps |

## Files

| File | Purpose |
|------|---------|
| `Dockerfile.gpu` | NVIDIA CUDA base image with GPU drivers |
| `entrypoint.gpu.sh` | GPU-aware Chromium + auto-detect NVENC |
| `streamer.gpu.py` | NVENC/libx264 auto-detect streaming server |
| `docker-compose.gpu.yml` | GPU compose with NVIDIA runtime |
| `deploy.sh` | One-command AWS EC2 deploy/terminate |
| `.env.example` | Configuration template |

## Troubleshooting

### NVENC not detected
Check GPU access inside container:
```bash
docker exec stackpilot-browser-sandbox nvidia-smi
```

### High latency
- Use a region closest to you
- Reduce `STREAM_WIDTH`/`STREAM_HEIGHT` to 1280x720
- Check `STREAM_BITRATE` isn't exceeding your upload bandwidth

### Chromium crash
- Increase `shm_size` in docker-compose
- Check `docker logs stackpilot-browser-sandbox` for OOM errors
