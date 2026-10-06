ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# The v1 package launches this helper for every Files and DirectoryBackup
# operation. Keep its presence executable as a build-time image contract so a
# stale or incompatible tools image cannot reach production as a broken body.
RUN chmod 755 /usr/local/bin/sandbox-shim \
	&& test -x /usr/local/bin/sandbox-shim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git gnupg python3 ffmpeg build-essential util-linux ripgrep tini \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && git --version \
    && gh --version \
    && node --version \
    && npm --version \
    && npm install -g bun@1.4.2 \
    && test "$(bun --version)" = "1.4.2"

# Compose runtime TLS trust before starting the native Sandbox server.
COPY computer-entrypoint.sh /usr/local/bin/tedix-workstation-entrypoint
RUN chmod 755 /usr/local/bin/tedix-workstation-entrypoint

ENV HOME=/home/tedi
ENV TEDIX_WORKSTATION_HOME=/home/tedi
ENV TEDIX_WORKSTATION_DIR=/home/tedi/workstation
ENV TEDIX_WORKSTATION_REPOS_DIR=/home/tedi/workstation/repos
ENV GH_PROMPT_DISABLED=1
ENV GCM_INTERACTIVE=Never
ENV GIT_ASKPASS=/bin/false
ENV GIT_TERMINAL_PROMPT=0
ENV BUN_INSTALL_CACHE_DIR=/home/tedi/workstation/cache/package-managers/bun

RUN mkdir -p /home/tedi/.config/gh \
    && mkdir -p /workspace/repos \
    && rm -rf /home/tedi/workstation \
    && ln -s /workspace /home/tedi/workstation \
    && chmod -R a+rX /home/tedi

WORKDIR /home/tedi/workstation

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tedix-workstation-entrypoint"]
