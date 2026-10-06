#!/bin/sh
set -eu

# Cloudflare's HTTPS outbound interception terminates TLS with a per-container
# CA mounted at runtime. Compose that CA with the normal system trust bundle and
# export the standard client hooks before either process starts. This keeps Git,
# curl, Node/Bun, npm, and Python verification enabled while allowing the
# governed egress proxy to inspect HTTPS traffic.
cloudflare_ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ "${SANDBOX_INTERCEPT_HTTPS:-}" = "1" ]; then
	attempt=0
	while [ ! -r "$cloudflare_ca" ] && [ "$attempt" -lt 50 ]; do
		sleep 0.1
		attempt=$((attempt + 1))
	done
	if [ ! -r "$cloudflare_ca" ]; then
		echo "[entrypoint] HTTPS interception CA did not arrive" >&2
		exit 1
	fi
fi
if [ -r "$cloudflare_ca" ]; then
	combined_ca=/tmp/tedix-cloudflare-containers-ca-bundle.crt
	cp /etc/ssl/certs/ca-certificates.crt "$combined_ca"
	cat "$cloudflare_ca" >> "$combined_ca"
	export CURL_CA_BUNDLE="$combined_ca"
	export GIT_SSL_CAINFO="$combined_ca"
	export NODE_EXTRA_CA_CERTS="$cloudflare_ca"
	export REQUESTS_CA_BUNDLE="$combined_ca"
	export SSL_CERT_FILE="$combined_ca"
fi

exec sleep infinity
