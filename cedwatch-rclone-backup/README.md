# Rclone Backup — Umbrel App

Automated SFTP backup scheduler for your web hosting. Your files, on your hardware. No cloud. No subscription.

## Features

- Web UI — no command line needed
- Daily rolling 7-day backup (Mon → Sun, auto-overwrite)
- SFTP connection via SSH key — no password stored
- Choose folders to include, file types to exclude
- Test connection before first run
- Run backup on demand
- Live log tail in the browser
- Works with cPanel / Spaceship / any shared hosting (port 21098)

## Setup

1. Install from the Networking category
2. Open the app UI
3. Enter your SFTP host, port, username
4. Upload your SSH private key (`id_rsa`)
5. List folders to backup (one per line)
6. Click **Save Settings** → **Test Connection** → **Run Backup Now**

### Generating an SSH key (if you don't have one)

On your Umbrel via SSH:
```bash
ssh-keygen -t rsa -b 4096 -f ~/id_rsa -N ""
cat ~/id_rsa.pub
```
Copy the public key → paste into your cPanel → SSH Access → Manage SSH Keys → Import → **Authorize**.

## Backup location

Backups are stored at:
```
/home/umbrel/umbrel/home/SpaceshipBak/daily_[DayName]/
```
Accessible via Umbrel's built-in file browser and Samba shares.

## Source

- Docker image: `ghcr.io/cedwatch/rclone-backup:latest`
- Store: [cedwatch/umbrel-community-app-store](https://github.com/cedwatch/umbrel-community-app-store)

---
Built in Kampot, Cambodia · [ced.watch](https://ced.watch) · [Donate](https://donate.ced.watch)
