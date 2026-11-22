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
  # The folder may already hold restored caches (CI restores runtime/.cache into it),
  # which `git clone` refuses: clone beside it and move the repository in.
  rm -rf "$dsh.clone"
  git clone --no-checkout "${DSH_GO_REPO:-https://github.com/ccch1mneyyy/dsh-go.git}" "$dsh.clone"
  mkdir -p "$dsh"
  mv "$dsh.clone/.git" "$dsh/.git"
  rm -rf "$dsh.clone"
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
  # dsh-Go's tawcroot build takes ANDROID_NDK_HOME before the SDK it was just given, and CI
  # images preset it to their own NDK (another version; on GitHub's runners we also delete it
  # for disk space). The toolchain above installed the pinned NDK under \$ANDROID_HOME/ndk.
  unset ANDROID_NDK_HOME ANDROID_NDK_ROOT ANDROID_NDK ANDROID_NDK_LATEST_HOME
fi
flutter --version | head -1
java -version 2>&1 | head -1

echo "→ check the DSMO Dart files compile"
(cd app && flutter pub get --enforce-lockfile >/dev/null && flutter analyze --no-pub --no-fatal-infos lib/api_demo)

echo "→ runtime ($rt)"
bash runtime/build-runtime.sh "$rt"

echo "→ APK"
# DSMO's signing key: every APK signed with it installs over the last one, data kept. Without it
# the build falls back to a debug key made on this machine, which other machines' builds don't share.
if [ -n "${DSMO_KEYSTORE:-}" ]; then
  [ -f "$DSMO_KEYSTORE" ] || { echo "✗ DSMO_KEYSTORE: no file at $DSMO_KEYSTORE" >&2; exit 1; }
  [ -n "${DSMO_KEYSTORE_PASSWORD:-}" ] || { echo "✗ DSMO_KEYSTORE_PASSWORD is not set" >&2; exit 1; }
  (umask 077 && printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' \
    "$DSMO_KEYSTORE" "$DSMO_KEYSTORE_PASSWORD" "${DSMO_KEY_ALIAS:-dsmo}" "$DSMO_KEYSTORE_PASSWORD" > app/android/key.properties)
  echo "  signing with DSMO's key"
else
  rm -f app/android/key.properties
  echo "  ! no DSMO_KEYSTORE: signed with this machine's debug key; it will not install over APKs built elsewhere"
fi
# The native bridge this APK provides: a hot-updated page that needs a newer one is not taken
# (web_update.dart, native/BRIDGE).
defines=("--dart-define=API_DEMO_BRIDGE=$(tr -dc 0-9 < "$here/BRIDGE")")
[ -n "${API_DEMO_UPDATE_REPO:-}" ] && defines+=("--dart-define=API_DEMO_UPDATE_REPO=$API_DEMO_UPDATE_REPO")
# --no-companion: since v1.3.0 dsh-Go's release builds put the licensed 伙伴 (whale-girl) pack in the
# APK and stop without it. It isn't ours to ship, and DSMO hides 伙伴小屋 (patch 0012).
DSH_BETA_TOKEN_FILE= bash tooling/build-apk.sh -f "$abi" --no-companion -- "${defines[@]}"

apk="$dsh/app/build/app/outputs/flutter-apk/app-$abi-release.apk"
mkdir -p "$repo/dist-apk"
cp "$apk" "$repo/dist-apk/dsmo-$abi.apk"
# The certificate the phone checks on every update (public; DSMO's key: FE:33:5D:B8:…:47:F3).
keytool -printcert -jarfile "$apk" 2>/dev/null | grep -m1 -E 'SHA256:' | sed 's/^[[:space:]]*/  certificate /' || true
echo "✓ $repo/dist-apk/dsmo-$abi.apk"
