#!/usr/bin/env bash
# Run Fulton from source on Linux / Steam Deck (Desktop Mode).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo " Fulton needs Node.js to run from source."
  echo " Install it once (https://nodejs.org, or your package manager: sudo apt install nodejs npm),"
  echo " then run this file again."
  echo
  read -r -p "Press Enter to close" _; exit 1
fi
if [ ! -d node_modules/electron ]; then
  echo "First run: downloading Electron. This takes a minute..."
  npm install --no-audit --no-fund || { echo " npm install failed. Check your internet connection."; read -r -p "Press Enter to close" _; exit 1; }
fi
exec npx electron . "$@"
