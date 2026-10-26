#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_dir=${TEDIX_INSTALL_DIR:-"$HOME/.local/bin"}
installer=$(mktemp "${TMPDIR:-/tmp}/tedix-install.XXXXXX")
trap 'rm -f "$installer"' EXIT HUP INT TERM

curl -fsSL https://downloads.tedix.dev/install.sh >"$installer"
TEDIX_INSTALL_DIR="$install_dir" sh "$installer"
export PATH="$install_dir:$PATH"

if ! command -v bun >/dev/null 2>&1; then
	echo "Repository bootstrap requires Bun on PATH." >&2
	exit 1
fi

cd "$repo_root"
bun install --frozen-lockfile

tedix --version
tedix -w "${TEDIX_WORKSPACE:-cloud}" auth status
