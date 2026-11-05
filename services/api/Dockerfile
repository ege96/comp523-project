# syntax=docker/dockerfile:1.7
# Image tags are written out in full (no ARGs) so Dependabot can read and bump them.
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

# ---- model: the local embedding model (EMBEDDING_PROVIDER=local), baked in so pods never
# download it. Lands in /opt/models/<EMBEDDING_MODEL> (LOCAL_MODEL_DIR's default). Build
# with --build-arg EMBEDDING_MODEL= to leave it out. Pin the revision to a commit once
# the model is settled; verify the repo still ships onnx/model.onnx.
FROM python:3.12-slim AS model
ARG EMBEDDING_MODEL=intfloat/multilingual-e5-small
ARG EMBEDDING_MODEL_REVISION=main
# Moves the weights to model.onnx.data, which ONNX Runtime memory-maps (about half the
# memory, no load spike). Keep the onnxruntime pin equal to the version in uv.lock.
# Uses pip, not uv, so the weekly uv bump doesn't invalidate this stage and download
# the model again; it only reruns when the pins, the model or prepare_model.py change.
COPY packages/providers/src/swayambhu_providers/prepare_model.py /tmp/prepare_model.py
RUN mkdir -p /opt/models && if [ -n "$EMBEDDING_MODEL" ]; then \
        python -m venv /tmp/tools \
        && /tmp/tools/bin/pip install --no-cache-dir --disable-pip-version-check \
            huggingface-hub==2.2.0 onnxruntime==1.31.0 \
        && /tmp/tools/bin/hf download "$EMBEDDING_MODEL" \
            onnx/model.onnx tokenizer.json --revision "$EMBEDDING_MODEL_REVISION" \
            --local-dir "/opt/models/$EMBEDDING_MODEL" \
        && /tmp/tools/bin/python /tmp/prepare_model.py "/opt/models/$EMBEDDING_MODEL" \
        && rm -rf "/opt/models/$EMBEDDING_MODEL/.cache" /root/.cache /tmp/tools; \
    fi

# ---- deps: third-party dependencies only, in /opt/venv ----
FROM python:3.12-slim AS deps
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

# ---- build: the shared packages and the app, installed non-editable so the runtime
# image needs no source tree. Our own packages are then staged on their own, so the
# runtime image gets them as a small layer on top of the (much larger) deps layer, and a
# code-only change doesn't produce a new copy of every dependency.
FROM deps AS build
COPY packages/core /app/packages/core
COPY packages/providers /app/packages/providers
COPY services/api/pyproject.toml services/api/uv.lock ./
COPY services/api/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable \
    && site=$(/opt/venv/bin/python -c 'import sysconfig; print(sysconfig.get_path("purelib"))') \
    && mkdir -p "/stage$site" \
    && cp -a "$site"/swayambhu_* "/stage$site/"

# ---- runtime: just Python and the venv (no uv, no build files) ----
FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1
# The model changes less often than the code, so its layer comes first.
COPY --from=model /opt/models /opt/models
# Files are world-readable, so OpenShift's arbitrary UID (group 0) can run them.
# No chmod/chgrp pass: that would copy the whole venv into a second layer.
COPY --from=deps /opt/venv /opt/venv
COPY --from=build /stage/ /
# Only the OpenShift router (via the Service) can reach the pod, so trust its
# X-Forwarded-For for client IPs. Override per environment if that ever changes.
ENV FORWARDED_ALLOW_IPS="*"
COPY services/api/start.sh /opt/start.sh
USER 1001
EXPOSE 8080
CMD ["sh", "/opt/start.sh"]
