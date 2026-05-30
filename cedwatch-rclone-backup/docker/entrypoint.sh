#!/bin/sh
set -e

# Ensure config and backups dirs exist and are writable by www-data (UID 82)
mkdir -p /data/config /data/backups
chown -R 82:82 /data/config /data/backups
chmod -R 775 /data/config /data/backups

# Generate crontab from settings.json if it exists
SETTINGS="/data/config/settings.json"
if [ -f "$SETTINGS" ]; then
    HOUR=$(php -r "echo json_decode(file_get_contents('$SETTINGS'))->hour ?? '0';")
    MIN=$(php -r "echo json_decode(file_get_contents('$SETTINGS'))->minute ?? '10';")
    echo "$MIN $HOUR * * * /usr/local/bin/rclone-backup.sh >> /data/config/backup.log 2>&1" | crontab -
else
    echo "10 0 * * * /usr/local/bin/rclone-backup.sh >> /data/config/backup.log 2>&1" | crontab -
fi

# Start crond
crond -l 8

# Start PHP-FPM
php-fpm -D

# Wait for socket
sleep 1

# Start nginx foreground
exec nginx -g "daemon off;"
