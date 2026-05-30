#!/bin/sh
# Rclone Backup — runs nightly via crond inside container
# Config read from /data/config/settings.json

SETTINGS="/data/config/settings.json"
LOG="/data/config/backup.log"

if [ ! -f "$SETTINGS" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: No settings.json found. Configure via web UI." >> "$LOG"
    exit 1
fi

# Parse settings
REMOTE=$(php -r "echo json_decode(file_get_contents('$SETTINGS'))->remote ?? 'Spaceship';")
SOURCE=$(php -r "echo json_decode(file_get_contents('$SETTINGS'))->source ?? 'public_html';")
DAY=$(date +%A)
DEST="/data/backups/daily_$DAY"

# Build filter args from folders array
FILTERS=$(php -r "
\$s = json_decode(file_get_contents('$SETTINGS'));
\$out = '';
foreach ((\$s->folders ?? []) as \$f) {
    \$out .= '--filter \"+ ' . trim(\$f) . '/**\" ';
}
foreach ((\$s->excludes ?? []) as \$e) {
    \$out .= '--filter \"- ' . trim(\$e) . '\" ';
}
\$out .= '--filter \"- **\"';
echo \$out;
")

echo "=== $(date '+%Y-%m-%d %H:%M:%S') === Starting backup to daily_$DAY ===" >> "$LOG"

eval rclone sync \
    --config /data/config/rclone.conf \
    "$REMOTE:$SOURCE" "$DEST" \
    $FILTERS \
    --sftp-key-file /data/config/id_rsa \
    --log-level INFO \
    --log-file "$LOG"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') === Done ===" >> "$LOG"
