#!/bin/bash
set -e

# --- Config ---
PI_USER="billy"
PI_HOST="192.168.0.65"
PI_DIR="/home/billy/VoiceBite"
SSH_TARGET="${PI_USER}@${PI_HOST}"

# SSH ControlMaster settings - one password prompt for the whole script
SOCKET="/tmp/voicebite-deploy-ssh"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=${SOCKET} -o ControlPersist=60"

echo "=== VoiceBite Deploy ==="

# --- Step 1: Open shared SSH connection (you type password once here) ---
echo "[1/3] Connecting to Pi..."
ssh ${SSH_OPTS} -fN ${SSH_TARGET}

# Make sure the directories exist on the Pi
ssh ${SSH_OPTS} ${SSH_TARGET} "mkdir -p ${PI_DIR}/src ${PI_DIR}/data"

# --- Step 2: Sync source files ---
# Note: we do NOT sync data/ (that lives on the Pi, don't overwrite it)
echo "[2/3] Syncing files to Pi..."
rsync -avz --delete \
  -e "ssh ${SSH_OPTS}" \
  src/ \
  ${SSH_TARGET}:${PI_DIR}/src/

# Build list of files to sync - only include files that actually exist on this machine
SYNC_FILES="package.json package-lock.json tsconfig.json"
[ -f ecosystem.config.cjs ] && SYNC_FILES="$SYNC_FILES ecosystem.config.cjs"
[ -f .env.example ] && SYNC_FILES="$SYNC_FILES .env.example"
[ -f .env ] && SYNC_FILES="$SYNC_FILES .env"

rsync -avz \
  -e "ssh ${SSH_OPTS}" \
  $SYNC_FILES \
  ${SSH_TARGET}:${PI_DIR}/

# --- Step 3: Install dependencies and restart ---
# We install pm2 globally as part of the deploy (npm is idempotent - safe to run every time)
# We use the full pm2 path derived from `npm prefix -g` to avoid PATH issues with SSH
echo "[3/3] Installing dependencies and restarting on Pi..."
ssh -T ${SSH_OPTS} ${SSH_TARGET} << ENDSSH
  set -e
  cd ${PI_DIR}

  # Install app dependencies
  npm install --omit=dev

  # Ensure pm2 is installed globally (safe to run even if already installed)
  npm install -g pm2

  # Get the full path to pm2 - avoids PATH issues with non-interactive SSH sessions
  PM2="\$(npm prefix -g)/bin/pm2"

  if \$PM2 list | grep -q VoiceBite; then
    echo "Restarting existing PM2 process..."
    \$PM2 restart VoiceBite
  else
    echo "Starting VoiceBite with PM2 for the first time..."
    \$PM2 save
  fi
ENDSSH

# Close the shared SSH connection
ssh -O exit -o ControlPath=${SOCKET} ${SSH_TARGET} 2>/dev/null || true

echo ""
echo "=== Deploy complete! ==="
echo ""
echo "Useful commands on the Pi:"
echo "  pm2 logs VoiceBite        # tail the live logs"
echo "  pm2 list                  # check it's running"
echo ""
echo "First time deploying? Run this on the Pi once to enable auto-start on boot:"
echo "  pm2 save && pm2 startup"
