'use strict';

// ---------- Hilfen ----------
const $ = (s) => document.querySelector(s);
const CHUNK_MS = 5 * 60 * 1000; // alle 5 Minuten eine neue Audiodatei, damit nichts zu groß wird
const MAX_UPLOAD = 24 * 1024 * 1024;
const PV = 2; // Stand der Verarbeitung; ältere Aufnahmen werden beim Öffnen einmal automatisch nachgearbeitet
const MIC = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } }; // Filter wie im Telefonat schlucken leise und entfernte Stimmen

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
  // Zweite Kopie in der Datenbank, falls das Handy den kleinen Speicher leert
  tx('audio', 'readwrite', (s) => s.put({ key: '__settings', settings })).catch(() => {});
}
async function restoreSettings() {
  if (settings.groq || settings.claude) return;
  try {
    const copy = (await tx('audio', 'readonly', (s) => s.get('__settings')))?.settings;
    if (copy && (copy.groq || copy.claude)) { settings = { ...defaults, ...copy }; saveSettings(); }
  } catch {}
}
// Sicherungslink: enthält die Schlüssel im Teil hinter #, der nie an einen Server geht
function setupLink() {
  const data = btoa(unescape(encodeURIComponent(JSON.stringify({ groq: settings.groq, claude: settings.claude }))));
  return location.origin + location.pathname + '#setup=' + data;
}
function importSetupLink(text = location.hash) {
  const m = text.match(/#setup=([A-Za-z0-9+/=]+)/);
  if (!m) return false;
  try {
    const d = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    settings = { ...settings, groq: d.groq || settings.groq, claude: d.claude || settings.claude };
    saveSettings();
    toast('Schlüssel aus dem Sicherungslink übernommen.', 4000);
  } catch { toast('Der Sicherungslink ist beschädigt.', 5000); }
  if (location.hash.startsWith('#setup=')) history.replaceState(null, '', location.pathname + '#/settings');
  return true;
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
const audioRange = (id) => IDBKeyRange.bound(`${id}:`, `${id}:\uffff`);
const chunkIdx = (c, i) => c.idx ?? i; // ältere Aufnahmen kennen nur die Reihenfolge
async function deleteRec(rec) {
  await tx('recs', 'readwrite', (s) => s.delete(rec.id));
  await tx('audio', 'readwrite', (s) => s.delete(audioRange(rec.id)));
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
  audioCtx: null, analyser: null, wake: null, lostAt: 0, speech: null, liveFinal: '', liveInterim: '', saving: Promise.resolve(),
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
    rec.stream = await navigator.mediaDevices.getUserMedia(MIC);
  } catch (e) {
    $('#recHint').textContent = 'Tippen zum Aufnehmen';
    toast('Kein Mikrofonzugriff (' + (e.name || e.message) + '). Bitte in den Einstellungen des Handys erlauben.', 6000);
    return;
  }
  watchTracks();
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
    duration: 0, mime: rec.mime, chunks: [], status: 'recording', pv: PV, parts: {}, transcript: null, liveText: '', summary: '', qa: [],
  });
  newRecorder();
  rec.rotateTimer = setInterval(rotate, CHUNK_MS);
  rec.tick = setInterval(updateTimer, 500);
  startMeter();
  if ($('#optLive').checked) startLive();
  keepAwake();
  try { navigator.storage?.persist?.(); } catch {}
  setRecUi('on');
}

// ---------- Wach bleiben und weiter aufnehmen ----------
// Bildschirm anlassen: Wake Lock, und falls das Handy es nicht kann oder verweigert, ein stummes Video in Dauerschleife
const wakeVideo = Object.assign(document.createElement('video'), { src: 'wach.mp4', loop: true, muted: true, playsInline: true });
wakeVideo.setAttribute('playsinline', '');
wakeVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
document.body.appendChild(wakeVideo);
async function keepAwake() {
  if (!isRecording() && !rec.stream) return;
  if (!rec.wake) {
    try {
      rec.wake = await navigator.wakeLock.request('screen');
      rec.wake.addEventListener('release', () => { rec.wake = null; });
    } catch { rec.wake = null; }
  }
  if (!rec.wake) wakeVideo.play().catch(() => {});
}
async function releaseAwake() {
  try { await rec.wake?.release(); } catch {}
  rec.wake = null;
  wakeVideo.pause();
}

