#!/bin/bash
# ─────────────────────────────────────────────────────────────
# StackPilot Browser Sandbox — AWS EC2 GPU Deployment Script
# ─────────────────────────────────────────────────────────────
#
# Usage:
#   ./deploy.sh                    # Deploy with defaults (g4dn.xlarge, us-east-1)
#   ./deploy.sh --instance g5.xlarge --region us-west-2
#   ./deploy.sh --spot              # Use spot instance (60-70% cheaper)
#   ./deploy.sh --terminate         # Tear down the instance
#
# Prerequisites:
#   - AWS CLI v2 installed and configured (aws configure)
#   - SSH key pair created in target region
#
set -euo pipefail

# ─── Configuration ──────────────────────────────────────────
INSTANCE_TYPE="${INSTANCE_TYPE:-g4dn.xlarge}"
REGION="${REGION:-us-east-1}"
KEY_NAME="${KEY_NAME:-stackpilot-sandbox}"
USE_SPOT=false
ACTION="deploy"
AMI_ID=""  # Will auto-detect latest Ubuntu 22.04 GPU AMI

# ─── Parse Arguments ────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --instance)    INSTANCE_TYPE="$2"; shift 2 ;;
    --region)      REGION="$2"; shift 2 ;;
    --key)         KEY_NAME="$2"; shift 2 ;;
    --spot)        USE_SPOT=true; shift ;;
    --terminate)   ACTION="terminate"; shift ;;
    --ami)         AMI_ID="$2"; shift 2 ;;
    *)             echo "Unknown option: $1"; exit 1 ;;
  esac
done

TAG_NAME="stackpilot-browser-sandbox"
SG_NAME="stackpilot-sandbox-sg"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Colors ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─── Terminate ──────────────────────────────────────────────
if [ "$ACTION" = "terminate" ]; then
  info "Finding instance with tag '$TAG_NAME'..."
  INSTANCE_ID=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=$TAG_NAME" "Name=instance-state-name,Values=running,pending,stopping,stopped" \
    --query 'Reservations[0].Instances[0].InstanceId' \
    --output text 2>/dev/null || echo "None")
  
  if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
    warn "No running instance found. Nothing to terminate."
    exit 0
  fi
  
  info "Terminating instance $INSTANCE_ID..."
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID"
  info "✅ Instance $INSTANCE_ID termination initiated."
  exit 0
fi

# ─── Deploy ─────────────────────────────────────────────────
info "🚀 Deploying StackPilot Browser Sandbox to AWS EC2"
info "   Instance: $INSTANCE_TYPE | Region: $REGION | Spot: $USE_SPOT"

# 1. Find AMI (Ubuntu 22.04 with NVIDIA drivers)
if [ -z "$AMI_ID" ]; then
  info "Finding latest Ubuntu 22.04 Deep Learning AMI..."
  AMI_ID=$(aws ec2 describe-images \
    --region "$REGION" \
    --owners amazon \
    --filters \
      "Name=name,Values=Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*" \
      "Name=state,Values=available" \
      "Name=architecture,Values=x86_64" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text 2>/dev/null || echo "")
  
  if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
    # Fallback to standard Ubuntu 22.04
    info "Deep Learning AMI not found, using standard Ubuntu 22.04..."
    AMI_ID=$(aws ec2 describe-images \
      --region "$REGION" \
      --owners 099720109477 \
      --filters \
        "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
        "Name=state,Values=available" \
      --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
      --output text)
  fi
fi
info "AMI: $AMI_ID"

