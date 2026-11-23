#!/bin/sh
# OmniGateway installer: https://github.com/harismawan/omnigateway
#
#   curl -fsSL https://raw.githubusercontent.com/harismawan/omnigateway/main/install.sh | sh
#
# Installs the release binary (default, no Node needed) or the npm package,
# writes a new .env, migrates the database, sets an admin password, installs a
# service and waits for /health. Re-running on an installed machine upgrades it.
#
# Flags:
#   --version <tag>     release to install (default: latest)
#   --method binary|npm how to install (default: binary)
#   --root <dir>        installation root (default: ~/.config/omnigateway)
#   --port <n>          port for a new .env (default: 9000)
#   --base-url <url>    OMNI_BASE_URL for a new .env (asked otherwise)
#   --no-service        install and set up, but no service and no start
#   --yes               no prompts; fail instead of asking
#
# OMNI_ADMIN_PASSWORD supplies the admin password without a prompt.
#
# Test-only overrides (not for normal use): OMNI_INSTALL_BASE_URL (release
# download base), OMNI_INSTALL_UNAME_S / OMNI_INSTALL_UNAME_M (fake uname),
# OMNI_INSTALL_PUBLIC_IP_URL (public-IP lookup; empty disables it).
#
# Design: docs/superpowers/specs/2026-11-23-install-script-design.md

set -eu

# The release workflow stamps the tag here when attaching this file to a
# release; the committed file installs the latest release.
DEFAULT_VERSION=latest

# Everything below lives in main(), called only by the very last line: a
# truncated `curl | sh` download defines nothing and runs nothing.
main() {

RELEASE_BASE_URL=${OMNI_INSTALL_BASE_URL:-https://github.com/harismawan/omnigateway/releases}
PUBLIC_IP_URL=${OMNI_INSTALL_PUBLIC_IP_URL-https://api.ipify.org}

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() { warn "error: $*"; exit 1; }

usage() {
  say "usage: install.sh [flags]"
  say "  --version <tag>     release to install (default: $DEFAULT_VERSION)"
  say "  --method binary|npm how to install (default: binary)"
  say "  --root <dir>        installation root (default: ~/.config/omnigateway)"
  say "  --port <n>          port for a new .env (default: 9000)"
  say "  --base-url <url>    OMNI_BASE_URL for a new .env (asked otherwise)"
  say "  --no-service        install and set up, but no service and no start"
  say "  --yes               no prompts; fail instead of asking"
  say "OMNI_ADMIN_PASSWORD supplies the admin password without a prompt."
}

VERSION=$DEFAULT_VERSION
METHOD_FLAG=
ROOT_FLAG=
PORT_FLAG=
BASEURL_FLAG=
NO_SERVICE=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case $1 in
    --version)
      [ $# -ge 2 ] || die "--version needs a value"
      VERSION=$2; shift 2 ;;
    --method)
      [ $# -ge 2 ] || die "--method needs a value"
      METHOD_FLAG=$2; shift 2 ;;
    --root)
      [ $# -ge 2 ] || die "--root needs a value"
      ROOT_FLAG=$2; shift 2 ;;
    --port)
      [ $# -ge 2 ] || die "--port needs a value"
      PORT_FLAG=$2; shift 2 ;;
    --base-url)
      [ $# -ge 2 ] || die "--base-url needs a value"
      BASEURL_FLAG=$2; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

case ${METHOD_FLAG:-binary} in
  binary|npm) ;;
  *) die "--method must be binary or npm" ;;
esac
if [ -n "$PORT_FLAG" ]; then
  case $PORT_FLAG in
    *[!0-9]*|'') die "--port must be a number" ;;
  esac
fi

# --- tools -----------------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  DOWNLOADER=curl
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER=wget
else
  die "need curl or wget"
fi
command -v tar >/dev/null 2>&1 || die "need tar"
if command -v sha256sum >/dev/null 2>&1; then
  HAVE_SHA256SUM=1
elif command -v shasum >/dev/null 2>&1; then
  HAVE_SHA256SUM=0
else
  die "need sha256sum or shasum"
fi