// Nimmt das Handy das Mikrofon weg (Sperrbildschirm, Anruf, andere App), friert die Uhr ein
// und verbindet sich wieder, sobald die App zurück ist. Die Aufnahme läuft im selben Gespräch weiter.
function watchTracks() {
  rec.stream.getAudioTracks().forEach((t) => {
    t.onended = () => micLost();
    t.onmute = () => { if (document.visibilityState === 'hidden') micLost(); };
    t.onunmute = () => { if (rec.lostAt && t.readyState === 'live') micBack(false); };
  });
}
function micLost() {
  if (!isRecording() || rec.lostAt) return;
  rec.lostAt = Date.now();
  if (!rec.pausedAt) rec.pausedAt = rec.lostAt;
  if (document.visibilityState === 'visible') reconnectMic();
}
function micBack(newStream) {
  const gap = Math.round((Date.now() - rec.lostAt) / 1000);
  if (rec.pausedAt === rec.lostAt) { rec.pausedTotal += Date.now() - rec.pausedAt; rec.pausedAt = 0; }
  rec.lostAt = 0;
  if (gap >= 3) toast(`Aufnahme läuft weiter. Das Handy hatte das Mikrofon ${fmtTime(gap)} gesperrt.`, 5000);
  if (newStream) { stopMeter(); startMeter(); }
}
let reconnecting = false;
async function reconnectMic() {
  if (reconnecting || !isRecording()) return;
  reconnecting = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia(MIC);
    const old = rec.recorder;
    const oldStream = rec.stream;
    old.endAt = elapsed();
    try { if (old.state !== 'inactive') old.stop(); } catch {}
    oldStream.getTracks().forEach((t) => { t.onended = t.onmute = t.onunmute = null; t.stop(); });
    rec.stream = s;
    watchTracks();
    rec.idx++;
    micBack(true);
    newRecorder();
    if (rec.pausedAt) rec.recorder.pause();
  } catch (e) {
    toast('Mikrofon nicht mehr verfügbar. Aufnahme bis hierhin gespeichert.', 6000);
    rec.lostAt = 0;
    toggleRec(true);
  } finally {
    reconnecting = false;
  }
}
function micBroken() {
  if (!isRecording()) return false;
  const tracks = rec.stream?.getAudioTracks() || [];
  return !!rec.lostAt || rec.recorder.state === 'inactive' || tracks.some((t) => t.readyState === 'ended');
}

function newRecorder() {
  const idx = rec.idx;
  const offset = elapsed();
  let r;
  try { r = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 64000 } : undefined); }
  catch { r = new MediaRecorder(rec.stream); }
  const parts = [];
  r.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
  r.onerror = () => { if (rec.recorder === r) micLost(); };
  r.onstop = () => {
    const blob = new Blob(parts, { type: r.mimeType || rec.mime || 'audio/webm' });
    const dur = (r.endAt ?? elapsed()) - offset;
    const id = rec.id;
    rec.saving = rec.saving.then(async () => {
      await putAudio(id, idx, blob);
      const x = await updateRec(id, (x) => ({
        chunks: [...x.chunks.filter((c, i) => chunkIdx(c, i) !== idx), { idx, offset, dur, size: blob.size, type: blob.type }].sort((a, b) => a.offset - b.offset),
        duration: Math.max(x.duration || 0, offset + dur),
      }));
      if (x.status !== 'recording') processRec(id); // kam erst nach dem Stopp an: nachholen
    });
  };
  r.start(); // ohne Zeitscheiben: Safari baut daraus sonst Dateien, die nur teilweise lesbar sein können
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
  rec.lostAt = 0;
  clearInterval(rec.rotateTimer);
  clearInterval(rec.tick);
  const r = rec.recorder;
  rec.recorder = null;
  // Nie ewig auf das Stopp-Ereignis warten: war der Recorder schon aus, kommt es nicht mehr
  const done = r.state === 'inactive' ? Promise.resolve() : new Promise((res) => {
    r.addEventListener('stop', res, { once: true });
    setTimeout(res, 15000);
  });
  try { if (r.state !== 'inactive') r.stop(); } catch {}
  await done;
  stopLive();
  rec.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  stopMeter();
  await releaseAwake();
  await rec.saving;
  const id = rec.id;
  const live = (rec.liveFinal + ' ' + rec.liveInterim).trim();
  rec.startedAt = 0;
  setRecUi('off');
  await updateRec(id, { status: 'pending', liveText: live });
  location.hash = '#/r/' + id;
  processRec(id).then(resumePending);
}
function setRecUi(state) {
  $('#btnRec').classList.toggle('on', state !== 'off');
  $('#btnRec').setAttribute('aria-label', state === 'off' ? 'Aufnahme starten' : 'Aufnahme beenden');
  $('#btnPause').hidden = state === 'off';
  $('#btnStop').hidden = state === 'off';
  $('#btnDark').hidden = state === 'off';
  if (state === 'off') setDark(false);
  $('#btnPause').textContent = state === 'paused' ? 'Weiter' : 'Pause';
  $('#recHint').textContent = state === 'off' ? 'Tippen zum Aufnehmen' : state === 'paused' ? 'Pausiert' : 'Aufnahme läuft. Bildschirm bleibt an, nicht die Seitentaste drücken.';
  $('#liveText').hidden = !(state !== 'off' && $('#optLive').checked);
  $('#optLive').disabled = state !== 'off';
  if (state === 'off') $('#timer').textContent = '00:00';
}
function updateTimer() {
  const t = fmtTime(elapsed());
  $('#timer').textContent = t;
  if (!$('#dark').hidden) $('#darkTimer').textContent = t;
}
// Taschenmodus: Bildschirm bleibt an, zeigt aber nur Schwarz. Spart Akku und verhindert versehentliches Tippen.
function setDark(on) {
  $('#dark').hidden = !on;
  if (on) $('#darkTimer').textContent = fmtTime(elapsed());
}
let darkTap = 0;
$('#dark').addEventListener('click', () => {
  if (Date.now() - darkTap < 400) setDark(false);
  darkTap = Date.now();
});
$('#btnDark').onclick = () => setDark(true);

