#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
umask 077
command -v exiftool >/dev/null || { echo 'Install ExifTool first: brew install exiftool'; exit 1; }
test -d '/Applications/Google Chrome.app' || { echo 'Install Google Chrome before setting up the publisher.'; exit 1; }
python3 -m venv .publisher/venv
.publisher/venv/bin/python -m pip install 'playwright==1.58.0'
echo 'Ready. Run: bun run publisher connect'
