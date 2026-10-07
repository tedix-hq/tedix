#!/bin/sh
set -eu

BASE_URL="${TEDIX_CLI_BASE_URL:-https://downloads.tedix.dev}"
INSTALL_DIR="${TEDIX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${TEDIX_CLI_VERSION:-}"
CHANNEL="${TEDIX_CLI_CHANNEL:-stable}"
RETRY_DELAY_SECONDS="${TEDIX_CLI_RETRY_DELAY_SECONDS:-1}"

# `curl -fsSL https://downloads.tedix.dev/install.sh | sh -s -- --channel beta`
while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL=${2:-}; shift 2 2>/dev/null || shift ;;
    --channel=*) CHANNEL=${1#--channel=}; shift ;;
    *) echo "Unknown installer option: $1" >&2; exit 1 ;;
  esac
done
case "$CHANNEL" in
  stable) POINTER=latest.json ;;
  beta) POINTER=beta.json ;;
  *) echo "Unknown Tedix CLI channel: $CHANNEL (use stable or beta)" >&2; exit 1 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "The Tedix CLI installer requires curl" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

download() {
  url=$1
  output=$2
  cache_control=${3:-}
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if [ "$cache_control" = "no-cache" ]; then
      if curl -fsSL --connect-timeout 15 -H 'Cache-Control: no-cache' "$url" -o "$output"; then
        return 0
      fi
    elif curl -fsSL --connect-timeout 15 "$url" -o "$output"; then
      return 0
    fi
    if [ "$attempt" -ge 3 ]; then
      echo "Could not download $url after $attempt attempts" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    echo "Download failed; retrying ($attempt/3): $url" >&2
    sleep "$RETRY_DELAY_SECONDS"
  done
}

if [ -z "$VERSION" ]; then
  LATEST_CACHE_BUST=$(date +%s)
  if ! download "$BASE_URL/$POINTER?t=$LATEST_CACHE_BUST" "$TMP_DIR/latest.json" no-cache; then
    echo "Could not resolve the latest Tedix CLI release ($CHANNEL channel)" >&2
    exit 1
  fi
  VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/latest.json")
fi
if [ -z "$VERSION" ]; then
  echo "Could not resolve the latest Tedix CLI release" >&2
  exit 1
fi
case "$VERSION" in
  *[!0-9A-Za-z.+-]*)
    echo "Invalid Tedix CLI release version: $VERSION" >&2
    exit 1
    ;;
esac

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="tedix-$VERSION-$OS-$ARCH"
BASE="$BASE_URL/releases/$VERSION"
if ! mkdir -p "$INSTALL_DIR"; then
  echo "Could not create the Tedix CLI install directory: $INSTALL_DIR" >&2
  exit 1
fi
if [ ! -d "$INSTALL_DIR" ] || [ ! -w "$INSTALL_DIR" ]; then
  echo "The Tedix CLI install directory is not writable: $INSTALL_DIR" >&2
  if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
    echo "If it was created with sudo, restore your ownership with:" >&2
    echo "  sudo chown \"$(id -un)\" \"$INSTALL_DIR\"" >&2
  fi
  echo "Otherwise, choose a writable directory by passing TEDIX_INSTALL_DIR to sh." >&2
  exit 1
fi

download "$BASE/$ASSET" "$TMP_DIR/$ASSET"
download "$BASE/SHA256SUMS" "$TMP_DIR/SHA256SUMS"
if ! LC_ALL=C awk -v asset="$ASSET" '
  $2 == asset || $2 == "*" asset {
    count++
    if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-fA-F]/) invalid = 1
    hash = $1
  }
  END {
    if (count != 1 || invalid) exit 1
    print hash "  " asset
  }
' "$TMP_DIR/SHA256SUMS" > "$TMP_DIR/selected-checksum"; then
  echo "Expected exactly one valid checksum for $ASSET" >&2
  exit 1
fi
(
  cd "$TMP_DIR"
  if command -v shasum >/dev/null 2>&1; then
    LC_ALL=C shasum -a 256 -c selected-checksum
  elif command -v sha256sum >/dev/null 2>&1; then
    LC_ALL=C sha256sum -c selected-checksum
  else
    echo "The Tedix CLI installer requires shasum or sha256sum" >&2
    exit 1
  fi
)
install -m 755 "$TMP_DIR/$ASSET" "$INSTALL_DIR/tedix"
echo "Installed tedix $VERSION to $INSTALL_DIR/tedix"

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) exit 0 ;;
esac

QUOTED_INSTALL_DIR=$(printf '%s' "$INSTALL_DIR" | sed "s/'/'\\\\''/g")
EXPORT_LINE="export PATH='$QUOTED_INSTALL_DIR':\"\$PATH\""
case "${SHELL:-}" in
  */fish)
    PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
    QUOTED_INSTALL_DIR=$(printf '%s' "$INSTALL_DIR" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")
    EXPORT_LINE="fish_add_path '$QUOTED_INSTALL_DIR'"
    ;;
  */bash)
    if [ -f "$HOME/.bash_profile" ]; then
      PROFILE="$HOME/.bash_profile"
    else
      PROFILE="$HOME/.bashrc"
    fi
    ;;
  */zsh) PROFILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
  *) PROFILE="" ;;
esac

echo ""
echo "$INSTALL_DIR is not on your PATH, so 'tedix' is not runnable yet."

if [ -z "$PROFILE" ] || [ "${TEDIX_NO_MODIFY_PATH:-}" = "1" ]; then
  echo "Add this line to your shell profile, then open a new terminal:"
  echo ""
  printf '  %s\n' "$EXPORT_LINE"
  exit 0
fi

if [ -f "$PROFILE" ] && grep -Fqx "$EXPORT_LINE" "$PROFILE"; then
  echo "$PROFILE already adds it. Open a new terminal, then run: tedix --version"
  exit 0
fi

if mkdir -p "$(dirname "$PROFILE")" 2>/dev/null &&
  printf '\n# Added by the Tedix CLI installer\n%s\n' "$EXPORT_LINE" >>"$PROFILE" 2>/dev/null; then
  echo "Added it to $PROFILE."
  echo "Open a new terminal, then run: tedix --version"
  echo ""
  echo "To use tedix in this terminal without reopening it, run:"
  echo ""
  printf '  %s\n' "$EXPORT_LINE"
else
  echo "Could not update $PROFILE. Add this line to your shell profile yourself,"
  echo "then open a new terminal:"
  echo ""
  printf '  %s\n' "$EXPORT_LINE"
fi
