'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(ROOT, 'backups');
const LOCAL_AUDIO_DIR = path.join(ROOT, 'audio');
const AUDIO_ASSET_DIR = path.join(ROOT, 'assets');
const HISTORY_PATH = path.join(DATA_DIR, 'history.jsonl');
const DEFAULT_PIPER_MODEL_DIR = '/root/TTS/models/piper';

const DEFAULT_CONFIG = {
  server: { host: '0.0.0.0', port: 16619, publicBaseUrl: 'http://192.168.150.162:16619' },
  mqtt: {
    enabled: true,
    host: '192.168.150.156',
    port: 1883,
    username: '',
    password: '',
    clientId: 'homepod-tts-server',
    topics: { say: 'tts/say', settings: 'tts/settings', status: 'tts/status' }
  },
  tts: {
    engine: 'piper',
    voice: 'de_DE-thorsten-medium',
    piperCommand: '/root/TTS/venv/bin/piper',
    piperModelDir: DEFAULT_PIPER_MODEL_DIR,
    piperModel: '/root/TTS/models/piper/de_DE-thorsten-medium.onnx',
    piperConfig: '/root/TTS/models/piper/de_DE-thorsten-medium.onnx.json',
    piperLengthScale: 1.0,
    piperNoiseScale: 0.667,
    piperNoiseWScale: 0.8,
    piperSpeaker: '',
    speed: 165,
    pitch: 50,
    amplitude: 160,
    maxTextLength: 1500,
    keepAudioFiles: 200
  },
  audio: {
    assetsDirectory: AUDIO_ASSET_DIR,
    defaultBefore: '',
    defaultAfter: ''
  },
  owntone: {
    baseUrl: 'http://127.0.0.1:3689',
    audioDirectory: '/srv/tts-audio',
    defaultOutputId: '',
    defaultOutputIds: [],
    defaultOutputName: '',
    defaultOutputNames: [],
    volume: 50,
    clearQueue: true,
    rescanWaitMs: 1200,
    rescanPollAttempts: 12
  },
  security: { apiToken: '' }
};

let config = merge(DEFAULT_CONFIG, {});
let mqttClient = null;
let speakQueue = Promise.resolve();
let lastStatus = { ok: true, message: 'starting', at: new Date().toISOString() };

function merge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
    '-',
    pad(d.getMilliseconds(), 3)
  ].join('');
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  await fsp.mkdir(LOCAL_AUDIO_DIR, { recursive: true });
  await fsp.mkdir(config?.audio?.assetsDirectory || AUDIO_ASSET_DIR, { recursive: true });
}

async function loadConfig() {
  await ensureDirs();
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    config = merge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    config = merge(DEFAULT_CONFIG, {});
    await saveConfig(config, 'initial');
  }
}

