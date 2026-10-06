ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install -g --force bun@1.4.2 && test "$(bun --version)" = "1.4.2" && node --version
COPY templates/ /workspace-templates/
# Tenant workspaces are standalone copies: bake canonical shared source links as bytes.
RUN cp -aL /workspace-templates /workspace-templates-materialized && rm -rf /workspace-templates && mv /workspace-templates-materialized /workspace-templates
WORKDIR /workspace
COPY templates/tedix/package.json templates/tedix/bun.lock* ./
COPY templates/tedix/patches/ ./patches/
RUN bun install
COPY templates/tedix/ ./
CMD ["sleep", "infinity"]
