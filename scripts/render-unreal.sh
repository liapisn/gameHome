#!/usr/bin/env bash
# Local render pipeline: FloorPlan → .glb → Unreal (Lumen) → PNG frames → MP4.
#
#   scripts/render-unreal.sh                     # demo plan, build + render
#   scripts/render-unreal.sh path/to/plan.json   # any FloorPlan JSON
#   BUILD_ONLY=1 scripts/render-unreal.sh        # build the level/sequence, leave the editor open to inspect
#
# Env: UE_ROOT (engine dir; defaults to the newest /Users/Shared/Epic Games/UE_5.*),
#      SECONDS_PER_ROOM (6), RESOLUTION (1920x1080).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${UE_ROOT:-}" ]]; then
  UE_ROOT=$(ls -d "/Users/Shared/Epic Games"/UE_5.* 2>/dev/null | sort -V | tail -1 || true)
fi
EDITOR="$UE_ROOT/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor"
if [[ ! -x "$EDITOR" ]]; then
  echo "UnrealEditor not found. Install UE 5.x via the Epic Games Launcher or set UE_ROOT." >&2
  exit 1
fi

# 1. Export geometry.
if [[ $# -gt 0 ]]; then out=$(npm run -s export:glb -- --plan "$1"); else out=$(npm run -s export:glb); fi
GLB=$(echo "$out" | tail -1 | awk '{print $1}')
LISTING_DIR=$(dirname "$GLB")
RENDERS="$LISTING_DIR/renders"
echo "→ $GLB"

# 2. Build (and render) in Unreal.
rm -rf "$RENDERS"
export GAMEHOME_GLB="$GLB" GAMEHOME_OUT="$RENDERS" \
  GAMEHOME_SECONDS_PER_ROOM="${SECONDS_PER_ROOM:-6}" GAMEHOME_RESOLUTION="${RESOLUTION:-1920x1080}"
if [[ -n "${BUILD_ONLY:-}" ]]; then
  export GAMEHOME_RENDER=0 GAMEHOME_QUIT=0
else
  export GAMEHOME_RENDER=1 GAMEHOME_QUIT=1
fi
"$EDITOR" "$PWD/unreal/GameHomeRender/GameHomeRender.uproject" \
  -ExecutePythonScript="$PWD/unreal/build_listing.py" \
  -unattended -nosplash -nosound -log

[[ -n "${BUILD_ONLY:-}" ]] && exit 0

# 3. Encode.
if ! ls "$RENDERS"/*.png >/dev/null 2>&1; then
  echo "No frames in $RENDERS. Check unreal/GameHomeRender/Saved/Logs/GameHomeRender.log" >&2
  exit 1
fi
if command -v ffmpeg >/dev/null; then
  first=$(ls "$RENDERS"/*.png | head -1)
  pattern=$(echo "$first" | sed -E 's/\.[0-9]+\.png$/.%04d.png/')
  ffmpeg -y -loglevel error -framerate 30 -i "$pattern" -c:v libx264 -pix_fmt yuv420p -crf 18 \
    "$LISTING_DIR/walkthrough.mp4"
  echo "✓ $LISTING_DIR/walkthrough.mp4"
else
  echo "✓ frames in $RENDERS (brew install ffmpeg to get an MP4)"
fi