async function backupFile(filePath, label) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const name = `${nowStamp()}-${label}-${path.basename(filePath)}`;
    await fsp.writeFile(path.join(BACKUP_DIR, name), raw, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function saveConfig(nextConfig, reason = 'settings') {
  await ensureDirs();
  await backupFile(CONFIG_PATH, reason);
  config = merge(DEFAULT_CONFIG, nextConfig);
  await fsp.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await appendHistory({ type: 'settings', reason, config });
  restartMqtt();
}

async function appendHistory(entry) {
  await ensureDirs();
  await fsp.appendFile(HISTORY_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function execFileP(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120000, maxBuffer: 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function textResponse(res, status, value, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(value);
}

function getRequestBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseRequestBody(req) {
  const rawBuffer = await getRequestBody(req);
  if (!rawBuffer.length) return {};
  const raw = rawBuffer.toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) return JSON.parse(raw);
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { text: raw };
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function parseContentDisposition(value) {
  const out = {};
  for (const part of String(value || '').split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rest.length) continue;
    out[rawKey.toLowerCase()] = rest.join('=').trim().replace(/^"|"$/g, '');
  }
  return out;
}

async function parseMultipart(req) {
  const type = req.headers['content-type'] || '';
  const match = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('Multipart boundary fehlt.');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const body = await getRequestBody(req, 80 * 1024 * 1024);
  const fields = {};
  const files = [];

  for (let part of splitBuffer(body, boundary)) {
    if (part.length < 4) continue;
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(0, 2).toString() === '--') continue;
    if (part.subarray(part.length - 2).toString() === '\r\n') part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString('utf8');
    const content = part.subarray(headerEnd + 4);
    const headers = Object.fromEntries(headerText.split(/\r?\n/).map(line => {
      const idx = line.indexOf(':');
      if (idx === -1) return ['', ''];
      return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
    }).filter(([key]) => key));
    const disposition = parseContentDisposition(headers['content-disposition']);
    if (!disposition.name) continue;
    if (disposition.filename) {
      files.push({ field: disposition.name, filename: disposition.filename, contentType: headers['content-type'] || '', content });
    } else {
      fields[disposition.name] = content.toString('utf8');
    }
  }
  return { fields, files };
}

function safeAssetName(value) {
  const parsed = path.parse(String(value || 'audio.wav'));
  const base = parsed.name.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'audio';
  const ext = parsed.ext.toLowerCase() || '.wav';
  return `${base}${ext}`;
}

function audioAssetDir() {
  return config.audio?.assetsDirectory || AUDIO_ASSET_DIR;
}

function audioAssetPath(name) {
  const fileName = safeAssetName(name);
  const full = path.resolve(audioAssetDir(), fileName);
  const root = path.resolve(audioAssetDir());
  if (!full.startsWith(`${root}${path.sep}`) && full !== root) throw new Error('Ungueltiger Audiodateiname.');
  return full;
}

async function backupBinaryFile(filePath, label) {
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    await fsp.copyFile(filePath, path.join(BACKUP_DIR, `${nowStamp()}-${label}-${path.basename(filePath)}`));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function authorized(req, url) {
  const token = config.security.apiToken;
  if (!token) return true;
  const queryToken = url.searchParams.get('token');
  const auth = req.headers.authorization || '';
  return queryToken === token || auth === `Bearer ${token}`;
}

async function fetchOwnTone(endpoint, options = {}) {
  const base = config.owntone.baseUrl.replace(/\/$/, '');
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const response = await httpRequest(`${base}${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      ...(options.headers || {})
    },
    body
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`OwnTone ${response.statusCode} for ${endpoint}: ${response.body || response.statusMessage}`);
  }
  if (response.statusCode === 204 || !response.body) return null;
  return JSON.parse(response.body);
}

function httpRequest(target, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(parsed, {
      method: options.method,
      headers: options.headers,
      timeout: 15000
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout for ${target}`)));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getOutputs() {
  const data = await fetchOwnTone('/api/outputs');
  return data.outputs || [];
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function toList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null) return [];
  return String(value).split(/[,;]/).map(item => item.trim()).filter(Boolean);
}

function matchOutputsByName(outputs, wantedName) {
  const name = normalizeName(wantedName);
  if (!name) return [];
  const exact = outputs.filter(out => normalizeName(out.name) === name);
  if (exact.length) return exact;
  return outputs.filter(out => normalizeName(out.name).includes(name));
}

function uniqueOutputs(items) {
  const seen = new Set();
  return items.filter(out => {
    const id = String(out.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function volumeForOutput(output, request) {
  const fallback = clampInt(request.volume ?? config.owntone.volume, 0, 100, config.owntone.volume);
  const candidates = [String(output.name || ''), String(output.id || '')].filter(Boolean);
  const maps = [request.volumes, request.outputVolumes, request.volumeByOutput, request.volumeByName];

  for (const map of maps) {
    if (!map || Array.isArray(map) || typeof map !== 'object') continue;
    for (const key of candidates) {
      if (map[key] !== undefined) return clampInt(map[key], 0, 100, fallback);
    }
    const normalizedName = normalizeName(output.name);
    const foundKey = Object.keys(map).find(key => normalizeName(key) === normalizedName || String(key) === String(output.id));
    if (foundKey) return clampInt(map[foundKey], 0, 100, fallback);
  }

  if (Array.isArray(request.outputVolumes)) {
    const found = request.outputVolumes.find(item => {
      if (!item || typeof item !== 'object') return false;
      return candidates.includes(String(item.id || item.outputId || item.output || ''))
        || normalizeName(item.name || item.outputName) === normalizeName(output.name);
    });
    if (found) return clampInt(found.volume, 0, 100, fallback);
  }

  return fallback;
}

async function resolveOutputs(request) {
  const outputs = await getOutputs();
  const airplay = outputs.filter(out => String(out.type || '').startsWith('AirPlay'));
  const requestedIds = [...toList(request.outputIds), ...toList(request.outputId), ...toList(request.output)];
  const requestedNames = [...toList(request.outputNames), ...toList(request.outputName)];
  const defaultIds = [...toList(config.owntone.defaultOutputIds), ...toList(config.owntone.defaultOutputId)];
  const defaultNames = [...toList(config.owntone.defaultOutputNames), ...toList(config.owntone.defaultOutputName)];

  let selected = [];
  if (requestedIds.length) selected = outputs.filter(out => requestedIds.includes(String(out.id)));
  if (!selected.length && requestedNames.length) {
    selected = uniqueOutputs(requestedNames.flatMap(name => matchOutputsByName(outputs, name)));
  }
  if (!selected.length && defaultIds.length) selected = outputs.filter(out => defaultIds.includes(String(out.id)));
  if (!selected.length && defaultNames.length) {
    selected = uniqueOutputs(defaultNames.flatMap(name => matchOutputsByName(outputs, name)));
  }
  if (!selected.length) selected = airplay.filter(out => out.selected);
  if (!selected.length && airplay.length) selected = [airplay[0]];

  if (!selected.length) {
    throw new Error('Kein AirPlay/HomePod-Output gefunden. Ist OwnTone gestartet und im selben Netzwerk?');
  }
  return selected;
}

async function setOutputs(outputs, request) {
  const ids = outputs.map(out => String(out.id));
  const locked = outputs.filter(out => out.needs_auth_key || out.requires_auth);
  if (locked.length) {
    throw new Error(`AirPlay-Verifikation noetig fuer: ${locked.map(out => out.name).join(', ')}. Bitte in der Webseite Output waehlen, PIN eingeben und "PIN senden" klicken.`);
  }
  await fetchOwnTone('/api/outputs/set', { method: 'PUT', body: { outputs: ids } });
  await Promise.all(outputs.map(out => {
    const vol = volumeForOutput(out, request);
    return fetchOwnTone(`/api/player/volume?volume=${vol}&output_id=${encodeURIComponent(String(out.id))}`, { method: 'PUT' });
  }));
}

async function authorizeOutput(outputId, pin) {
  if (!outputId) throw new Error('Output ID fehlt.');
  if (!pin) throw new Error('PIN fehlt.');
  await fetchOwnTone(`/api/outputs/${encodeURIComponent(outputId)}`, {
    method: 'PUT',
    body: { selected: true, pin: String(pin).trim() }
  });
  return { ok: true, outputId };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function piperLengthScaleFromSpeed(value) {
  const speed = clampInt(value, 80, 450, 165);
  return clampNumber(165 / speed, 0.5, 2.0, 1.0);
}

function safeVoiceName(value) {
  return String(value || '')
    .replace(/\.onnx(\.json)?$/i, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function piperModelDir() {
  return config.tts.piperModelDir || path.dirname(config.tts.piperModel || path.join(DEFAULT_PIPER_MODEL_DIR, 'voice.onnx'));
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function voiceNameFromModelPath(modelPath) {
  return safeVoiceName(path.basename(modelPath || '', '.onnx'));
}

function voiceNameFromUrl(modelUrl) {
  const parsed = new URL(modelUrl);
  return safeVoiceName(path.basename(decodeURIComponent(parsed.pathname), '.onnx'));
}

async function scanPiperVoices() {
  const dir = piperModelDir();
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const voices = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.onnx')) continue;
    const model = path.join(dir, entry.name);
    const modelConfig = `${model}.json`;
    const name = voiceNameFromModelPath(model);
    voices.push({
      raw: `${name} (Piper)`,
      language: name.startsWith('de_') ? 'de_DE' : '',
      name,
      voice: name,
      engine: 'piper',
      model,
      config: await fileExists(modelConfig) ? modelConfig : ''
    });
  }
  if (config.tts.piperModel && !voices.some(voice => voice.model === config.tts.piperModel)) {
    const name = config.tts.voice || voiceNameFromModelPath(config.tts.piperModel) || 'piper';
    voices.unshift({
      raw: `${name} (Piper)`,
      language: name.startsWith('de_') ? 'de_DE' : '',
      name,
      voice: name,
      engine: 'piper',
      model: config.tts.piperModel,
      config: config.tts.piperConfig || ''
    });
  }
  return voices.sort((a, b) => a.name.localeCompare(b.name));
}

async function resolvePiperVoice(wantedVoice) {
  const voices = await scanPiperVoices();
  const wanted = String(wantedVoice || config.tts.voice || '').trim();
  const found = voices.find(voice => voice.voice === wanted || voice.name === wanted);
  if (found) return found;
  if (config.tts.piperModel) {
    return {
      name: config.tts.voice || voiceNameFromModelPath(config.tts.piperModel) || 'piper',
      voice: config.tts.voice || 'piper',
      model: config.tts.piperModel,
      config: config.tts.piperConfig || ''
    };
  }
  throw new Error(`Piper-Stimme nicht gefunden: ${wanted || '(leer)'}`);
}

function downloadFile(sourceUrl, destination) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(sourceUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(parsed, { timeout: 120000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, sourceUrl).toString();
        downloadFile(nextUrl, destination).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`Download fehlgeschlagen (${res.statusCode}) fuer ${sourceUrl}`));
        return;
      }
      const file = fs.createWriteStream(destination);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout fuer ${sourceUrl}`)));
    req.on('error', reject);
  });
}

async function backupExistingVoiceFile(filePath) {
  if (!(await fileExists(filePath))) return;
  await ensureDirs();
  await fsp.copyFile(filePath, path.join(BACKUP_DIR, `${nowStamp()}-voice-${path.basename(filePath)}`));
}

async function installPiperVoice(request) {
  const modelUrl = String(request.modelUrl || '').trim();
  if (!modelUrl) throw new Error('modelUrl fehlt.');
  const configUrl = String(request.configUrl || `${modelUrl}.json`).trim();
  const voiceName = safeVoiceName(request.name || voiceNameFromUrl(modelUrl));
  if (!voiceName) throw new Error('Stimmenname fehlt.');
  const dir = piperModelDir();
  await fsp.mkdir(dir, { recursive: true });
  const modelPath = path.join(dir, `${voiceName}.onnx`);
  const modelConfigPath = `${modelPath}.json`;

  await backupExistingVoiceFile(modelPath);
  await backupExistingVoiceFile(modelConfigPath);
  await downloadFile(modelUrl, modelPath);
  await downloadFile(configUrl, modelConfigPath);

  const installed = {
    raw: `${voiceName} (Piper)`,
    language: voiceName.startsWith('de_') ? 'de_DE' : '',
    name: voiceName,
    voice: voiceName,
    engine: 'piper',
    model: modelPath,
    config: modelConfigPath
  };

  if (request.setDefault !== false) {
    await saveConfig(merge(config, {
      tts: {
        engine: 'piper',
        voice: voiceName,
        piperModel: modelPath,
        piperConfig: modelConfigPath
      }
    }), 'voice-install');
  }
  await appendHistory({ type: 'voice-install', ok: true, voice: voiceName, model: modelPath });
  return installed;
}

async function listAudioAssets() {
  await ensureDirs();
  const dir = audioAssetDir();
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    files.push({
      name: entry.name,
      size: stat.size,
      mtime: stat.mtime.toISOString()
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function uploadAudioAsset(req) {
  await ensureDirs();
  const { fields, files } = await parseMultipart(req);
  const file = files.find(item => item.field === 'file') || files[0];
  if (!file) throw new Error('Audiodatei fehlt.');
  const name = safeAssetName(fields.name || file.filename);
  const ext = path.extname(name).toLowerCase();
  if (!['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) {
    throw new Error('Unterstuetzt werden WAV, MP3, M4A, AAC, FLAC und OGG.');
  }
  const target = audioAssetPath(name);
  await backupBinaryFile(target, 'audio-upload');
  await fsp.writeFile(target, file.content);
  const stat = await fsp.stat(target);
  const asset = { name, size: stat.size, mtime: stat.mtime.toISOString() };
  await appendHistory({ type: 'audio-upload', ok: true, audio: name, size: stat.size });
  return asset;
}

async function deleteAudioAsset(name) {
  const target = audioAssetPath(name);
  await backupBinaryFile(target, 'audio-delete');
  await fsp.unlink(target);
  await appendHistory({ type: 'audio-delete', ok: true, audio: safeAssetName(name) });
  return { ok: true, name: safeAssetName(name) };
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function requestAudioBefore(request) {
  if ('audioBefore' in request || 'beforeAudio' in request || 'intro' in request || 'introAudio' in request) {
    return firstValue(request.audioBefore, request.beforeAudio, request.intro, request.introAudio);
  }
  return firstValue(config.audio?.defaultBefore);
}

function requestAudioAfter(request) {
  if ('audioAfter' in request || 'afterAudio' in request || 'outro' in request || 'outroAudio' in request) {
    return firstValue(request.audioAfter, request.afterAudio, request.outro, request.outroAudio);
  }
  return firstValue(config.audio?.defaultAfter);
}

async function combineAudioAttachments(generated, request) {
  const before = requestAudioBefore(request);
  const after = requestAudioAfter(request);
  if (!before && !after) return { ...generated, audioBefore: '', audioAfter: '' };

  const inputs = [];
  if (before) inputs.push({ role: 'before', file: audioAssetPath(before), name: safeAssetName(before) });
  inputs.push({ role: 'tts', file: generated.localPath, name: path.basename(generated.localPath) });
  if (after) inputs.push({ role: 'after', file: audioAssetPath(after), name: safeAssetName(after) });
  for (const input of inputs) {
    if (!(await fileExists(input.file))) throw new Error(`Audiodatei nicht gefunden: ${input.name}`);
  }

  const combinedBase = `${generated.fileBase}-audio`;
  const combinedFile = path.join(LOCAL_AUDIO_DIR, `${combinedBase}.wav`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of inputs) args.push('-i', input.file);
  const chains = inputs.map((_, index) => `[${index}:a]aformat=sample_rates=44100:channel_layouts=mono[a${index}]`).join(';');
  const concatInputs = inputs.map((_, index) => `[a${index}]`).join('');
  args.push(
    '-filter_complex',
    `${chains};${concatInputs}concat=n=${inputs.length}:v=0:a=1[out]`,
    '-map',
    '[out]',
    '-ar',
    '44100',
    '-ac',
    '1',
    combinedFile
  );
  await execFileP('ffmpeg', args, { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  return {
    fileBase: combinedBase,
    localPath: combinedFile,
    ownTonePath: path.posix.join(config.owntone.audioDirectory, `${combinedBase}.wav`),
    audioBefore: before ? safeAssetName(before) : '',
    audioAfter: after ? safeAssetName(after) : ''
  };
}

function sanitizeText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) throw new Error('Text fehlt.');
  if (value.length > config.tts.maxTextLength) {
    throw new Error(`Text ist zu lang. Maximum: ${config.tts.maxTextLength} Zeichen.`);
  }
  return value;
}

async function synthesize(text, request) {
  const fileBase = `tts-${nowStamp()}`;
  const outFile = path.join(LOCAL_AUDIO_DIR, `${fileBase}.wav`);
  const engine = config.tts.engine || 'piper';

  if (engine === 'piper') {
    const selectedVoice = await resolvePiperVoice(request.voice || config.tts.voice);
    const command = config.tts.piperCommand || '/root/TTS/venv/bin/piper';
    const model = selectedVoice.model;
    const modelConfig = selectedVoice.config || config.tts.piperConfig;
    const lengthScale = request.lengthScale === undefined
      ? piperLengthScaleFromSpeed(request.speed ?? config.tts.speed)
      : clampNumber(request.lengthScale, 0.5, 2.0, 1.0);
    if (!model) throw new Error('Piper Modell fehlt in tts.piperModel.');
    const inputFile = path.join(DATA_DIR, `${fileBase}.txt`);
    const args = [
      '-m', model,
      '-i', inputFile,
      '-f', outFile,
      '--length-scale', String(lengthScale),
      '--noise-scale', String(clampNumber(request.noiseScale ?? config.tts.piperNoiseScale, 0.0, 2.0, 0.667)),
      '--noise-w-scale', String(clampNumber(request.noiseWScale ?? config.tts.piperNoiseWScale, 0.0, 2.0, 0.8))
    ];
    if (modelConfig) args.splice(2, 0, '-c', modelConfig);
    if (config.tts.piperSpeaker !== '') args.push('--speaker', String(config.tts.piperSpeaker));

    await fsp.writeFile(inputFile, `${text}\n`, 'utf8');
    try {
      await execFileP(command, args);
    } finally {
      await fsp.unlink(inputFile).catch(() => {});
    }
    return { fileBase, localPath: outFile, ownTonePath: path.posix.join(config.owntone.audioDirectory, `${fileBase}.wav`) };
  }

  if (engine === 'espeak-ng') {
    const voice = request.voice || config.tts.voice || 'de';
    const speed = clampInt(request.speed ?? config.tts.speed, 80, 450, 165);
    const pitch = clampInt(request.pitch ?? config.tts.pitch, 0, 99, 50);
    const amplitude = clampInt(request.amplitude ?? config.tts.amplitude, 0, 200, 160);
    await execFileP('espeak-ng', ['-v', voice, '-s', String(speed), '-p', String(pitch), '-a', String(amplitude), '-w', outFile, text]);
    return { fileBase, localPath: outFile, ownTonePath: path.posix.join(config.owntone.audioDirectory, `${fileBase}.wav`) };
  }

  throw new Error(`Unbekannte TTS-Engine: ${engine}`);
}

async function cleanupAudioFiles() {
  const keep = clampInt(config.tts.keepAudioFiles, 1, 2000, 200);
  const files = await fsp.readdir(LOCAL_AUDIO_DIR, { withFileTypes: true }).catch(() => []);
  const wavs = [];
  for (const dirent of files) {
    if (!dirent.isFile() || !dirent.name.endsWith('.wav')) continue;
    const full = path.join(LOCAL_AUDIO_DIR, dirent.name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat) wavs.push({ full, mtimeMs: stat.mtimeMs });
  }
  wavs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(wavs.slice(keep).map(file => fsp.unlink(file.full).catch(() => {})));
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findTrack(generated) {
  const attempts = clampInt(config.owntone.rescanPollAttempts, 1, 60, 12);
  const waitMs = clampInt(config.owntone.rescanWaitMs, 100, 10000, 500);
  const expectedBase = path.posix.basename(generated.ownTonePath);

  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await wait(waitMs);
    const query = encodeURIComponent(generated.fileBase);
    const result = await fetchOwnTone(`/api/search?type=tracks&query=${query}&limit=10`).catch(() => null);
    const items = result?.tracks?.items || [];
    const found = items.find(item => path.posix.basename(item.path || '') === expectedBase || item.uri);
    if (found?.uri) return found;
  }

  throw new Error(`OwnTone findet ${expectedBase} nicht. Pruefe, ob OwnTone ${config.owntone.audioDirectory} scannt und lesen darf.`);
}

async function playTrack(track) {
  const params = new URLSearchParams({
    uris: track.uri,
    playback: 'start',
    clear: String(Boolean(config.owntone.clearQueue))
  });
  return fetchOwnTone(`/api/queue/items/add?${params.toString()}`, { method: 'POST' });
}

async function say(request) {
  const text = sanitizeText(request.text || request.message || request.payload);
  const outputs = await resolveOutputs(request);
  await setOutputs(outputs, request);
  const rawGenerated = await synthesize(text, request);
  const generated = await combineAudioAttachments(rawGenerated, request);
  await cleanupAudioFiles();
  const track = await findTrack(generated);
  const queue = await playTrack(track);
  const entry = {
    type: 'say',
    ok: true,
    text,
    outputIds: outputs.map(out => out.id),
    outputNames: outputs.map(out => out.name),
    outputVolumes: Object.fromEntries(outputs.map(out => [out.name, volumeForOutput(out, request)])),
    voice: request.voice || config.tts.voice,
    audioBefore: generated.audioBefore || '',
    audioAfter: generated.audioAfter || '',
    file: generated.localPath,
    trackUri: track.uri
  };
  await appendHistory(entry);
  setStatus(true, `Gespielt: ${outputs.map(out => out.name).join(', ')}`, entry);
  return { ...entry, queue };
}

function enqueueSay(request) {
  const job = speakQueue.then(() => say(request));
  speakQueue = job.catch(() => {});
  return job;
}

function setStatus(ok, message, extra = {}) {
  lastStatus = { ok, message, at: new Date().toISOString(), ...extra };
  mqttPublishStatus(lastStatus);
}

async function listVoices() {
  const out = await scanPiperVoices();
  try {
    const { stdout } = await execFileP('espeak-ng', ['--voices']);
    out.push(...stdout.split(/\r?\n/).slice(1).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        raw: line.trim(),
        language: parts[1] || '',
        name: parts[3] || parts[4] || '',
        voice: parts[3] || '',
        engine: 'espeak-ng'
      };
    }).filter(voice => voice.raw));
    return out;
  } catch (err) {
    out.push({ raw: `espeak-ng nicht verfuegbar: ${err.message}`, language: '', name: '', voice: '', engine: 'espeak-ng' });
    return out;
  }
}

async function readHistory(limit = 50) {
  const raw = await fsp.readFile(HISTORY_PATH, 'utf8').catch(() => '');
  return raw.trim().split(/\r?\n/).filter(Boolean).slice(-limit).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  }).reverse();
}

async function clearHistory() {
  await ensureDirs();
  await backupFile(HISTORY_PATH, 'history-clear');
  await fsp.writeFile(HISTORY_PATH, '', 'utf8');
  setStatus(true, 'Verlauf geloescht');
  return { ok: true, backupDir: BACKUP_DIR };
}

async function serveStatic(url, res) {
  const target = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, target));
  if (!filePath.startsWith(PUBLIC_DIR)) return textResponse(res, 403, 'Forbidden');
  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    textResponse(res, 404, 'Not found');
  }
}

async function handleApi(req, res, url) {
  if (!authorized(req, url)) return jsonResponse(res, 401, { ok: false, error: 'Unauthorized' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return jsonResponse(res, 200, { ok: true, status: lastStatus, configPath: CONFIG_PATH });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const safeConfig = merge(config, { security: { apiToken: config.security.apiToken ? '********' : '' } });
      return jsonResponse(res, 200, safeConfig);
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await parseRequestBody(req);
      const next = merge(config, body);
      if (body.security?.apiToken === '********') next.security.apiToken = config.security.apiToken;
      await saveConfig(next, 'web');
      return jsonResponse(res, 200, { ok: true, config: merge(config, { security: { apiToken: config.security.apiToken ? '********' : '' } }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/say') {
      const body = await parseRequestBody(req);
      const result = await enqueueSay(body);
      return jsonResponse(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/audio') {
      return jsonResponse(res, 200, { files: await listAudioAssets() });
    }
    if (req.method === 'POST' && url.pathname === '/api/audio') {
      return jsonResponse(res, 200, { ok: true, file: await uploadAudioAsset(req), files: await listAudioAssets() });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/audio') {
      return jsonResponse(res, 200, await deleteAudioAsset(url.searchParams.get('name') || ''));
    }
    if (req.method === 'GET' && url.pathname === '/api/outputs') {
      return jsonResponse(res, 200, { outputs: await getOutputs() });
    }
    if (req.method === 'POST' && url.pathname === '/api/outputs/auth') {
      const body = await parseRequestBody(req);
      return jsonResponse(res, 200, await authorizeOutput(body.outputId, body.pin));
    }
    if (req.method === 'GET' && url.pathname === '/api/voices') {
      return jsonResponse(res, 200, { voices: await listVoices() });
    }
    if (req.method === 'POST' && url.pathname === '/api/voices/install') {
      const body = await parseRequestBody(req);
      return jsonResponse(res, 200, { ok: true, voice: await installPiperVoice(body), voices: await listVoices() });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      return jsonResponse(res, 200, { history: await readHistory(Number(url.searchParams.get('limit') || 50)) });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/history') {
      return jsonResponse(res, 200, await clearHistory());
    }
    jsonResponse(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    setStatus(false, err.message);
    jsonResponse(res, 500, { ok: false, error: err.message, stderr: err.stderr || undefined });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(url, res);
}

function encodeLength(length) {
  const bytes = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 0x80;
    bytes.push(digit);
  } while (length > 0);
  return Buffer.from(bytes);
}

function utf8Field(value) {
  const body = Buffer.from(String(value || ''), 'utf8');
  const header = Buffer.alloc(2);
  header.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function mqttPacket(type, body) {
  return Buffer.concat([Buffer.from([type]), encodeLength(body.length), body]);
}

class SimpleMqttClient {
  constructor(settings, onMessage) {
    this.settings = settings;
    this.onMessage = onMessage;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.packetId = 1;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.connected = false;
    this.closed = false;
  }

  connect() {
    if (!this.settings.enabled || this.closed) return;
    this.socket = net.createConnection({ host: this.settings.host, port: this.settings.port || 1883 }, () => this.sendConnect());
    this.socket.on('data', data => this.handleData(data));
    this.socket.on('error', err => setStatus(false, `MQTT Fehler: ${err.message}`));
    this.socket.on('close', () => this.scheduleReconnect());
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.connected = false;
    if (this.socket) {
      this.socket.removeAllListeners('close');
      this.socket.destroy();
    }
  }

  sendConnect() {
    const flags = 0x02 | (this.settings.username ? 0x80 : 0) | (this.settings.password ? 0x40 : 0);
    const variable = Buffer.concat([
      utf8Field('MQTT'),
      Buffer.from([4, flags, 0, 60])
    ]);
    const payload = [utf8Field(this.settings.clientId || `homepod-tts-${process.pid}`)];
    if (this.settings.username) payload.push(utf8Field(this.settings.username));
    if (this.settings.password) payload.push(utf8Field(this.settings.password));
    this.socket.write(mqttPacket(0x10, Buffer.concat([variable, ...payload])));
  }

  subscribe(topic) {
    const id = this.packetId++;
    const header = Buffer.alloc(2);
    header.writeUInt16BE(id, 0);
    const body = Buffer.concat([header, utf8Field(topic), Buffer.from([0])]);
    this.socket.write(mqttPacket(0x82, body));
  }

  publish(topic, payload) {
    if (!this.connected || !this.socket) return;
    const body = Buffer.concat([utf8Field(topic), Buffer.from(String(payload), 'utf8')]);
    this.socket.write(mqttPacket(0x30, body));
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      let multiplier = 1;
      let value = 0;
      let offset = 1;
      let digit;
      do {
        if (offset >= this.buffer.length) return;
        digit = this.buffer[offset++];
        value += (digit & 127) * multiplier;
        multiplier *= 128;
      } while ((digit & 128) !== 0);
      const end = offset + value;
      if (this.buffer.length < end) return;
      const packet = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end);
      this.handlePacket(packet, offset);
    }
  }

  handlePacket(packet, bodyOffset) {
    const type = packet[0] >> 4;
    const body = packet.subarray(bodyOffset);
    if (type === 2) {
      this.connected = true;
      const topics = this.settings.topics || {};
      this.subscribe(topics.say || 'tts/say');
      this.subscribe(topics.settings || 'tts/settings');
      this.pingTimer = setInterval(() => this.socket?.write(Buffer.from([0xc0, 0x00])), 30000);
      setStatus(true, `MQTT verbunden: ${this.settings.host}:${this.settings.port || 1883}`);
    } else if (type === 3) {
      let p = 0;
      const topicLength = body.readUInt16BE(p);
      p += 2;
      const topic = body.subarray(p, p + topicLength).toString('utf8');
      p += topicLength;
      const qos = (packet[0] & 0x06) >> 1;
      let packetId = null;
      if (qos > 0) {
        packetId = body.readUInt16BE(p);
        p += 2;
      }
      const message = body.subarray(p).toString('utf8');
      if (qos === 1 && packetId) {
        const ack = Buffer.alloc(4);
        ack[0] = 0x40;
        ack[1] = 0x02;
        ack.writeUInt16BE(packetId, 2);
        this.socket.write(ack);
      }
      this.onMessage(topic, message);
    }
  }

  scheduleReconnect() {
    clearInterval(this.pingTimer);
    this.connected = false;
    if (this.closed || this.reconnectTimer || !this.settings.enabled) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }
}

function parseMqttPayload(payload) {
  const trimmed = String(payload || '').trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  return { text: trimmed };
}

function handleMqttMessage(topic, payload) {
  const topics = config.mqtt.topics || {};
  Promise.resolve().then(async () => {
    if (topic === (topics.settings || 'tts/settings')) {
      const body = parseMqttPayload(payload);
      await saveConfig(merge(config, body), 'mqtt');
      setStatus(true, 'Settings per MQTT gespeichert');
      return;
    }
    if (topic === (topics.say || 'tts/say')) {
      const body = parseMqttPayload(payload);
      await enqueueSay(body);
    }
  }).catch(err => {
    setStatus(false, `MQTT Nachricht fehlgeschlagen: ${err.message}`);
    appendHistory({ type: 'error', source: 'mqtt', topic, error: err.message }).catch(() => {});
  });
}

function mqttPublishStatus(status) {
  const topic = config.mqtt?.topics?.status || 'tts/status';
  if (mqttClient) mqttClient.publish(topic, JSON.stringify(status));
}

function restartMqtt() {
  if (mqttClient) mqttClient.close();
  mqttClient = null;
  if (config.mqtt.enabled) {
    mqttClient = new SimpleMqttClient(config.mqtt, handleMqttMessage);
    mqttClient.connect();
  }
}

async function main() {
  await loadConfig();
  if (process.env.HOST) config.server.host = process.env.HOST;
  if (process.env.PORT) config.server.port = clampInt(process.env.PORT, 1, 65535, config.server.port);
  restartMqtt();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => jsonResponse(res, 500, { ok: false, error: err.message }));
  });
  server.on('error', err => {
    console.error(`HTTP Server Fehler: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.server.port, config.server.host, () => {
    const message = `TTS Server laeuft auf ${config.server.host}:${config.server.port}`;
    console.log(message);
    setStatus(true, message);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
