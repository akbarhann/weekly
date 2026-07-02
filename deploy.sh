#!/bin/bash
# deploy.sh
# Pull latest changes from GitHub and restart the weekly-discord-bot service.

set -e

# Change directory to the repository root
cd "$(dirname "$0")"

echo "=== Restoring Chrome Profile in Agency ==="
git restore agency/data/chrome_profile/
git clean -fdx agency/data/chrome_profile/

echo "=== Restoring Chrome Profile in VB ==="
git restore VB/data/chrome_profiles/
git clean -fdx VB/data/chrome_profiles/

echo "=== Pulling latest changes from GitHub ==="
git pull

echo "=== Restarting weekly-discord-bot service ==="
sudo -S systemctl restart weekly-discord-bot

echo "=== Checking service status ==="
sudo -S systemctl status weekly-discord-bot --no-pager