fetch() {
  if [ "$DOWNLOADER" = curl ]; then
    curl -fsSL -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

sha256_of() {
  if [ "$HAVE_SHA256SUM" = 1 ]; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

have_tty() { (: < /dev/tty) 2>/dev/null; }

# Reads .env like omni-cli context.rs: skip blank/# lines, strip an optional
# `export ` prefix, trim, split on the first =, strip one matching quote pair;
# the last occurrence wins.
env_value() {
  awk -v key="$1" -v sq="'" '
    {
      line = $0
      gsub(/^[ \t\r]+|[ \t\r]+$/, "", line)
      if (line == "" || line ~ /^#/) next
      sub(/^export /, "", line)
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      eq = index(line, "=")
      if (eq == 0) next
      k = substr(line, 1, eq - 1)
      v = substr(line, eq + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", k)
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (k == "") next
      n = length(v)
      if (n >= 2 && ((substr(v, 1, 1) == "\"" && substr(v, n, 1) == "\"") ||
                     (substr(v, 1, 1) == sq && substr(v, n, 1) == sq)))
        v = substr(v, 2, n - 2)
      if (k == key) val = v
    }
    END { print val }
  ' "$2"
}

# --- step 1: detect OS and CPU ----------------------------------------------

OS_RAW=${OMNI_INSTALL_UNAME_S:-$(uname -s)}
ARCH_RAW=${OMNI_INSTALL_UNAME_M:-$(uname -m)}
case $OS_RAW in
  Linux|linux) OS=linux ;;
  Darwin|darwin) OS=darwin ;;
  *) die "unsupported OS '$OS_RAW'. Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64 (no Windows build exists)" ;;
esac
case $ARCH_RAW in
  x86_64|amd64) CPU=x64 ;;
  aarch64|arm64) CPU=arm64 ;;
  *) die "unsupported CPU '$ARCH_RAW'. Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64" ;;
esac
if [ "$OS" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  CPU=arm64
fi

# --- paths ------------------------------------------------------------------

IS_ROOT=0
if [ "$(id -u)" = 0 ]; then
  IS_ROOT=1
fi
if [ "$IS_ROOT" = 1 ]; then
  DATA_DIR=/opt/omnigateway
  BIN_DIR=/usr/local/bin
  UNIT_FILE=/etc/systemd/system/omnigateway.service
else
  DATA_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/omnigateway
  BIN_DIR=$HOME/.local/bin
  # The CLI hardcodes these paths (omni-cli context.rs / service.rs unit);
  # XDG_CONFIG_HOME must not fork the script away from them.
  UNIT_FILE=$HOME/.config/systemd/user/omnigateway.service
fi
DEFAULT_ROOT=$HOME/.config/omnigateway

# --- step 0: find an existing installation ----------------------------------

# Follows symlinks by hand; readlink -f is not portable to older macOS.
resolve_path() {
  rp_path=$1
  rp_hops=0
  while [ -L "$rp_path" ] && [ "$rp_hops" -lt 40 ]; do
    rp_target=$(readlink "$rp_path")
    case $rp_target in
      /*) rp_path=$rp_target ;;
      *) rp_path=$(dirname "$rp_path")/$rp_target ;;
    esac
    rp_hops=$((rp_hops + 1))
  done
  printf '%s\n' "$rp_path"
}

classify_method() {
  case $1 in
    */node_modules/*) printf 'npm\n' ;;
    *) printf 'binary\n' ;;
  esac
}

# The gateway binary only acts as the CLI when argv0 is omni or the first
# argument is omni (omni-gateway main.rs). timeout may not exist (macOS);
# where it does, it caps a hung doctor call.
detect_root() {
  if [ "${ON_PATH##*/}" = omni ]; then
    set -- "$ON_PATH" doctor --json
  else
    set -- "$ON_PATH" omni doctor --json
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 "$@"
  else
    "$@"
  fi
}

FOUND_ROOT=
FOUND_METHOD=
if [ -f "$UNIT_FILE" ]; then
  FOUND_ROOT=$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE" | head -n 1)
  FOUND_METHOD=$(classify_method "$(sed -n 's/^ExecStart=//p' "$UNIT_FILE" | head -n 1)")
