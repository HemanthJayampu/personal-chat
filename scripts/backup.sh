#!/usr/bin/env bash
# NFR-6 / section 10: weekly database backup to this laptop.
#
# Get the connection string from Supabase -> Connect -> "Session pooler"
# (it contains your database password, so keep it out of Git):
#
#   export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
#   ./scripts/backup.sh
#
# Needs pg_dump with the same major version as your project's Postgres
# (Project Settings -> Infrastructure), e.g. `brew install postgresql@17`.
# Stored files are not included; they're temporary (30 days) by design.
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL first (see the comment at the top of this script).}"

dir="${BACKUP_DIR:-$HOME/personal-chat-backups}"
mkdir -p "$dir"
chmod 700 "$dir"
out="$dir/personal-chat-$(date +%Y-%m-%d).dump"

# public: profiles, conversations, messages, files, invites, audit log
# auth:   accounts, password hashes and 2FA factors (needed to restore logins)
pg_dump "$SUPABASE_DB_URL" \
  --schema=public --schema=auth \
  --no-owner --no-privileges \
  --format=custom --file="$out"

chmod 600 "$out"
echo "Backup written to $out ($(du -h "$out" | cut -f1))"

# Keep the last 8 weekly backups.
ls -1t "$dir"/personal-chat-*.dump 2>/dev/null | tail -n +9 | while read -r old; do rm -- "$old"; done
