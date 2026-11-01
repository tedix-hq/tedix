ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools
FROM docker.io/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun-binary

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN ln -s bun /usr/local/bin/bunx && test "$(bun --version)" = "1.4.4" && node --version
COPY templates/ /workspace-templates/
# Tenant workspaces are standalone copies: bake canonical shared source links as bytes.
RUN cp -aL /workspace-templates /workspace-templates-materialized && rm -rf /workspace-templates && mv /workspace-templates-materialized /workspace-templates
WORKDIR /workspace
COPY templates/tedix/package.json templates/tedix/bun.lock* ./
COPY templates/tedix/patches/ ./patches/
RUN bun install
COPY templates/tedix/ ./
CMD ["sleep", "infinity"]