elif ON_PATH=$(command -v omni 2>/dev/null || command -v omnigateway 2>/dev/null); then
  FOUND_METHOD=$(classify_method "$(resolve_path "$ON_PATH")")
  FOUND_ROOT=$(detect_root 2>/dev/null \
    | sed -n 's/.*"root"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) || FOUND_ROOT=
fi

UPGRADE=0
if [ -n "$FOUND_ROOT" ] || [ -n "$FOUND_METHOD" ]; then
  UPGRADE=1
fi
if [ -n "$ROOT_FLAG" ]; then
  FOUND_ROOT=$ROOT_FLAG
fi
if [ -n "$METHOD_FLAG" ]; then
  FOUND_METHOD=$METHOD_FLAG
fi
ROOT=${FOUND_ROOT:-$DEFAULT_ROOT}
METHOD=${FOUND_METHOD:-binary}
if [ "$UPGRADE" = 1 ]; then
  say "Found an existing installation (root: $ROOT, method: $METHOD); upgrading it."
fi

# --- resolve the version ----------------------------------------------------

if [ "$VERSION" = latest ]; then
  if [ "$DOWNLOADER" = curl ]; then
    LATEST_URL=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASE_BASE_URL/latest")
  else
    # busybox wget may lack --spider -S; refuse clearly instead of hanging
    # on an empty tag.
    wget --help 2>&1 | grep -q -- '--spider' \
      || die "this wget cannot resolve the latest release tag; pass --version vX.Y.Z or install curl"
    # GNU wget prints the raw Location header and its own "Location: ...
    # [following]" line; keep only the first field of each value so the
    # suffix never leaks into the tag.
    LATEST_URL=$(wget --spider -S "$RELEASE_BASE_URL/latest" 2>&1 \
      | tr -d '\r' | sed -n 's/^[[:space:]]*[Ll]ocation:[[:space:]]*//p' \
      | awk '{print $1}' | tail -n 1)
  fi
  VERSION=${LATEST_URL##*/}
  [ -n "$VERSION" ] || die "could not resolve the latest release tag; pass --version vX.Y.Z or install curl"
fi
case $VERSION in
  v[0-9]*[!A-Za-z0-9._+-]*) die "not a release tag: '$VERSION'" ;;
  v[0-9]*) ;;
  *) die "not a release tag: '$VERSION'" ;;
esac

# --- step 2/3: install ------------------------------------------------------

if [ "$METHOD" = binary ]; then
  ARCHIVE=omnigateway-$VERSION-$OS-$CPU.tar.gz
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  say "Downloading $ARCHIVE ..."
  fetch "$RELEASE_BASE_URL/download/$VERSION/$ARCHIVE" "$TMP/$ARCHIVE"
  fetch "$RELEASE_BASE_URL/download/$VERSION/SHA256SUMS" "$TMP/SHA256SUMS"
  EXPECTED=$(awk -v f="$ARCHIVE" \
    '{ name = $2; sub(/^\.\//, "", name); sub(/^\*/, "", name); if (name == f) print $1 }' \
    "$TMP/SHA256SUMS")
  [ -n "$EXPECTED" ] || die "no checksum for $ARCHIVE in SHA256SUMS; refusing to install"
  ACTUAL=$(sha256_of "$TMP/$ARCHIVE")
  [ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $ARCHIVE; refusing to install"

  VERDIR=$DATA_DIR/$VERSION
  PREVIOUS=
  if [ -L "$DATA_DIR/current" ]; then
    PREVIOUS=$(readlink "$DATA_DIR/current")
  fi
  mkdir -p "$VERDIR"
  tar -xzf "$TMP/$ARCHIVE" -C "$VERDIR"
  rm -f "$DATA_DIR/current"
  ln -s "$VERDIR" "$DATA_DIR/current"
  mkdir -p "$BIN_DIR"
  ln -sf "$DATA_DIR/current/omnigateway" "$BIN_DIR/omnigateway"
  ln -sf "$DATA_DIR/current/omni" "$BIN_DIR/omni"
  OMNI=$BIN_DIR/omni
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$VERDIR" ]; then
    say "Previous version kept at $PREVIOUS (point $DATA_DIR/current back at it to roll back)."
  fi
  case :$PATH: in
    *":$BIN_DIR:"*) ;;
    *) say "note: $BIN_DIR is not on PATH. Add it: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
else
  command -v npm >/dev/null 2>&1 || die "npm not found; use --method binary (no Node needed)"
  command -v node >/dev/null 2>&1 || die "node not found; use --method binary (no Node needed)"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
    || die "Node 18 or later is required; use --method binary (no Node needed)"
  npm i -g "omnigateway@${VERSION#v}" --allow-scripts=omnigateway
  OMNI=$(command -v omni) || die "omni not found on PATH after npm install"
fi

# --- step 4: .env -----------------------------------------------------------

