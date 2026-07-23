const $ = id => document.getElementById(id);
let currentConfig = null;
let outputs = [];
let voices = [];
let audioFiles = [];

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    headers: { ...(isForm ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}

function fillConfig() {
  $('mqttEnabled').checked = Boolean(currentConfig.mqtt.enabled);
  $('mqttHost').value = currentConfig.mqtt.host || '';
  $('mqttPort').value = currentConfig.mqtt.port || 1883;
  $('mqttSayTopic').value = currentConfig.mqtt.topics.say || 'tts/say';
  $('mqttSettingsTopic').value = currentConfig.mqtt.topics.settings || 'tts/settings';
  $('owntoneUrl').value = currentConfig.owntone.baseUrl || '';
  $('audioDirectory').value = currentConfig.owntone.audioDirectory || '';
  $('volume').value = currentConfig.owntone.volume ?? 50;
  $('speed').value = currentConfig.tts.speed ?? 165;
  $('clearQueue').checked = Boolean(currentConfig.owntone.clearQueue);
}

function currentDefaultOutputIds() {
  return [...(currentConfig?.owntone?.defaultOutputIds || []), currentConfig?.owntone?.defaultOutputId].filter(Boolean).map(String);
}

function currentDefaultOutputNames() {
  return [...(currentConfig?.owntone?.defaultOutputNames || []), currentConfig?.owntone?.defaultOutputName].filter(Boolean);
}

function fillOutputs() {
  const select = $('output');
  select.innerHTML = '';
  select.append(new Option('Default', ''));
  for (const out of outputs) {
    const auth = out.needs_auth_key || out.requires_auth ? ', PIN noetig' : '';
    const label = `${out.name} (${out.type}${out.selected ? ', aktiv' : ''}${auth})`;
    select.append(new Option(label, out.id));
  }
  const defaultIds = currentDefaultOutputIds();
  const defaultNames = currentDefaultOutputNames().map(name => name.toLowerCase());
  for (const option of select.options) {
    const out = outputs.find(item => String(item.id) === option.value);
    option.selected = defaultIds.includes(option.value) || defaultNames.includes(String(out?.name || '').toLowerCase());
  }
}

function fillDefaultOutputs() {
  const select = $('defaultOutputs');
  select.innerHTML = '';
  const defaultIds = currentDefaultOutputIds();
  const defaultNames = currentDefaultOutputNames().map(name => name.toLowerCase());
  for (const out of outputs) {
    const label = `${out.name} (${out.type}${out.selected ? ', aktiv' : ''})`;
    const option = new Option(label, out.name);
    option.selected = defaultIds.includes(String(out.id)) || defaultNames.includes(String(out.name || '').toLowerCase());
    select.append(option);
  }
}

function fillVoiceSelect(select, selectedValue) {
  select.innerHTML = '';
  const seen = new Set();
  for (const voice of voices) {
    if (!voice.voice || seen.has(voice.voice)) continue;
    seen.add(voice.voice);
    const engine = voice.engine ? `, ${voice.engine}` : '';
    select.append(new Option(`${voice.raw}${engine}`, voice.voice));
  }
  const preferred = ['de', 'de+f1', 'de+f2', 'de+f3', 'de+m1', 'de+m2', 'de+m3'];
  for (const voice of preferred) {
    if (seen.has(voice)) continue;
    select.append(new Option(`${voice} (espeak-ng)`, voice));
  }
  select.value = selectedValue || currentConfig?.tts?.voice || 'de_DE-thorsten-medium';
}

function fillVoices() {
  fillVoiceSelect($('voice'), currentConfig?.tts?.voice);
  fillVoiceSelect($('defaultVoice'), currentConfig?.tts?.voice);
}

function fillAudioSelect(select, selectedValue) {
  select.innerHTML = '';
  select.append(new Option('Kein Audio', ''));
  for (const file of audioFiles) select.append(new Option(file.name, file.name));
  select.value = selectedValue || '';
}

function fillAudio() {
  fillAudioSelect($('audioBefore'), currentConfig?.audio?.defaultBefore);
  fillAudioSelect($('audioAfter'), currentConfig?.audio?.defaultAfter);
  fillAudioSelect($('defaultAudioBefore'), currentConfig?.audio?.defaultBefore);
  fillAudioSelect($('defaultAudioAfter'), currentConfig?.audio?.defaultAfter);
  renderAudioList();
}

function selectedOutputNames(selectId) {
  return Array.from($(selectId).selectedOptions).map(option => option.value).filter(Boolean);
}

function selectedVoice(value) {
  return voices.find(voice => voice.voice === value);
}

function selectedAnnouncementOutputNames() {
  const selectedIds = Array.from($('output').selectedOptions).map(option => option.value).filter(Boolean);
  const names = selectedIds.map(id => outputs.find(out => String(out.id) === String(id))?.name).filter(Boolean);
  return names.length ? names : currentDefaultOutputNames();
}

function renderMqttExample() {
  const outputNames = selectedOutputNames('defaultOutputs');
  const example = {
    text: 'Die Waschmaschine ist fertig.',
    outputNames: outputNames.length ? outputNames : ['Wohnzimmer'],
    voice: $('defaultVoice').value || $('voice').value || 'de_DE-thorsten-medium',
    volume: Number($('volume').value || 50),
    volumes: Object.fromEntries((outputNames.length ? outputNames : ['Wohnzimmer']).map(name => [name, Number($('volume').value || 50)])),
    audioBefore: $('defaultAudioBefore').value || undefined,
    audioAfter: $('defaultAudioAfter').value || undefined,
    speed: Number($('speed').value || 165)
  };
  if (!example.audioBefore) delete example.audioBefore;
  if (!example.audioAfter) delete example.audioAfter;
  $('mqttExample').textContent = JSON.stringify(example, null, 2);
}

function renderAudioList() {
  const node = $('audioList');
  node.innerHTML = '';
  if (!audioFiles.length) {
    const div = document.createElement('div');
    div.className = 'item muted';
    div.textContent = 'Noch keine Audiodateien hochgeladen.';
    node.append(div);
    return;
  }
  for (const file of audioFiles) {
    const div = document.createElement('div');
    div.className = 'fileItem';
    const meta = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = file.name;
    const small = document.createElement('small');
    small.textContent = `${Math.round(file.size / 1024)} KB`;
    meta.append(strong, small);
    const button = document.createElement('button');
    button.className = 'dangerBtn';
    button.textContent = 'Loeschen';
    button.addEventListener('click', () => deleteAudio(file.name));
    div.append(meta, button);
    node.append(div);
  }
}

function renderHistory(items) {
  const node = $('history');
  node.innerHTML = '';
  if (!items.length) {
    const div = document.createElement('div');
    div.className = 'item muted';
    div.textContent = 'Kein Verlauf vorhanden.';
    node.append(div);
    return;
  }
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'item';
    const title = document.createElement('strong');
    title.textContent = item.type === 'say'
      ? `${item.outputNames?.join(', ') || 'Ansage'}`
      : item.type || 'Eintrag';
    const small = document.createElement('small');
    small.textContent = item.at || '';
    const text = document.createElement('div');
    text.textContent = item.text || item.message || item.error || item.reason || '';
    div.append(title, small, text);
    node.append(div);
  }
}

