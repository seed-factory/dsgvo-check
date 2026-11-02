#!/bin/sh
# Prints the Chromium sandbox profile or starts the CLI under tini.
set -eu

if [ "${1:-}" = "seccomp-profile" ]; then
  exec cat /etc/dsgvo-check/seccomp.json
fi

exec node /app/dist/cli.js "$@"
