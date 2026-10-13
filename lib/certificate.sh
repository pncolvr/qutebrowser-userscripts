#!/usr/bin/env bash

URL="$1"

HOST=$(echo "$URL" | sed -E 's#https?://([^/]+).*#\1#')
CERT=$(echo | openssl s_client -connect "${HOST}:443" -servername "$HOST" 2>/dev/null | openssl x509 -noout -text)

if [[ -z "$CERT" ]]; then
    echo "Failed to fetch certificate for $HOST"
    exit 1
fi

echo -e "\e[1;32m=== SSL Certificate Info for $HOST ===\e[0m"
echo "$CERT" | awk '
/Subject:/ {print "\033[1;33m" $0 "\033[0m"}
/Issuer:/ {print "\033[1;34m" $0 "\033[0m"}
/Not Before:/ {print "\033[1;35m" $0 "\033[0m"}
/Not After :/ {print "\033[1;35m" $0 "\033[0m"}
/SHA256 Fingerprint:/ {print "\033[1;36m" $0 "\033[0m"}
'
echo -e "\e[1;32m====================================\e[0m"