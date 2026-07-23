#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
node --check server.js
echo "Syntax OK"
command -v espeak-ng >/dev/null && espeak-ng --voices | head -20 || echo "espeak-ng fehlt"
curl -fsS http://127.0.0.1:3689/api/config >/dev/null && echo "OwnTone API OK" || echo "OwnTone API nicht erreichbar"
