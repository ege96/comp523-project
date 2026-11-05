# syntax=docker/dockerfile:1.7
# Image tags are written out in full (no ARGs) so Dependabot can read and bump them.
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

# ---- model: the local embedding model (EMBEDDING_PROVIDER=local), baked in so pods never
# download it. Lands in /opt/models/<EMBEDDING_MODEL> (LOCAL_MODEL_DIR's default). Build
# with --build-arg EMBEDDING_MODEL= to leave it out. Pin the revision to a commit once
# the model is settled; verify the repo still ships onnx/model.onnx.
FROM python:3.12-slim AS model
COPY --from=uv /uv /usr/local/bin/uv
ARG EMBEDDING_MODEL=intfloat/multilingual-e5-small
ARG EMBEDDING_MODEL_REVISION=main
# Moves the weights to model.onnx.data, which ONNX Runtime memory-maps (about half the
# memory, no load spike). Keep the onnxruntime pin equal to the version in uv.lock.
COPY packages/providers/src/swayambhu_providers/prepare_model.py /tmp/prepare_model.py
RUN mkdir -p /opt/models && if [ -n "$EMBEDDING_MODEL" ]; then \
        uv tool run --from huggingface-hub==2.2.0 hf download "$EMBEDDING_MODEL" \
            onnx/model.onnx tokenizer.json --revision "$EMBEDDING_MODEL_REVISION" \
            --local-dir "/opt/models/$EMBEDDING_MODEL" \
        && uv run --no-project --with onnxruntime==1.31.0 python /tmp/prepare_model.py \
            "/opt/models/$EMBEDDING_MODEL" \
        && rm -rf "/opt/models/$EMBEDDING_MODEL/.cache" /root/.cache; \
    fi

# ---- build: resolve and install dependencies into /opt/venv ----
FROM python:3.12-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/opt/venv
# Build context is the repo root (so packages/ is reachable); see .dockerignore.
WORKDIR /app/services/api

# Third-party dependencies only. This layer is reused until pyproject.toml or uv.lock
# changes, and the cache mount keeps downloaded wheels between builds.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=services/api/pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=services/api/uv.lock,target=uv.lock \
    uv sync --frozen --no-dev --no-install-project --no-install-local

# Then the shared packages and the app, installed non-editable so the runtime
# image needs no source tree.
COPY packages/core /app/packages/core
COPY packages/providers /app/packages/providers
COPY services/api/pyproject.toml services/api/uv.lock ./
COPY services/api/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# ---- runtime: just Python and the venv (no uv, no build files) ----
FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1
# The model changes less often than the code, so its layer comes first.
COPY --from=model /opt/models /opt/models
# Files are world-readable, so OpenShift's arbitrary UID (group 0) can run them.
# No chmod/chgrp pass: that would copy the whole venv into a second layer.
COPY --from=build /opt/venv /opt/venv
# Only the OpenShift router (via the Service) can reach the pod, so trust its
# X-Forwarded-For for client IPs. Override per environment if that ever changes.
ENV FORWARDED_ALLOW_IPS="*"
COPY services/api/start.sh /opt/start.sh
# Media volume mount point, writable by group 0 like the worker's, whichever container
# first fills a fresh compose volume.
RUN mkdir -p /data/media && chgrp 0 /data/media && chmod 2775 /data/media
USER 1001
EXPOSE 8080
CMD ["sh", "/opt/start.sh"]
