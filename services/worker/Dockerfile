# syntax=docker/dockerfile:1.7
# Image tags are written out in full (no ARGs) so Dependabot can read and bump them.
FROM ghcr.io/astral-sh/uv:0.11.32 AS uv
FROM mwader/static-ffmpeg:9.0.2 AS ffmpeg

# ---- build: resolve and install dependencies into /opt/venv ----
FROM python:3.12-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app

# Dependencies only. This layer is reused until pyproject.toml or uv.lock changes,
# and the cache mount keeps downloaded wheels between builds.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    uv sync --frozen --no-dev --no-install-project

# Then the app itself, installed non-editable so the runtime image needs no source tree.
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# ---- runtime: just Python, FFmpeg and the venv (no uv, no build files) ----
FROM python:3.12-slim
# Two static FFmpeg/FFprobe binaries instead of apt's ffmpeg, which pulls in
# hundreds of MB of shared libraries. GPL build; fine for this project, revisit if relicensing.
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1
# Files are world-readable, so OpenShift's arbitrary UID (group 0) can run them.
# No chmod/chgrp pass: that would copy the whole venv into a second layer.
COPY --from=build /opt/venv /opt/venv
USER 1001
CMD ["python", "-m", "swayambhu_worker"]
