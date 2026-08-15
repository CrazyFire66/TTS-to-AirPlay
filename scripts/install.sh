#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/root/TTS"
SERVICE_FILE="/etc/systemd/system/homepod-tts.service"
BACKUP_DIR="${APP_DIR}/backups"
SHARED_AUDIO_DIR="/srv/tts-audio"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PORT="${TTS_PORT:-16619}"
MQTT_HOST="${TTS_MQTT_HOST:-192.168.150.156}"
OWNTONE_VERSION="${TTS_OWNTONE_VERSION:-29.0}"

detect_server_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i=="src") {print $(i+1); exit}}')"
  fi
  if [[ -z "${ip}" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  echo "${ip:-127.0.0.1}"
}

unit_exists() {
  systemctl list-unit-files "$1" 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
}

SERVER_IP="${TTS_SERVER_IP:-$(detect_server_ip)}"
PUBLIC_BASE_URL="${TTS_PUBLIC_BASE_URL:-http://${SERVER_IP}:${APP_PORT}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Bitte als root ausfuehren."
  exit 1
fi

install_owntone_from_source() {
  local version="${OWNTONE_VERSION}"
  local build_root="/usr/local/src"
  local archive="${build_root}/owntone-${version}.tar.gz"
  local source_dir="${build_root}/owntone-server-${version}"

  echo "OwnTone ist nicht als apt-Paket verfuegbar. Baue OwnTone ${version} aus dem offiziellen Quellcode."
  apt-get update
  apt-get install -y \
    build-essential git autotools-dev autoconf automake libtool gettext gawk \
    pkg-config gperf bison flex libconfuse-dev libunistring-dev libsqlite3-dev \
    libavcodec-dev libavformat-dev libavfilter-dev libswscale-dev libavutil-dev \
    libasound2-dev libxml2-dev libgcrypt20-dev libavahi-client-dev zlib1g-dev \
    libevent-dev libplist-dev libsodium-dev libjson-c-dev libwebsockets-dev \
    libcurl4-openssl-dev libprotobuf-c-dev

  mkdir -p "${build_root}"
  if [[ ! -f "${archive}" ]]; then
    curl -L --fail -o "${archive}" "https://github.com/owntone/owntone-server/archive/refs/tags/${version}.tar.gz"
  fi
  if [[ -d "${source_dir}" ]]; then
    mv "${source_dir}" "${source_dir}-$(date +%Y%m%d-%H%M%S).bak"
  fi
  tar -xzf "${archive}" -C "${build_root}"
  cd "${source_dir}"
  autoreconf -i
  ./configure --prefix=/usr --sysconfdir=/etc --localstatedir=/var --enable-install-user
  make -j"$(nproc)"
  make install
  cd "${APP_DIR}"
  systemctl daemon-reload
}

mkdir -p "${APP_DIR}" "${BACKUP_DIR}" "${APP_DIR}/data" "${APP_DIR}/assets" "${APP_DIR}/downloads" "${SHARED_AUDIO_DIR}"

if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
  if [[ -f "${APP_DIR}/config.json" ]]; then
    tar -czf "${BACKUP_DIR}/deploy-$(date +%Y%m%d-%H%M%S).tar.gz" -C "${APP_DIR}" config.json data audio assets downloads 2>/dev/null || true
  fi
  rsync -a --exclude backups --exclude data --exclude audio --exclude assets --exclude downloads --exclude config.json "${SOURCE_DIR}/" "${APP_DIR}/"
fi

cd "${APP_DIR}"

if ! command -v node >/dev/null 2>&1 || ! command -v espeak-ng >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1 || ! command -v ffmpeg >/dev/null 2>&1 || ! command -v avahi-daemon >/dev/null 2>&1 || ! dpkg -s libnss-mdns >/dev/null 2>&1; then
  echo "Installiere benoetigte Pakete: nodejs, espeak-ng, rsync, curl, python3, ffmpeg, avahi-daemon"
  apt-get update
  apt-get install -y nodejs espeak-ng rsync curl python3 ffmpeg avahi-daemon libnss-mdns
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

if ! unit_exists owntone.service && ! unit_exists forked-daapd.service; then
  echo "Installiere OwnTone/forked-daapd"
  if ! apt-get install -y owntone; then
    if ! apt-get install -y forked-daapd; then
      install_owntone_from_source
    fi
  fi
fi

if unit_exists owntone.service; then
  AIRPLAY_SERVICE="owntone.service"
elif unit_exists forked-daapd.service; then
  AIRPLAY_SERVICE="forked-daapd.service"
else
  AIRPLAY_SERVICE="network-online.target"
fi

CONFIG_CREATED=0
if [[ ! -f "${APP_DIR}/config.json" ]]; then
  cp "${APP_DIR}/config.example.json" "${APP_DIR}/config.json"
  CONFIG_CREATED=1
fi

node - "${APP_DIR}/config.json" "${CONFIG_CREATED}" "${PUBLIC_BASE_URL}" "${APP_PORT}" "${MQTT_HOST}" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const created = process.argv[3] === '1';
const publicBaseUrl = process.argv[4];
const port = Number(process.argv[5]);
const mqttHost = process.argv[6];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.server = config.server || {};
if (created || process.env.TTS_PUBLIC_BASE_URL || !config.server.publicBaseUrl || config.server.publicBaseUrl === 'http://192.168.150.162:16619') {
  config.server.publicBaseUrl = publicBaseUrl;
}
if (created || process.env.TTS_PORT) config.server.port = port;
config.owntone = config.owntone || {};
if (!config.owntone.audioDirectory || config.owntone.audioDirectory === '/root/TTS/audio') {
  config.owntone.audioDirectory = '/srv/tts-audio';
}
config.mqtt = config.mqtt || {};
if (created || process.env.TTS_MQTT_HOST) config.mqtt.host = mqttHost;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
NODE

if [[ -e "${APP_DIR}/audio" && ! -L "${APP_DIR}/audio" ]]; then
  mv "${APP_DIR}/audio" "${BACKUP_DIR}/audio-local-$(date +%Y%m%d-%H%M%S)"
fi
ln -sfn "${SHARED_AUDIO_DIR}" "${APP_DIR}/audio"

chmod 755 "${APP_DIR}"
chmod 755 "${SHARED_AUDIO_DIR}"
chmod 755 "${APP_DIR}/scripts"
chmod 755 "${APP_DIR}/assets"
chmod 755 "${APP_DIR}/downloads"

configure_owntone_library() {
  local conf=""
  if [[ -f /etc/owntone.conf ]]; then
    conf="/etc/owntone.conf"
  elif [[ -f /etc/forked-daapd.conf ]]; then
    conf="/etc/forked-daapd.conf"
  else
    return 0
  fi

  cp "${conf}" "${BACKUP_DIR}/$(basename "${conf}")-$(date +%Y%m%d-%H%M%S).bak"
  node - "${conf}" "${SHARED_AUDIO_DIR}" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const audioDir = process.argv[3];
let text = fs.readFileSync(file, 'utf8');
const wanted = `directories = { "${audioDir}" }`;
const blockPattern = /^[ \t]*directories\s*=\s*\{[\s\S]*?^[ \t]*\}[ \t]*$/m;
if (blockPattern.test(text)) {
  text = text.replace(blockPattern, wanted);
} else if (/^[ \t]*directories\s*=.*$/m.test(text)) {
  text = text.replace(/^\s*directories\s*=.*$/m, wanted);
} else {
  text += `\n${wanted}\n`;
}
fs.writeFileSync(file, text);
NODE
}

node --check "${APP_DIR}/server.js"

configure_owntone_library

systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
systemctl restart avahi-daemon >/dev/null 2>&1 || true

if [[ "${AIRPLAY_SERVICE}" == "owntone.service" || "${AIRPLAY_SERVICE}" == "forked-daapd.service" ]]; then
  systemctl enable --now "${AIRPLAY_SERVICE}" >/dev/null 2>&1 || true
  systemctl restart "${AIRPLAY_SERVICE}" >/dev/null 2>&1 || true
fi

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
Environment=HOST=0.0.0.0
Environment=PORT=${APP_PORT}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now homepod-tts
systemctl restart homepod-tts

sleep 2

APP_HEALTH="nicht erreichbar"
if curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
  APP_HEALTH="OK"
fi

OWNTONE_HEALTH="nicht erreichbar"
if curl -fsS "http://127.0.0.1:3689/api/outputs" >/dev/null 2>&1; then
  OWNTONE_HEALTH="OK"
fi

echo
echo "HomePod TTS laeuft als systemd Service."
echo "Web UI: ${PUBLIC_BASE_URL}"
echo "App Health: ${APP_HEALTH}"
echo "OwnTone API: ${OWNTONE_HEALTH}"
echo
echo "OwnTone wurde auf ${SHARED_AUDIO_DIR} als Library-Ordner gesetzt, falls die Config-Datei vorhanden war."
echo "Wenn HomePods nicht erscheinen: Webseite oeffnen und 'AirPlay Geraete suchen' klicken."
echo
echo "Optionale Install-Parameter:"
echo "  TTS_MQTT_HOST=192.168.150.156 TTS_PORT=16619 bash scripts/install.sh"
