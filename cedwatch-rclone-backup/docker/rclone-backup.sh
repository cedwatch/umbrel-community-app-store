#!/bin/sh
# Rclone Backup — cedwatch
# Reads /data/config/settings.json and runs rclone sync

SETTINGS="/data/config/settings.json"
CONF="/data/config/rclone.conf"
KEY="/data/config/id_rsa"
LOG="/data/config/backup.log"
DAY=$(date +%A)
DEST="/data/backups/daily_$DAY"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') === Starting backup to daily_$DAY ===" >> "$LOG"

if [ ! -f "$SETTINGS" ]; then
    echo "ERROR: No settings.json" >> "$LOG"
    exit 1
fi
if [ ! -f "$CONF" ]; then
    echo "ERROR: No rclone.conf" >> "$LOG"
    exit 1
fi
if [ ! -f "$KEY" ]; then
    echo "ERROR: No id_rsa" >> "$LOG"
    exit 1
fi

# Read values directly with grep/sed — no php, no eval
REMOTE=$(grep '"remote"' "$SETTINGS" | sed 's/.*": *"\(.*\)".*/\1/')
SOURCE=$(grep '"source"' "$SETTINGS" | sed 's/.*": *"\(.*\)".*/\1/')

# Build filter file
FILTERFILE="/tmp/rclone-filters.txt"
rm -f "$FILTERFILE"

# Excludes first
python3 -c "
import json
with open('$SETTINGS') as f:
    s = json.load(f)
for e in s.get('excludes', []):
    print('- ' + e.strip())
for folder in s.get('folders', []):
    print('+ ' + folder.strip() + '/**')
print('- **')
" >> "$FILTERFILE" 2>> "$LOG"

echo "--- Filters applied ---" >> "$LOG"
cat "$FILTERFILE" >> "$LOG"
echo "--- Running rclone ---" >> "$LOG"

/usr/local/bin/rclone sync \
    --config "$CONF" \
    "$REMOTE:$SOURCE" "$DEST" \
    --filter-from "$FILTERFILE" \
    --sftp-key-file "$KEY" \
    --no-check-dest \
    --sftp-disable-hashcheck \
    --log-level INFO \
    --log-file "$LOG"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') === Done ===" >> "$LOG"
