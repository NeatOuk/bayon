#!/bin/sh
# The one-shot before api and supervisor start: an encrypted
# backup of an existing DB (frm backup, its key from /run/secrets), then the migrations. It refuses
# while a supervisor lock is present: deploy/bayon.sh stops the writers first, and clears a lock a
# crash left only after `docker compose ps` shows no supervisor running. No key, no migration.
set -eu
: "${FRM_HOME:?FRM_HOME is not set}"
if [ -e "$FRM_HOME/supervisor.lock" ]; then
  echo "migrate: $FRM_HOME/supervisor.lock exists: stop the supervisor first (deploy/bayon.sh upgrade does)" >&2
  exit 1
fi
if [ -e "$FRM_HOME/foreman.db" ]; then
  node /opt/bayon/tools/frm/dist/main.js backup
fi
exec node /opt/bayon/packages/db/dist/cli.js up
