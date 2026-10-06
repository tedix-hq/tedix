ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g --force bun@1.4.2 \
	&& test "$(bun --version)" = "1.4.2" \
	&& test -s /etc/ssl/certs/ca-certificates.crt \
	&& node --version \
	&& git --version

# Nimbus' versioned scaffolder fetches an immutable template tag matching the
# CLI version. The renderer is pinned here so every tenant build uses the same
# certified framework until Tedix deliberately upgrades the image.
WORKDIR /opt
RUN bun x @cloudflare/create-nimbus-docs@0.7.7 \
	tedix-docs-template \
	--yes \
	--deploy other \
	--content empty \
	--package-manager bun \
	--no-git \
	--skip-install

WORKDIR /opt/tedix-docs-template
RUN bun add @cloudflare/nimbus-docs@0.15.0 --exact

COPY template/astro.config.ts /opt/tedix-docs-template/astro.config.ts
COPY template/docs-navigation.ts /opt/tedix-docs-template/docs-navigation.ts
COPY template/content.config.ts /opt/tedix-docs-template/src/content.config.ts
COPY template/index.mdx /opt/tedix-docs-template/src/content/docs/index.mdx
COPY template/index.astro /opt/tedix-docs-template/src/pages/index.astro
COPY template/Header.astro /opt/tedix-docs-template/src/components/Header.astro
COPY template/AgentPageHandoff.astro /opt/tedix-docs-template/src/components/AgentPageHandoff.astro
COPY template/CatalogGrid.astro /opt/tedix-docs-template/src/components/CatalogGrid.astro
COPY template/HubLinks.astro /opt/tedix-docs-template/src/components/HubLinks.astro
COPY template/HubLayout.astro /opt/tedix-docs-template/src/layouts/HubLayout.astro
COPY template/docs-hubs.ts /opt/tedix-docs-template/src/lib/docs-hubs.ts
COPY template/docs-navigation.ts /opt/tedix-docs-template/src/lib/docs-navigation.ts
COPY template/src/lib/docs-provenance.ts /opt/tedix-docs-template/src/lib/docs-provenance.ts
COPY template/src/lib/sitemap-last-updated.ts /opt/tedix-docs-template/src/lib/sitemap-last-updated.ts
COPY template/clipboard.ts /opt/tedix-docs-template/src/lib/clipboard.ts
COPY template/agent-page-handoff.ts /opt/tedix-docs-template/src/lib/agent-page-handoff.ts
COPY template/directory.astro /opt/tedix-docs-template/src/pages/directory.astro
COPY template/resources.astro /opt/tedix-docs-template/src/pages/resources.astro
COPY template/updates.astro /opt/tedix-docs-template/src/pages/updates.astro
COPY template/updates-rss.xml.ts /opt/tedix-docs-template/src/pages/updates/rss.xml.ts
COPY template/agent-setup.astro /opt/tedix-docs-template/src/pages/agent-setup.astro
COPY template/tedix-theme.css /opt/tedix-docs-template/src/styles/tedix-theme.css

WORKDIR /workspace
CMD ["sleep", "infinity"]

COPY template/DocsLayout.astro /opt/tedix-docs-template/src/layouts/DocsLayout.astro
COPY template/page-markdown.ts /opt/tedix-docs-template/src/pages/[...slug]/index.md.ts
COPY template/page.astro /opt/tedix-docs-template/src/pages/[...slug].astro
COPY template/page-paths.ts /opt/tedix-docs-template/src/lib/page-paths.ts
