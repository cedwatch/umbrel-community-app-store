#!/bin/sh
set -e

# Ensure /tmp is writable (for PHP cache files: bb_pulse, bb_ohlc_*, bb_etf_flows, etc.)
chmod 1777 /tmp

# Start PHP-FPM in background
php-fpm -D

# Wait for socket to be ready
sleep 1

# Handoff to nginx (foreground)
exec nginx -g "daemon off;"
