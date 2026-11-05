# syntax=docker/dockerfile:1
FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ARG ENGINE
RUN apt-get update && apt-get install --no-install-recommends -y libgomp1 libespeak-ng1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home voice
COPY deploy/voice/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r /app/requirements.lock
COPY deploy/voice/models.json /app/models.json
COPY packages/llm/voice /app/
RUN python /app/download_models.py --manifest /app/models.json --destination /models --engine "$ENGINE" \
    && chmod -R a-w /models
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 DO_NOT_TRACK=1 TOKENIZERS_PARALLELISM=false
USER 1000:1000
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3).read()"