async function clearHistory() {
  if (!window.confirm('Verlauf wirklich loeschen? Es wird vorher ein Backup im TTS-Ordner gespeichert.')) return;
  try {
    $('clearHistoryBtn').disabled = true;
    setStatus('Loesche Verlauf...');
    await api('/api/history', { method: 'DELETE' });
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('clearHistoryBtn').disabled = false;
  }
}

async function refresh() {
  try {
    setStatus('Lade...');
    const [configData, outputData, voiceData, historyData, audioData, healthData] = await Promise.all([
      api('/api/config'),
      api('/api/outputs').catch(err => ({ outputs: [], error: err.message })),
      api('/api/voices'),
      api('/api/history'),
      api('/api/audio'),
      api('/api/health')
    ]);
    currentConfig = configData;
    outputs = outputData.outputs || [];
    voices = voiceData.voices || [];
    audioFiles = audioData.files || [];
    fillConfig();
    fillOutputs();
    fillDefaultOutputs();
    fillVoices();
    fillAudio();
    renderHistory(historyData.history || []);
    renderMqttExample();
    setStatus(healthData.status?.message || 'Bereit', healthData.status?.ok === false);
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function say() {
  const selectedOutputIds = Array.from($('output').selectedOptions).map(option => option.value).filter(Boolean);
  const payload = {
    text: $('text').value,
    outputIds: selectedOutputIds,
    voice: $('voice').value,
    volume: Number($('volume').value),
    audioBefore: $('audioBefore').value,
    audioAfter: $('audioAfter').value,
    speed: Number($('speed').value)
  };
  try {
    $('sayBtn').disabled = true;
    setStatus('Erzeuge und spiele Ansage...');
    await api('/api/say', { method: 'POST', body: JSON.stringify(payload) });
    $('text').value = '';
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('sayBtn').disabled = false;
  }
}

async function saveSettings() {
  const voice = selectedVoice($('defaultVoice').value);
  const payload = {
    mqtt: {
      enabled: $('mqttEnabled').checked,
      host: $('mqttHost').value.trim(),
      port: Number($('mqttPort').value),
      topics: {
        say: $('mqttSayTopic').value.trim(),
        settings: $('mqttSettingsTopic').value.trim(),
        status: currentConfig.mqtt.topics.status || 'tts/status'
      }
    },
    tts: {
      engine: voice?.engine || currentConfig.tts.engine || 'piper',
      voice: $('defaultVoice').value,
      speed: Number($('speed').value),
      piperCommand: currentConfig.tts.piperCommand,
      piperModelDir: currentConfig.tts.piperModelDir,
      piperModel: voice?.model || currentConfig.tts.piperModel,
      piperConfig: voice?.config || currentConfig.tts.piperConfig,
      piperLengthScale: currentConfig.tts.piperLengthScale,
      piperNoiseScale: currentConfig.tts.piperNoiseScale,
      piperNoiseWScale: currentConfig.tts.piperNoiseWScale,
      piperSpeaker: currentConfig.tts.piperSpeaker
    },
    owntone: {
      baseUrl: $('owntoneUrl').value.trim(),
      audioDirectory: $('audioDirectory').value.trim(),
      defaultOutputIds: [],
      defaultOutputId: '',
      defaultOutputNames: selectedOutputNames('defaultOutputs'),
      defaultOutputName: '',
      volume: Number($('volume').value),
      clearQueue: $('clearQueue').checked
    },
    audio: {
      assetsDirectory: currentConfig.audio?.assetsDirectory,
      defaultBefore: $('defaultAudioBefore').value,
      defaultAfter: $('defaultAudioAfter').value
    }
  };
  try {
    $('saveBtn').disabled = true;
    await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('saveBtn').disabled = false;
  }
}

async function saveCurrentAsDefault() {
  const names = selectedAnnouncementOutputNames();
  for (const option of $('defaultOutputs').options) option.selected = names.includes(option.value);
  $('defaultVoice').value = $('voice').value;
  $('defaultAudioBefore').value = $('audioBefore').value;
  $('defaultAudioAfter').value = $('audioAfter').value;
  await saveSettings();
}

async function uploadAudio() {
  const file = $('audioFile').files[0];
  if (!file) {
    setStatus('Bitte Audiodatei auswaehlen.', true);
    return;
  }
  const form = new FormData();
  form.append('file', file);
  form.append('name', $('audioName').value.trim() || file.name);
  try {
    $('uploadAudioBtn').disabled = true;
    setStatus('Lade Audio hoch...');
    await api('/api/audio', { method: 'POST', body: form });
    $('audioFile').value = '';
    $('audioName').value = '';
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('uploadAudioBtn').disabled = false;
  }
}

async function deleteAudio(name) {
  if (!window.confirm(`${name} wirklich loeschen? Es wird vorher ein Backup gespeichert.`)) return;
  try {
    await api(`/api/audio?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function installVoice() {
  const payload = {
    name: $('voiceName').value.trim(),
    modelUrl: $('voiceModelUrl').value.trim(),
    configUrl: $('voiceConfigUrl').value.trim(),
    setDefault: $('voiceSetDefault').checked
  };
  try {
    $('installVoiceBtn').disabled = true;
    setStatus('Lade Stimme...');
    await api('/api/voices/install', { method: 'POST', body: JSON.stringify(payload) });
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('installVoiceBtn').disabled = false;
  }
}

async function sendPin() {
  try {
    $('pinBtn').disabled = true;
    await api('/api/outputs/auth', {
      method: 'POST',
      body: JSON.stringify({ outputId: Array.from($('output').selectedOptions).map(option => option.value).filter(Boolean)[0], pin: $('airplayPin').value })
    });
    $('airplayPin').value = '';
    await refresh();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('pinBtn').disabled = false;
  }
}

$('sayBtn').addEventListener('click', say);
$('saveBtn').addEventListener('click', saveSettings);
$('saveCurrentBtn').addEventListener('click', saveCurrentAsDefault);
$('refreshBtn').addEventListener('click', refresh);
$('pinBtn').addEventListener('click', sendPin);
$('installVoiceBtn').addEventListener('click', installVoice);
$('clearHistoryBtn').addEventListener('click', clearHistory);
$('uploadAudioBtn').addEventListener('click', uploadAudio);
$('defaultOutputs').addEventListener('change', renderMqttExample);
$('defaultVoice').addEventListener('change', renderMqttExample);
$('defaultAudioBefore').addEventListener('change', renderMqttExample);
$('defaultAudioAfter').addEventListener('change', renderMqttExample);
$('volume').addEventListener('input', renderMqttExample);
$('speed').addEventListener('input', renderMqttExample);
refresh();
