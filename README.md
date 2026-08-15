# TTS to AirPlay

Node.js-Server für kostenlose Offline-TTS-Ansagen, die per OwnTone/AirPlay auf HomePods ausgegeben werden. Texte können über die moderne Weboberfläche oder per MQTT gesendet werden.

## Funktionen

- Weboberfläche mit Menübereichen für Ansage, Einstellungen, Audio, Download, Stimmen, MQTT und Verlauf
- AirPlay-Geräte über die Webseite neu suchen
- MQTT-Eingang für Automationen, z. B. Home Assistant, ioBroker oder Node-RED
- Mehrere HomePods gleichzeitig per `outputNames`
- Separate Lautstärke pro Lautsprecher per `volumes`
- Piper TTS als kostenlose Offline-Stimme
- `espeak-ng` als Fallback
- Piper-Stimmen über die Weboberfläche laden
- Audiodateien hochladen und vor/nach Ansagen abspielen
- Audiodateien auch ohne TTS-Text direkt abspielen
- TTS- und Audio-Dateien über die Weboberfläche erstellen und herunterladen
- Aktuelle Ansage-Auswahl als Standard speichern
- Verlauf anzeigen und mit Backup löschen
- Automatische Backups bei Konfigurationsänderungen
- Systemd-Service für dauerhaften Betrieb

## Architektur

HomePods werden nicht direkt vom Node.js-Prozess angesteuert. OwnTone übernimmt AirPlay/AirPlay 2 und stellt eine lokale HTTP-API bereit. Diese App erzeugt eine WAV-Datei mit Piper, hängt bei Bedarf Intro-/Outro-Audio an, legt die fertige Datei in `/srv/tts-audio` ab, wählt die gewünschten OwnTone-Ausgänge und startet die Wiedergabe.

```text
Web UI / MQTT
    |
    v
Node.js TTS Server
    |
    v
Piper + optionale Audiodateien -> /srv/tts-audio
    |
    v
OwnTone -> AirPlay -> HomePods
```

## Installation

Zielsystem: Debian/Ubuntu, Root-Zugriff, Node.js >= 14, OwnTone im selben Netzwerk wie die HomePods.

```bash
cd /root
git clone https://github.com/CrazyFire66/TTS-to-AirPlay.git TTS
cd /root/TTS
bash scripts/install.sh
```

Weboberfläche:

```text
http://SERVER-IP:16619
```

Beispiel:

```text
http://192.168.150.162:16619
```

## Weboberfläche

Die Oberfläche ist in Menübereiche aufgeteilt:

- **Ansage**: Text, Zielgeräte, Stimme, Lautstärke, Tempo, direktes Audio und Audio vorher/nachher auswählen
- **Einstellungen**: Standardziele, Standardstimme, MQTT, OwnTone und Standard-Audio speichern
- **Audio**: Audiodateien hochladen und löschen
- **Download**: neue TTS-/Audio-Dateien erstellen, herunterladen und löschen
- **Stimmen**: Piper-Stimmen laden
- **MQTT**: Beispiel-Payload passend zu den aktuellen Einstellungen
- **Verlauf**: Verlauf ansehen und mit Backup löschen

Mit **AirPlay Geräte suchen** wird OwnTone neu gestartet und danach die aktuelle Ausgabeliste neu geladen.

## OwnTone

OwnTone muss diesen Audio-Ordner scannen:

```text
/srv/tts-audio
```

Falls OwnTone Ansagen nicht findet, in `/etc/owntone.conf` den Library-Ordner prüfen:

```text
directories = { "/srv/tts-audio" }
```

Danach OwnTone neu starten:

```bash
systemctl restart owntone
```

## Konfiguration

Die aktive Konfiguration liegt hier:

```text
/root/TTS/config.json
```

Standard-HomePods sollten über Namen gesetzt werden, nicht über IDs. Das geht in der Weboberfläche unter **Einstellungen -> Standardziele**.

Mit **Auswahl als Standard speichern** wird die aktuelle Ansage-Auswahl dauerhaft gespeichert:

- gewählte Geräte
- Stimme/Sprache
- Lautstärke
- Tempo
- Audio vorher/nachher

## MQTT

Einfacher Text:

```bash
mosquitto_pub -h 192.168.150.156 -t tts/say -m "Die Waschmaschine ist fertig."
```

JSON Payload:

```json
{
  "text": "Haustür wurde geöffnet.",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "voice": "de_DE-ramona-low",
  "volume": 45,
  "audioBefore": "gong.wav",
  "speed": 165
}
```

`volume` gilt für alle ausgewählten HomePods. Einzelne HomePods können mit `volumes` überschrieben werden:

```json
{
  "text": "Haustür wurde geöffnet.",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "volume": 40,
  "volumes": {
    "Wohnzimmer": 30,
    "Schlafzimmer": 55
  },
  "audioBefore": "gong.wav"
}
```

Die Keys in `volumes` können Output-Namen oder OwnTone-Output-IDs sein. Alternativ ist auch eine Liste möglich:

```json
{
  "text": "Test",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "outputVolumes": [
    { "name": "Wohnzimmer", "volume": 30 },
    { "name": "Schlafzimmer", "volume": 55 }
  ]
}
```

Settings per MQTT aktualisieren:

```json
{
  "owntone": {
    "defaultOutputNames": ["Wohnzimmer"],
    "volume": 35
  },
  "tts": {
    "engine": "piper",
    "voice": "de_DE-ramona-low"
  }
}
```

## Audiodateien vor/nach Ansagen

Unter **Audio-Dateien** können WAV, MP3, M4A, AAC, FLAC und OGG hochgeladen werden. Die Dateien werden hier gespeichert:

