#!/bin/sh
# Container entrypoint (runs under tini). `dsgvo-check seccomp-profile` prints the seccomp profile that lets the
# Chromium sandbox start without --privileged or CAP_SYS_ADMIN; everything else goes to the CLI.
set -eu

if [ "${1:-}" = "seccomp-profile" ]; then
  exec cat /etc/dsgvo-check/seccomp.json
fi

exec node /app/dist/cli.js "$@"