// Pegelanzeige
function startMeter() {
  try {
    rec.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    rec.audioCtx.resume?.().catch(() => {});
    const src = rec.audioCtx.createMediaStreamSource(rec.stream);
    rec.analyser = rec.audioCtx.createAnalyser();
    rec.analyser.fftSize = 512;
    src.connect(rec.analyser);
    const mine = rec.analyser;
    const c = $('#level'), g = c.getContext('2d');
    const data = new Uint8Array(rec.analyser.fftSize);
    const hist = new Array(100).fill(0);
    const draw = () => {
      if (rec.analyser !== mine) { if (!rec.analyser) g.clearRect(0, 0, c.width, c.height); return; }
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
  const base = { id, title: file.name.replace(/\.[^.]+$/, ''), created: file.lastModified || Date.now(), duration: 0, mime: file.type, chunks: [], status: 'pending', pv: PV, parts: {}, transcript: null, liveText: '', summary: '', qa: [] };
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
    base.chunks.push({ idx: i, offset, dur: pieces[i].dur, size: pieces[i].blob.size, type: pieces[i].blob.type || file.type });
    offset += pieces[i].dur;
  }
  base.duration = offset;
  await putRec(base);
  location.hash = '#/r/' + id;
  processRec(id);
}
// Wartet höchstens ms; danach gilt fallback. Das iPhone meldet manche Ereignisse im Hintergrund nie.
const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(fallback), ms))]);
function probeDuration(blob) {
  const url = URL.createObjectURL(blob);
  return withTimeout(new Promise((res) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => res(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => res(0);
    a.src = url;
    try { a.load(); } catch {}
  }), 8000, 0).finally(() => URL.revokeObjectURL(url));
}
const RATE = 16000;
async function decodeMono(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const ch0 = buf.getChannelData(0);
    if (buf.numberOfChannels < 2) return ch0;
    const ch1 = buf.getChannelData(1);
    return ch0.map((v, i) => (v + ch1[i]) / 2);
  } finally { ctx.close(); }
}
function pcmToWav(pcm) {
  const n = pcm.length;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
async function splitToWav(file) {
  const pcm = await decodeMono(file);
  const per = 10 * 60 * RATE;
  const out = [];
  for (let start = 0; start < pcm.length; start += per) {
    const part = pcm.subarray(start, start + per);
    out.push({ blob: pcmToWav(part), dur: part.length / RATE });
  }
  return out;
}

// ---------- KI: Transkription + Zusammenfassung ----------
const working = new Set();
let RETRY_MS = 15000;
function extFor(type) {
  if (/mp4|m4a|aac/.test(type)) return 'm4a';
  if (/wav/.test(type)) return 'wav';
  if (/ogg/.test(type)) return 'ogg';
  if (/mpeg|mp3/.test(type)) return 'mp3';
  return 'webm';
}
const KEY_ERR = {
  get groq() { return 'Groq lehnt den Schlüssel' + keyEnd(settings.groq) + ' ab. Hier tippen und ihn in den Einstellungen neu eintragen.'; },
  get claude() { return 'Anthropic lehnt den Claude-Schlüssel' + keyEnd(settings.claude) + ' ab. Hier tippen und ihn in den Einstellungen neu eintragen.'; },
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Wie lange Groq warten lässt: aus dem Header oder aus dem Fehlertext („try again in 7m30s“)
async function limitWait(r) {
  const h = parseFloat(r.headers.get('retry-after') || '');
  if (h > 0) return h * 1000;
  const m = (await r.clone().text().catch(() => '')).match(/try again in ((?:[\d.]+(?:ms|h|m|s))+)/i);
  if (!m) return 0;
  let ms = 0;
  for (const [, n, u] of m[1].matchAll(/([\d.]+)(ms|h|m|s)/g)) ms += n * { ms: 1, s: 1000, m: 60000, h: 3600000 }[u];
  return ms;
}
// Wiederholt bei Netzfehlern, Limits und Serverproblemen; hängt nie endlos, auch wenn das Handy die App schlafen legt
async function fetchRetry(url, opts, tries = 5) {
  for (let a = 1; ; a++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 240000);
    let r = null;
    try { r = await fetch(url, { ...opts, signal: ctl.signal }); } catch {} finally { clearTimeout(timer); }
    if (r && r.status !== 429 && r.status < 500) return r;
    const wait = r?.status === 429 ? await limitWait(r) : 0;
    if (wait > 60000) { r.limitWait = wait; return r; } // Längere Sperre: nicht blockieren, processRec plant den nächsten Versuch
    if (a >= tries) {
      if (r) return r;
      throw new Error('Keine Verbindung. Die Verarbeitung geht beim nächsten Öffnen der App an dieser Stelle weiter.');
    }
    await sleep(wait ? wait + 1000 : RETRY_MS * a);
  }
}
async function groqTranscribe(blob, type, temperature = 0) {
  const fd = new FormData();
  fd.append('file', blob, 'audio.' + extFor(type || blob.type));
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', String(temperature));
  if (settings.lang) fd.append('language', settings.lang);
  const r = await fetchRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + settings.groq }, body: fd,
  });
  if (r.status === 401) throw new Error(KEY_ERR.groq);
  if (r.status === 429) throw Object.assign(new Error('Das Groq-Limit ist gerade erreicht.'), { limitWait: r.limitWait || 300000 });
  if (!r.ok) throw new Error('Transkription fehlgeschlagen (' + r.status + '): ' + (await r.text()).slice(0, 200));
  return r.json();
}
const toSegs = (j, off, dur) => (j.segments?.length
  ? j.segments.map((s) => ({ start: s.start + off, end: s.end + off, text: s.text }))
  : j.text?.trim() ? [{ start: off, end: off + dur, text: j.text }] : []);

