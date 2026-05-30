# Stage 1: grab rclone binary from official image
FROM rclone/rclone:latest AS rclone

# Stage 2: main image
FROM php:8.1-fpm-alpine

# Install nginx, crond, openssh-client
RUN apk add --no-cache nginx openssh-client tzdata unzip

# Copy rclone binary from official image — arch-correct, no wget needed
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
RUN chmod 755 /usr/local/bin/rclone

# PHP config
RUN echo "allow_url_fopen = On" >> /usr/local/etc/php/php.ini \
    && echo "file_uploads = On" >> /usr/local/etc/php/php.ini \
    && echo "upload_max_filesize = 4M" >> /usr/local/etc/php/php.ini \
    && echo "post_max_size = 4M" >> /usr/local/etc/php/php.ini

# nginx + php-fpm configs
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/php-fpm.conf /usr/local/etc/php-fpm.conf

# App files
COPY app/ /var/www/html/
RUN chown -R www-data:www-data /var/www/html \
    && chmod -R 755 /var/www/html

# Backup script
COPY docker/rclone-backup.sh /usr/local/bin/rclone-backup.sh
RUN chmod +x /usr/local/bin/rclone-backup.sh

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
