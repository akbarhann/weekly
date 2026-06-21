#!/bin/bash
# deploy.sh
# Pull latest changes from GitHub and restart the weekly-discord-bot service.

set -e

# Change directory to the repository root
cd "$(dirname "$0")"

echo "=== Pulling latest changes from GitHub ==="
git pull

echo "=== Restarting weekly-discord-bot service ==="
sudo systemctl restart weekly-discord-bot

echo "=== Checking service status ==="
sudo systemctl status weekly-discord-bot --no-pager
