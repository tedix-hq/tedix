#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${1:-tedix-docs-nimbus-015-contract}"

docker build --platform linux/amd64 -t "$image" "$app_dir"
docker run --rm --entrypoint bash \
	-v "$app_dir/test-fixtures/nimbus-015:/fixture:ro" \
	"$image" -lc '
set -euo pipefail
workspace=/tmp/nimbus-contract
mkdir -p "$workspace"
cd /opt/tedix-docs-template
tar --exclude="./node_modules" -cf - . | tar -xf - -C "$workspace"
ln -s /opt/tedix-docs-template/node_modules "$workspace/node_modules"
rm -rf "$workspace/src/content/docs"
mkdir -p "$workspace/src/content/docs" "$workspace/.tedix"
cp -R /fixture/content/. "$workspace/src/content/docs/"
cp /fixture/docs-provenance.json "$workspace/.tedix/docs-provenance.json"
cd "$workspace"
export TEDIX_DOCS_SITE_SLUG=customer-handbook
export TEDIX_DOCS_SITE_URL=https://customer-handbook.docs.tedix.dev
export TEDIX_DOCS_ENTRY_PATH=/index
export TEDIX_DOCS_TITLE="Customer Handbook"
export TEDIX_DOCS_DESCRIPTION="Nimbus image contract fixture"
export TEDIX_DOCS_LOCALE=en
export TEDIX_DOCS_REPOSITORY_URL=""
bun x astro check
build_output="$(bun run build 2>&1)"
printf "%s\n" "$build_output"
if grep -Fq "conflicts with higher priority route \`/\`" <<<"$build_output"; then
	echo "Nimbus emitted a duplicate root route" >&2
	exit 1
fi
test -f dist/index.html
test -f dist/guides/visible/index.html
test -f dist/guides/hidden/index.html
test -f dist/guides/visible/index.md
test -f dist/guides/hidden/index.md
test -f dist/guides/hidden/index.mdx
test -d dist/pagefind
grep -Fq "Return to [home](/index)" dist/guides/visible/index.md
if grep -R -Fq "TEDIX_HIDDEN_SENTINEL_9537" dist/llms.txt dist/llms-full.txt dist/pagefind; then
	echo "noindex content leaked into an agent or search index" >&2
	exit 1
fi
grep -Fq "<lastmod>2026-09-20T12:00:00.000Z</lastmod>" dist/sitemap-0.xml
grep -Fq "<lastmod>2026-09-21T12:00:00.000Z</lastmod>" dist/sitemap-0.xml
if grep -Fq "/guides/hidden" dist/sitemap-0.xml; then
	echo "noindex page leaked into sitemap" >&2
	exit 1
fi
echo "Nimbus image contract passed"
'