// Lücken im Transkript, in denen das Audio nicht still ist, gezielt noch einmal transkribieren
const GAP_MIN = 15;
function findGaps(segs, dur) {
  const gaps = [];
  let pos = 0;
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    if (s.start - pos >= GAP_MIN) gaps.push({ from: pos, to: s.start });
    pos = Math.max(pos, s.end);
  }
  if (dur - pos >= GAP_MIN) gaps.push({ from: pos, to: dur });
  return gaps;
}
function hasSound(pcm, gap) {
  const win = RATE / 2;
  let loud = 0, total = 0;
  for (let i = Math.floor(gap.from * RATE); i + win <= Math.min(pcm.length, gap.to * RATE); i += win) {
    let sum = 0;
    for (let k = i; k < i + win; k++) sum += pcm[k] * pcm[k];
    total++;
    if (Math.sqrt(sum / win) > 0.008) loud++;
  }
  return total > 0 && loud / total >= 0.05;
}
let decodeStuck = false;
async function transcribeChunk(c, blob) {
  const j = await groqTranscribe(blob, c.type);
  let segs = toSegs(j, 0, c.dur);
  const warn = [];
  const small = c.dur ? c.dur <= 1800 : blob.size <= 10 * 1024 * 1024; // längere Dateien passen nicht sicher in den Handy-Speicher
  let pcm = null;
  if (small && !decodeStuck) {
    try { pcm = await withTimeout(decodeMono(blob), 90000, 'stuck'); } catch {}
    if (pcm === 'stuck') { pcm = null; decodeStuck = true; } // Einmal gehangen: in dieser Sitzung nicht mehr versuchen
  }
  if (!pcm) {
    const last = segs.reduce((m, s) => Math.max(m, s.end), 0);
    if (c.dur - last >= 60) warn.push({ from: last, to: c.dur });
    return { segs, warn };
  }
  const dur = pcm.length / RATE;
  for (const gap of findGaps(segs, dur)) {
    if (!hasSound(pcm, gap)) continue;
    for (let from = Math.max(0, gap.from - 1); from < gap.to; from += 600) {
      const to = Math.min(gap.to + 1, from + 600);
      const sub = await groqTranscribe(pcmToWav(pcm.subarray(Math.floor(from * RATE), Math.floor(to * RATE))), 'audio/wav', 0.2);
      segs = segs.concat(toSegs(sub, from, to - from));
    }
  }
  for (const gap of findGaps(segs, dur)) if (hasSound(pcm, gap)) warn.push(gap); // auch beim zweiten Versuch nichts erkannt
  return { segs: segs.sort((a, b) => a.start - b.start), warn };
}
function buildTranscript(r) {
  const segments = [], gaps = [];
  r.chunks.forEach((c, i) => {
    const p = r.parts?.[chunkIdx(c, i)];
    if (!p) return;
    for (const s of p.segs) segments.push({ start: s.start + c.offset, end: s.end + c.offset, text: s.text });
    for (const g of p.warn) gaps.push(g.missing ? g : { from: g.from + c.offset, to: g.to + c.offset });
  });
  segments.sort((a, b) => a.start - b.start);
  return { segments, gaps };
}
// Audio, das gespeichert ist, aber in der Liste der Teile fehlt, wieder einhängen
async function recoverChunks(r) {
  const keys = await tx('audio', 'readonly', (s) => s.getAllKeys(audioRange(r.id)));
  const chunks = r.chunks.map((c, i) => ({ ...c, idx: chunkIdx(c, i) }));
  const known = new Set(chunks.map((c) => c.idx));
  const lost = keys.map((k) => Number(String(k).split(':')[1])).filter((i) => !known.has(i)).sort((a, b) => a - b);
  if (!lost.length) return r;
  for (const idx of lost) {
    const blob = await getAudio(r.id, idx);
    const prev = chunks.filter((c) => c.idx < idx).sort((a, b) => b.idx - a.idx)[0];
    chunks.push({ idx, offset: prev ? prev.offset + prev.dur : 0, dur: await probeDuration(blob), size: blob.size, type: blob.type });
  }
  chunks.sort((a, b) => a.offset - b.offset);
  return updateRec(r.id, (x) => ({ chunks, duration: Math.max(x.duration || 0, ...chunks.map((c) => c.offset + c.dur)) }));
}

