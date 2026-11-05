# syntax=docker/dockerfile:1
FROM python:3.13-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f
RUN pip install --no-cache-dir pandas==3.1.0 matplotlib==3.11.2 \
    && useradd --uid 1000 --create-home sandbox \
    && mkdir /workspace && chown 1000:1000 /workspace
COPY deploy/images/runner.py /opt/sazuz/runner.py
COPY deploy/images/relay.py /opt/sazuz/relay.py
USER 1000:1000
WORKDIR /workspace
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLCONFIGDIR=/tmp/mpl
CMD ["python", "--version"]
