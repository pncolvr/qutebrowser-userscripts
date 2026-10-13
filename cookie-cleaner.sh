#!/usr/bin/env bash

BASE="$HOME/.local/share"

PROFILE=$(find "$BASE" -maxdepth 1 -type d -name "qutebrowser*" -printf "%f\n" | fzf --prompt="Select qutebrowser profile: ")

if [ -z "$PROFILE" ]; then
    echo "No profile selected."
    exit 1
fi

PROFILE_PATH="$BASE/$PROFILE"

CANDIDATE1="$PROFILE_PATH/webengine/Cookies"
CANDIDATE2="$PROFILE_PATH/data/webengine/Cookies"

if [ -f "$CANDIDATE1" ]; then
    DB="$CANDIDATE1"
elif [ -f "$CANDIDATE2" ]; then
    DB="$CANDIDATE2"
else
    echo "Error: Cookies DB not found for profile $PROFILE"
    exit 1
fi

echo "Using Cookies DB: $DB"

if pgrep qutebrowser >/dev/null; then
    echo "Please close qutebrowser before continuing."
    exit 1
fi

BACKUP="${DB}.bak_$(date +%Y%m%d_%H%M%S)"
cp "$DB" "$BACKUP"
echo "Backup created at: $BACKUP"

HOST=$(sqlite3 "$DB" "SELECT DISTINCT host_key FROM cookies ORDER BY host_key;" | fzf --prompt="Select host_key to delete: ")

if [ -z "$HOST" ]; then
    echo "No host selected."
    exit 1
fi

echo "Deleting cookies for host_key = '$HOST' ..."

sqlite3 "$DB" "DELETE FROM cookies WHERE host_key = '$HOST';"

echo "Done."
echo "All cookies for '$HOST' have been deleted."
