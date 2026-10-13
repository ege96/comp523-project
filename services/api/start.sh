#!/bin/sh
# Container entrypoint: bring the database schema up to date, then serve.
# A failed migration exits non-zero, so the pod never becomes ready and OpenShift keeps the
# previous pod serving. Set RUN_MIGRATIONS=0 to skip (CI smoke test, which has no database).
set -e
if [ "${RUN_MIGRATIONS:-1}" != "0" ]; then
    python -m swayambhu_api.migrate upgrade head
fi
exec uvicorn swayambhu_api.main:app --host 0.0.0.0 --port 8080 --proxy-headers
