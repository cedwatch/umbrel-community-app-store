FROM php:8.1-fpm-alpine

# Install nginx + gettext (envsubst)
RUN apk add --no-cache nginx gettext

# PHP: enable allow_url_fopen + set temp dir writable
RUN echo "allow_url_fopen = On" >> /usr/local/etc/php/php.ini && \
    echo "upload_max_filesize = 8M" >> /usr/local/etc/php/php.ini

# nginx config
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/php-fpm.conf /usr/local/etc/php-fpm.conf

# App files
COPY app/ /var/www/html/

# Permissions
RUN chown -R www-data:www-data /var/www/html && \
    chmod -R 755 /var/www/html

# /tmp writable for PHP cache (pulse, ohlc, etf, mining)
RUN chmod 1777 /tmp

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
