#!/usr/bin/env bash
# Fetch the Russian speech model into android/model-assets/, where the Gradle
# build picks it up as APK assets. The model is 46 MB, so it is downloaded rather
# than committed.
set -euo pipefail

MODEL=vosk-model-small-ru-0.22
URL="https://alphacephei.com/vosk/models/$MODEL.zip"

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/android/model-assets/model-ru"

if [ -f "$dest/uuid" ]; then
  echo "Model already present at $dest"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $MODEL…"
curl -fL --progress-bar -o "$tmp/model.zip" "$URL"
unzip -q "$tmp/model.zip" -d "$tmp"

rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
mv "$tmp/$MODEL" "$dest"

# Vosk's StorageService copies the model out of the APK once, and uses this file
# to tell whether the copy on the device is still the one that shipped.
echo "$MODEL" > "$dest/uuid"

echo "Model ready at $dest"
