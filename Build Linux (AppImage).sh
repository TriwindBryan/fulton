#!/usr/bin/env bash
# Builds Fulton-<version>-linux-x64.AppImage (and a .tar.gz) into the dist folder.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Install Node.js first: https://nodejs.org"; exit 1; }
npm install --no-audit --no-fund && npm run dist:linux
echo; echo "Done. Look in the dist folder."
