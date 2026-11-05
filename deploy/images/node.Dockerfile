# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
RUN mkdir /workspace && chown 1000:1000 /workspace
COPY deploy/images/runner.mjs /opt/sazuz/runner.mjs
COPY deploy/images/relay.mjs /opt/sazuz/relay.mjs
USER 1000:1000
WORKDIR /workspace
CMD ["node", "--version"]
