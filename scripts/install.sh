#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/root/TTS"
SERVICE_FILE="/etc/systemd/system/homepod-tts.service"
BACKUP_DIR="${APP_DIR}/backups"
SHARED_AUDIO_DIR="/srv/tts-audio"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Bitte als root ausfuehren."
  exit 1
fi

mkdir -p "${APP_DIR}" "${BACKUP_DIR}" "${APP_DIR}/data" "${SHARED_AUDIO_DIR}"

if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
  if [[ -f "${APP_DIR}/config.json" ]]; then
    tar -czf "${BACKUP_DIR}/deploy-$(date +%Y%m%d-%H%M%S).tar.gz" -C "${APP_DIR}" config.json data audio 2>/dev/null || true
  fi
  rsync -a --exclude backups --exclude data --exclude audio --exclude config.json "${SOURCE_DIR}/" "${APP_DIR}/"
fi

cd "${APP_DIR}"

if ! command -v node >/dev/null 2>&1 || ! command -v espeak-ng >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  echo "Installiere benoetigte Pakete: nodejs, espeak-ng, rsync, curl, python3"
  apt-get update
  apt-get install -y nodejs espeak-ng rsync curl python3
fi

if [[ ! -d "${APP_DIR}/venv" ]]; then
  if ! python3 -m venv "${APP_DIR}/venv" >/dev/null 2>&1; then
    echo "Installiere Python venv-Unterstuetzung"
    apt-get update
    apt-get install -y python3-venv || apt-get install -y python3.10-venv
    python3 -m venv "${APP_DIR}/venv"
  fi
fi

if [[ ! -x "${APP_DIR}/venv/bin/piper" ]]; then
  "${APP_DIR}/venv/bin/python" -m pip install --upgrade pip piper-tts
fi

mkdir -p "${APP_DIR}/models/piper"
DEFAULT_PIPER_MODEL="${APP_DIR}/models/piper/de_DE-thorsten-medium.onnx"
DEFAULT_PIPER_CONFIG="${DEFAULT_PIPER_MODEL}.json"
if [[ ! -f "${DEFAULT_PIPER_MODEL}" ]]; then
  curl -L --fail -o "${DEFAULT_PIPER_MODEL}" "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx"
fi
if [[ ! -f "${DEFAULT_PIPER_CONFIG}" ]]; then
  curl -L --fail -o "${DEFAULT_PIPER_CONFIG}" "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json"
fi

node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 14) { console.error('Node.js >=14 ist erforderlich. Gefunden: ' + process.versions.node); process.exit(1); }"

if ! systemctl list-unit-files owntone.service >/dev/null 2>&1 && ! systemctl list-unit-files forked-daapd.service >/dev/null 2>&1; then
  echo "Installiere OwnTone/forked-daapd"
  if ! apt-get install -y owntone; then
    apt-get install -y forked-daapd
  fi
fi

if systemctl list-unit-files owntone.service >/dev/null 2>&1; then
  AIRPLAY_SERVICE="owntone.service"
elif systemctl list-unit-files forked-daapd.service >/dev/null 2>&1; then
  AIRPLAY_SERVICE="forked-daapd.service"
else
  AIRPLAY_SERVICE="network-online.target"
fi

if [[ ! -f "${APP_DIR}/config.json" ]]; then
  cp "${APP_DIR}/config.example.json" "${APP_DIR}/config.json"
fi

node - "${APP_DIR}/config.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.owntone = config.owntone || {};
if (!config.owntone.audioDirectory || config.owntone.audioDirectory === '/root/TTS/audio') {
  config.owntone.audioDirectory = '/srv/tts-audio';
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
NODE

if [[ -e "${APP_DIR}/audio" && ! -L "${APP_DIR}/audio" ]]; then
  mv "${APP_DIR}/audio" "${BACKUP_DIR}/audio-local-$(date +%Y%m%d-%H%M%S)"
fi
ln -sfn "${SHARED_AUDIO_DIR}" "${APP_DIR}/audio"

chmod 755 "${APP_DIR}"
chmod 755 "${SHARED_AUDIO_DIR}"
chmod 755 "${APP_DIR}/scripts"

node --check "${APP_DIR}/server.js"

cat > "${SERVICE_FILE}" <<UNIT
[Unit]
Description=HomePod TTS Server
After=network-online.target ${AIRPLAY_SERVICE}
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=3
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now homepod-tts

echo
echo "HomePod TTS laeuft als systemd Service."
echo "Web UI: http://192.168.150.162:16619"
echo
echo "Wichtig: OwnTone muss ${SHARED_AUDIO_DIR} als Library-Ordner scannen koennen."
echo "Falls Ansagen erzeugt, aber nicht gefunden werden, pruefe /etc/owntone.conf und die Rechte auf ${SHARED_AUDIO_DIR}."