const CONTINUE = 'Deine Antwort wurde abgeschnitten. Schreib genau an dieser Stelle weiter, ohne Wiederholung und ohne Einleitung.';
async function llmOnce(system, messages, maxTokens) {
  if (settings.claude) {
    const r = await fetchRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.claude,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: settings.claudeModel || defaults.claudeModel, max_tokens: maxTokens, system, messages }),
    });
    if (r.status === 401) throw new Error(KEY_ERR.claude);
    if (!r.ok) {
      const t = await r.text();
      if (/credit balance/i.test(t)) throw new Error('Das Anthropic-Guthaben ist leer. Bitte in der Anthropic-Konsole aufladen oder den Claude-Schlüssel in den Einstellungen löschen, dann fasst Groq zusammen.');
      throw new Error('Claude-Fehler (' + r.status + '): ' + t.slice(0, 200));
    }
    const j = await r.json();
    return { text: j.content.filter((c) => c.type === 'text').map((c) => c.text).join(''), cut: j.stop_reason === 'max_tokens' };
  }
  if (settings.groq) {
    const r = await fetchRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + settings.groq },
      body: JSON.stringify({ model: settings.groqModel || defaults.groqModel, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'system', content: system }, ...messages] }),
    });
    if (r.status === 401) throw new Error(KEY_ERR.groq);
    if (!r.ok) throw new Error('Groq-Fehler (' + r.status + '): ' + (await r.text()).slice(0, 200));
    const c = (await r.json()).choices[0];
    return { text: c.message.content, cut: c.finish_reason === 'length' };
  }
  throw new Error('Für die Zusammenfassung fehlt ein Schlüssel (Einstellungen).');
}
async function llm(system, user, maxTokens = 4000) {
  let all = '';
  for (let round = 0; round < 5; round++) {
    const messages = [{ role: 'user', content: user }];
    if (all) messages.push({ role: 'assistant', content: all.trimEnd() }, { role: 'user', content: CONTINUE });
    const { text, cut } = await llmOnce(system, messages, maxTokens);
    all += text;
    if (!cut) break;
  }
  return all;
}
const STYLE = 'Schreibe auf Deutsch mit echten Umlauten (ä, ö, ü, ß). Verwende keine Gedankenstriche (– oder —); schreibe Bereiche mit „bis“. Erfinde nichts, was nicht im Transkript steht. Deute offensichtliche Transkriptionsfehler sinnvoll.';
const SUMMARY_SYSTEM = `Du fasst Gesprächsmitschnitte für einen viel beschäftigten Unternehmer zusammen, der sie unterwegs auf dem Handy liest. ${STYLE}
Decke das ganze Gespräch von Anfang bis Ende ab: Jedes Thema, auch aus dem letzten Teil und auch Nebenthemen, kommt vor. Je länger das Gespräch, desto mehr Kernpunkte.
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
const NOTES_SYSTEM = `Du bekommst einen Abschnitt eines langen Gesprächsmitschnitts. Schreibe vollständige Stichpunkte zu allem, was darin vorkommt: Themen, Aussagen, Entscheidungen, Aufgaben, Zahlen, Termine, Namen. Lass nichts weg, behalte die Zeitmarken in eckigen Klammern, keine Einleitung. ${STYLE}`;
const PART_CHARS = 16000; // etwa 20 Minuten Gespräch; passt auch ins Limit des Groq-Gratistarifs
function splitText(text, max) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}
// Lange Gespräche zuerst abschnittsweise verdichten, damit auch das Ende vollständig berücksichtigt wird
async function condense(text, onProgress) {
  for (let round = 0; text.length > PART_CHARS && round < 3; round++) {
    const parts = splitText(text, PART_CHARS);
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      if (onProgress) await onProgress(i + 1, parts.length);
      notes.push(await llm(NOTES_SYSTEM, `Abschnitt ${i + 1} von ${parts.length}:\n${parts[i]}`, 2500));
    }
    text = notes.join('\n\n');
  }
  return text;
}

function transcriptText(r) {
  if (r.transcript?.segments?.length) return r.transcript.segments.map((s) => `[${fmtTime(s.start)}] ${s.text.trim()}`).join('\n');
  return r.transcript?.text || r.liveText || '';
}
const DIAG_VERSION = 'v11';
const rerun = new Set();
// Nacharbeiten alter Aufnahmen tritt zurück, solange aufgenommen wird oder eine neue Aufnahme verarbeitet wird
const priority = new Set();
const isBackfill = (r) => r.backfill ?? (r.pv !== PV || !!r.redo);
// Whisper-Limit: danach automatisch weitermachen, solange die App offen ist
let limitUntil = 0, limitTimer = 0;
function noteLimit(ms) {
  limitUntil = Date.now() + ms + 2000;
  clearTimeout(limitTimer);
  limitTimer = setTimeout(() => { limitUntil = 0; resumePending(); }, ms + 2000);
  const at = new Date(limitUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `Groq-Limit erreicht. Geht gegen ${at} Uhr automatisch weiter, wenn die App offen ist.`;
}
async function processRec(id, { retranscribe = false, resummarize = false } = {}) {
  if (working.has(id)) { if (!retranscribe && !resummarize) rerun.add(id); return; }
  working.add(id);
  let back = false;
  try {
    let r = await getRec(id);
    if (!r) return;
    if (retranscribe) r = await updateRec(id, { parts: {}, redo: true, backfill: false });
    if (resummarize) r = await updateRec(id, { resum: true, backfill: false });
    back = isBackfill(r);
    if (!back) priority.add(id);
    const hold = async () => { while (back && (rec.startedAt || priority.size)) await sleep(1000); };
    r = await recoverChunks(r);
    const open = (x) => x.chunks.findIndex((c, i) => !x.parts?.[chunkIdx(c, i)]);
    // Nur Live-Text vorhanden und noch keine Zusammenfassung: mit Whisper sauber neu transkribieren
    const onlyLive = r.transcript && !r.transcript.segments?.length && !r.summary;
    const late = r.parts && open(r) >= 0;
    if ((!r.transcript || r.redo || onlyLive || late) && settings.groq && r.chunks.length) {
      // Jeder fertige Teil wird sofort gespeichert; nach einer Unterbrechung geht es dort weiter
      for (;;) {
        await hold();
        r = await getRec(id);
        const i = open(r);
        if (i < 0) break;
        const c = r.chunks[i], idx = chunkIdx(c, i);
        await updateRec(id, { status: 'transcribing', progress: `Transkribiere Teil ${i + 1} von ${r.chunks.length} …`, error: '' });
        const blob = await getAudio(id, idx);
        const part = !blob ? { segs: [], warn: [{ missing: true, from: c.offset, to: c.offset + c.dur }] }
          : blob.size < 1000 ? { segs: [], warn: [] }
          : await transcribeChunk(c, blob);
        await updateRec(id, (x) => ({ parts: { ...x.parts, [idx]: part } }));
      }
      const { segments, gaps } = buildTranscript(r);
      const patch = { redo: false, resum: true, gaps };
      if (segments.length || !r.transcript) patch.transcript = { segments, text: segments.map((s) => s.text.trim()).join(' ') };
      r = await updateRec(id, patch);
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
    if (!r.summary || r.resum) {
      await hold();
      if (!settings.groq && !settings.claude) {
        await updateRec(id, { status: 'error', progress: '', error: 'Für die Zusammenfassung einen Schlüssel in den Einstellungen eintragen.' });
        return;
      }
      await updateRec(id, { status: 'summarizing', progress: 'Fasse zusammen …', error: '' });
      const extra = settings.prompt ? `\n\nZusätzliche Wünsche: ${settings.prompt}` : '';
      const notes = await condense(text, (i, n) => updateRec(id, { progress: `Lese Abschnitt ${i} von ${n} …` }));
      await updateRec(id, { progress: 'Fasse zusammen …' });
      const label = notes === text ? 'Transkript' : 'Vollständige Notizen zum ganzen Gespräch';
      const out = await llm(SUMMARY_SYSTEM + extra, `Datum: ${fmtDate(r.created)}\nDauer: ${fmtTime(r.duration)}\n\n${label}:\n${notes}`, settings.claude ? 8000 : 4000);
      const m = out.match(/^\s*#\s+(.+)\n/);
      const patch = { summary: m ? out.slice(m[0].length).trim() : out.trim(), resum: false, notes: notes === text ? '' : notes };
      if (m && (r.autoTitle !== false)) patch.title = m[1].trim();
      r = await updateRec(id, patch);
    }
    await updateRec(id, { status: 'done', progress: '', error: '', backfill: false });
  } catch (e) {
    if (e.limitWait) await updateRec(id, { status: 'pending', progress: noteLimit(e.limitWait), error: '' });
    else await updateRec(id, { status: 'error', progress: '', error: e.message || String(e) });
  } finally {
    working.delete(id);
    priority.delete(id);
    if (rerun.delete(id)) processRec(id);
  }
}
async function ask(id, q) {
  const r = await getRec(id);
  const full = transcriptText(r);
  // Groq schafft im Gratistarif keine langen Transkripte am Stück, dann dienen die Notizen als Grundlage
  const source = settings.claude || full.length <= PART_CHARS ? full : (r.notes || await condense(full));
  const answer = await llm(
    `Du beantwortest Fragen zu einem Gesprächsmitschnitt. Antworte knapp und nenne, wo möglich, die Zeitmarke in eckigen Klammern. Wenn das Gespräch die Antwort nicht hergibt, sag das. ${STYLE}`,
    `Transkript:\n${source}\n\nFrage: ${q}`, 1500);
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
    $('#sBackupText').value = ''; $('#sBackupBox').hidden = true;
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
  const warn = $('#dWarn');
  warn.hidden = !r.gaps?.length;
  warn.textContent = (r.gaps || []).map((g) => g.missing
    ? `${fmtTime(g.from)} bis ${fmtTime(g.to)}: Dieser Audioteil fehlt im Speicher.`
    : `${fmtTime(g.from)} bis ${fmtTime(g.to)}: Geräusche, aber keine Sprache erkannt. Bitte im Audio nachhören.`).join(' ');
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
    const b = await getAudio(r.id, chunkIdx(r.chunks[i], i));
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
    releaseAwake();
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
  if (working.has(current.id)) { toast('Diese Aufnahme wird gerade schon verarbeitet.'); return; }
  processRec(current.id, { retranscribe: true, resummarize: true });
};
$('#aResum').onclick = () => {
  if (!current) return;
  if (working.has(current.id)) { toast('Diese Aufnahme wird gerade schon verarbeitet.'); return; }
  processRec(current.id, { resummarize: true });
};
$('#aDelete').onclick = async () => {
  if (!current || !confirm('Dieses Gespräch mit Audio endgültig löschen?')) return;
  await deleteRec(current);
  location.hash = '#/';
  toast('Gelöscht.');
};
// Einstellungen speichern sich bei jeder Eingabe selbst, der Knopf prüft zusätzlich den Schlüssel
function readSettingsForm(e) {
  // Sicherungslink in ein Schlüsselfeld eingefügt: beide Schlüssel übernehmen
  const pasted = [$('#sGroq').value, $('#sClaude').value].find((v) => v.includes('#setup='));
  if (pasted && importSetupLink(pasted)) { fillSettings(); updateKeyState(); resumePending(); return; }
  const hadKey = !!(settings.groq || settings.claude);
  // Ein Schlüssel wird nur leer, wenn man ihn selbst löscht, nie durch Autofill in einem anderen Feld
  const key = (sel, old) => { const v = $(sel).value.trim(); return v || (e?.target !== $(sel) ? old : ''); };
  settings = {
    ...settings,
    groq: key('#sGroq', settings.groq), claude: key('#sClaude', settings.claude), lang: $('#sLang').value,
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
// Nur die letzten vier Zeichen zeigen, damit man den Schlüssel mit der Anbieter-Konsole vergleichen kann
const keyEnd = (k) => (k ? ' (endet auf ' + k.slice(-4) + ')' : '');
function updateKeyState(check) {
  const el = $('#sGroqState');
  const has = !!(settings.groq || settings.claude);
  $('#keyBanner').hidden = !!settings.groq;
  if (!settings.groq) { el.textContent = 'Kein Groq-Schlüssel gespeichert.'; el.className = 'small bad'; }
  else if (!check) { el.textContent = 'Groq-Schlüssel gespeichert' + keyEnd(settings.groq) + '.'; el.className = 'small good'; }
  else el.textContent = { ok: '✓ Groq-Schlüssel funktioniert' + keyEnd(settings.groq) + '.', bad: '✗ Groq lehnt diesen Schlüssel ab' + keyEnd(settings.groq) + '. Bitte neu kopieren.', offline: 'Keine Verbindung, Schlüssel konnte nicht geprüft werden.' }[check] || '';
  $('#sClaudeState').textContent = settings.claude ? 'Claude-Schlüssel gespeichert' + keyEnd(settings.claude) + '.' : '';
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
$('#sBackup').onclick = async () => {
  if (!settings.groq && !settings.claude) { toast('Erst Schlüssel eintragen.'); return; }
  const url = setupLink();
  // Link immer sichtbar zeigen, denn manche Handys blockieren das Kopieren still
  const box = $('#sBackupText');
  box.value = url;
  $('#sBackupBox').hidden = false;
  $('#sBackupShare').hidden = !navigator.share;
  box.focus(); box.select(); box.setSelectionRange(0, url.length);
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch {}
  if (!ok) { try { ok = document.execCommand('copy'); } catch {} }
  toast(ok ? 'Sicherungslink kopiert. In einer gesperrten Notiz oder im Passwort-Manager ablegen.'
           : 'Kopieren blockiert. ' + (navigator.share ? 'Tippe auf „Teilen“ oder halte' : 'Halte') + ' den Link gedrückt und wähle Kopieren.', 6000);
};
$('#sBackupShare').onclick = async () => {
  try { await navigator.share({ title: 'Mitschrift Sicherungslink', text: $('#sBackupText').value }); } catch {}
};
$('#sDiag').onclick = async () => {
  const recs = (await allRecs()).sort((a, b) => b.created - a.created);
  const keys = await tx('audio', 'readonly', (s) => s.getAllKeys());
  const lines = [
    `Mitschrift-Diagnose ${new Date().toLocaleString('de-DE')} | Version ${DIAG_VERSION}`,
    `Groq-Schlüssel: ${settings.groq ? 'ja' + keyEnd(settings.groq) : 'nein'} | Claude-Schlüssel: ${settings.claude ? 'ja' + keyEnd(settings.claude) : 'nein'}`,
    `In Arbeit: ${[...working].join(', ') || 'nichts'} | Warteschlange läuft: ${resuming ? 'ja' : 'nein'} | Limit bis: ${limitUntil > Date.now() ? new Date(limitUntil).toLocaleTimeString('de-DE') : 'keins'}`,
  ];
  for (const r of recs) {
    const audio = keys.filter((k) => String(k).startsWith(r.id + ':')).length;
    const parts = Object.keys(r.parts || {}).length;
    lines.push([
      fmtDate(r.created), (r.title || '').slice(0, 30), `Status ${r.status}`, `Dauer ${fmtTime(r.duration || 0)}`,
      `Teile ${r.chunks?.length || 0}, Audio ${audio}, fertig ${parts}`, `pv ${r.pv ?? '-'}`,
      `nach ${r.backfill ? 'j' : 'n'}/${r.redo ? 'j' : 'n'}/${r.resum ? 'j' : 'n'}`,
      `Text ${(r.transcript?.text || '').length}, Zus ${(r.summary || '').length}`,
      r.gaps?.length ? `Lücken ${r.gaps.length}` : '', r.progress || '', r.error ? `Fehler: ${r.error}` : '',
    ].filter(Boolean).join(' | '));
  }
  const text = lines.join('\n');
  $('#sDiagText').value = text;
  $('#sDiagText').hidden = false;
  try { await navigator.clipboard.writeText(text); toast('Diagnose kopiert. Schick sie mir.'); } catch { toast('Text markieren und kopieren.'); }
};
$('#sBackupHide').onclick = () => { $('#sBackupText').value = ''; $('#sBackupBox').hidden = true; };
$('#dStatus').onclick = () => { if (current?.error && /Schlüssel|Einstellungen/.test(current.error)) location.hash = '#/settings'; };

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (isRecording()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!isRecording()) { resumePending(); return; }
  keepAwake();
  if (micBroken()) { if (rec.lostAt) reconnectMic(); else micLost(); }
});

// Unterbrochene Aufnahmen, offene Verarbeitungen und ältere Aufnahmen nacheinander abarbeiten
let resuming = false, resumeAgain = false;
async function resumePending() {
  if (resuming) { resumeAgain = true; return; }
  if (rec.startedAt || Date.now() < limitUntil) return;
  resuming = true;
  try {
    // Neue Aufnahmen zuerst, danach alte; jeweils die neueste voran
    const recs = (await allRecs()).sort((a, b) => isBackfill(a) - isBackfill(b) || b.created - a.created);
    for (let r of recs) {
      if (rec.startedAt || Date.now() < limitUntil) break; // Aufnahme oder Limit geht vor, danach läuft es weiter
      if (r.status === 'recording') r = await updateRec(r.id, { status: 'pending' });
      if (r.pv !== PV && settings.groq && r.status !== 'pending') r = await updateRec(r.id, { pv: PV, parts: {}, redo: r.chunks.length > 0, resum: !!(r.chunks.length || r.transcript), backfill: true });
      const open = ['pending', 'transcribing', 'summarizing'].includes(r.status) || (r.redo && settings.groq) || (r.resum && (settings.groq || settings.claude));
      if (open || (r.status === 'error' && !r.summary && (settings.groq || settings.claude))) await processRec(r.id);
    }
  } finally {
    resuming = false;
    if (resumeAgain) { resumeAgain = false; resumePending(); }
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
try { navigator.storage?.persist?.(); } catch {}
importSetupLink();
restoreSettings().then(() => { updateKeyState(); return route(); }).then(resumePending);
