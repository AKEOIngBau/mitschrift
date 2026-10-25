'use strict';

// ---------- Hilfen ----------
const $ = (s) => document.querySelector(s);
const CHUNK_MS = 5 * 60 * 1000; // alle 5 Minuten eine neue Audiodatei, damit nichts zu groß wird
const MAX_UPLOAD = 24 * 1024 * 1024;

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function renderMd(md) {
  const out = [];
  let inList = false;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) out.push(`<h3>${inline(h[1])}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

// ---------- Einstellungen ----------
const SETTINGS_KEY = 'mitschrift.settings';
const defaults = { groq: '', claude: '', lang: 'de', claudeModel: 'claude-sonnet-5-5', groqModel: 'llama-3.3-70b-versatile', prompt: '', live: false };
function loadSettings() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defaults }; }
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

// ---------- Speicher (IndexedDB) ----------
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('mitschrift', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('recs', { keyPath: 'id' });
        r.result.createObjectStore('audio', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const getRec = (id) => tx('recs', 'readonly', (s) => s.get(id));
const putRec = (rec) => tx('recs', 'readwrite', (s) => s.put(rec));
const allRecs = () => tx('recs', 'readonly', (s) => s.getAll());
const putAudio = (id, idx, blob) => tx('audio', 'readwrite', (s) => s.put({ key: `${id}:${idx}`, blob }));
const getAudio = async (id, idx) => (await tx('audio', 'readonly', (s) => s.get(`${id}:${idx}`)))?.blob;
async function deleteRec(rec) {
  await tx('recs', 'readwrite', (s) => s.delete(rec.id));
  for (let i = 0; i < rec.chunks.length; i++) await tx('audio', 'readwrite', (s) => s.delete(`${rec.id}:${i}`));
}
async function updateRec(id, patch) {
  const rec = await getRec(id);
  if (!rec) return null;
  Object.assign(rec, typeof patch === 'function' ? patch(rec) : patch);
  await putRec(rec);
  if (current && current.id === id) { current = rec; renderDetail(); }
  renderList();
  return rec;
}

// ---------- Aufnahme ----------
const rec = {
  stream: null, recorder: null, id: null, mime: '', idx: 0, chunkStart: 0,
  startedAt: 0, pausedTotal: 0, pausedAt: 0, rotateTimer: null, tick: null,
  audioCtx: null, analyser: null, wake: null, speech: null, liveFinal: '', liveInterim: '', saving: Promise.resolve(),
};
function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function elapsed() {
  if (!rec.startedAt) return 0;
  const now = rec.pausedAt || Date.now();
  return (now - rec.startedAt - rec.pausedTotal) / 1000;
}
function isRecording() { return !!rec.recorder; }

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('Dieser Browser kann nicht aufnehmen. Bitte Safari (iPhone) oder Chrome (Android) nutzen.', 6000);
    return;
  }
  $('#recHint').textContent = 'Mikrofon wird gestartet …';
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    $('#recHint').textContent = 'Tippen zum Aufnehmen';
    toast('Kein Mikrofonzugriff (' + (e.name || e.message) + '). Bitte in den Einstellungen des Handys erlauben.', 6000);
    return;
  }
  // Beendet das System das Mikrofon (Anruf, andere App), sauber abschließen statt hängen zu bleiben
  rec.stream.getAudioTracks().forEach((t) => (t.onended = () => {
    if (isRecording()) { toast('Das Mikrofon wurde vom Handy beendet. Aufnahme gespeichert.', 5000); toggleRec(); }
  }));
  rec.mime = pickMime();
  rec.id = uid();
  rec.idx = 0;
  rec.liveFinal = '';
  rec.liveInterim = '';
  rec.startedAt = Date.now();
  rec.pausedTotal = 0;
  rec.pausedAt = 0;
  await putRec({
    id: rec.id, title: 'Gespräch vom ' + new Date().toLocaleDateString('de-DE'), created: Date.now(),
    duration: 0, mime: rec.mime, chunks: [], status: 'recording', transcript: null, liveText: '', summary: '', qa: [],
  });
  newRecorder();
  rec.rotateTimer = setInterval(rotate, CHUNK_MS);
  rec.tick = setInterval(updateTimer, 500);
  startMeter();
  if ($('#optLive').checked) startLive();
  try { rec.wake = await navigator.wakeLock?.request('screen'); } catch {}
  try { navigator.storage?.persist?.(); } catch {}
  setRecUi('on');
}

function newRecorder() {
  const idx = rec.idx;
  const offset = elapsed();
  let r;
  try { r = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 32000 } : undefined); }
  catch { r = new MediaRecorder(rec.stream); }
  const parts = [];
  r.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
  r.onstop = () => {
    const blob = new Blob(parts, { type: r.mimeType || rec.mime || 'audio/webm' });
    const dur = elapsed() - offset;
    const id = rec.id;
    rec.saving = rec.saving.then(async () => {
      await putAudio(id, idx, blob);
      await updateRec(id, (x) => ({ chunks: [...x.chunks, { offset, dur, size: blob.size, type: blob.type }], duration: offset + dur }));
    });
  };
  r.start(10000); // alle 10 s Daten einsammeln
  rec.recorder = r;
}
function rotate() {
  if (!rec.recorder || rec.recorder.state !== 'recording') return;
  const old = rec.recorder;
  rec.idx++;
  newRecorder();
  old.stop();
}
function togglePause() {
  if (!rec.recorder) return;
  if (rec.recorder.state === 'recording') {
    rec.recorder.pause();
    rec.pausedAt = Date.now();
    clearInterval(rec.rotateTimer);
    stopLive();
    setRecUi('paused');
  } else {
    rec.pausedTotal += Date.now() - rec.pausedAt;
    rec.pausedAt = 0;
    rec.recorder.resume();
    rec.rotateTimer = setInterval(rotate, CHUNK_MS);
    if ($('#optLive').checked) startLive();
    setRecUi('on');
  }
}
async function stopRecording() {
  if (!rec.recorder) return;
  if (rec.pausedAt) { rec.pausedTotal += Date.now() - rec.pausedAt; rec.pausedAt = 0; }
  clearInterval(rec.rotateTimer);
  clearInterval(rec.tick);
  const r = rec.recorder;
  rec.recorder = null;
  // Nie ewig auf das Stopp-Ereignis warten: war der Recorder schon aus, kommt es nicht mehr
  const done = r.state === 'inactive' ? Promise.resolve() : new Promise((res) => {
    r.addEventListener('stop', res, { once: true });
    setTimeout(res, 4000);
  });
  try { if (r.state !== 'inactive') r.stop(); } catch {}
  await done;
  stopLive();
  rec.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  stopMeter();
  try { await rec.wake?.release(); } catch {}
  rec.wake = null;
  await rec.saving;
  const id = rec.id;
  const live = (rec.liveFinal + ' ' + rec.liveInterim).trim();
  rec.startedAt = 0;
  setRecUi('off');
  await updateRec(id, { status: 'pending', liveText: live });
  location.hash = '#/r/' + id;
  processRec(id);
}
function setRecUi(state) {
  $('#btnRec').classList.toggle('on', state !== 'off');
  $('#btnRec').setAttribute('aria-label', state === 'off' ? 'Aufnahme starten' : 'Aufnahme beenden');
  $('#btnPause').hidden = state === 'off';
  $('#btnStop').hidden = state === 'off';
  $('#btnPause').textContent = state === 'paused' ? 'Weiter' : 'Pause';
  $('#recHint').textContent = state === 'off' ? 'Tippen zum Aufnehmen' : state === 'paused' ? 'Pausiert' : 'Aufnahme läuft. Bildschirm bleibt an.';
  $('#liveText').hidden = !(state !== 'off' && $('#optLive').checked);
  $('#optLive').disabled = state !== 'off';
  if (state === 'off') $('#timer').textContent = '00:00';
}
function updateTimer() { $('#timer').textContent = fmtTime(elapsed()); }

// Pegelanzeige
function startMeter() {
  try {
    rec.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    rec.audioCtx.resume?.().catch(() => {});
    const src = rec.audioCtx.createMediaStreamSource(rec.stream);
    rec.analyser = rec.audioCtx.createAnalyser();
    rec.analyser.fftSize = 512;
    src.connect(rec.analyser);
    const c = $('#level'), g = c.getContext('2d');
    const data = new Uint8Array(rec.analyser.fftSize);
    const hist = new Array(100).fill(0);
    const draw = () => {
      if (!rec.analyser) { g.clearRect(0, 0, c.width, c.height); return; }
      rec.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      hist.push(rec.pausedAt ? 0 : peak / 128);
      hist.shift();
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = '#ff4d4f';
      const w = c.width / hist.length;
      hist.forEach((v, i) => {
        const h = Math.max(2, Math.min(1, v * 2.5) * c.height);
        g.fillRect(i * w + 1, (c.height - h) / 2, w - 2, h);
      });
      requestAnimationFrame(draw);
    };
    draw();
  } catch {}
}
function stopMeter() {
  rec.analyser = null;
  try { rec.audioCtx?.close(); } catch {}
  rec.audioCtx = null;
}

// Live-Mitschrift über die Spracherkennung des Browsers
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function startLive() {
  if (!SR) { toast('Live-Mitschrift wird von diesem Browser nicht unterstützt.'); return; }
  const s = new SR();
  s.lang = ({ de: 'de-DE', tr: 'tr-TR', en: 'en-US' })[settings.lang] || 'de-DE';
  s.continuous = true;
  s.interimResults = true;
  s.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) rec.liveFinal += r[0].transcript.trim() + ' ';
      else interim += r[0].transcript;
    }
    rec.liveInterim = interim;
    const el = $('#liveText');
    el.innerHTML = esc(rec.liveFinal) + '<i>' + esc(interim) + '</i>';
    el.scrollTop = el.scrollHeight;
  };
  s.onend = () => { if (rec.speech === s && rec.recorder && !rec.pausedAt) { try { s.start(); } catch {} } };
  s.onerror = (e) => { if (e.error === 'not-allowed') { rec.speech = null; toast('Live-Mitschrift nicht erlaubt.'); } };
  rec.speech = s;
  try { s.start(); } catch {}
}
function stopLive() {
  const s = rec.speech;
  rec.speech = null;
  try { s?.stop(); } catch {}
}

// ---------- Import ----------
async function importFile(file) {
  const id = uid();
  const base = { id, title: file.name.replace(/\.[^.]+$/, ''), created: file.lastModified || Date.now(), duration: 0, mime: file.type, chunks: [], status: 'pending', transcript: null, liveText: '', summary: '', qa: [] };
  toast('Datei wird eingelesen …');
  let pieces;
  if (file.size <= MAX_UPLOAD) {
    pieces = [{ blob: file, dur: await probeDuration(file) }];
  } else {
    try { pieces = await splitToWav(file); }
    catch { toast('Datei zu groß zum Zerlegen auf diesem Gerät (max. ca. 24 MB am Stück).', 5000); return; }
  }
  let offset = 0;
  for (let i = 0; i < pieces.length; i++) {
    await putAudio(id, i, pieces[i].blob);
    base.chunks.push({ offset, dur: pieces[i].dur, size: pieces[i].blob.size, type: pieces[i].blob.type || file.type });
    offset += pieces[i].dur;
  }
  base.duration = offset;
  await putRec(base);
  location.hash = '#/r/' + id;
  processRec(id);
}
function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { const d = a.duration; URL.revokeObjectURL(a.src); res(isFinite(d) ? d : 0); };
    a.onerror = () => res(0);
    a.src = URL.createObjectURL(blob);
  });
}
async function splitToWav(file) {
  const rate = 16000;
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  const ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const per = 10 * 60 * buf.sampleRate;
  const out = [];
  for (let start = 0; start < buf.length; start += per) {
    const n = Math.min(per, buf.length - start);
    const view = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, buf.sampleRate, true); view.setUint32(28, buf.sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      let v = ch1 ? (ch0[start + i] + ch1[start + i]) / 2 : ch0[start + i];
      v = Math.max(-1, Math.min(1, v));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    out.push({ blob: new Blob([view], { type: 'audio/wav' }), dur: n / buf.sampleRate });
  }
  return out;
}

// ---------- KI: Transkription + Zusammenfassung ----------
const working = new Set();
function extFor(type) {
  if (/mp4|m4a|aac/.test(type)) return 'm4a';
  if (/wav/.test(type)) return 'wav';
  if (/ogg/.test(type)) return 'ogg';
  if (/mpeg|mp3/.test(type)) return 'mp3';
  return 'webm';
}
async function groqTranscribe(blob, type) {
  const fd = new FormData();
  fd.append('file', blob, 'audio.' + extFor(type || blob.type));
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  if (settings.lang) fd.append('language', settings.lang);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + settings.groq }, body: fd,
    });
    if (r.status === 429 && attempt < 4) { await new Promise((ok) => setTimeout(ok, 15000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error('Transkription fehlgeschlagen (' + r.status + '): ' + (await r.text()).slice(0, 200));
    return r.json();
  }
}
async function llm(system, user, maxTokens = 4000) {
  if (settings.claude) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.claude,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: settings.claudeModel || defaults.claudeModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error('Claude-Fehler (' + r.status + '): ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  if (settings.groq) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + settings.groq },
      body: JSON.stringify({ model: settings.groqModel || defaults.groqModel, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error('Groq-Fehler (' + r.status + '): ' + (await r.text()).slice(0, 200));
    return (await r.json()).choices[0].message.content;
  }
  throw new Error('Für die Zusammenfassung fehlt ein Schlüssel (Einstellungen).');
}
const STYLE = 'Schreibe auf Deutsch mit echten Umlauten (ä, ö, ü, ß). Verwende keine Gedankenstriche (– oder —); schreibe Bereiche mit „bis“. Erfinde nichts, was nicht im Transkript steht. Deute offensichtliche Transkriptionsfehler sinnvoll.';
const SUMMARY_SYSTEM = `Du fasst Gesprächsmitschnitte für einen viel beschäftigten Unternehmer zusammen, der sie unterwegs auf dem Handy liest. ${STYLE}
Antworte exakt in diesem Format (Markdown), lasse Abschnitte ohne Inhalt weg:
# <prägnanter Titel, höchstens 6 Wörter>
### Kurzfassung
<2 bis 4 Sätze>
### Kernpunkte
- ...
### Entscheidungen
- ...
### Aufgaben
- <Wer>: <was>, <bis wann, falls genannt>
### Zahlen, Termine, Namen
- ...
### Offene Fragen
- ...`;

function transcriptText(r) {
  if (r.transcript?.segments?.length) return r.transcript.segments.map((s) => `[${fmtTime(s.start)}] ${s.text.trim()}`).join('\n');
  return r.transcript?.text || r.liveText || '';
}
async function processRec(id, { retranscribe = false, resummarize = false } = {}) {
  if (working.has(id)) return;
  working.add(id);
  try {
    let r = await getRec(id);
    if (!r) return;
    // Nur Live-Text vorhanden und noch keine Zusammenfassung: mit Whisper sauber neu transkribieren
    const onlyLive = r.transcript && !r.transcript.segments?.length && !r.summary;
    if ((!r.transcript || retranscribe || onlyLive) && settings.groq && r.chunks.length) {
      const segments = [];
      for (let i = 0; i < r.chunks.length; i++) {
        await updateRec(id, { status: 'transcribing', progress: `Transkribiere Teil ${i + 1} von ${r.chunks.length} …`, error: '' });
        const blob = await getAudio(id, i);
        if (!blob || blob.size < 1000) continue;
        const j = await groqTranscribe(blob, r.chunks[i].type);
        const off = r.chunks[i].offset;
        if (j.segments?.length) for (const s of j.segments) segments.push({ start: s.start + off, end: s.end + off, text: s.text });
        else if (j.text) segments.push({ start: off, end: off + r.chunks[i].dur, text: j.text });
      }
      r = await updateRec(id, { transcript: { segments, text: segments.map((s) => s.text.trim()).join(' ') } });
    } else if (!r.transcript && r.liveText) {
      r = await updateRec(id, { transcript: { segments: [], text: r.liveText } });
    }
    const text = transcriptText(r);
    if (!text.trim()) {
      await updateRec(id, {
        status: 'error', progress: '',
        error: settings.groq ? 'Im Audio wurde keine Sprache erkannt.' : 'Kein Transkript: Groq-Schlüssel in den Einstellungen eintragen oder Live-Mitschrift einschalten.',
      });
      return;
    }
    if (!r.summary || resummarize) {
      if (!settings.groq && !settings.claude) {
        await updateRec(id, { status: 'error', progress: '', error: 'Für die Zusammenfassung einen Schlüssel in den Einstellungen eintragen.' });
        return;
      }
      await updateRec(id, { status: 'summarizing', progress: 'Fasse zusammen …', error: '' });
      const extra = settings.prompt ? `\n\nZusätzliche Wünsche: ${settings.prompt}` : '';
      const out = await llm(SUMMARY_SYSTEM + extra, `Datum: ${fmtDate(r.created)}\nDauer: ${fmtTime(r.duration)}\n\nTranskript:\n${text}`);
      const m = out.match(/^\s*#\s+(.+)\n/);
      const patch = { summary: m ? out.slice(m[0].length).trim() : out.trim() };
      if (m && (r.autoTitle !== false)) patch.title = m[1].trim();
      r = await updateRec(id, patch);
    }
    await updateRec(id, { status: 'done', progress: '', error: '' });
  } catch (e) {
    await updateRec(id, { status: 'error', progress: '', error: e.message || String(e) });
  } finally {
    working.delete(id);
  }
}
async function ask(id, q) {
  const r = await getRec(id);
  const answer = await llm(
    `Du beantwortest Fragen zu einem Gesprächsmitschnitt. Antworte knapp und nenne, wo möglich, die Zeitmarke in eckigen Klammern. Wenn das Gespräch die Antwort nicht hergibt, sag das. ${STYLE}`,
    `Transkript:\n${transcriptText(r)}\n\nFrage: ${q}`, 1500);
  await updateRec(id, (x) => ({ qa: [...(x.qa || []), { q, a: answer }] }));
}

// ---------- Ansichten ----------
let current = null;
let player = { id: null, idx: 0, urls: [] };

function show(view) {
  for (const v of ['Home', 'Detail', 'Settings']) $('#view' + v).hidden = v !== view;
  $('#btnBack').hidden = view === 'Home';
  $('#btnSettings').hidden = view !== 'Home';
  $('#title').textContent = view === 'Settings' ? 'Einstellungen' : view === 'Detail' ? 'Gespräch' : 'Mitschrift';
}
async function route() {
  const h = location.hash;
  if (h.startsWith('#/r/')) {
    current = await getRec(h.slice(4));
    if (!current) { location.hash = '#/'; return; }
    show('Detail');
    setTab('sum');
    await loadPlayer(current);
    renderDetail();
  } else if (h === '#/settings') {
    current = null;
    show('Settings');
    fillSettings();
  } else {
    current = null;
    show('Home');
    renderList();
  }
}

const STATUS_LABEL = { recording: 'nimmt auf', pending: 'wartet', transcribing: 'transkribiert', summarizing: 'fasst zusammen', error: 'Fehler' };
async function renderList() {
  if ($('#viewHome').hidden) return;
  const q = $('#search').value.trim().toLowerCase();
  let recs = (await allRecs()).sort((a, b) => b.created - a.created);
  if (q) recs = recs.filter((r) => [r.title, r.summary, r.transcript?.text, r.liveText].join(' ').toLowerCase().includes(q));
  $('#empty').hidden = recs.length > 0;
  $('#empty').textContent = q ? 'Nichts gefunden.' : 'Noch keine Aufnahmen.';
  $('#list').innerHTML = recs.map((r) => {
    const st = STATUS_LABEL[r.status];
    const badge = st ? `<span class="badge ${r.status === 'error' ? 'err' : 'work'}">${st}</span>` : '';
    const preview = (r.summary || '').replace(/^#+.*$/gm, '').replace(/[-*#]/g, '').trim().slice(0, 200);
    return `<li data-id="${r.id}"><div class="t">${esc(r.title)}</div>
      <div class="s"><span>${fmtDate(r.created)}</span><span>${fmtTime(r.duration)}</span>${badge}</div>
      ${preview ? `<div class="p">${esc(preview)}</div>` : ''}</li>`;
  }).join('');
}
function renderDetail() {
  const r = current;
  if (!r || $('#viewDetail').hidden) return;
  if (document.activeElement !== $('#dTitle')) $('#dTitle').value = r.title;
  $('#dMeta').textContent = `${fmtDate(r.created)} · ${fmtTime(r.duration)}`;
  const st = $('#dStatus');
  st.hidden = !(r.progress || r.error || r.status === 'pending');
  st.className = 'status' + (r.error ? ' err' : '');
  st.textContent = r.error || r.progress || 'Wartet auf Verarbeitung …';
  $('#dSummary').innerHTML = r.summary ? renderMd(r.summary) : '<p class="small">Noch keine Zusammenfassung.</p>';
  const segs = r.transcript?.segments || [];
  $('#dTranscript').innerHTML = segs.length
    ? segs.map((s) => `<p><span class="ts" data-t="${s.start}">${fmtTime(s.start)}</span>${esc(s.text.trim())}</p>`).join('')
    : (r.transcript?.text || r.liveText) ? `<p>${esc(r.transcript?.text || r.liveText)}</p>` : '<p class="small">Noch kein Transkript.</p>';
  $('#askLog').innerHTML = (r.qa || []).map((x) => `<div class="q">${esc(x.q)}</div><div class="md">${renderMd(x.a)}</div>`).join('');
}
function setTab(t) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('#tabSum').hidden = t !== 'sum';
  $('#tabTx').hidden = t !== 'tx';
  $('#tabAsk').hidden = t !== 'ask';
}

// Wiedergabe: Teile nacheinander abspielen
async function loadPlayer(r) {
  player.urls.forEach((u) => u && URL.revokeObjectURL(u));
  player = { id: r.id, idx: 0, urls: [] };
  for (let i = 0; i < r.chunks.length; i++) {
    const b = await getAudio(r.id, i);
    player.urls.push(b ? URL.createObjectURL(b) : null);
  }
  const a = $('#dAudio');
  a.hidden = !player.urls.length;
  if (player.urls[0]) a.src = player.urls[0];
}
function seekTo(t) {
  const r = current;
  if (!r || !r.chunks.length) return;
  let idx = r.chunks.findIndex((c, i) => t < c.offset + c.dur || i === r.chunks.length - 1);
  if (idx < 0) idx = 0;
  const a = $('#dAudio');
  const go = () => { a.currentTime = Math.max(0, t - r.chunks[idx].offset); a.play(); };
  if (player.idx !== idx) {
    player.idx = idx;
    a.src = player.urls[idx];
    a.addEventListener('loadedmetadata', go, { once: true });
  } else go();
}
$('#dAudio').addEventListener('ended', () => {
  if (player.idx + 1 < player.urls.length) {
    player.idx++;
    const a = $('#dAudio');
    a.src = player.urls[player.idx];
    a.play();
  }
});

function fullText(r) {
  return `${r.title}\n${fmtDate(r.created)} · ${fmtTime(r.duration)}\n\n${r.summary || ''}\n\n--- Transkript ---\n${transcriptText(r)}`;
}

// Einstellungen
function fillSettings() {
  $('#sGroq').value = settings.groq;
  $('#sClaude').value = settings.claude;
  $('#sLang').value = settings.lang;
  $('#sClaudeModel').value = settings.claudeModel;
  $('#sGroqModel').value = settings.groqModel;
  $('#sPrompt').value = settings.prompt;
  updateKeyState();
  navigator.storage?.estimate?.().then((e) => {
    $('#sStorage').textContent = `Belegter Speicher: ${(e.usage / 1048576).toFixed(1)} MB von etwa ${(e.quota / 1073741824).toFixed(1)} GB.`;
  });
}

// ---------- Ereignisse ----------
// Ein Tipp nach dem anderen: Doppeltipps während Start oder Stopp werden ignoriert
let recBusy = false;
async function toggleRec(forceStop = false) {
  if (recBusy) return;
  recBusy = true;
  try {
    if (isRecording()) await stopRecording();
    else if (!forceStop) await startRecording();
  } catch (e) {
    toast('Aufnahme-Fehler: ' + (e.message || e), 6000);
    try { rec.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    clearInterval(rec.rotateTimer);
    clearInterval(rec.tick);
    stopLive();
    stopMeter();
    rec.recorder = null;
    rec.startedAt = 0;
    setRecUi('off');
  } finally {
    recBusy = false;
  }
}
$('#btnRec').onclick = () => toggleRec();
$('#btnStop').onclick = () => toggleRec(true);
$('#btnPause').onclick = () => { try { togglePause(); } catch (e) { toast('Pause nicht möglich: ' + e.message, 5000); } };
window.addEventListener('error', (e) => toast('Fehler: ' + e.message, 6000));
window.addEventListener('unhandledrejection', (e) => toast('Fehler: ' + (e.reason?.message || e.reason), 6000));
$('#btnSettings').onclick = () => (location.hash = '#/settings');
$('#btnBack').onclick = () => (location.hash = '#/');
// Live-Mitschrift standardmäßig aus: auf vielen Handys streitet sie mit der Aufnahme ums Mikrofon
$('#optLive').checked = !!settings.live && !!SR;
$('#optLive').closest('label').hidden = !SR;
$('#optLive').onchange = (e) => { settings.live = e.target.checked; saveSettings(); };
$('#search').oninput = () => renderList();
$('#list').onclick = (e) => { const li = e.target.closest('li'); if (li) location.hash = '#/r/' + li.dataset.id; };
$('#fileImport').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };

document.querySelector('.tabs').onclick = (e) => { if (e.target.dataset.tab) setTab(e.target.dataset.tab); };
$('#dTranscript').onclick = (e) => { const t = e.target.dataset.t; if (t) seekTo(+t); };
$('#dTitle').onchange = (e) => current && updateRec(current.id, { title: e.target.value.trim() || current.title, autoTitle: false });
$('#askForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#askInput').value.trim();
  if (!q || !current) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = '…';
  try { await ask(current.id, q); $('#askInput').value = ''; }
  catch (err) { toast(err.message, 5000); }
  finally { btn.disabled = false; btn.textContent = 'Fragen'; }
};
$('#aShare').onclick = async () => {
  if (!current) return;
  const text = fullText(current);
  if (navigator.share) { try { await navigator.share({ title: current.title, text }); } catch {} }
  else { await navigator.clipboard.writeText(text); toast('Kopiert.'); }
};
$('#aCopy').onclick = async () => { if (current) { await navigator.clipboard.writeText(fullText(current)); toast('Kopiert.'); } };
$('#aRetx').onclick = () => {
  if (!current) return;
  if (!settings.groq) { toast('Dafür den Groq-Schlüssel in den Einstellungen eintragen.'); return; }
  processRec(current.id, { retranscribe: true, resummarize: true });
};
$('#aResum').onclick = () => current && processRec(current.id, { resummarize: true });
$('#aDelete').onclick = async () => {
  if (!current || !confirm('Dieses Gespräch mit Audio endgültig löschen?')) return;
  await deleteRec(current);
  location.hash = '#/';
  toast('Gelöscht.');
};
// Einstellungen speichern sich bei jeder Eingabe selbst, der Knopf prüft zusätzlich den Schlüssel
function readSettingsForm() {
  const hadKey = !!(settings.groq || settings.claude);
  settings = {
    ...settings,
    groq: $('#sGroq').value.trim(), claude: $('#sClaude').value.trim(), lang: $('#sLang').value,
    claudeModel: $('#sClaudeModel').value.trim() || defaults.claudeModel,
    groqModel: $('#sGroqModel').value.trim() || defaults.groqModel, prompt: $('#sPrompt').value.trim(),
  };
  saveSettings();
  updateKeyState();
  if (!hadKey && (settings.groq || settings.claude)) resumePending();
}
['#sGroq', '#sClaude', '#sLang', '#sClaudeModel', '#sGroqModel', '#sPrompt'].forEach((s) => $(s).addEventListener('input', readSettingsForm));
async function checkGroqKey() {
  if (!settings.groq) return 'missing';
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + settings.groq } });
    return r.ok ? 'ok' : 'bad';
  } catch { return 'offline'; }
}
function updateKeyState(check) {
  const el = $('#sGroqState');
  const has = !!(settings.groq || settings.claude);
  $('#keyBanner').hidden = !!settings.groq;
  if (!settings.groq) { el.textContent = 'Kein Groq-Schlüssel gespeichert.'; el.className = 'small bad'; }
  else if (!check) { el.textContent = 'Groq-Schlüssel gespeichert.'; el.className = 'small good'; }
  else el.textContent = { ok: '✓ Groq-Schlüssel funktioniert.', bad: '✗ Groq lehnt diesen Schlüssel ab. Bitte neu kopieren.', offline: 'Keine Verbindung, Schlüssel konnte nicht geprüft werden.' }[check] || '';
  if (check) el.className = 'small ' + (check === 'ok' ? 'good' : 'bad');
  return has;
}
$('#sSave').onclick = async () => {
  readSettingsForm();
  const btn = $('#sSave');
  btn.disabled = true; btn.textContent = 'Prüfe …';
  const res = await checkGroqKey();
  btn.disabled = false; btn.textContent = 'Speichern und prüfen';
  updateKeyState(res === 'missing' ? null : res);
  if (res === 'ok') { toast('Gespeichert, Schlüssel funktioniert.'); resumePending(); }
  else if (res === 'missing' && settings.claude) toast('Gespeichert. Für die Transkription fehlt noch der Groq-Schlüssel.', 4000);
};
$('#keyBanner').onclick = () => (location.hash = '#/settings');
$('#dStatus').onclick = () => { if (current?.error && /Schlüssel|Einstellungen/.test(current.error)) location.hash = '#/settings'; };

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (isRecording()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isRecording() && !rec.wake) {
    try { rec.wake = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

// Unterbrochene Aufnahmen und offene Verarbeitungen wieder aufnehmen
async function resumePending() {
  for (const r of await allRecs()) {
    if (r.status === 'recording' && !isRecording()) await updateRec(r.id, { status: 'pending' });
    if (['recording', 'pending', 'transcribing', 'summarizing'].includes(r.status) || (r.status === 'error' && !r.summary && (settings.groq || settings.claude))) processRec(r.id);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
updateKeyState();
route().then(resumePending);
