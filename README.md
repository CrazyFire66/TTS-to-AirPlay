# TTS to AirPlay

Node.js-Server fuer kostenlose Offline-TTS-Ansagen, die per OwnTone/AirPlay auf HomePods ausgegeben werden. Texte koennen ueber die Weboberflaeche oder per MQTT gesendet werden.

## Funktionen

- Web UI fuer Ansagen, HomePod-Auswahl, Standardziele, Lautstaerke und Stimmen
- Aktuelle Ansage-Auswahl als Standard speichern
- MQTT-Eingang fuer Automationen, z. B. Home Assistant, ioBroker oder Node-RED
- Mehrere HomePods gleichzeitig per `outputNames`
- Piper TTS als kostenlose Offline-Stimme
- `espeak-ng` als Fallback
- Neue Piper-Stimmen ueber die Weboberflaeche laden
- Verlauf anzeigen und mit Backup loeschen
- Automatische Backups bei Konfigurationsaenderungen
- Systemd-Service fuer dauerhaften Betrieb

## Architektur

HomePods werden nicht direkt vom Node.js-Prozess angesteuert. OwnTone uebernimmt AirPlay/AirPlay 2 und stellt eine lokale HTTP-API bereit. Diese App erzeugt eine WAV-Datei mit Piper, legt sie in `/srv/tts-audio` ab, waehlt die gewuenschten OwnTone-Ausgaenge und startet die Wiedergabe.

```text
Web UI / MQTT
    |
    v
Node.js TTS Server
    |
    v
Piper erzeugt WAV -> /srv/tts-audio
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

Danach die Weboberflaeche oeffnen:

```text
http://SERVER-IP:16619
```

Im aktuellen Heimnetz ist die vorkonfigurierte Adresse:

```text
http://192.168.150.162:16619
```

## OwnTone

OwnTone muss den Audio-Ordner scannen:

```text
/srv/tts-audio
```

Falls OwnTone Ansagen nicht findet, in `/etc/owntone.conf` den Library-Ordner pruefen:

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

Wichtige Standardwerte:

```json
{
  "mqtt": {
    "host": "192.168.150.156",
    "topics": {
      "say": "tts/say",
      "settings": "tts/settings",
      "status": "tts/status"
    }
  },
  "tts": {
    "engine": "piper",
    "voice": "de_DE-thorsten-medium"
  },
  "owntone": {
    "baseUrl": "http://127.0.0.1:3689",
    "audioDirectory": "/srv/tts-audio",
    "defaultOutputNames": ["Wohnzimmer"],
    "volume": 35
  }
}
```

Standard-HomePods sollten ueber Namen gesetzt werden, nicht ueber IDs. Das geht direkt in der Weboberflaeche unter **Einstellungen -> Default Ziele**.

In der Ansage-Box kann die aktuelle Auswahl mit **Auswahl als Standard speichern** dauerhaft gespeichert werden. Gespeichert werden:

- gewaehlte Geraete
- Stimme/Sprache
- Lautstaerke
- Tempo

## MQTT

Einfacher Text:

```bash
mosquitto_pub -h 192.168.150.156 -t tts/say -m "Die Waschmaschine ist fertig."
```

JSON Payload:

```json
{
  "text": "Haustuer wurde geoeffnet.",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "voice": "de_DE-ramona-low",
  "volume": 45,
  "speed": 165
}
```

`volume` gilt fuer alle ausgewaehlten HomePods. Einzelne HomePods koennen mit `volumes` ueberschrieben werden:

```json
{
  "text": "Haustuer wurde geoeffnet.",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "volume": 40,
  "volumes": {
    "Wohnzimmer": 30,
    "Schlafzimmer": 55
  }
}
```

Die Keys in `volumes` koennen Output-Namen oder OwnTone-Output-IDs sein. Alternativ ist auch eine Liste moeglich:

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

Mehrere HomePods gleichzeitig:

```json
{
  "text": "Guten Morgen.",
  "outputNames": ["Wohnzimmer", "Schlafzimmer"],
  "volume": 50,
  "speed": 180
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

Die Weboberflaeche zeigt ein passendes MQTT-JSON-Beispiel fuer die aktuellen Default-Ziele, Stimme und Lautstaerke.

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

Neue Stimmen koennen ueber die Weboberflaeche geladen werden. Benoetigt werden:

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

In der Weboberflaeche kann der Verlauf geloescht werden. Vorher wird automatisch ein Backup nach `/root/TTS/backups` geschrieben.

Auch Konfigurationsaenderungen und ueberschriebene Stimmen werden vor dem Aendern gesichert.

## API

```text
GET    /api/health
GET    /api/config
POST   /api/config
GET    /api/outputs
POST   /api/outputs/auth
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

Nuetzliche Checks:

```bash
systemctl status homepod-tts
journalctl -u homepod-tts -n 100 --no-pager
curl http://127.0.0.1:16619/api/health
curl http://127.0.0.1:16619/api/outputs
curl http://127.0.0.1:3689/api/outputs
```

## Troubleshooting

**Ansage wird erzeugt, aber nicht abgespielt**

OwnTone scannt wahrscheinlich `/srv/tts-audio` nicht oder hat keinen Zugriff auf den Ordner.

**HomePod erscheint nicht**

Avahi/mDNS und OwnTone muessen im selben Netzwerk wie der HomePod laufen. Bei VLANs oder Docker-Setups muss mDNS weitergeleitet werden.

**Piper-Stimme klingt nicht oder wirft Fehler**

Modell und Config muessen zusammenpassen. Eine `.onnx`-Datei hat normalerweise mehrere zehn MB; wenn sie nur wenige KB gross ist, wurde vermutlich eine HTML-Fehlerseite heruntergeladen.

**AirPlay PIN erforderlich**

In der Weboberflaeche den betroffenen Output markieren, PIN eingeben und **PIN senden** klicken.

## Entwicklung

Lokaler Syntaxcheck:

```bash
npm run check
```

Start:

```bash
npm start
```

Der Server nutzt bewusst keine npm-Abhaengigkeiten. MQTT, HTTP und OwnTone-Anbindung sind in `server.js` implementiert.