mkdir -p "$ROOT"
chmod 700 "$ROOT"
ENV_FILE=$ROOT/.env
PORT=${PORT_FLAG:-9000}

local_ips() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d / -f 1 \
      | grep -v '^0\.0\.0\.0$' || true
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' || true
  fi
}
LOCAL_IPS=$(local_ips)

if [ -f "$ENV_FILE" ]; then
  if [ -n "$PORT_FLAG" ] || [ -n "$BASEURL_FLAG" ]; then
    say "note: $ENV_FILE exists and is never rewritten; --port/--base-url are ignored."
  fi
  PORT=$(env_value OMNI_PORT "$ENV_FILE")
  HOST=$(env_value OMNI_HOST "$ENV_FILE")
  BASE=$(env_value OMNI_BASE_URL "$ENV_FILE")
  PORT=${PORT:-9000}
  HOST=${HOST:-0.0.0.0}
else
  HOST=0.0.0.0
  if [ -n "$BASEURL_FLAG" ]; then
    case $BASEURL_FLAG in
      *://*) BASE=$BASEURL_FLAG ;;
      *) BASE=http://$BASEURL_FLAG:$PORT ;;
    esac
  else
    PUBLIC_IP=
    if [ -n "$PUBLIC_IP_URL" ]; then
      if [ "$DOWNLOADER" = curl ]; then
        PUBLIC_IP=$(curl -fsSL -m 4 "$PUBLIC_IP_URL" 2>/dev/null || true)
      else
        PUBLIC_IP=$(wget -q -t 1 -T 4 -O - "$PUBLIC_IP_URL" 2>/dev/null || true)
      fi
      case $PUBLIC_IP in
        *[!0-9.]*|'') PUBLIC_IP= ;;
      esac
    fi
    FIRST_PRIVATE=$(printf '%s\n' "$LOCAL_IPS" | head -n 1)
    DEFAULT_HOST=${PUBLIC_IP:-${FIRST_PRIVATE:-$(hostname 2>/dev/null || echo localhost)}}
    if [ "$ASSUME_YES" = 1 ]; then
      BASE=http://$DEFAULT_HOST:$PORT
    elif have_tty; then
      printf 'Address your laptop uses to reach this server (host, IP or full URL) [%s]: ' \
        "$DEFAULT_HOST" > /dev/tty
      read -r ANSWER < /dev/tty
      ANSWER=${ANSWER:-$DEFAULT_HOST}
      case $ANSWER in
        *://*) BASE=$ANSWER ;;
        *) BASE=http://$ANSWER:$PORT ;;
      esac
    else
      die "no terminal to ask for the server address; pass --base-url or --yes"
    fi
  fi
  if command -v openssl >/dev/null 2>&1; then
    KEY=$(openssl rand -base64 32)
  else
    KEY=$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n')
  fi
  (
    umask 077
    cat > "$ENV_FILE" <<EOF
OMNI_ENCRYPTION_KEY=$KEY
OMNI_HOST=0.0.0.0
OMNI_PORT=$PORT
OMNI_BASE_URL=$BASE
EOF
  )
  chmod 600 "$ENV_FILE"
  say "Wrote $ENV_FILE. Keep OMNI_ENCRYPTION_KEY safe: changing it makes every stored credential unreadable."
fi

# --- step 5: database -------------------------------------------------------

"$OMNI" db migrate --root "$ROOT"

# --- step 6: admin password -------------------------------------------------

# A failed status call says nothing about the password; resetting one that
# exists would lock the operator out, so only a readable adminConfigured
# decides (true: skip, false: set, anything else: warn and skip).
if STATUS_JSON=$("$OMNI" status --json --root "$ROOT") \
  && printf '%s\n' "$STATUS_JSON" \
    | grep -Eq '"adminConfigured"[[:space:]]*:[[:space:]]*(true|false)'; then
  if printf '%s\n' "$STATUS_JSON" | grep -q '"adminConfigured"[[:space:]]*:[[:space:]]*true'; then
    :
  elif [ -n "${OMNI_ADMIN_PASSWORD:-}" ]; then
    printf '%s\n' "$OMNI_ADMIN_PASSWORD" | "$OMNI" admin set-password --root "$ROOT"
  elif [ "$ASSUME_YES" = 1 ]; then
    die "no admin password is set and --yes was given; supply one via OMNI_ADMIN_PASSWORD"
  elif have_tty; then
    "$OMNI" admin set-password --root "$ROOT" < /dev/tty
  else
    die "no terminal to ask for an admin password; supply one via OMNI_ADMIN_PASSWORD"
  fi
