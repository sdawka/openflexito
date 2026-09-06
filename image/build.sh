#!/bin/bash
# Build a flashable openflexito image from the official Raspberry Pi OS Lite 64-bit image using
# sdm (https://github.com/gitbls/sdm). Needs Linux with loop-device support; on macOS this runs
# inside a privileged Docker container. Output: image/build/openflexito-<date>.img
#
#   ./image/build.sh                 # downloads base image if missing, builds
#   BASE_IMAGE_URL=... ./image/build.sh
set -euo pipefail
[ "${1:-}" = --lib ] && LIB_ONLY=1 || LIB_ONLY=0
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
BUILD="$HERE/build"; mkdir -p "$BUILD"
BASE_IMAGE_URL=${BASE_IMAGE_URL:-https://downloads.raspberrypi.com/raspios_oldstable_lite_arm64/images/raspios_oldstable_lite_arm64-2026-06-19/2026-06-18-raspios-bookworm-arm64-lite.img.xz}
BASE_XZ="$BUILD/base.img.xz"
OUT="$BUILD/openflexito-$(date +%Y%m%d).img"

if [ $LIB_ONLY = 0 ] && [ ! -f "$BASE_XZ" ]; then
  echo "== downloading base image"
  curl -L --fail -o "$BASE_XZ" "$BASE_IMAGE_URL"
fi
if [ $LIB_ONLY = 0 ] && [ ! -f "$REPO/webapp/dist/index.html" ]; then
  echo "== building webapp"
  (cd "$REPO/webapp" && npm ci && npm run build)
fi

run_sdm() {
  # $1 = working dir containing the repo and build dir (inside the container this is /work)
  set -x
  IMG="$1/image/build/openflexito.img"
  xz -dkc "$1/image/build/base.img.xz" > "$IMG"
  sdm --customize \
      --plugin user:"deluser=pi" \
      --plugin user:"adduser=admin|password=microscope|groups=sudo,adm,video,dialout" \
      --plugin L10n:host \
      --plugin disables:"piwiz|triggerhappy|bluetooth" \
      --plugin copydir:"from=$1|to=/opt/openflexito-src|rsyncopts=--exclude=.git --exclude=node_modules --exclude=.venv --exclude=image/build" \
      --plugin runscript:"script=/opt/openflexito-src/image/sdm-customize.sh|stage=post-install" \
      --expand-root --regen-ssh-host-keys --restart \
      --batch "$IMG"
  mv "$IMG" "$OUT"
  set +x
}

if [ $LIB_ONLY = 1 ]; then
  return 0 2>/dev/null || true
elif [ "$(uname -s)" = Linux ] && command -v sdm >/dev/null; then
  run_sdm "$REPO"
else
  echo "== running sdm in Docker (privileged, for loop devices)"
  docker run --rm --privileged -v "$REPO":/work -w /work debian:bookworm bash -c '
    set -e
    apt-get update -qq && apt-get install -y -qq curl xz-utils rsync qemu-user-static binfmt-support systemd-container parted fdisk >/dev/null
    curl -fsSL https://raw.githubusercontent.com/gitbls/sdm/master/EZsdmInstaller | bash
    source /work/image/build.sh --lib
    run_sdm /work'
fi
echo "== image ready: $OUT"