```text
/root/TTS/assets
```

MQTT/API-Beispiel mit Audio vorher:

```json
{
  "text": "Es hat geklingelt.",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "audioBefore": "gong.wav",
  "volume": 45
}
```

Audio nach der Ansage:

```json
{
  "text": "Die Haustür wurde geöffnet.",
  "audioAfter": "gong.wav"
}
```

Vorher und nachher:

```json
{
  "text": "Alarmanlage wurde aktiviert.",
  "audioBefore": "gong.wav",
  "audioAfter": "gong.wav"
}
```

Nur Audio ohne TTS-Text:

```json
{
  "audio": "gong.wav",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "volume": 45
}
```

Auch `audioBefore` und `audioAfter` können ohne `text` gesendet werden. Dann wird nur diese Audiodatei bzw. die Kombination aus beiden Dateien abgespielt.

Alias-Felder funktionieren ebenfalls: `beforeAudio`, `intro`, `introAudio`, `afterAudio`, `outro`, `outroAudio`.

Damit unterschiedliche Dateiformate und Sampleraten sauber an Piper-TTS angehängt werden können, nutzt der Server `ffmpeg`.

## Download-Dateien

Im Menübereich **Download** können Audiodateien erstellt werden, ohne sie direkt auf den HomePods abzuspielen. Möglich sind:

- TTS aus Text
- TTS mit Audio vorher/nachher
- reine Audiodateien ohne TTS-Text

Die Dateien werden als WAV gespeichert und können direkt im Browser heruntergeladen werden. Sie liegen auf dem Server hier:

```text
/root/TTS/downloads
```

Beim Überschreiben oder Löschen einer Download-Datei wird vorher ein Backup unter `/root/TTS/backups` erstellt.

API-Beispiel:

```bash
curl -X POST http://127.0.0.1:16619/api/downloads \
  -H 'content-type: application/json' \
  --data '{"name":"tuerklingel.wav","text":"Es hat geklingelt.","voice":"de_DE-ramona-low","audioBefore":"gong.wav"}'
```

Nur Audio als Download-Datei:

```bash
curl -X POST http://127.0.0.1:16619/api/downloads \
  -H 'content-type: application/json' \
  --data '{"name":"gong-kopie.wav","audio":"gong.wav"}'
```

Vorhandene Download-Dateien auflisten:

```bash
curl http://127.0.0.1:16619/api/downloads
```

Eine Datei herunterladen:

```text
http://127.0.0.1:16619/api/downloads/file?name=tuerklingel.wav
```

## Stimmen

Standardstimme:

```text
de_DE-thorsten-medium
```

Weitere getestete deutsche Piper-Stimmen:

```text
de_DE-kerstin-low
de_DE-ramona-low
```

Neue Stimmen können über die Weboberfläche geladen werden. Benötigt werden:

- Name, z. B. `de_DE-ramona-low`
- Modell-URL, z. B. `.onnx`
- Config-URL, z. B. `.onnx.json`

Beispiel Ramona:

```text
https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/ramona/low/de_DE-ramona-low.onnx
https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/ramona/low/de_DE-ramona-low.onnx.json
```

Die Modelle liegen nach dem Download hier:

```text
/root/TTS/models/piper
```

## Verlauf und Backups

Der Verlauf liegt in:

```text
/root/TTS/data/history.jsonl
```

In der Weboberfläche kann der Verlauf gelöscht werden. Vorher wird automatisch ein Backup nach `/root/TTS/backups` geschrieben.

Auch Konfigurationsänderungen, gelöschte Verläufe, überschriebenen Stimmen und Audiodateien werden vor dem Ändern gesichert.

## API

```text
GET    /api/health
GET    /api/config
POST   /api/config
GET    /api/outputs
POST   /api/outputs/refresh
POST   /api/outputs/auth
GET    /api/audio
POST   /api/audio
DELETE /api/audio?name=DATEI
GET    /api/downloads
POST   /api/downloads
GET    /api/downloads/file?name=DATEI
DELETE /api/downloads?name=DATEI
GET    /api/voices
POST   /api/voices/install
POST   /api/say
GET    /api/history
DELETE /api/history
```

Ansage per HTTP:

```bash
curl -X POST http://127.0.0.1:16619/api/say \
  -H 'content-type: application/json' \
  --data '{"text":"Testansage","outputNames":["Wohnzimmer"],"voice":"de_DE-ramona-low","volume":45,"volumes":{"Wohnzimmer":35}}'
```

Nur Audio per HTTP:

```bash
curl -X POST http://127.0.0.1:16619/api/say \
  -H 'content-type: application/json' \
  --data '{"audio":"gong.wav","outputNames":["Wohnzimmer"],"volume":45}'
```

AirPlay-Geräte neu suchen:

```bash
curl -X POST http://127.0.0.1:16619/api/outputs/refresh
```

Wenn `security.apiToken` gesetzt ist, muss der Token als Header oder Query-Parameter mitgegeben werden:

```text
Authorization: Bearer TOKEN
```

oder:

```text
?token=TOKEN
```

## Diagnose

```bash
cd /root/TTS
bash scripts/diagnose.sh
```

Nützliche Checks:

```bash
systemctl status homepod-tts
journalctl -u homepod-tts -n 100 --no-pager
curl http://127.0.0.1:16619/api/health
curl http://127.0.0.1:16619/api/outputs
curl http://127.0.0.1:3689/api/outputs
```

## Entwicklung

Lokaler Syntaxcheck:

```bash
npm run check
```

Start:

```bash
npm start
```

Der Server nutzt bewusst keine npm-Abhängigkeiten. MQTT, HTTP, Datei-Upload und OwnTone-Anbindung sind in `server.js` implementiert.