else
  warn "warning: could not tell whether an admin password is set; skipping. Set one with: omni admin set-password --root $ROOT"
fi

# --- step 7: service and start ----------------------------------------------

# omni start/restart probes OMNI_BASE_URL for up to ~60s before returning.
start_or_restart() {
  say "Starting the gateway; omni probes OMNI_BASE_URL and may take up to a minute."
  "$OMNI" "$@"
}

if [ "$NO_SERVICE" = 1 ]; then
  say "Skipping service install and start (--no-service). Start later with: $OMNI start --root $ROOT"
else
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$IS_ROOT" = 1 ]; then
      "$OMNI" service install --system --enable --force --root "$ROOT"
      SCOPE=system
    else
      "$OMNI" service install --enable --force --root "$ROOT"
      SCOPE=user
      if ! loginctl enable-linger "$(id -un)" 2>/dev/null; then
        warn "warning: could not enable linger; the gateway stops when you log out."
      fi
    fi
    if [ "$UPGRADE" = 1 ]; then
      if [ "$SCOPE" = system ]; then
        # omni stop/restart refuse --system; ask the manager directly.
        systemctl restart omnigateway.service
      else
        start_or_restart restart --root "$ROOT"
      fi
    elif [ "$IS_ROOT" = 1 ]; then
      start_or_restart start --system --root "$ROOT" || true
    else
      start_or_restart start --root "$ROOT" || true
    fi
  else
    if [ "$UPGRADE" = 1 ]; then
      start_or_restart restart --root "$ROOT" || true
    else
      start_or_restart start --root "$ROOT" || true
    fi
    say "note: no systemd here; omni supervises the process, but it will not come back after a reboot."
  fi

  # omni start probes OMNI_BASE_URL, which a cloud server often cannot reach;
  # only this loopback poll decides health.
  say "Waiting for http://127.0.0.1:$PORT/health ..."
  HEALTHY=0
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 15 ]; do
    if [ "$DOWNLOADER" = curl ]; then
      if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
        HEALTHY=1
        break
      fi
    elif wget -q -t 1 -T 2 -O /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
      HEALTHY=1
      break
    fi
    sleep 1
    ATTEMPT=$((ATTEMPT + 1))
  done
  if [ "$HEALTHY" = 0 ]; then
    warn "the gateway did not answer /health within 15s. Last console lines:"
    "$OMNI" console --root "$ROOT" 2>&1 | tail -n 20 >&2 || true
    exit 1
  fi
fi

# --- step 8: finish ---------------------------------------------------------

DISPLAY_BASE=${BASE:-http://$(printf '%s\n' "$LOCAL_IPS" | head -n 1):$PORT}
case $DISPLAY_BASE in
  http://:*) DISPLAY_BASE=http://127.0.0.1:$PORT ;;
esac
say ""
say "OmniGateway $VERSION is ready (root: $ROOT, method: $METHOD)."
say ""
say "Dashboard: $DISPLAY_BASE"
printf '%s\n' "$LOCAL_IPS" | while IFS= read -r IP; do
  if [ -n "$IP" ] && [ "http://$IP:$PORT" != "$DISPLAY_BASE" ]; then
    say "  also: http://$IP:$PORT"
  fi
done
if [ "$HOST" != "0.0.0.0" ]; then
  say "note: OMNI_HOST=$HOST listens locally only. Set OMNI_HOST=0.0.0.0 in $ENV_FILE and restart to reach it from another machine."
  say "  local: http://127.0.0.1:$PORT"
fi
case $DISPLAY_BASE in
  http://*)
    say "Plain HTTP is unencrypted. Port $PORT must be open in your firewall / security group."
    ;;
esac
say ""
say "Next commands:"
say "  omni connect anthropic                          # connect a provider account"
say "  omni models catalog                             # what is available"
say "  omni models put fast --from-catalog anthropic:claude-sonnet-5"
say "  omni keys create --label laptop                 # printed once; keep it"
say "  curl $DISPLAY_BASE/v1/chat/completions -H 'Authorization: Bearer <key>' \\"
say "    -H 'Content-Type: application/json' -d '{\"model\":\"fast\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
say "  omni status"

}

# Truncation to exactly `main` (missing ` "$@"`) defines the function but runs nothing: inherent to the idiom.
main "$@"
