#!/usr/bin/env bash
set -u

APP_URL="${APP_URL:-http://127.0.0.1:16619}"
OWNTONE_URL="${OWNTONE_URL:-http://127.0.0.1:3689}"

echo "== systemd: homepod-tts =="
systemctl --no-pager --full status homepod-tts 2>&1 | sed -n '1,80p'

echo
echo "== logs: homepod-tts =="
journalctl -u homepod-tts -n 120 --no-pager 2>&1

echo
echo "== systemd: owntone/forked-daapd =="
systemctl --no-pager --full status owntone 2>&1 | sed -n '1,60p' || true
systemctl --no-pager --full status forked-daapd 2>&1 | sed -n '1,60p' || true

echo
echo "== app health =="
curl -fsS "${APP_URL}/api/health" 2>&1 || true

echo
echo
echo "== app outputs =="
curl -fsS "${APP_URL}/api/outputs" 2>&1 || true

echo
echo
echo "== owntone config =="
curl -fsS "${OWNTONE_URL}/api/config" 2>&1 || true

echo
echo
echo "== owntone outputs =="
curl -fsS "${OWNTONE_URL}/api/outputs" 2>&1 || true

echo
echo
echo "== files and permissions =="
ls -ld /root /root/TTS /root/TTS/audio /srv/tts-audio 2>&1 || true
find /srv/tts-audio -maxdepth 1 -type f -printf '%TY-%Tm-%Td %TH:%TM %p\n' 2>&1 | tail -20 || true

echo
echo "== tts binary =="
command -v node 2>&1 || true
node --version 2>&1 || true
command -v espeak-ng 2>&1 || true
espeak-ng --voices 2>&1 | sed -n '1,20p' || true
ls -lh /root/TTS/venv/bin/piper /root/TTS/models/piper/*.onnx /root/TTS/models/piper/*.onnx.json 2>&1 || true
/root/TTS/venv/bin/piper --help 2>&1 | sed -n '1,20p' || true

echo
echo "== mqtt broker =="
timeout 4 bash -c '</dev/tcp/192.168.150.156/1883' && echo "MQTT TCP OK" || echo "MQTT TCP nicht erreichbar"
