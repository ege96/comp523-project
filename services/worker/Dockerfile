FROM python:3.12-slim

# FFmpeg is needed for media processing (handoff §2).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PATH=/opt/venv/bin:$PATH

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

# OpenShift runs containers as an arbitrary UID in group 0.
RUN chgrp -R 0 /app /opt/venv && chmod -R g=u /app /opt/venv
USER 1001
CMD ["python", "-m", "swayambhu_worker"]
