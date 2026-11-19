#!/usr/bin/env bash
# One-shot APK build on x86_64 Linux (a Docker container, a VM or a CI runner):
#
#   native/build-apk.sh [work-dir]          # default work-dir: ./build-apk
#
#   1. clones dsh-Go into <work-dir>/dsh-go at native/BASE (reuses an existing clone)
#   2. builds web/ unless web/dist already exists (needs Node ≥ 20 on PATH)
#   3. native/apply.sh (patches, overlay, bundled page, launcher icons)
#   4. dsh-Go's own toolchain + runtime + APK scripts (README › 从源码构建)
#
# Environment:
#   ABI=arm64|x64              default arm64 (x64 for emulators / x86 devices)
#   DSH_GO_REPO=<git url>      default https://github.com/ccch1mneyyy/dsh-go.git
#   DEV_ROOT=<dir>             where dsh-Go's toolchain goes (default ~/dev)
#   API_DEMO_UPDATE_REPO=o/r   your GitHub repo for in-app updates (optional)
#   SKIP_TOOLCHAIN=1           flutter / java / Android SDK already on PATH
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
work="$(mkdir -p "${1:-$repo/build-apk}" && cd "${1:-$repo/build-apk}" && pwd)"
abi="${ABI:-arm64}"
case "$abi" in arm64) rt=arm64-v8a ;; x64) rt=x86_64 ;; *) echo "ABI is arm64 or x64" >&2; exit 1 ;; esac
base="$(cat "$here/BASE")"
dsh="$work/dsh-go"

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo "✗ needs x86_64 Linux (dsh-Go's runtime build does); see HANDOFF.md" >&2; exit 1; }

echo "→ dsh-Go @ ${base:0:7}"
if [ ! -d "$dsh/.git" ]; then
  git clone "${DSH_GO_REPO:-https://github.com/ccch1mneyyy/dsh-go.git}" "$dsh"
fi
cd "$dsh"
if git log -1 --format=%s | grep -qE '^(API Demo|DSMO): overlay files'; then
  echo "  already patched (delete $dsh to start over)"
else
  git fetch -q origin "$base" 2>/dev/null || git fetch -q origin
  git checkout -q --detach "$base"
  if [ ! -f "$repo/web/dist/index.html" ]; then
    echo "→ web"
    (cd "$repo/web" && npm ci && npm run build)
  fi
  bash "$here/apply.sh" "$dsh" --skip-web
fi

if [ "${SKIP_TOOLCHAIN:-0}" != 1 ]; then
  echo "→ toolchain (JDK 17, Flutter, Android SDK/NDK into ${DEV_ROOT:-~/dev}; first run downloads several GB)"
  if [ -n "${GITHUB_ACTIONS:-}" ] || [ "${USE_OFFICIAL_MIRROR:-0}" = 1 ]; then
    echo "  (CI / Official Mirror: configuring setup-toolchain.sh to use official Google/Pub endpoints)"
    sed -i.bak 's|https://storage.flutter-io.cn|https://storage.googleapis.com|g' tooling/setup-toolchain.sh
    sed -i.bak 's|https://pub.flutter-io.cn|https://pub.dev|g' tooling/setup-toolchain.sh
    rm -f tooling/setup-toolchain.sh.bak
  fi
  bash tooling/setup-toolchain.sh
  # shellcheck disable=SC1091
  source tooling/env.sh
fi
flutter --version | head -1
java -version 2>&1 | head -1

echo "→ check the DSMO Dart files compile"
(cd app && flutter pub get --enforce-lockfile >/dev/null && flutter analyze --no-pub lib/api_demo)

echo "→ runtime ($rt)"
bash runtime/build-runtime.sh "$rt"

echo "→ APK"
extra=()
[ -n "${API_DEMO_UPDATE_REPO:-}" ] && extra=(-- "--dart-define=API_DEMO_UPDATE_REPO=$API_DEMO_UPDATE_REPO")
DSH_BETA_TOKEN_FILE= bash tooling/build-apk.sh -f "$abi" "${extra[@]}"

apk="$dsh/app/build/app/outputs/flutter-apk/app-$abi-release.apk"
mkdir -p "$repo/dist-apk"
cp "$apk" "$repo/dist-apk/dsmo-$abi.apk"
echo "✓ $repo/dist-apk/dsmo-$abi.apk"
