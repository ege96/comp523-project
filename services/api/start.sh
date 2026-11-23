#!/bin/sh
# Container entrypoint: bring the database schema up to date, then serve.
# A failed migration exits before serving; with the Recreate strategy the old pod is already
# stopped, so the API stays down until the previous image is redeployed or the migration is fixed. RUN_MIGRATIONS=0 skips startup migration.
set -e
if [ "${RUN_MIGRATIONS:-1}" != "0" ]; then
    python -m swayambhu_api.migrate upgrade head
fi
# Keep idle connections open longer than uvicorn's 5 s default, so a browser that pauses
# between requests reuses its connection instead of opening a new one (TCP + TLS each time).
exec uvicorn swayambhu_api.main:app --host 0.0.0.0 --port 8080 --proxy-headers \
    --timeout-graceful-shutdown 10 --timeout-keep-alive 65