# 2. Create or find Security Group
SG_ID=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' \
  --output text 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  info "Creating security group '$SG_NAME'..."
  SG_ID=$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SG_NAME" \
    --description "StackPilot Browser Sandbox - CDP + Stream" \
    --query 'GroupId' --output text)
  
  MY_IP=$(curl -s https://checkip.amazonaws.com)/32
  info "Your IP: $MY_IP"
  
  # SSH
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr "$MY_IP" > /dev/null
  # CDP WebSocket
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 9222 --cidr "$MY_IP" > /dev/null
  # Video Stream
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 8099 --cidr "$MY_IP" > /dev/null
  info "Security group created: $SG_ID (restricted to $MY_IP)"
else
  info "Using existing security group: $SG_ID"
fi

# 3. Create SSH key if it doesn't exist
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" > /dev/null 2>&1; then
  info "Creating SSH key pair '$KEY_NAME'..."
  aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text > "${SCRIPT_DIR}/${KEY_NAME}.pem"
  chmod 400 "${SCRIPT_DIR}/${KEY_NAME}.pem"
  info "SSH key saved to ${SCRIPT_DIR}/${KEY_NAME}.pem"
fi

# 4. Create user-data script
USER_DATA=$(cat <<'USERDATA'
#!/bin/bash
set -e
exec > /var/log/stackpilot-setup.log 2>&1

echo "=== StackPilot Browser Sandbox Setup ==="
apt-get update -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Install NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update -y
apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

# Install Docker Compose plugin
apt-get install -y docker-compose-plugin

# Create project directory
mkdir -p /opt/stackpilot-sandbox
cd /opt/stackpilot-sandbox

# Signal that setup is complete
touch /opt/stackpilot-sandbox/.setup-complete
echo "=== Setup Complete ==="
USERDATA
)

# 5. Launch instance
info "Launching EC2 instance..."
if [ "$USE_SPOT" = "true" ]; then
  INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":50,"VolumeType":"gp3"}}]' \
    --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"persistent","InstanceInterruptionBehavior":"stop"}}' \
    --user-data "$USER_DATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG_NAME}]" \
    --query 'Instances[0].InstanceId' \
    --output text)
  info "Spot instance requested: $INSTANCE_ID"
else
  INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":50,"VolumeType":"gp3"}}]' \
    --user-data "$USER_DATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG_NAME}]" \
    --query 'Instances[0].InstanceId' \
    --output text)
  info "On-demand instance launched: $INSTANCE_ID"
fi

# 6. Wait for running state
info "Waiting for instance to be running..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

# 7. Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

info "✅ Instance is running!"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  StackPilot Browser Sandbox — Deployed!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Instance ID:  $INSTANCE_ID"
echo "  Public IP:    $PUBLIC_IP"
echo "  Instance:     $INSTANCE_TYPE"
echo "  Region:       $REGION"
echo ""
echo "  📡 Endpoints (available after setup completes ~3-5 min):"
echo "     CDP:       ws://$PUBLIC_IP:9222"
echo "     Stream:    tcp://$PUBLIC_IP:8099"
echo ""
echo "  🔑 SSH Access:"
echo "     ssh -i ${SCRIPT_DIR}/${KEY_NAME}.pem ubuntu@$PUBLIC_IP"
echo ""
echo "  📋 Next Steps:"
echo "     1. Wait ~5 min for Docker + NVIDIA toolkit setup"
echo "     2. SSH in and run the sandbox:"
echo "        scp -i ${KEY_NAME}.pem -r ../browser-sandbox ubuntu@$PUBLIC_IP:/opt/stackpilot-sandbox/"
echo "        ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP"
echo "        cd /opt/stackpilot-sandbox && docker compose -f docker-compose.gpu.yml up -d --build"
echo ""
echo "     3. Update your local .env:"
echo "        BROWSER_SANDBOX_URL=ws://$PUBLIC_IP:9222"
echo "        BROWSER_STREAM_HOST=$PUBLIC_IP"
echo "        BROWSER_STREAM_PORT=8099"
echo ""
echo "     4. Restart local ai-service to use remote sandbox"
echo ""
echo "  🛑 To terminate:"
echo "     ./deploy.sh --terminate --region $REGION"
echo "═══════════════════════════════════════════════════════════"
