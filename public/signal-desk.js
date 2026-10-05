const feed = document.getElementById('feed');
// Each research renders inside its own .run-view container so an in-flight
// run keeps painting (and completing, and persisting to Recents) after the
// user switches to another research. `view` is where new blocks land NOW;
// async continuations capture their own container and re-enter it with
// inView() so a finished background run never writes into the visible one.
let view = feed;
function newView(){
  feed.querySelectorAll(':scope > .run-view').forEach(v=>{ v.style.display='none'; });
  const v=document.createElement('div');
  v.className='run-view';
  feed.append(v);
  view=v;
  return v;
}
function inView(v, fn){ const cur=view; view=v; try{ return fn(); } finally{ view=cur; } }
const composer = document.getElementById('composer');
const newBtn = document.getElementById('newBtn');
const startBtn = document.getElementById('startBtn');
const ta = document.getElementById('doc');
const fileName = document.getElementById('fileName');
// Added sources (PDF, screenshot, tweet, video link, article) — all become text.
let sources = [];
const srcText = () => sources.map(s=>`[Source: ${s.label}]\n${s.text}`).join('\n\n');
// Admin prompt-log view of the same sources (user decision 2026-07-16): links
// log only their URL, screenshots/files a placeholder, voice notes keep the
// full transcript. Sources restored from Recents predate `kind` and fall back
// to the full text.
const srcLog = () => sources.map(s =>
  s.kind==='link' ? `[Link] ${s.url || s.label}`
  : s.kind==='file' ? `[screenshot/file] ${s.label}`
  : s.kind==='voice' ? `[Voice note]\n${s.text}`
  : `[Source: ${s.label}]\n${s.text}`).join('\n\n');
const URL_RE = /^https?:\/\/\S+$/i;
const trimUrl = (s) => s.trim().replace(/[)\].,;!?]+$/g, '');
const pastedUrl = (s) => {
  const clean = trimUrl(s);
  try { return URL_RE.test(clean) ? new URL(clean).href : ''; }
  catch { return ''; }
};

// Enable start as soon as the user has provided any prompt or source text.
const refreshReady = () => { startBtn.disabled = (ta.value.trim() + srcText()).trim().length === 0; };
ta.addEventListener('input', refreshReady);

// All API calls go through here so the beta auth token (sd-auth.js) rides
// along when auth is enabled; without it this is a plain fetch (spec §12).
// sd-auth.js is a separate script: poll briefly in case a call fires before
// it has bootstrapped (page scripts carry no load-order guarantee).
async function apiFetch(path, opts = {}){
  for (let i = 0; i < 100 && !window.sdAuthReady; i++) await new Promise((r) => setTimeout(r, 50));
  await (window.sdAuthReady || Promise.resolve());
  const t = window.sdAuth ? await window.sdAuth.token() : null;
  const headers = { ...(opts.headers || {}) };
  if (t) headers.authorization = 'Bearer ' + t;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && window.sdAuth?.enabled) {
    // Never a dead end (e2e R3): a dismissed sign-in dialog comes back.
    window.sdAuth.showGate?.();
    throw new Error('Please sign in to continue.');
  }
  return res;
}
const CREDITS_OUT_MSG = 'You have no credits left for today. Credits refresh every day at midnight UTC. Contact the beta admin if you need more sooner.';
// sd-auth.js owns the floating notice; degrade to console if it did not load.
const flashNote = (m) => (window.flashNote ? window.flashNote(m) : console.warn(m));

function renderSrcChips(){
  const el = document.getElementById('srcChips');
  el.innerHTML = '';
  sources.forEach((s, i) => {
    const c = document.createElement('button');
    c.className = 'chip'; c.type = 'button';
    c.style.color = 'var(--amber)'; c.style.borderColor = 'rgba(240,168,60,.4)';
    c.textContent = `${s.label} · ${s.text.length.toLocaleString()} characters · Remove`;
    c.title = 'Remove this source';
    c.onclick = () => { sources.splice(i, 1); renderSrcChips(); refreshReady(); };
    el.appendChild(c);
  });
}
function addSource(label, text, note, meta){
  sources.push({ label, text, ...(meta || {}) });
  renderSrcChips();
  fileName.textContent = note || '';
  refreshReady();
}

async function loadLinkSource(url){
  fileName.textContent = 'Opening link. This can take about 30 seconds.';
  const res = await apiFetch('/api/extract', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'link', url }) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || 'Could not read that link.');
  addSource(j.label, j.text, j.approximate ? 'Web search reconstructed this source. Review the thesis before continuing.' : '', {kind:'link', url});
  return j;
}

ta.addEventListener('paste', (e) => {
  const url = pastedUrl(e.clipboardData?.getData('text/plain') || '');
  if (!url) return;
  e.preventDefault();
  loadLinkSource(url).catch((err) => { fileName.textContent = '⚠ ' + err.message; });
});

const addMenuBtn = document.getElementById('addMenuBtn');
const addMenu = document.getElementById('addMenu');
function setAddMenu(open){
  addMenu.hidden = !open;
  addMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
addMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setAddMenu(addMenu.hidden);
});
document.addEventListener('click', (e) => {
  if (!addMenu.hidden && !addMenu.contains(e.target) && e.target !== addMenuBtn) setAddMenu(false);
});

// Model picker: display only for now. The current model is fixed; the other
// entries are disabled "Soon" placeholders until user model choice ships.
const modelBtn = document.getElementById('modelBtn');
const modelMenu = document.getElementById('modelMenu');
function setModelMenu(open){
  modelMenu.hidden = !open;
  modelBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setModelMenu(modelMenu.hidden);
});
document.getElementById('modelCurrent').addEventListener('click', () => setModelMenu(false));
document.addEventListener('click', (e) => {
  if (!modelMenu.hidden && !modelMenu.contains(e.target) && !modelBtn.contains(e.target)) setModelMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setAddMenu(false);
    setModelMenu(false);
    linkWrap.style.display = 'none';
  }
});

// pdf.js is served by our own server from the pdfjs-dist package (security
// audit M4: no third-party CDN script on this origin) and loaded only when a
// PDF is added. Eval stays off; recent pdf.js builds have no eval path at all.
let pdfjsReady = null;
function loadPdfjs(){
  if (!pdfjsReady) {
    pdfjsReady = import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
    pdfjsReady.catch(() => { pdfjsReady = null; }); // a failed load may be retried
  }
  return pdfjsReady;
}

// ➕ Add file: PDF (client-side pdf.js), screenshot/image (server vision),
// audio/video files (transcoded to WAV client-side, transcribed server-side).
document.getElementById('addFileBtn').addEventListener('click', () => {
  setAddMenu(false);
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = '';
  try {
    if (file.type === 'application/pdf') {
      fileName.textContent = 'Reading ' + file.name + '…';
      const buf = await file.arrayBuffer();
      let pdfjsLib;
      try { pdfjsLib = await loadPdfjs(); }
      catch { throw new Error('The PDF reader could not be loaded. Try again in a moment.'); }
      const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      let txt = ''; const max = Math.min(doc.numPages, 20);
      for (let i = 1; i <= max; i++) {
        const pg = await doc.getPage(i);
        const c = await pg.getTextContent();
        txt += c.items.map((it) => it.str).join(' ') + '\n';
      }
      if (txt.trim().length < 20) throw new Error('No readable text was found in that PDF.');
      addSource(file.name, txt.trim(), '', {kind:'file'});
    } else if (file.type.startsWith('image/')) {
      if (file.size > 5 * 1024 * 1024) throw new Error('The image exceeds the 5 MB limit.');
      fileName.textContent = 'Reading ' + file.name + '…';
      const b64 = await new Promise((ok, ko) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1]);
        r.onerror = ko; r.readAsDataURL(file);
      });
      const res = await apiFetch('/api/extract', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'image', media_type: file.type, data: b64 }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Could not extract text from that image.');
      addSource(file.name + ' (screenshot)', j.text, '', {kind:'file'});
    } else if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
      await transcribeAudio(await file.arrayBuffer(), file.name);
    } else {
      fileName.textContent = '⚠ Unsupported file type: ' + (file.type || file.name.split('.').pop());
    }
  } catch (err) {
    fileName.textContent = '⚠ ' + err.message;
  }
});

// ---- Voice notes: any audio the browser can decode → 16kHz mono WAV →
// /api/extract {kind:'audio'} → transcript becomes a normal source (spec §5.1).
const MAX_AUDIO_SEC = 600;

// AudioBuffer (1ch) → base64 of a 16-bit PCM WAV file.
function wavBase64(mono){
  const pcm = mono.getChannelData(0), n = pcm.length, rate = mono.sampleRate;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = ''; // btoa can't take the whole buffer as one call-arg list
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function transcribeAudio(arrayBuf, label){
  fileName.textContent = 'Preparing audio…';
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let decoded;
  try { decoded = await ac.decodeAudioData(arrayBuf); }
  catch { throw new Error('Could not read that audio. For a video, add its link instead.'); }
  finally { ac.close(); }
  if (decoded.duration > MAX_AUDIO_SEC) throw new Error(`The audio is ${Math.round(decoded.duration / 60)} minutes long. The limit is ${MAX_AUDIO_SEC / 60} minutes.`);
  if (decoded.duration < 1) throw new Error('The recording is too short.');
  const rate = 16000; // speech-recognition standard; shrinks the upload too
  const oc = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = oc.createBufferSource(); src.buffer = decoded; src.connect(oc.destination); src.start();
  const data = wavBase64(await oc.startRendering());
  fileName.textContent = `Transcribing ${label} (${Math.round(decoded.duration)} seconds)…`;
  const res = await apiFetch('/api/extract', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'audio', media_type: 'audio/wav', data }) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || 'Could not transcribe that recording.');
  addSource(`${label} (voice note)`, j.text, '', {kind:'voice'});
}

// 🎙 Record voice: MediaRecorder → same transcode + transcription path.
const recBtn = document.getElementById('recBtn');
const MIC_ICON = recBtn.innerHTML;
const STOP_ICON = '<span class="stop-dot" aria-hidden="true"></span>';
function paintRecIdle(){
  recBtn.innerHTML = MIC_ICON;
  recBtn.classList.remove('is-recording');
  recBtn.setAttribute('aria-label', 'Record a voice note');
  recBtn.title = 'Record a voice note';
}
function paintRecRecording(seconds){
  const label = `Stop recording (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')})`;
  recBtn.innerHTML = STOP_ICON;
  recBtn.classList.add('is-recording');
  recBtn.setAttribute('aria-label', label);
  recBtn.title = label;
}
let rec = null, recTimer = null;
recBtn.addEventListener('click', async () => {
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  let stream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'SecurityError' });
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // Embedded previews (IDE panels) auto-deny the mic without ever prompting —
    // tell the user to move to a real browser tab instead of "check permission".
    fileName.textContent =
      err.name === 'NotAllowedError'
        ? 'Microphone access is blocked. Open this page in Chrome or Safari, then allow microphone access in the address bar.'
        : err.name === 'NotFoundError' || err.name === 'OverconstrainedError'
          ? 'No microphone was found. You can upload a voice recording with Add file.'
          : err.name === 'SecurityError'
            ? 'Recording requires a secure connection. Open the app at http://localhost.'
            : 'Microphone unavailable: ' + (err.message || err.name);
    return;
  }
  const chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recTimer);
    paintRecIdle();
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      await transcribeAudio(await blob.arrayBuffer(), 'recorded');
    } catch (err) { fileName.textContent = '⚠ ' + err.message; }
    rec = null;
  };
  rec.start();
  const t0 = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    paintRecRecording(s);
    fileName.textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}. Select the microphone to stop.`;
    if (s >= MAX_AUDIO_SEC && rec) rec.stop();
  };
  tick(); recTimer = setInterval(tick, 1000);
});

// 🔗 Add link: X/Twitter post, YouTube video, or any article URL.
const linkWrap = document.getElementById('linkWrap');
document.getElementById('addLinkBtn').addEventListener('click', async () => {
  setAddMenu(false);
  linkWrap.style.display = linkWrap.style.display === 'none' ? 'block' : 'none';
  if (linkWrap.style.display !== 'block') return;
  const input = document.getElementById('linkUrl');
  input.focus();
  // Pre-fill from the clipboard when it holds a URL, but never auto-load —
  // the user confirms with Load/Enter (spec §6, 2026-07-09).
  try {
    const url = pastedUrl(await navigator.clipboard?.readText?.() || '');
    if (url && !input.value) input.value = url;
  } catch {
    // Clipboard access is optional; manual paste still works.
  }
});
document.getElementById('linkLoad').addEventListener('click', async () => {
  const url = pastedUrl(document.getElementById('linkUrl').value);
  if (!url) return;
  try {
    await loadLinkSource(url);
    document.getElementById('linkUrl').value = '';
    linkWrap.style.display = 'none';
  } catch (err) {
    fileName.textContent = '⚠ ' + err.message;
  }
});
document.getElementById('linkUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('linkLoad').click(); }
});

// Ideas for you: three example researches that show the vocabulary the
// screen understands (asset kinds, geographies, direction), each with a
// small pictogram matching the topic.
const IDEA_ICONS = {
  factory: '<svg viewBox="0 0 24 24"><path d="M2 20h20"/><path d="M4 20V9l5 4V9l5 4V4h6v16"/><path d="M17 8h.01"/></svg>',
  eth: '<svg viewBox="0 0 24 24"><path d="M12 2 5 12l7 4 7-4Z"/><path d="m5 14 7 8 7-8-7 4Z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6Z"/></svg>',
};
const IDEAS = [
  { icon: 'factory', text: 'Long European industrial automation stocks as manufacturing reshores to Europe.' },
  { icon: 'eth', text: 'Rollups and staking will increase demand across the Ethereum ecosystem. Screen crypto only.' },
  { icon: 'bolt', text: 'US data center power demand will benefit utilities, nuclear stocks and grid ETFs.' },
];
const ideaList = document.getElementById('ideaList');
if (ideaList) IDEAS.forEach((idea) => {
  const b = document.createElement('button');
  b.className = 'idea'; b.type = 'button'; b.title = idea.text;
  b.innerHTML = `<span class="idea-ico">${IDEA_ICONS[idea.icon]}</span><span class="idea-t"></span>`;
  b.querySelector('.idea-t').textContent = idea.text;
  b.onclick = () => { ta.value = idea.text; refreshReady(); ta.focus(); };
  ideaList.appendChild(b);
});
// Dice button (2026-07-13): drops a random ready-made thesis into the
// composer. Ten phrases across the asset categories, served in shuffled
// rotation so all ten cycle before any repeats.
const RANDOM_THESES = [
  'European defense spending is entering a multi year upcycle. Long contractors and their suppliers.',
  'AI compute demand will outpace supply for years. Long chipmakers, data center REITs and power providers.',
  'Ethereum layer 2 adoption will drive fee revenue across the ecosystem. Screen crypto only.',
  'I want diversified exposure to the global energy transition through ETFs only, no single stocks.',
  'Space launch and satellite infrastructure are the next platform shift. Include pre IPO companies.',
  'Central banks will cut rates faster than markets expect. Show me Polymarket bets and rate sensitive assets.',
  'Legacy carmakers that lag on software will lose share to EV natives. Short candidates only.',
  'Italian luxury and high end manufacturing keep gaining pricing power. Screen Italian stocks.',
  'Obesity drugs will reshape healthcare economics. Long the winners across pharma and their supply chain.',
  'Copper supply cannot keep up with electrification. Long miners and royalty companies with copper exposure.',
];
const randomBtn = document.getElementById('randomBtn');
if (randomBtn) {
  let deck = [];
  randomBtn.addEventListener('click', () => {
    if (!deck.length) deck = [...RANDOM_THESES].sort(() => Math.random() - 0.5);
    ta.value = deck.pop();
    refreshReady(); ta.focus();
  });
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Data attribution: CoinGecko API terms 4.3 and its attribution guide ask for
// "Data provided by CoinGecko", linked, close to where its data is shown.
const CG_URL='https://www.coingecko.com/en/api';
/** True when a result shows CoinGecko figures (a crypto pick with market data). */
const showsCoinGecko=(r)=>(r?.picks||[]).some(p=>p.kind==='crypto'&&p.market);
const fmtMoney = (v, cur) => {
  if (v == null) return 'N/A';
  const code = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'HKD' ? 'HK$' : cur + ' ';
  return code + (v >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 0}) : v.toLocaleString('en-US', {maximumFractionDigits: v >= 1 ? 2 : 4}));
};
const fmtCap = (v) => v == null ? 'N/A' : v >= 1e12 ? '$' + (v/1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v/1e9).toFixed(1) + 'B' : '$' + (v/1e6).toFixed(0) + 'M';
// Trading volumes can be small (a $100k/day coin floors to "$0M" under fmtCap), so keep the k tier.
const fmtVol = (v) => v == null ? 'N/A' : v >= 1e9 ? '$' + (v/1e9).toFixed(1) + 'B' : v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v/1e3).toFixed(0) + 'k' : '$' + Math.round(v);

// Alignment gauge — semicircular score arc (spec §6): score-proportional fill,
// threshold notches at 40/70, centered numeric score, animated sweep.
function gauge(score){
  const s=Math.max(0, Math.min(100, Number(score)||0));
  const cx=70, cy=74, R=56, band=11;
  const D2R=d=>d*Math.PI/180;
  const px=(ang,rad)=>[cx+rad*Math.cos(D2R(ang)), cy-rad*Math.sin(D2R(ang))];
  const p0=px(180,R), p1=px(0,R);
  const track=`M ${p0[0].toFixed(1)} ${p0[1].toFixed(1)} A ${R} ${R} 0 0 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
  const bkt = s>=70?'high': s>=40?'mid':'low';
  const col = bkt==='high'?'var(--amber)': bkt==='mid'?'#caa15a':'var(--bone-dim)';
  const len = Math.PI*R;
  const target = len*(1-s/100);
  const notches=[40,70].map(v=>{
    const a=180-(v/100)*180, i=px(a,R-band/2-2.5), o=px(a,R+band/2+2.5);
    return `<line x1="${i[0].toFixed(1)}" y1="${i[1].toFixed(1)}" x2="${o[0].toFixed(1)}" y2="${o[1].toFixed(1)}" stroke="var(--ink-2)" stroke-width="2.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 140 84" width="140" height="84" role="img" aria-label="Thesis fit: ${bkt==='mid'?'medium':bkt}, ${s} out of 100">
    <path d="${track}" fill="none" stroke="rgba(154,163,154,.22)" stroke-width="${band}" stroke-linecap="round"/>
    <path class="garc" d="${track}" fill="none" stroke="${col}" stroke-width="${band}" stroke-linecap="round"
      stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${len.toFixed(1)}" data-target="${target.toFixed(1)}"/>
    ${notches}
    <text class="gnum" x="${cx}" y="63" text-anchor="middle" fill="${col}">${s}</text>
    <text class="gsub" x="${cx}" y="77" text-anchor="middle" fill="var(--bone-dim)">/ 100</text>
  </svg>`;
}
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function activateGauges(scope){ (scope||document).querySelectorAll('.garc').forEach(a=>{ const t=a.getAttribute('data-target'); if(reduce){ a.style.transition='none'; a.style.strokeDashoffset=t; } else { requestAnimationFrame(()=>requestAnimationFrame(()=>{ a.style.strokeDashoffset=t; })); } }); }

// Real 30-day sparkline (spec §5.6: true series, asOf shown, SIM/LIVE retired).
// Start / avg / last are annotated ON the chart (spec §0, 2026-07-08): start
// pinned at the line's left end, avg as a dashed level with a centered label,
// last pinned at the right end and colored green/red vs the START price.
// Labels are HTML overlays, not SVG text — preserveAspectRatio="none" would
// stretch glyphs. Vertical positions clamp to 14–86% so edge points don't
// push a label outside the 48px chart.
// `fmt` selects the value formatter: 'price' (default) for quotes, 'cap' for
// pre-IPO valuation curves, whose billions render unreadably under fmtMoney.
function sparkline(series, change, currency, fmt){
  if (!series || series.length < 2) return '<div class="sub" style="font-family:var(--mono);font-size:11px;color:var(--bone-dim)">Price history unavailable</div>';
  const w=210, h=48, min=Math.min(...series), max=Math.max(...series), span=(max-min)||1;
  const y=(v)=>(h-4-((v-min)/span)*(h-8));
  const pts=series.map((v,i)=>`${(i/(series.length-1)*w).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const color = change==null ? 'var(--bone-dim)' : change>=0 ? 'var(--up)' : 'var(--down)';
  const first=series[0], last=series[series.length-1];
  const avg=series.reduce((a,b)=>a+b,0)/series.length;
  const f=(v)=>fmt==='cap' ? fmtCap(v) : fmtMoney(v, currency||'USD');
  const yPct=(v)=>Math.min(86, Math.max(14, y(v)/h*100)).toFixed(1)+'%';
  const lastColor = last>=first ? 'var(--up)' : 'var(--down)';
  return `<div class="spark-wrap">
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <line x1="0" y1="${y(avg).toFixed(1)}" x2="${w}" y2="${y(avg).toFixed(1)}" stroke="var(--bone-dim)" stroke-width="1" stroke-dasharray="3,5" opacity=".45"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/>
    </svg>
    <span class="spark-val start" style="top:${yPct(first)}">${f(first)}</span>
    <span class="spark-val avg" style="top:${yPct(avg)}">${f(avg)}</span>
    <span class="spark-val last" style="top:${yPct(last)};color:${lastColor}">${f(last)}</span>
  </div>`;
}

function fmtWeight(v){ return v == null ? 'N/A' : Number(v).toFixed(Number(v) >= 10 ? 1 : 2) + '%'; }
function portfolioBlock(p){
  const pf=p.etf_portfolio||{};
  const holdings=(pf.top_holdings||[]).slice(0,8);
  const slices=(pf.sector_weights?.length ? pf.sector_weights : pf.asset_allocation?.length ? pf.asset_allocation : pf.region_weights || []).slice(0,8);
  if(!holdings.length && !slices.length) return '';
  const h=holdings.map(x=>`<div class="holding"><span>${x.symbol?`<b>${esc(x.symbol)}</b>`:''}${esc(x.name)}</span><span class="wt">${fmtWeight(x.weight)}</span></div>`).join('');
  const s=slices.map(x=>`<div class="slice"><span>${esc(x.name)}</span><span class="wt">${fmtWeight(x.weight)}</span></div>`).join('');
  const sliceLabel = pf.sector_weights?.length ? 'Sector weights' : pf.asset_allocation?.length ? 'Asset allocation' : 'Region weights';
  return `<div class="portfolio">
    <div class="portfolio-grid">
      ${holdings.length?`<div><div class="k">Top holdings${pf.holdings_count?` · ${esc(pf.holdings_count)} total`:''}</div>${h}</div>`:''}
      ${slices.length?`<div><div class="k">${sliceLabel}</div>${s}</div>`:''}
    </div>
  </div>`;
}

const assetLabel=(xs)=>xs?.length?xs.map(x=>({stock:'Stocks',crypto:'Crypto',etf:'ETFs',bond:'Bonds',private:'Pre IPO',polymarket:'Polymarket'}[x]||x)).join(' + '):'Full universe';
const regionLabel=(xs)=>xs?.length?xs.map(x=>({us:'US',eu:'Europe',cn:'China',it:'Italy',other:'Intl',global:'Global'}[x]||x)).join(' / '):'Any market';
const dirLabel=(d)=>d==='short'?'Short':d==='both'?'Both sides':'Long';
// Mirrors the Screen settings selectors (2026-07-13): same categories, same
// live state — every seg click repaints this bar via repaintParse().
function parseSummary(t){
  const picks=(key,allVal)=>((typeof cardCrit!=='undefined'&&cardCrit?.[key])||[]).filter(v=>v!==allVal);
  const caps=picks('cap_set',CAP_ALL);
  const capLabel=caps.length?caps.map(c=>({low:'Low',medium:'Mid',high:'High'}[c]||c)).join(' + '):'All sizes';
  const showBreadth=(t.strategies||[]).length>=2 && (t.direction||'long')!=='both';
  return `<div class="parse-bar">
    <div class="parse-item"><div class="k">Direction</div><div class="v">${dirLabel(t.direction)}</div></div>
    ${showBreadth?`<div class="parse-item"><div class="k">Breadth</div><div class="v">${breadthMode==='diversified'?'Diversified':'Focused'}</div></div>`:''}
    <div class="parse-item"><div class="k">Assets</div><div class="v">${assetLabel(picks('asset_set',ASSET_ALL))}</div></div>
    <div class="parse-item"><div class="k">Markets</div><div class="v">${regionLabel(picks('region_set',REGION_GLOBAL))}</div></div>
    <div class="parse-item"><div class="k">Market cap</div><div class="v">${capLabel}</div></div>
  </div>`;
}
function splitSentences(s){
  return String(s||'').replace(/\s+/g,' ').trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(x=>x.trim()).filter(Boolean)||[];
}
function caveatText(p){
  const text=p.analysis||p.why||'';
  const s=splitSentences(text);
  const hit=s.find(x=>/(caveat|risk|limit|partial|weaker|less pure|watch|thin|liquid|borrow|valuation|volatile|execution|identity|mismatch|conflict|not directly|secondary|peripheral)/i.test(x));
  if(hit) return hit;
  if(p.score<60) return 'This is an indirect expression of the thesis. Treat it as a secondary candidate, not a core position.';
  if(p.kind==='crypto' && !(p.cex_venues||[]).length) return 'No major centralized venue is listed. Access and liquidity may be limited.';
  return 'No specific risk was identified in the analysis. Review valuation, liquidity, access, timing and position size before acting.';
}
function newsBlock(p){
  const n=p.news;
  if(!n?.url || !n?.headline) return `<div class="news-hit no-news"><div class="nh">Recent news</div><p>Coming soon.</p></div>`;
  const meta=[n.source, n.date].filter(Boolean).join(' · ');
  return `<div class="news-hit"><div class="nh">Recent news</div>
    <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.headline)}</a>
    ${meta?`<div class="src">${esc(meta)}</div>`:''}
    ${n.summary?`<p>${esc(n.summary)}</p>`:''}
  </div>`;
}
function warningBadges(p, groupSize=1){
  const w=[];
  const text=`${p.why||''} ${p.analysis||''}`;
  if(/appears to conflict|should be flagged|no identifiable mechanism|identity|mismatch/i.test(text)) w.push(['risk','identity risk']);
  if(groupSize>1) w.push(['warn',`${groupSize} listings`]);
  if(/\bADR\b|OTC/i.test(`${p.name} ${p.exchange||''} ${text}`)) w.push(['warn','listing nuance']);
  if(p.score<60) w.push(['warn','stretch fit']);
  if(p.kind==='crypto' && !(p.cex_venues||[]).length) w.push(['warn','limited exchange access']);
  return w.map(([cls,label])=>`<span class="badge ${cls}">${esc(label)}</span>`).join('');
}
const SORT_SELECT=`<label>Sort <select data-act="sort"><option value="rank">rank</option><option value="score">thesis fit</option><option value="cap">market cap</option><option value="move">30 day move</option></select></label>`;
function basketMetrics(groups, dir){
  const picks=groups.flat();
  const kinds=[...new Set(picks.map(p=>p.kind))];
  const regions=[...new Set(picks.filter(p=>p.kind!=='crypto').map(p=>p.region))];
  const avg=picks.length?Math.round(picks.reduce((s,p)=>s+(Number(p.score)||0),0)/picks.length):0;
  const risks=[
    groups.some(g=>g.length>1)?'duplicate listings':'',
    // Data held back by the display policy is explained by the results note,
    // not flagged as a gap here.
    picks.some(p=>!p.market_withheld && !p.market?.price)?'missing prices':'',
    picks.some(p=>p.score<60)?'stretch fits':'',
    dir==='short'?'borrow/squeeze risk':'',
  ].filter(Boolean).join(', ') || 'standard diligence';
  return `<div class="basket-metrics">
    <div><div class="k">Companies and listings</div><div class="v">${groups.length} / ${picks.length}</div></div>
    <div><div class="k">Asset mix</div><div class="v">${assetLabel(kinds)}</div></div>
    <div><div class="k">Markets</div><div class="v">${regionLabel(regions)}</div></div>
    <div><div class="k">Average fit</div><div class="v">${avg}/100 · ${esc(risks)}</div></div>
  </div>`;
}
// Compact summary box (metrics only) — used by the multi-section result layouts.
function basketSummary(groups, dir, opts){
  const sortRow = opts?.withSort ? `<div class="basket-sort">${SORT_SELECT}</div>` : '';
  return `<section class="block basket${opts?.withSort?' has-sort':''}">${basketMetrics(groups, dir)}${sortRow}</section>`;
}
// Single-list results header as one card: title, recap, metrics and Sort all in
// one bordered box (spec §6, 2026-07-13).
function resultsCard(groups, dir, heading, recap){
  return `<section class="block res-summary has-sort">
    <h2>${esc(heading)}</h2>
    <div class="recap">${esc(recap)}</div>
    ${basketMetrics(groups, dir)}
    <div class="basket-sort">${SORT_SELECT}</div>
  </section>`;
}
function auditSummary(r){
  const lines=(r.statusLines||[]).filter(s=>/criteria check removed|audit removed|compliance audit removed/i.test(s));
  if(!lines.length) return '';
  return `<section class="block empty-state" style="text-align:left;border-style:solid">
    <h3 style="display:flex;align-items:center;gap:9px">Criteria adjustments<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></h3>
    <p>${lines.map(esc).join(' ')}</p>
  </section>`;
}
function rerunWithCrit(next){
  Object.assign(cardCrit, next);
  const btn=document.getElementById('continueBtn');
  if(btn) btn.click(); else complete('', lastAnswers, {rerun:true});
}
function emptyResearchState(r){
  const isEtf=(r.crit?.asset_set||[]).includes('etf');
  const isEu=(r.crit?.region_set||[]).includes('eu');
  return `<section class="block empty-state">
    <h3>Nothing matched your requirements</h3>
    <p>No asset met every requirement. Widen one or more filters to run a broader screen.</p>
    <div class="empty-actions">
      ${isEtf&&isEu?'<button type="button" data-empty-act="us-etf">Try US ETFs</button>':''}
      <button type="button" data-empty-act="all-assets">Remove asset filter</button>
      <button type="button" data-empty-act="all-markets">Search all markets</button>
    </div>
  </section>`;
}
function wireEmptyActions(scope){
  scope.querySelector('[data-empty-act="us-etf"]')?.addEventListener('click',()=>rerunWithCrit({asset_set:['etf'],region_set:['us']}));
  scope.querySelector('[data-empty-act="all-assets"]')?.addEventListener('click',()=>rerunWithCrit({asset_set:[ASSET_ALL]}));
  scope.querySelector('[data-empty-act="all-markets"]')?.addEventListener('click',()=>rerunWithCrit({region_set:[REGION_GLOBAL]}));
}

function linksRow(p){
  const items=[];
  if(p.website) items.push(`<a class="card-link project" href="${esc(p.website)}" target="_blank" rel="noopener">↗ Website</a>`);
  if(p.platform?.url) items.push(`<a class="card-link" href="${esc(p.platform.url)}" target="_blank" rel="noopener">↗ ${esc(p.platform.label)}</a>`);
  return items.length?`<div class="card-links">${items.join('')}</div>`:'';
}
// Fund facts (spec §3/§6, 2026-07-12): stored at ingest from FMP etf/info.
// Rows with no stored value are omitted, never guessed. The row builder is
// shared with the report export (§6, 2026-07-15), which restyles the rows.
function fundFactRows(p){
  if(p.kind!=='etf'&&p.kind!=='bond') return [];
  const pf=p.etf_portfolio||{};
  const compact=(v)=>{try{return new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(v);}catch{return String(v);}};
  return [
    ['Issuer',pf.issuer||null],
    ['Expense ratio',pf.expense_ratio!=null?Number(pf.expense_ratio).toFixed(2)+'%':null],
    ['Holdings',pf.holdings_count!=null?compact(pf.holdings_count):null],
    ['Inception',pf.inception_date?new Date(pf.inception_date).toLocaleDateString():null],
    ['Avg daily volume',pf.avg_volume!=null?compact(pf.avg_volume)+' shares':null],
    ['NAV',pf.nav!=null?fmtMoney(pf.nav, pf.nav_currency||'USD'):null],
    ['Domicile',pf.domicile||null],
  ].filter(([,v])=>v!=null&&v!=='');
}
function fundFacts(p){
  const rows=fundFactRows(p);
  if(!rows.length) return '';
  return `<div class="fa-sec"><div class="fa-lbl">Fund facts</div><div class="fund-facts">${rows.map(([k,v])=>`<div><span class="ff-k">${esc(k)}</span><span class="ff-v">${esc(String(v))}</span></div>`).join('')}</div></div>`;
}
// Financial data table (spec §5.6 fin + §6, 2026-07-13): everything else the
// vendors already give us free, per kind — the card keeps only the top 3 tiles.
// Rows with no value are omitted, never guessed. finRows/finRange are shared
// with the report export (§6, 2026-07-15), which restyles them for print.
function finRows(p){
  if(p.kind==='private') return [];
  const m=p.market||{}; const fin=m.fin||{};
  const cur=m.currency||'USD';
  const money=(v)=>v!=null?fmtMoney(v,cur):null;
  const num=(v,d=2)=>v!=null&&isFinite(v)?Number(v).toFixed(d):null;
  const pct=(v)=>v!=null&&isFinite(v)?Number(v).toFixed(2)+'%':null;
  const compact=(v)=>{try{return new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(v);}catch{return String(v);}};
  const span=(lo,hi)=>lo!=null&&hi!=null?`${fmtMoney(lo,cur)} to ${fmtMoney(hi,cur)}`:null;
  let rows=[];
  if(p.kind==='crypto'){
    rows=[
      ['Market cap rank',fin.rank!=null?'#'+fin.rank:null],
      ['Market cap',m.marketCap!=null?fmtCap(m.marketCap):null],
      ['Fully diluted valuation',fin.fdv!=null?fmtCap(fin.fdv):null],
      ['Circulating supply',fin.circSupply!=null?compact(fin.circSupply):null],
      ['Total supply',fin.totalSupply!=null?compact(fin.totalSupply):null],
      ['Max supply',fin.maxSupply!=null?compact(fin.maxSupply):null],
      ['24h volume',m.volume24h!=null?fmtVol(m.volume24h):null],
      ['7d avg daily volume',fin.avgVol7d!=null?fmtVol(fin.avgVol7d):null],
      ['30d avg daily volume',fin.avgVol30d!=null?fmtVol(fin.avgVol30d):null],
      ['24h range',span(fin.low24h,fin.high24h)],
      ['All-time high',fin.ath!=null?fmtMoney(fin.ath,cur)+(fin.athChangePct!=null?` (${Number(fin.athChangePct).toFixed(1)}%)`:''):null],
      ['All-time low',fin.atl!=null?fmtMoney(fin.atl,cur):null],
    ];
  }else{
    rows=[
      ['Open',money(fin.open)],
      ['Previous close',money(fin.prevClose)],
      ['Day range',span(fin.dayLow,fin.dayHigh)],
      ['Volume today',fin.volume!=null?compact(fin.volume)+' shares':null],
      ['50-day average',money(fin.priceAvg50)],
      ['200-day average',money(fin.priceAvg200)],
    ];
    if(p.kind==='stock'){
      rows.push(
        ['Market cap',m.marketCap!=null?fmtCap(m.marketCap):null],
        ['EPS (TTM)',num(fin.eps)],
        ['P/E (TTM)',num(fin.pe,1)],
        ['Price to sales',num(fin.priceToSales)],
        ['Price to book',num(fin.priceToBook)],
        ['Debt to equity',num(fin.debtToEquity)],
        ['Dividend yield',pct(fin.dividendYieldPct)],
        ['Gross margin',pct(fin.grossMarginPct)],
        ['Net margin',pct(fin.netMarginPct)],
      );
    }else{
      rows.push(['AUM',m.marketCap!=null?fmtCap(m.marketCap):null]);
    }
  }
  return rows.filter(([,v])=>v!=null&&v!=='');
}
// 52-week range (§6, 2026-07-13): lo/hi plus where today's price sits, 0-100.
function finRange(p){
  if(p.kind==='private') return null;
  const m=p.market||{};
  if(m.yearLow==null||m.yearHigh==null||m.yearHigh<=m.yearLow) return null;
  const pos=m.price!=null?Math.max(0,Math.min(100,((m.price-m.yearLow)/(m.yearHigh-m.yearLow))*100)):null;
  return {lo:m.yearLow, hi:m.yearHigh, pos, cur:m.currency||'USD'};
}
function finTable(p){
  const rows=finRows(p);
  const rng=finRange(p);
  const rangeRow=rng
    ? `<div class="fin-range"><span class="ff-k">52-week range</span><div class="range52"><span>${esc(fmtMoney(rng.lo,rng.cur))}</span><div class="range-bar">${rng.pos!=null?`<i style="left:${rng.pos.toFixed(1)}%"></i>`:''}</div><span>${esc(fmtMoney(rng.hi,rng.cur))}</span></div></div>`
    : '';
  if(!rows.length&&!rangeRow) return '';
  return `<div class="fa-sec"><div class="fa-lbl">Financial data</div><div class="fund-facts">${rows.map(([k,v])=>`<div><span class="ff-k">${esc(k)}</span><span class="ff-v">${esc(String(v))}</span></div>`).join('')}</div>${rangeRow}</div>`;
}
function fullAnalysis(p){
  const links=linksRow(p);
  const facts=fundFacts(p);
  const fintab=finTable(p);
  const secs=[];
  if(p.about) secs.push(`<div class="fa-sec"><div class="fa-lbl">Company overview</div><p>${esc(p.about)}</p></div>`);
  if(facts) secs.push(facts);
  if(fintab) secs.push(fintab);
  if(links) secs.push(`<div class="fa-sec"><div class="fa-lbl">Links</div>${links}</div>`);
  if(p.analysis) secs.push(`<div class="fa-sec"><div class="fa-lbl">Investment thesis</div><p>${esc(p.analysis)}</p></div>`);
  if(!secs.length) return '';
  return `<details class="deep"><summary>Detailed analysis and financial data</summary><div class="fa-body">${secs.join('')}</div></details>`;
}
// Logo image fallbacks as delegated listeners instead of inline onerror/onload
// attributes (security audit M5), so a future CSP can drop 'unsafe-inline'
// from script-src. error and load do not bubble, hence the capture phase.
// A broken image flips its logo box to the ticker monogram; a tiny favicon
// (data-ddg = host) upgrades once to DuckDuckGo's higher-res icon.
function bindLogoFallbacks(doc){
  doc.addEventListener('error', e=>{
    const img=e.target;
    if(img?.tagName!=='IMG') return;
    img.closest('.asset-logo, .r-logo')?.classList.add('logo-err');
  }, true);
  doc.addEventListener('load', e=>{
    const img=e.target;
    if(img?.tagName!=='IMG' || !img.dataset.ddg || img.dataset.up) return;
    if(img.naturalWidth && img.naturalWidth<40){ img.dataset.up='1'; img.src='https://icons.duckduckgo.com/ip3/'+img.dataset.ddg+'.ico'; }
  }, true);
}
bindLogoFallbacks(document);

// Asset logo (spec §5.6b): vendor logo_url → website favicon (privates have no
// vendor logo) → ticker monogram. A broken image flips to the monogram.
function assetLogo(p){
  const initials=(p.ticker||'?').replace(/[^A-Za-z0-9]/g,'').slice(0,3)||'?';
  let src=p.logo||'';
  let host='';
  // Strip the www. prefix (Google indexes e.g. optimism.io at 64px but
  // www.optimism.io only at 16px) and ask for the 128px icon.
  if(!src&&p.website){ try{ host=new URL(p.website).hostname.replace(/^www\./,''); src='https://www.google.com/s2/favicons?sz=128&domain='+encodeURIComponent(host); }catch{} }
  // Some domains only expose a 16px favicon, which blurs when shown. When the
  // loaded icon is tiny, upgrade once to DuckDuckGo's higher-res icon.
  const ddg=host?` data-ddg="${esc(host)}"`:'';
  const img=src?`<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer"${ddg}>`:'';
  return `<span class="asset-logo${src?'':' logo-err'}" aria-hidden="true">${img}<span class="logo-fallback">${esc(initials)}</span></span>`;
}
function card(p, rank, alt='', groupSize=1){
  const short = p.dir==='short';
  const bkt = p.score>=70?'high':p.score>=40?'medium':'low';
  const alLabel = short
    ? (bkt==='high'?'Prime short candidate':bkt==='medium'?'Moderate short exposure':'Weak short case')
    : (bkt==='high'?'High fit':bkt==='medium'?'Medium fit':'Low fit');
  const m = p.market || {};
  const relBadge = p.rel && p.rel!=='adjacent' ? `<span class="badge ${p.rel}">${p.rel}</span>` : '';
  const dirBadge = short ? '<span class="badge competitor">SHORT</span>' : '';
  const warns = warningBadges(p, groupSize);
  const priv = p.kind==='private'; // pre-IPO (§4.2b): no public quote exists — valuation instead of price
  const venues = p.kind==='crypto'
    ? [...(p.cex_venues||[]).map((v,i)=>`<span class="venue ${i===0?'primary':''}">${esc(v)}</span>`), ...(p.dex_venues||[]).map(v=>`<span class="venue dex">${esc(v)}</span>`)].join('')
    : priv ? '<span class="venue primary">Private, not listed</span>'
    : `<span class="venue primary">${esc(p.exchange||'N/A')}</span>`;
  // A frozen snapshot (§5.6, 2026-07-28) carries a date, not a timestamp, and
  // must never read as a live quote — it says "snapshot" where a live quote
  // would say "delayed".
  const asOf = m.asOf
    ? `<span class="asof">as of ${m.stale ? new Date(m.asOf).toLocaleDateString() : new Date(m.asOf).toLocaleString()}${m.stale ? ' · snapshot' : m.delayed ? ' · delayed' : ''}</span>`
    : '';
  // 1-day + 30-day moves side by side, each colored by its own sign (§5.6
  // quote-field surfacing, 2026-07-12); either may be missing independently.
  const chgSeg=(v,lbl)=>v==null?'':`<span class="${v>=0?'up':'down'}">${v>=0?'▲':'▼'} ${Math.abs(v).toFixed(1)}% ${lbl}</span>`;
  const chgSegs=[chgSeg(m.change1d, p.kind==='crypto'?'24h':'today'), chgSeg(m.change30d,'30d')].filter(Boolean);
  const chgLine=chgSegs.length?chgSegs.join('<span class="chg-sep"> · </span>'):'Change unavailable';
  const isFund = p.kind==='etf'||p.kind==='bond';
  const capLabel = priv?'Est. valuation':isFund?'AUM':'Market cap';
  // Max 3 kind-specific tiles (§6, 2026-07-13): stock → Price/Mcap/PE, fund →
  // Price/AUM/Expense, crypto → Price/Mcap/24h vol; the rest lives in Financial data.
  const expenseTile = isFund
    ? `<div class="metric"><div class="k">Expense ratio</div><div class="v">${p.etf_portfolio?.expense_ratio!=null?Number(p.etf_portfolio.expense_ratio).toFixed(2)+'%':'—'}</div></div>`
    : '';
  const peTile = p.kind==='stock'
    ? `<div class="metric"><div class="k">P/E (TTM)</div><div class="v">${m.fin?.pe!=null?Number(m.fin.pe).toFixed(1):'—'}</div>${m.fin?.eps!=null?`<div class="sub">EPS ${Number(m.fin.eps).toFixed(2)}</div>`:''}</div>`
    : '';
  // CoinGecko's attribution next to the prices it supplies (its API terms 4.3).
  const cgAttr = p.kind==='crypto' && p.market ? `<a class="data-attr" href="${CG_URL}" target="_blank" rel="noopener">Data provided by CoinGecko</a>` : '';
  return `<section class="card">
    <div class="card-head">
      <div class="name-block">${assetLogo(p)}<div class="nb-txt"><h3>${esc(p.name)}</h3><div class="sym">#${rank} · ${esc(p.ticker)}${p.sector?' · '+esc(p.sector):''}</div></div></div>
      <div class="tags">${alt}${dirBadge}<span class="badge ${p.kind}">${p.kind}</span>${relBadge}${warns}<span class="card-nav">
        <button class="cnav" data-nav="up" type="button" title="Previous asset" aria-label="Go to previous asset"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.75 7 5.25l3.5 3.5"/></svg></button>
        <button class="cnav" data-nav="down" type="button" title="Next asset" aria-label="Go to next asset"><svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.25 7 8.75l3.5-3.5"/></svg></button>
      </span></div>
    </div>
    <div class="align-row">
      <div class="align-fit">
        <div class="gauge">${gauge(p.score)}</div>
        <div class="align-txt"><div class="al ${bkt}">${alLabel}</div><div class="sc"><span class="lbl-hint" tabindex="0">${short?'Short fit':'Thesis fit'}<span class="lbl-pop wide">How directly this asset expresses your thesis, on an absolute 0 to 100 scale. Above 70 the connection is central and explicit, 40 to 70 is a partial or indirect link, below 40 is a stretch. The score always compares the asset with your thesis, never with the other results.</span></span></div></div>
      </div>
      ${priv && !(m.series && m.series.length >= 2)
        ? `<div class="align-spark align-spark-empty" aria-hidden="true"></div>`
        : `<div class="spark align-spark"><div class="spark-label">${m.seriesLabel || '30 day price history'}</div>${sparkline(m.series, m.change30d, m.currency, m.seriesFormat)}</div>`}
    </div>
    <div class="metrics">
      ${priv
        ? `<div class="metric"><div class="k">Public price</div><div class="v price">Not listed</div><div class="sub">${m.asOf?`Data updated ${new Date(m.asOf).toLocaleDateString()}`:'Private company'}</div></div>`
        : `<div class="metric"><div class="k">Price${asOf}</div><div class="v price">${fmtMoney(m.price, m.currency||'USD')}</div>
        <div class="sub">${chgLine}</div>${cgAttr}</div>`}
      <div class="metric"><div class="k">${capLabel}</div><div class="v">${fmtCap(m.marketCap)}</div></div>
      ${expenseTile}
      ${peTile}
      ${p.kind==='crypto'?`<div class="metric"><div class="k">24h volume</div><div class="v">${fmtVol(m.volume24h)}</div></div>`:''}
      ${priv?`<div class="metric"><div class="k">Asset and market</div><div class="v" style="font-size:14px">${p.kind} · ${p.region}</div></div>`:''}
    </div>
    <div class="fit-grid">
      <div class="why"><div class="lbl">${short?'Why it may fall':'Investment case'}</div><p>${esc(p.why || p.analysis || 'No rationale provided.')}</p></div>
      <div class="why news">${newsBlock(p)}</div>
    </div>
    ${fullAnalysis(p)}
    <div class="lower">
      <div class="buy"><div class="k">Where it trades</div><div class="venues">${venues}</div></div>
    </div>
    ${portfolioBlock(p)}
  </section>`;
}

// ---- staged flow: thesis review → complete ----
// Guided screen (expert interview) is parked while the app has a single Quick
// mode; the pipeline plumbing stays so the mode can return as Chat later.
let mode='oneshot';

let docText='', thesis=null, cardCrit={asset_set:[],region_set:[],cap_set:[]}, lastAnswers=null, onRunFinished=null;
let breadthMode='focused'; // Breadth seg (§6): pre-set Focused — Diversified is the explicit opt-in
let pmSelectedByUser=false; // user deliberately toggled the Polymarket seg ON (§5.8 bets-first ordering)
let regionSelectedByUser=false; // distinguishes card-selected China from doc/interview China (§6)
let capSelectedByUser=false; // lets an explicit Mcap=All clear a document cap restriction
// Everything the review-card segs can express (spec §6). A fully-selected
// group means "no constraint" — kinds/regions with no button (bonds, non-
// US/EU/CN listings) stay in the universe.
const SEG_ASSETS=['stock','crypto','etf','private','polymarket'];
// 'it' = Italy (§6): binds via the 'Italy' category tag server-side, not the
// coarse region column; EU deliberately still includes Italian stocks.
const SEG_REGIONS=['us','eu','cn','it'];
const REGION_GLOBAL='global';
// Market-cap buckets (spec §6). The UI offers three coarse bands; each snaps to
// the DB's cap_class tiers (ingest/lib/caps.ts) — the store has no per-band
// USD threshold, only these classes, so Low≈micro(<$300M), Mid≈small($300M–$2B),
// High≈mid+large+mega(>$2B). Card sends the expanded cap_class list; all-on = no
// constraint. Cap filters don't apply to ETFs/bonds (audit.ts, §5.2).
const SEG_CAPS=['low','medium','high'];
const CAP_CLASSES={low:['micro'], medium:['small'], high:['mid','large','mega']};
// Sentinels for the "no constraint" state — one explicit All button per group,
// mutually exclusive with the specific picks (Markets has always worked this way
// via 'global'). asset_set / region_set / cap_set each hold EITHER [sentinel] or
// a subset of specifics; the sentinel is sent to the server as an empty filter.
const ASSET_ALL='all';
const CAP_ALL='all';

function initCardCritFromThesis(){
  const preOrAll=(docVals,specifics,allVal)=>{
    const hit=specifics.filter(v=>(docVals||[]).includes(v));
    return hit.length?hit:[allVal];
  };
  cardCrit={
    asset_set: preOrAll(thesis?.docCrit?.asset_set, SEG_ASSETS, ASSET_ALL),
    region_set: preOrAll(thesis?.docCrit?.region_set, SEG_REGIONS, REGION_GLOBAL),
    cap_set: [CAP_ALL],
  };
  // docCrit can never contain 'polymarket' — keep bets on alongside a doc asset
  // constraint (matches the review-card default); × to drop from the card.
  if(!cardCrit.asset_set.includes(ASSET_ALL) && !cardCrit.asset_set.includes('polymarket')) cardCrit.asset_set.push('polymarket');
}

// Run section markers (2026-07-13): every research reads as three numbered
// steps — 01 Your investment thesis, 02 Screen progress, 03 Results — each
// with an info button that opens a short explainer of what the section does.
const INFO_ICON='<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="5" r="1" fill="currentColor"/><rect x="7.3" y="7.1" width="1.4" height="4.4" rx=".7" fill="currentColor"/></svg>';
const SEC_INFO={
  thesis:'SyntheTick reads your input and builds this card: a summary of the thesis, its key themes ranked by search priority, and the screen settings. Everything here is editable, and it is what steers the screen.',
  progress:'The screen runs in steps: apply your criteria, search the eligible universe, rank candidates by thesis fit, check every constraint, then load market data. Follow each step live here.',
  results:'The assets that passed every check, ranked by thesis fit on an absolute 0 to 100 scale. Each card shows market data and 30 day price history where they can be shown, risks and trading venues, plus a downloadable report. Recent news is coming soon.'
};
function sectionHead(key, num, title, info){
  const el=document.createElement('section');
  el.className='block sec-head'; el.dataset.sec=key;
  el.innerHTML=`<span class="sec-num">${num}</span><span class="sec-title">${esc(title)}</span>
    <span class="info-wrap"><button class="info-btn" type="button" aria-expanded="false" aria-label="About ${esc(title)}">${INFO_ICON}</button>
    <span class="info-pop" role="note">${esc(info)}</span></span><span class="sec-rule" aria-hidden="true"></span>`;
  const wrap=el.querySelector('.info-wrap'), btn=el.querySelector('.info-btn');
  btn.addEventListener('click',(e)=>{ e.stopPropagation(); const open=wrap.classList.toggle('open'); btn.setAttribute('aria-expanded',String(open)); });
  return el;
}
// Screen-settings / key-themes label with a short explainer on hover or focus.
// Small monoline glyphs for each screen-setting category (inherit label color).
const SVG_ATTRS='width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
const SETTING_ICONS={
  direction:`<svg ${SVG_ATTRS}><path d="M7 2.5v9"/><path d="M4.6 5 7 2.5 9.4 5"/><path d="M4.6 9 7 11.5 9.4 9"/></svg>`,
  breadth:`<svg ${SVG_ATTRS}><path d="M2.4 3.4h9.2L8.1 7.6v3.4L5.9 11V7.6z"/></svg>`,
  assets:`<svg ${SVG_ATTRS}><path d="M7 2.3 12.2 5 7 7.7 1.8 5z"/><path d="M1.8 8.4 7 11.1l5.2-2.7"/></svg>`,
  markets:`<svg ${SVG_ATTRS}><circle cx="7" cy="7" r="4.7"/><path d="M2.3 7h9.4"/><path d="M7 2.3c1.8 1.6 1.8 7.8 0 9.4c-1.8-1.6-1.8-7.8 0-9.4z"/></svg>`,
  cap:`<svg ${SVG_ATTRS}><path d="M3 11.2V8.2"/><path d="M7 11.2V5.4"/><path d="M11 11.2V3"/></svg>`,
};
const hintLabel=(text,hint,icon='')=>`<span class="setting-lbl">${icon?`<span class="lbl-ico" aria-hidden="true">${icon}</span>`:''}<span class="th-sub lbl-hint" tabindex="0" style="padding:0">${esc(text)}<span class="lbl-pop">${esc(hint)}</span></span></span>`;
// Card up/down hop (2026-07-13): the chevrons in each card head jump to the
// previous/next visible card in the CURRENT order — delegated, since holders
// repaint on listing swaps and reorder on sort.
document.addEventListener('click',(e)=>{
  const b=e.target.closest?.('.cnav'); if(!b) return;
  const holder=b.closest('.pick-list > div'); if(!holder) return;
  const step=b.dataset.nav==='up'?'previousElementSibling':'nextElementSibling';
  let n=holder[step];
  while(n && n.style.display==='none') n=n[step];
  n?.scrollIntoView({behavior:'smooth', block:'start'});
});
// One open popover at a time: any outside click or Escape closes them all.
const closeInfoPops=()=>document.querySelectorAll('.info-wrap.open').forEach(w=>{ w.classList.remove('open'); w.querySelector('.info-btn')?.setAttribute('aria-expanded','false'); });
document.addEventListener('click', closeInfoPops);
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeInfoPops(); });

const TRACE_SETS={
  complete:[
    {title:'Apply criteria', detail:'Applying the selected markets, assets and preferences.', match:/applying your requirements|applying selected criteria/i},
    {title:'Screen the market', detail:'Searching the eligible investment universe.', match:/matching your thesis|screening the eligible universe|nothing in the universe|no asset meets|prediction markets only/i},
    {title:'Rank candidates', detail:'Ranking candidates by how well they fit the thesis.', match:/reading your thesis|hunting for|working both sides|ranking/i},
    {title:'Check constraints', detail:'Removing candidates that do not meet the criteria.', match:/audit|compliance|criteria check/i},
    {title:'Build results', detail:'Preparing the final list.', match:/final(?: list)?:|no picks survived|no candidate passed/i},
    {title:'Load market data', detail:'Loading prices and 30 day history.', match:/fetching real prices|loading prices/i}
  ]
};
function statusBlock(kind='complete', onCancel){
  const steps=TRACE_SETS[kind]||TRACE_SETS.complete;
  const el=document.createElement('section'); el.className='block status';
  el.innerHTML=`
    <div class="status-panel" aria-live="polite">
      <div class="trace-head">
        <div class="trace-titles">
          <div class="trace-active-row">
            <span class="trace-count">1/${steps.length}</span>
            <span class="trace-active">${esc(steps[0].title)}</span>
          </div>
          <div class="trace-copy">${esc(steps[0].detail)}</div>
        </div>
        <div class="trace-meta">
          <span class="trace-eta">Est. 60 sec</span>
          ${onCancel?'<button class="trace-cancel" type="button" aria-label="Cancel run" title="Cancel"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8"/></svg></button>':''}
        </div>
      </div>
      <div class="trace-progress"><i></i></div>
      <div class="trace-scroll-wrap">
        <button class="trace-nav" type="button" aria-label="Scroll previous step">&lsaquo;</button>
        <div class="trace-rail" tabindex="0" aria-label="Research steps">
          ${steps.map((step,i)=>`<div class="trace-step" data-i="${i}">
            <div class="n">${i+1}/${steps.length}</div>
            <div class="t">${esc(step.title)}</div>
            <div class="d">${esc(step.detail)}</div>
          </div>`).join('')}
        </div>
        <button class="trace-nav" type="button" aria-label="Scroll next step">&rsaquo;</button>
      </div>
    </div>`;
  el.prepend(sectionHead('progress','02','Screen progress',SEC_INFO.progress));
  view.appendChild(el);
  const active=el.querySelector('.trace-active');
  const copy=el.querySelector('.trace-copy');
  const count=el.querySelector('.trace-count');
  const bar=el.querySelector('.trace-progress i');
  const rail=el.querySelector('.trace-rail');
  const cards=[...el.querySelectorAll('.trace-step')];
  // Compact live status line (mirrors the extraction "Reading sources…" line)
  // shown between the thesis card and the Screen progress section, so the
  // current step reads right above the panel. Removed when the run ends.
  const runStatus=document.createElement('div'); runStatus.className='source-loading run-status block';
  runStatus.innerHTML=`<span class="pulse"></span><span class="run-status-t">${esc(steps[0].detail)}</span>`;
  el.before(runStatus);
  const setDockStatus=(txt)=>{ const t=runStatus?.querySelector('.run-status-t'); if(t) t.textContent=txt; };
  let idx=0;
  let finished=false;
  const paint=()=>{
    const stepPct=steps.length===1?100:Math.round((idx+1)/steps.length*100);
    const pct=finished?100:(idx===steps.length-1?Math.min(96, stepPct):stepPct);
    active.textContent=steps[idx].title;
    count.textContent=`${idx+1}/${steps.length}`;
    bar.style.width=pct+'%';
    cards.forEach((card,i)=>{
      card.classList.toggle('is-done', i<idx);
      card.classList.toggle('is-current', i===idx);
      card.classList.toggle('is-upcoming', i>idx);
    });
    cards[idx]?.scrollIntoView({behavior:'smooth', block:'nearest', inline:'nearest'});
  };
  el.querySelectorAll('.trace-nav').forEach((btn,i)=>btn.addEventListener('click',()=>{
    rail.scrollBy({left:(i?1:-1)*190, behavior:'smooth'});
  }));
  const cancelBtn=el.querySelector('.trace-cancel');
  cancelBtn?.addEventListener('click',()=>{
    cancelBtn.disabled=true; cancelBtn.title='Cancelling…';
    onCancel();
  });
  paint();
  const update=(s)=>{
    const text=String(s||'');
    const next=steps.findIndex((step)=>step.match.test(text));
    if(next>=0) idx=Math.max(idx,next);
    copy.textContent=text||steps[idx].detail;
    setDockStatus(copy.textContent);
    const d=cards[idx]?.querySelector('.d');
    if(d && text) d.textContent=text;
    paint();
  };
  update.finish=()=>{
    finished=true;
    idx=steps.length-1;
    cancelBtn?.remove();
    runStatus?.remove();
    paint();
  };
  update.cancelled=()=>{
    finished=true;
    runStatus?.remove();
    copy.textContent=mode==='expert'
      ? 'Run cancelled. The review card is still editable.'
      : 'Run cancelled. Edit the input or run the screen again.';
    if(cancelBtn){ cancelBtn.disabled=true; cancelBtn.title='Cancelled'; }
  };
  update.el=el;
  return update;
}

function startResearch(text, logText){
  docText=text;
  thesis=null; cardCrit={asset_set:[],region_set:[],cap_set:[]}; lastAnswers=null; onRunFinished=null; breadthMode='focused';
  finReq=null; finReqDropped.clear();
  pmSelectedByUser=false; regionSelectedByUser=false; capSelectedByUser=false;
  composer.style.display='none'; feed.classList.remove('empty');
  showView('home');
  newView();
  recentStart(text);
  runViews.set(currentRunId, view);
  const parts=sources.map(s=>s.label); if(ta.value.trim()) parts.push('pasted text');
  const dock=document.createElement('div'); dock.className='docked block';
  dock.innerHTML=`<span class="k">Sources:</span> ${esc(parts.join(' + ')||'pasted text')} · ${text.length.toLocaleString()} characters
    <button class="dock-x" type="button" title="Cancel this research" aria-label="Cancel this research"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8"/></svg></button>`;
  // X = dismiss this research and go back to the editor: abort an in-flight
  // run (same as the progress X) and drop only this run's container.
  const myView=view;
  dock.querySelector('.dock-x').addEventListener('click',()=>{
    myView.querySelector('.trace-cancel')?.click();
    myView.remove();
    if(view===myView){ view=feed; composer.style.display=''; feed.classList.add('empty'); }
  });
  view.appendChild(dock);
  extractThesis(text, logText);
}

// "Back to editor" — the composer keeps the pasted text and added sources.
// Only the current research's container is removed: hidden background runs
// keep living (and completing) in theirs.
function restoreComposer(){
  if(view!==feed){ view.remove(); view=feed; }
  composer.style.display=''; feed.classList.add('empty');
}
async function extractThesis(text, logText){
  // Capture this research's container and Recents id: the user may switch to
  // another research before the fetch resolves.
  const myView=view, myRunId=currentRunId;
  const loading=document.createElement('div'); loading.className='source-loading block';
  loading.innerHTML='<span class="pulse"></span><span>Reading sources and identifying the investment case…</span>';
  view.appendChild(loading);
  const recover=[['Try again',()=>inView(myView,()=>extractThesis(text, logText))],['Back to editor',()=>{ myView.remove(); if(view===myView) view=feed; composer.style.display=''; feed.classList.add('empty'); }]];
  try{
    const res=await apiFetch('/api/thesis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text, log: logText||undefined})});
    if(!res.ok){ const j=await res.json().catch(()=>({})); loading.remove(); inView(myView,()=>renderError(j.error||('HTTP '+res.status), recover)); renderRecents(); return; }
    const tj=await res.json();
    thesis=tj.thesis;
    // Requirements arrive with the thesis so the card can show them (§15.3).
    finReq=tj.finReq||null; finReqDropped.clear();
    recentUpdate({ title:thesis.title||undefined, thesis:snap(thesis) }, myRunId);
    loading.remove();
    inView(myView,()=>renderThesisReview({docText:text, runId:myRunId}));
  }catch(err){ loading.remove(); inView(myView,()=>renderError(err.message, recover)); renderRecents(); }
}


// ---- Financial requirements on the review card (spec §15.3) ----
// The screen enforces these deterministically, so an over-strict one silently
// empties the result. They are shown as removable chips for the same reason
// Markets and Mcap are: a binding requirement the user cannot see or change is
// a dead end that costs another run to escape.
let finReq=null;                 // as extracted by /api/thesis
const finReqDropped=new Set();   // chip ids the user switched off

function finReqChips(){
  if(!finReq) return [];
  const out=[];
  (finReq.bounds||[]).forEach((b,i)=>out.push({id:`b${i}`, label:finReqLabel(b)}));
  (finReq.exposures||[]).forEach((e,i)=>out.push({id:`e${i}`, label:`at least ${e.minWeightPct}% in ${e.name}`}));
  if((finReq.currencies||[]).length) out.push({id:'cur', label:`listed in ${finReq.currencies.join(' or ')}`});
  if((finReq.domiciles||[]).length) out.push({id:'dom', label:`domiciled in ${finReq.domiciles.join(' or ')}`});
  return out;
}
const FINREQ_LABELS={market_cap_usd:'market cap',pe:'P/E',forward_pe:'forward P/E',price_to_book:'price/book',price_to_sales:'price/sales',ev_to_ebitda:'EV/EBITDA',dividend_yield_pct:'dividend yield',revenue_growth_pct:'revenue growth',earnings_growth_pct:'earnings growth',gross_margin_pct:'gross margin',operating_margin_pct:'operating margin',net_margin_pct:'net margin',roe:'return on equity',roic:'return on invested capital',debt_to_equity:'debt/equity',net_debt_to_ebitda:'net debt/EBITDA',fcf_per_share:'free cash flow per share',fcf_yield_pct:'free cash flow yield',current_ratio:'current ratio',interest_coverage:'interest coverage',altman_z:'Altman Z-score',piotroski:'Piotroski score',beta:'beta',return_30d_pct:'30-day return',return_ytd_pct:'year-to-date return',return_1y_pct:'12-month return',avg_volume:'average daily volume',aum_usd:'AUM',ter_pct:'TER',track_record_years:'track record',fund_avg_volume:'average daily volume',holdings_count:'holdings'};
const FINREQ_UNITS={market_cap_usd:'usd',aum_usd:'usd',ter_pct:'pct',dividend_yield_pct:'pct',revenue_growth_pct:'pct',earnings_growth_pct:'pct',gross_margin_pct:'pct',operating_margin_pct:'pct',net_margin_pct:'pct',fcf_yield_pct:'pct',return_30d_pct:'pct',return_ytd_pct:'pct',return_1y_pct:'pct',track_record_years:'years',avg_volume:'shares',fund_avg_volume:'shares'};
function finReqValue(v,unit){
  if(unit==='usd'){ const a=Math.abs(v);
    if(a>=1e12) return '$'+(v/1e12).toFixed(2)+'T';
    if(a>=1e9) return '$'+(v/1e9).toFixed(1)+'B';
    if(a>=1e6) return '$'+(v/1e6).toFixed(0)+'M';
    return '$'+v; }
  if(unit==='pct') return v+'%';
  if(unit==='years') return v+(v===1?' year':' years');
  if(unit==='shares') return v>=1e6?(v/1e6).toFixed(1)+'M':String(v);
  return String(v);
}
function finReqLabel(b){
  const name=FINREQ_LABELS[b.key]||b.key, unit=FINREQ_UNITS[b.key]||'ratio';
  if(b.min!=null&&b.max!=null) return `${name} ${finReqValue(b.min,unit)} to ${finReqValue(b.max,unit)}`;
  if(b.min!=null) return `${name} at or above ${finReqValue(b.min,unit)}`;
  return `${name} at or below ${finReqValue(b.max,unit)}`;
}
function finReqBlock(){
  const chips=finReqChips();
  const cannot=(finReq?.unverifiable)||[];
  if(!chips.length&&!cannot.length) return '';
  return `<div class="th-section fin-req">
    <div class="lbl lbl-hint" tabindex="0">Financial requirements<span class="lbl-pop">Read from your request and applied as hard filters. Remove one to widen the screen.</span></div>
    ${chips.length?`<div class="crit-chips" id="finReqChips">${chips.map(c=>`<span class="crit" data-fr="${c.id}">${esc(c.label)}<button type="button" class="crit-x" data-fr="${c.id}" title="Remove this requirement" aria-label="Remove ${esc(c.label)}">×</button></span>`).join('')}</div>`:''}
    ${cannot.length?`<div class="fin-req-note">Not applied, because we do not hold this data: ${esc(cannot.join('; '))}. These are left to the thesis match.</div>`:''}
  </div>`;
}
/** The requirement set as the card now stands, with removed chips stripped. */
function finReqForRun(){
  if(!finReq) return undefined;
  const keep=id=>!finReqDropped.has(id);
  return {
    bounds:(finReq.bounds||[]).filter((_,i)=>keep(`b${i}`)),
    exposures:(finReq.exposures||[]).filter((_,i)=>keep(`e${i}`)),
    currencies:keep('cur')?(finReq.currencies||[]):[],
    domiciles:keep('dom')?(finReq.domiciles||[]):[],
    unverifiable:finReq.unverifiable||[],
  };
}

// Thesis review card (v3): editable summary, intent toggle, requirements box.
// opts.savedRun renders a restored research: no auto-run (a re-run is an
// explicit paid action) and the action row opens as "Run updated screen".
function renderThesisReview(opts){
  // Capture this card's run context now: the autonomous first run fires on the
  // next frame, by which time a "+ New research" soft reset may have cleared
  // the globals and pointed `view` back at the home feed — the run would then
  // post empty text (400 "Missing document text or thesis") and paint its
  // progress and error onto the fresh home view (2026-07-14).
  const myView=view, myThesis=thesis, myDocText=opts?.docText??docText, myRunId=opts?.runId??currentRunId;
  const t=thesis;
  const card=document.createElement('section'); card.className='block thesis';
  card.innerHTML=`
    <div class="th-h"><h3>${esc(t.title)}</h3></div>
    ${parseSummary(t)}
    <div class="th-sub lbl-hint" tabindex="0" style="padding-top:22px; color:var(--amber)">Investment thesis<span class="lbl-pop">A plain-language summary of your thesis. Edit it to change what the screen looks for.</span></div>
    <div class="core" id="coreWrap"><p id="corePara">${esc(t.summary)}</p></div>
    <div class="th-section th-themes"><div class="lbl lbl-hint" id="themesLbl" tabindex="0"><span id="themesLblText">Key themes. Ranked by search priority.</span><span class="lbl-pop">The sub ideas of your thesis. Order sets which ones are searched first.</span></div>
      <div id="themesWrap"></div></div>
    ${(t.private_entities||[]).length?`<div class="th-section"><div class="lbl">Referenced entities that are not available as investments</div>
      <div class="crit-chips">${t.private_entities.map(p=>`<span class="crit">${esc(p.name)}${p.note?` · <b>${esc(p.note)}</b>`:''}</span>`).join('')}</div>
      <div style="font-size:12px; color:var(--bone-dim); margin-top:8px">These entities are private or outside the current universe. The screen will look for listed exposure through the themes above.</div></div>`:''}
    <div class="th-sub lbl-hint" tabindex="0" style="padding-top:22px; color:var(--amber)">Screen settings<span class="lbl-pop">Direction, breadth, assets, markets and size. These filters shape which assets the screen returns.</span></div>
    <div class="th-section intent-row">
      <div class="setting-row">
        ${hintLabel('Direction','Long buys the theme, Short bets against it, Both screens each side.',SETTING_ICONS.direction)}
        <span class="seg" id="dirSeg" style="display:inline-flex;background:var(--ink);border:1px solid var(--rule);border-radius:9px;padding:3px;gap:6px">
          <button data-v="long" style="font-family:var(--display);font-weight:600;font-size:13px;border:0;border-radius:7px;padding:7px 15px;cursor:pointer;background:transparent;color:var(--bone-dim)">Long</button>
          <button data-v="short" style="font-family:var(--display);font-weight:600;font-size:13px;border:0;border-radius:7px;padding:7px 15px;cursor:pointer;background:transparent;color:var(--bone-dim)">Short</button>
          <button data-v="both" style="font-family:var(--display);font-weight:600;font-size:13px;border:0;border-radius:7px;padding:7px 15px;cursor:pointer;background:transparent;color:var(--bone-dim)">Both</button>
        </span>
      </div>
      <div class="setting-row" id="breadthWrap" hidden>
        ${hintLabel('Breadth','Focused keeps the strongest matches. Diversified spreads results across themes.',SETTING_ICONS.breadth)}
        <span class="seg" id="breadthSeg">
          <button type="button" data-v="focused">Focused</button>
          <button type="button" data-v="diversified">Diversified</button>
        </span>
      </div>
      <div class="setting-row">
        ${hintLabel('Assets','Which asset classes to include. All screens the full universe.',SETTING_ICONS.assets)}
        <span class="seg" id="assetSeg">
          <button type="button" data-v="all">All</button>
          <button type="button" data-v="stock">Stock</button>
          <button type="button" data-v="crypto">Crypto</button>
          <button type="button" data-v="etf">ETF</button>
          <button type="button" data-v="private">Pre IPO</button>
          <button type="button" data-v="polymarket">Polymarket</button>
        </span>
      </div>
      <div class="setting-row">
        ${hintLabel('Markets','Which stock markets to screen. Crypto is always global.',SETTING_ICONS.markets)}
        <span class="seg" id="regionSeg">
          <button type="button" data-v="global">Global</button>
          <button type="button" data-v="us">USA</button>
          <button type="button" data-v="eu">EU</button>
          <button type="button" data-v="cn">China</button>
          <button type="button" data-v="it">Italy</button>
        </span>
      </div>
      <div class="setting-row">
        ${hintLabel('Market cap','Company size band. Does not apply to ETFs or bonds.',SETTING_ICONS.cap)}
        <span class="seg" id="capSeg">
          <button type="button" data-v="all">All</button>
          <button type="button" data-v="low">Low</button>
          <button type="button" data-v="medium">Mid</button>
          <button type="button" data-v="high">High</button>
        </span>
      </div>
      ${finReqBlock()}
    </div>
    `;
  if(!view.querySelector('.sec-head[data-sec="thesis"]')) view.appendChild(sectionHead('thesis','01','Your investment thesis',SEC_INFO.thesis));
  view.appendChild(card);

  // Removing a requirement chip widens the screen; the chip stays visible but
  // struck through so the user can see what they switched off.
  card.querySelectorAll('.crit-x[data-fr]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.getAttribute('data-fr');
      const chip=card.querySelector(`.crit[data-fr="${id}"]`);
      if(finReqDropped.has(id)){ finReqDropped.delete(id); chip?.classList.remove('crit-off'); btn.textContent='×'; btn.title='Remove this requirement'; }
      else { finReqDropped.add(id); chip?.classList.add('crit-off'); btn.textContent='+'; btn.title='Restore this requirement'; }
    });
  });

  // The header bar mirrors the selectors — repaint it on every seg change.
  const repaintParse=()=>{ const pb=card.querySelector('.parse-bar'); if(pb) pb.outerHTML=parseSummary(thesis); };
  const paintDir=()=>{
    card.querySelectorAll('#dirSeg button').forEach(x=>{
      const on=x.dataset.v===(thesis.direction||'long');
      x.setAttribute('aria-pressed',String(on));
      x.style.background=on?(x.dataset.v==='short'?'rgba(207,123,107,.14)':x.dataset.v==='both'?'var(--amber-soft)':'rgba(127,174,122,.14)'):'transparent';
      x.style.color=on?(x.dataset.v==='short'?'var(--down)':x.dataset.v==='both'?'var(--amber)':'var(--up)'):'var(--bone-dim)';
    });
  };
  paintDir();
  card.querySelectorAll('#dirSeg button').forEach(b=>b.addEventListener('click',()=>{
    thesis.direction=b.dataset.v;
    paintDir();
    paintBreadth(); // 'both' runs are always Focused (§5.3) — hide the seg
    repaintParse();
  }));

  // Asset / Markets / Mcap selectors (spec §6): binding requirements, sent as
  // cardCrit and merged server-side. Each group holds EITHER its All sentinel
  // (no constraint) or a subset of specifics — clicking All clears the picks,
  // clicking a pick clears All, and emptying the picks falls back to All.
  // Pre-seeded from the document's own requirements (what the user said in ① is
  // visibly binding); All when it specifies nothing. Mcap always starts All —
  // a doc-derived cap_set keeps binding invisibly via docCrit, since the 3 UI
  // bands can't losslessly represent the 5 cap_class tiers.
  initCardCritFromThesis();
  repaintParse(); // the bar renders before cardCrit is seeded — sync it now
  // One All-toggle wiring for all three groups (the old Markets/global logic,
  // generalized). onPick fires for a specific button so Asset can flag §5.8.
  const wireAllSeg=(id,key,allVal,onPick)=>{
    const paint=()=>card.querySelectorAll(`#${id} button`).forEach(b=>b.setAttribute('aria-pressed',String(cardCrit[key].includes(b.dataset.v))));
    card.querySelectorAll(`#${id} button`).forEach(b=>b.addEventListener('click',()=>{
      const v=b.dataset.v;
      if(v===allVal){
        cardCrit[key]=[allVal];
        onPick?.(v, true);
      } else {
        const arr=cardCrit[key].filter(x=>x!==allVal);
        const i=arr.indexOf(v);
        if(i>=0) arr.splice(i,1); else arr.push(v);
        cardCrit[key]=arr.length?arr:[allVal];
        onPick?.(v, i<0);
      }
      paint();
      repaintParse();
    }));
    paint();
  };
  wireAllSeg('assetSeg','asset_set',ASSET_ALL,(v,on)=>{
    if(v===ASSET_ALL) pmSelectedByUser=false;
    else if(v==='polymarket') pmSelectedByUser=on;
  });
  wireAllSeg('regionSeg','region_set',REGION_GLOBAL,()=>{ regionSelectedByUser=true; });
  wireAllSeg('capSeg','cap_set',CAP_ALL,()=>{ capSelectedByUser=true; });

  // Editable themes (spec §6): × removes a theme, drag one chip onto another to
  // take its slot. Order = search priority; the surviving list is what
  // /api/complete embeds, so this directly steers where assets are searched.
  // The card opens READ-ONLY — top-3 chips only, no ×/reorder, no Others —
  // and an "Edit themes" ghost chip reveals the full editable view.
  thesis.themes = thesis.themes || [];
  const themesWrap=card.querySelector('#themesWrap');
  const themesLbl=card.querySelector('#themesLblText');
  let themesEditing=false;
  let dragFrom=null;
  const paintThemes=()=>{
    const th=thesis.themes;
    themesLbl.textContent=themesEditing
      ? 'Key themes. Remove or reorder to change search priority.'
      : 'Key themes. Ranked by search priority.';
    if(!themesEditing){
      const roChip=(x,i)=>`<span class="theme-tag tt-ro">${i<3?`<b class="tt-rank">${i+1}</b>`:''}${esc(x)}</span>`;
      const editBtn=`<button type="button" class="tt-edit" id="themesEditBtn">Edit themes${th.length>3?` (${th.length-3} more)`:''}</button>`;
      themesWrap.innerHTML = th.length
        ? `<div class="theme-tags">${th.slice(0,3).map((x,i)=>roChip(x,i)).join('')}${editBtn}</div>`
        : `<div class="tt-none">No themes selected. The thesis summary will drive the screen.</div>`;
      themesWrap.querySelector('#themesEditBtn')?.addEventListener('click',()=>{ themesEditing=true; paintThemes(); });
      return;
    }
    const chip=(x,i)=>`<span class="theme-tag tt${i>=3?' tt-other':''}" draggable="true" data-i="${i}">${i>0?`<button type="button" class="tt-up" aria-label="Move theme earlier: ${esc(x)}">‹</button>`:''}${i<3?`<b class="tt-rank">${i+1}</b>`:''}${esc(x)}<button type="button" class="tt-x" aria-label="Remove theme: ${esc(x)}">×</button></span>`;
    themesWrap.innerHTML = th.length
      ? `<div class="theme-tags">${th.slice(0,3).map((x,i)=>chip(x,i)).join('')}</div>`
        + (th.length>3?`<div class="lbl tt-others">Other themes. Included at lower priority.</div><div class="theme-tags">${th.slice(3).map((x,j)=>chip(x,j+3)).join('')}</div>`:'')
      : `<div class="tt-none">No themes selected. The thesis summary will drive the screen.</div>`;
    themesWrap.querySelectorAll('.tt').forEach(el=>{
      const i=+el.dataset.i;
      el.querySelector('.tt-x').addEventListener('click',()=>{ th.splice(i,1); paintThemes(); });
      // ‹ = move one slot earlier: the touch/keyboard equivalent of drag-to-reorder.
      el.querySelector('.tt-up')?.addEventListener('click',()=>{ const [m]=th.splice(i,1); th.splice(i-1,0,m); paintThemes(); });
      el.addEventListener('dragstart',e=>{ dragFrom=i; el.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });
      el.addEventListener('dragend',()=>{ dragFrom=null; paintThemes(); });
      el.addEventListener('dragover',e=>{ if(dragFrom!==null&&dragFrom!==i){ e.preventDefault(); el.classList.add('over'); } });
      el.addEventListener('dragleave',()=>el.classList.remove('over'));
      el.addEventListener('drop',e=>{ e.preventDefault(); if(dragFrom===null||dragFrom===i) return; const [m]=th.splice(dragFrom,1); th.splice(i,0,m); dragFrom=null; paintThemes(); });
    });
  };
  paintThemes();

  // Strategy breadth (§6): the Breadth seg renders in the controls row only
  // for goal-seeking theses (≥2 extracted strategies); 'both' direction runs
  // are always Focused (§5.3) — the seg hides there too. The strategies
  // themselves aren't editable on the card (chips section removed 2026-07-10);
  // the parse-bar shows their count and they flow to /api/complete unchanged.
  thesis.strategies = thesis.strategies || [];
  const breadthWrap=card.querySelector('#breadthWrap');
  const paintBreadth=()=>{
    breadthWrap.hidden=!(thesis.strategies.length>=2 && (thesis.direction||'long')!=='both');
    card.querySelectorAll('#breadthSeg button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===breadthMode)));
  };
  card.querySelectorAll('#breadthSeg button').forEach(b=>b.addEventListener('click',()=>{ breadthMode=b.dataset.v; paintBreadth(); repaintParse(); }));
  paintBreadth();

  // Plain-language requirements box removed from the card (§6, 2026-07-10):
  // binding requirements come from the document, the selectors and the
  // interview. The helper stays for its call sites and now returns ''.
  const extraReq=()=>card.querySelector('#extraReq')?.value.trim()||'';

  // Run/edit actions (spec §6): re-shown on the review card after every run,
  // so the user can tweak the text, themes or selectors and run the same
  // research again. A re-run wipes everything rendered below the card first.
  const clearBelow=()=>{ let n=card.nextSibling; while(n){ const nx=n.nextSibling; n.remove(); n=nx; } };
  const run=(again)=>{
    clearBelow();
    // Show an in-progress state on the card so it is clear the screen is
    // already running — the first run starts autonomously and users were
    // missing that (2026-07-14). onRunFinished restores the editable actions.
    paintRunning(again);
    if(mode==='expert' && !again) startInterview(extraReq());
    else inView(myView,()=>complete(extraReq(), lastAnswers, {runId:myRunId, docText:myDocText, thesis:myThesis, finish:()=>paintActions(true), rerun:again}));
  };
  // In-progress action row: a disabled "Screen progress" button with moving
  // dots. The first (autonomous) run also carries a note explaining it runs on
  // its own and can be edited and rerun afterwards.
  const paintRunning=(again)=>{
    card.querySelector('#thActions')?.remove();
    const act=document.createElement('div'); act.className='th-actions is-running'; act.id='thActions';
    act.innerHTML=`<button class="btn-primary btn-running" id="continueBtn" type="button" disabled aria-busy="true">Screen progress<span class="ell" aria-hidden="true"><i></i><i></i><i></i></span></button>`
      +(again?'':`<span class="run-note">The first screen runs automatically. You will be able to edit the investment thesis and run it again.</span>`);
    card.appendChild(act);
  };
  const paintActions=(again)=>{
    card.querySelector('#thActions')?.remove();
    const act=document.createElement('div'); act.className='th-actions'; act.id='thActions';
    act.innerHTML=`<button class="btn-primary" id="continueBtn">${again?'Run updated screen':'Run screen'}</button>
      <button class="btn-ghost" id="editBtn">Edit</button>`;
    card.appendChild(act);
    act.querySelector('#continueBtn').addEventListener('click',()=>run(again));
    act.querySelector('#editBtn').addEventListener('click',()=>{
      const wrap=card.querySelector('#coreWrap');
      wrap.innerHTML='<textarea id="coreEdit"></textarea>';
      const te=wrap.querySelector('#coreEdit'); te.value=thesis.summary; te.focus();
      act.innerHTML='<button class="btn-primary" id="saveBtn">Save &amp; run</button><button class="btn-ghost" id="cancelBtn">Cancel</button>';
      act.querySelector('#saveBtn').addEventListener('click',()=>{
        thesis.summary=te.value.trim()||thesis.summary;
        wrap.innerHTML=`<p id="corePara">${esc(thesis.summary)}</p>`;
        run(again);
      });
      act.querySelector('#cancelBtn').addEventListener('click',()=>{
        wrap.innerHTML=`<p id="corePara">${esc(thesis.summary)}</p>`;
        paintActions(again);
      });
    });
  };
  paintActions(!!opts?.savedRun);
  onRunFinished=()=>paintActions(true);
  if(mode==='oneshot' && !opts?.savedRun) requestAnimationFrame(()=>run(false));
}

// ---- Expert interview (v3: multi-select, auto-skip, back/skip, conflict check) ----
const QUESTIONS=[
  {id:'asset_class', q:'1 · Which assets should be screened?', help:'Choose one.', opts:[['Stocks only','stock'],['Crypto only','crypto'],['ETFs only','etf'],['Bonds only','bond'],['Pre IPO only','preipo'],['Stocks and crypto','both']]},
  {id:'geography', type:'multi', q:'2 · Which stock markets?', help:'Select all that apply. Continue without a selection to include any market. Crypto is global.', opts:[['United States','us'],['Europe','eu'],['China','china'],['Other markets','row']], skipIf:a=>a.asset_class==='crypto'},
  {id:'cap', type:'multi', q:'3 · Which market cap ranges?', help:'Select all that apply.', opts:[['Mega, over $200B','mega'],['Large, $10B to $200B','large'],['Mid, $2B to $10B','mid'],['Small, $300M to $2B','small'],['Micro, under $300M','micro']]},
  {id:'risk', q:'4 · Risk tolerance?', opts:[['Conservative','conservative'],['Balanced','balanced'],['Aggressive','aggressive']]},
  {id:'horizon', q:'5 · Time horizon?', opts:[['Under 1 year','under1'],['1 to 3 years','1to3'],['More than 3 years','3plus']]},
  {id:'familiarity', q:'6 · Company profile?', opts:[['Mostly established names','household'],['Mostly less followed names','gems'],['A mix','mix']]},
  {id:'crypto_venue', q:'7 · For crypto, where are you comfortable buying?', opts:[['Major exchanges only','cex'],['DEXs are fine too','any']], skipIf:a=>['stock','etf','bond','preipo'].includes(a.asset_class)},
  {id:'exclusions', type:'multi', q:'8 · What should be excluded?', help:'Select all that apply. Continue without a selection for no exclusions.', opts:[['Defense and weapons','defense'],['Speculative micro caps','micro'],['Stablecoin and yield protocols','stableyield']]},
  {id:'spread', q:'9 · How broad should the results be?', opts:[['Keep only the strongest matches','concentrated'],['Spread results across themes','diversified']]},
];
const iv={answers:{}, idx:0, history:[], extraReq:''};
function startInterview(extraReq){ iv.answers={}; iv.idx=0; iv.history=[]; iv.extraReq=extraReq; askNext(); }
function applicableTotal(){ return QUESTIONS.filter(q=>!(q.skipIf&&q.skipIf(iv.answers))).length; }
function displayIndex(){ let n=0; for(let i=0;i<=iv.idx&&i<QUESTIONS.length;i++){ const q=QUESTIONS[i]; if(!(q.skipIf&&q.skipIf(iv.answers))) n++; } return n; }
function askNext(){
  while(iv.idx<QUESTIONS.length){
    const q=QUESTIONS[iv.idx];
    if(q.skipIf&&q.skipIf(iv.answers)){ iv.answers[q.id]=undefined; iv.idx++; continue; }
    return renderQuestion(q);
  }
  finishInterview();
}
function renderQuestion(q){
  const wrap=document.createElement('div'); wrap.className='q-wrap block';
  const num=displayIndex(), total=applicableTotal(), multi=q.type==='multi';
  wrap.innerHTML=`
    <div class="q-progress"><span>Question ${num} of ${total}</span><span class="bar"><i style="width:${Math.round((num-1)/total*100)}%"></i></span></div>
    <div class="bubble ai">${esc(q.q)}</div>
    ${q.help?`<div class="q-help">${esc(q.help)}</div>`:''}
    <div class="opts">${q.opts.map((o,i)=>`<button class="opt" data-i="${i}">${esc(o[0])}</button>`).join('')}</div>
    ${multi?'<button class="opt-continue" id="mContinue">Continue →</button>':''}
    <div class="q-links">${iv.history.length?'<a data-act="back">← Back</a>':''}<a data-act="skip">Skip</a></div>`;
  view.appendChild(wrap);
  const finalize=(values,labels)=>{
    wrap.querySelector('.opts').remove();
    wrap.querySelector('#mContinue')?.remove();
    wrap.querySelector('.q-links')?.remove();
    const me=document.createElement('div'); me.className='bubble me'; me.textContent=labels&&labels.length?labels.join(', '):'No preference'; wrap.appendChild(me);
    iv.answers[q.id]=values; iv.history.push(iv.idx); iv.idx++; askNext();
  };
  if(multi){
    const chosen=new Set();
    wrap.querySelectorAll('.opt').forEach(btn=>btn.addEventListener('click',()=>{
      const i=+btn.dataset.i;
      if(chosen.has(i)){ chosen.delete(i); btn.classList.remove('sel'); } else { chosen.add(i); btn.classList.add('sel'); }
    }));
    wrap.querySelector('#mContinue').addEventListener('click',()=>finalize([...chosen].map(i=>q.opts[i][1]),[...chosen].map(i=>q.opts[i][0])));
  } else {
    wrap.querySelectorAll('.opt').forEach(btn=>btn.addEventListener('click',()=>{ const o=q.opts[+btn.dataset.i]; finalize(o[1],[o[0]]); }));
  }
  wrap.querySelector('[data-act="back"]')?.addEventListener('click',()=>{ wrap.remove(); const prev=iv.history.pop(); const blocks=feed.querySelectorAll('.q-wrap'); if(blocks.length) blocks[blocks.length-1].remove(); iv.idx=prev; askNext(); });
  wrap.querySelector('[data-act="skip"]')?.addEventListener('click',()=>{
    wrap.querySelector('.opts').remove(); wrap.querySelector('#mContinue')?.remove(); wrap.querySelector('.q-links').remove();
    const me=document.createElement('div'); me.className='bubble me'; me.textContent='Skipped'; wrap.appendChild(me);
    iv.answers[q.id]=multi?[]:undefined; iv.history.push(iv.idx); iv.idx++; askNext();
  });
}
const ASEL_MAP={stock:['stock'],crypto:['crypto'],etf:['etf'],bond:['bond'],preipo:['private'],both:['stock','crypto']};
function textRequestsPolymarketOnly(text){
  const s=String(text||'');
  const pm='(?:polymarket|prediction markets?)';
  const only='(?:only|just|solely|exclusively)';
  return new RegExp(`\\b${only}\\b.{0,48}\\b${pm}\\b|\\b${pm}\\b.{0,48}\\b${only}\\b`,'i').test(s);
}
async function finishInterview(){
  const A=iv.answers;
  // CONFLICT CHECK (v3): expert answer vs document requirement — never silently override.
  if(A.asset_class){
    const ansSet=(ASEL_MAP[A.asset_class]||[A.asset_class]).slice();
    const docSet=(thesis.docCrit?.asset_set||[]).slice();
    const sameOrSubset=!docSet.length||ansSet.every(x=>docSet.includes(x));
    if(!sameOrSubset){
      const AL={stock:'stocks',crypto:'crypto',etf:'ETFs',bond:'bonds'};
      const choice=await new Promise(resolve=>{
        const wrap=document.createElement('div'); wrap.className='q-wrap block';
        wrap.innerHTML=`<div class="bubble ai">The document limits the screen to <b>${esc(docSet.map(x=>AL[x]||x).join(' + '))}</b>. Your answer selected <b>${esc(ansSet.map(x=>AL[x]||x).join(' + '))}</b>. Which should take priority?</div>
          <div class="opts"><button class="opt" data-v="doc">Follow my document (${esc(docSet.map(x=>AL[x]||x).join(' + '))} only)</button><button class="opt" data-v="answer">Follow my answer (${esc(ansSet.map(x=>AL[x]||x).join(' + '))})</button></div>`;
        view.appendChild(wrap);
        wrap.querySelectorAll('.opt').forEach(b=>b.addEventListener('click',()=>{
          wrap.querySelector('.opts').remove();
          const me=document.createElement('div'); me.className='bubble me'; me.textContent=b.dataset.v==='doc'?'Follow my document':'Follow my answer'; wrap.appendChild(me);
          resolve(b.dataset.v);
        }));
      });
      if(choice==='doc') A.asset_class=null;
    }
  }
  complete(iv.extraReq, A);
}

// Stage 2: run the rest of the pipeline over SSE.
async function complete(extraReq, answers, ctx){
  // Background continuation (2026-07-11): everything this run touches later is
  // captured NOW, so switching to a recent (or starting a new research) lets
  // this run finish into its own hidden container and its own Recents entry.
  // Retries pass ctx back in: after a soft reset (+ New research) the globals
  // are cleared, so a retried run must never re-read them — it used to 400
  // with "Missing document text or thesis" and paint the error onto the fresh
  // home view (2026-07-14).
  const myView=view, myRunId=ctx?.runId??currentRunId, myDocText=ctx?.docText??docText, myThesis=ctx?.thesis??thesis, myFinish=ctx?.finish??onRunFinished;
  lastAnswers=answers; // reused verbatim when the user re-runs after editing
  let payload=ctx?.payload;
  if(!payload){
    // The selectors are the user's final word (spec §6): a fully-selected group
    // = no constraint, sent empty AND cleared from docCrit so a narrower doc
    // requirement can't resurrect after the user widened; a partial group binds
    // as-is (server merge replaces the doc's field).
    // full = the All sentinel (or every specific hand-picked) → send empty, i.e.
    // no constraint. Mcap additionally expands its 3 bands → DB cap_class list.
    const SPECIFICS={asset_set:SEG_ASSETS, region_set:SEG_REGIONS, cap_set:SEG_CAPS};
    const ALL={asset_set:ASSET_ALL, region_set:REGION_GLOBAL, cap_set:CAP_ALL};
    const sendCrit={};
    for(const k of ['asset_set','region_set','cap_set']){
      const sel=cardCrit[k]||[];
      const full=!sel.length || sel.includes(ALL[k]) || SPECIFICS[k].every(v=>sel.includes(v));
      sendCrit[k]=full?[]:(k==='cap_set'?sel.flatMap(v=>CAP_CLASSES[v]||[]):sel.slice());
      // Only clear a doc field the segs can fully express — "only bonds" or a
      // rest-of-world region has no button, so it must keep binding invisibly.
      // (cap_set is never pre-seeded from docCrit, so nothing to clear there.)
      if(full && k!=='cap_set' && myThesis?.docCrit?.[k]?.every(v=>SPECIFICS[k].includes(v))) delete myThesis.docCrit[k];
      if(full && k==='cap_set' && capSelectedByUser) delete myThesis?.docCrit?.cap_set;
    }
    // Unlike a document/interview China requirement (ADR + HKEX), an explicit
    // review-card China choice is HKEX-only. The server and exit audit both
    // enforce this flag; merely pre-seeding China from the document does not.
    sendCrit.cn_hkex_only=regionSelectedByUser && sendCrit.region_set?.includes('cn');
    // Breadth (§6): the seg's state is the final word; without ≥2 surviving
    // strategy chips the run is Focused regardless.
    const breadth=(myThesis?.strategies?.length>=2)?breadthMode:'focused';
    payload={text:myDocText, thesis:myThesis, extraReq, answers, cardCrit:sendCrit, breadth, finReq:finReqForRun(), rerun:!!ctx?.rerun};
  }
  const retryCtx={runId:myRunId, docText:myDocText, thesis:myThesis, finish:myFinish, payload};
  // Cancel aborts both the request and any in-flight body reads (spec §6, 2026-07-09).
  const ctrl=new AbortController();
  const say=statusBlock('complete', ()=>ctrl.abort());
  // A failed run is never a dead end (spec §6, 2026-07-15): whatever the
  // reason the screen did not go through, the error asks the user to edit
  // the input and rerun, next to retrying the identical request.
  const tryAgain=['Try again',()=>{ say.el.remove(); inView(myView,()=>complete(extraReq, answers, retryCtx)); }];
  const editInput=['Edit input',()=>{ say.el.remove(); jumpToEditInput(); }];
  const retry=[editInput, tryAgain];
  const RUN_FAIL_HINT='The screen did not go through. Edit your input and run it again, or try again with the same input.';
  say('Applying selected criteria…');
  try{
    const res=await apiFetch('/api/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:ctrl.signal});
    // Out of credits is not an input problem: no edit prompt, retry only.
    if(res.status===402){ const j=await res.json().catch(()=>({})); if(window.setCredits)setCredits(j); inView(myView,()=>renderError(CREDITS_OUT_MSG, [tryAgain])); return; }
    if(!res.ok){ const j=await res.json().catch(()=>({})); inView(myView,()=>renderError(j.error||('HTTP '+res.status), retry, RUN_FAIL_HINT)); return; }
    const reader=res.body.getReader(); const dec=new TextDecoder(); let buf='';
    let result=null, errMsg=null;
    const statusLines=[];
    while(true){
      const {done,value}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      const events=buf.split('\n\n'); buf=events.pop();
      for(const ev of events){
        const type=(ev.match(/^event: (.+)$/m)||[])[1];
        const data=(ev.match(/^data: (.+)$/m)||[])[1];
        if(!type||!data) continue;
        if(type==='status') { const line=JSON.parse(data); statusLines.push(line); say(line, true); }
        else if(type==='result') result=JSON.parse(data);
        else if(type==='credits') { if(window.setCredits) setCredits(JSON.parse(data)); } // spec §12: balance after debit/refund
        else if(type==='error') errMsg=JSON.parse(data).message;
      }
    }
    if(errMsg){ inView(myView,()=>renderError(errMsg, retry, RUN_FAIL_HINT)); return; }
    if(!result){ inView(myView,()=>renderError('No result received.', retry, RUN_FAIL_HINT)); return; }
    result.statusLines=statusLines;
    // Bets-first ordering (§5.8): only when bets are the sole requested output.
    // Mixed asset runs keep stocks/ETFs first, even if Polymarket is included.
    result.pmFirst = !!result.pmOnly || pmSelectedByUser || textRequestsPolymarketOnly(`${myDocText} ${extraReq||''}`);
    // Persist the completed run so Recents can restore the review card and
    // regenerate this report later (sources keep an excerpt for the basis
    // section; docText already carries the full text).
    recentUpdate({ thesis:snap(myThesis), result:snap(result), sources:sources.map(s=>({label:s.label, text:String(s.text||'').slice(0,1500)})) }, myRunId);
    inView(myView,()=>render(result));
    say.finish();
  }catch(err){
    if(err.name==='AbortError') {
      say.cancelled();
      if(mode==='oneshot') inView(myView,()=>renderError('Run cancelled.', retry));
    }
    else inView(myView,()=>renderError(err.message, retry, RUN_FAIL_HINT));
  }
  finally{ myFinish?.(); renderRecents(); } // re-show Edit / Run-again on this run's review card; drop the list's live badge
}

// Prediction-market bet card (spec §5.8): question, LEADING outcome (highest
// implied probability) highlighted — the aligned side is stated in the
// why-line header — plus why-line, volume, end date, market link.
function pmCard(b){
  const pct=(p)=>Math.round((Number(p)||0)*100)+'%';
  // Bet volumes run thousands–millions; fmtCap floors to $M and would show $0M.
  const vol=(v)=>v>=1e6?'$'+(v/1e6).toFixed(1)+'M':v>=1e3?'$'+(v/1e3).toFixed(0)+'k':'$'+Math.round(v);
  const ends=b.endDate?new Date(b.endDate).toLocaleDateString():null;
  // 24h momentum chip (§5.8): on the LEADING outcome only; null = omit.
  const pmPrices=(b.prices||[]).map(Number);
  const leadIdx=pmPrices.length?pmPrices.indexOf(Math.max(...pmPrices)):-1;
  const delta=(i)=>{
    if(i!==leadIdx||b.leadDayChangePct==null)return'';
    const v=Number(b.leadDayChangePct);
    return ` <span class="pm-delta ${v>=0?'up':'down'}">${v>=0?'▲':'▼'}${Math.abs(v).toFixed(1)}% 24h</span>`;
  };
  const outs=(b.outcomes||[]).map((o,i)=>`<span class="pm-out ${i===leadIdx?'on':''}">${esc(o)} · ${pct(b.prices?.[i])}${delta(i)}</span>`).join('');
  return `<section class="card">
    <div class="card-head">
      <div class="name-block"><h3>${esc(b.question)}</h3><div class="sym">${esc(b.eventTitle&&b.eventTitle!==b.question?b.eventTitle:'Polymarket')}</div></div>
      <div class="tags"><span class="badge pm">bet</span></div>
    </div>
    <div class="pm-outs">${outs}</div>
    <div class="why"><div class="lbl">Thesis outcome: ${esc(b.side)} (${pct(b.prices?.[b.sideIndex])} implied probability)</div><p>${esc(b.why)}</p></div>
    <div class="pm-meta">
      ${b.volume!=null?`<span>volume ${vol(b.volume)}</span>`:''}
      ${ends?`<span>ends ${esc(ends)}</span>`:''}
      <span>${b.score} / 100 · thesis relevance</span>
      <a class="pm-link" href="${esc(b.url)}" target="_blank" rel="noopener">View on Polymarket ↗</a>
    </div>
  </section>`;
}

// ---- Report export (spec §6, 2026-07-09): the full run — sources, thesis,
// requirements, assets and bets — rendered as a print-optimized investment
// report, written into a hidden iframe and handed to the browser's
// print-to-PDF dialog. Client-side only: it prints exactly what the run
// produced (missing data → "—"), no re-fetching and no vendor cost.
const excerpt=(t,n=420)=>{ const s=String(t||'').replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n)+'…':s; };
const DIR_NARR={
  long:'expressed through long positions in assets that may benefit if the thesis is correct',
  short:'expressed through short candidates that may decline if the thesis is correct',
  both:'expressed through long positions that may benefit and short candidates that may decline',
};
function reportSources(){
  const items=sources.map(s=>({label:s.label, text:s.text}));
  const pasted=ta.value.trim();
  if(pasted) items.push({label:'Pasted text', text:pasted});
  if(!items.length) items.push({label:'Research input', text:docText});
  return items;
}
function reportCritList(crit){
  const AL={stock:'stocks',crypto:'crypto',etf:'ETFs',bond:'bonds'};
  const RL={us:'US',eu:'Europe',cn:'China',it:'Italy',other:'international'};
  const out=[];
  if(crit?.asset_set?.length) out.push('only '+crit.asset_set.map(a=>AL[a]||a).join(' + '));
  if(crit?.region_set?.length) out.push('markets: '+crit.region_set.map(r=>RL[r]||r).join(' / '));
  if(crit?.cap_set?.length) out.push('size: '+crit.cap_set.join(' / '));
  if(crit?.exclusions_set?.length) out.push('exclude: '+crit.exclusions_set.join(', '));
  if(crit?.exclude_tickers?.length) out.push('avoid reference assets: '+crit.exclude_tickers.join(', '));
  if(crit?.constraint_note) out.push('“'+crit.constraint_note+'”');
  return out.length?out:['no explicit requirements. The full universe was searched'];
}
// Ordered company groups, matching how the holdings section renders (both mode
// splits long then short) so the at-a-glance table and detail numbering align.
function orderedGroups(r){
  const picks=r.picks||[];
  if((r.thesis?.direction||'long')==='both'){
    return { long: groupByCompany(picks.filter(p=>p.dir!=='short')), short: groupByCompany(picks.filter(p=>p.dir==='short')) };
  }
  return { flat: groupByCompany(picks) };
}
function glanceRow(g, rank){
  const p=g[0], m=p.market||{};
  const chg=m.change30d==null?'N/A':(m.change30d>=0?'+':'')+m.change30d.toFixed(1)+'%';
  const chgCls=m.change30d==null?'r-dim':m.change30d>=0?'r-up':'r-down';
  return `<tr>
    <td class="r-mono r-dim">${rank}</td>
    <td><b>${esc(p.name)}</b>${g.length>1?` <span class="r-dim">+${g.length-1}</span>`:''}</td>
    <td class="r-mono">${esc(p.ticker)}</td>
    <td>${esc(p.kind)}${p.kind!=='crypto'?' · '+esc(p.region):''}</td>
    <td class="r-mono r-score-cell">${p.score}</td>
    <td class="r-mono">${esc(fmtMoney(m.price, m.currency||'USD'))}</td>
    <td class="r-mono ${chgCls}">${chg}</td>
  </tr>`;
}
function glanceTable(groups){
  return `<table class="r-table"><thead><tr>
    <th>#</th><th>Company</th><th>Ticker</th><th>Type</th><th>Fit</th><th>Price</th><th>30d</th>
  </tr></thead><tbody>${groups.map((g,i)=>glanceRow(g,i+1)).join('')}</tbody></table>`;
}
function reportGlance(r){
  const og=orderedGroups(r);
  if(og.flat) return og.flat.length?`<div class="r-glance-h">Holdings at a glance</div>${glanceTable(og.flat)}`:'';
  let out='';
  if(og.long.length) out+=`<div class="r-glance-h">Long book at a glance</div>${glanceTable(og.long)}`;
  if(og.short.length) out+=`<div class="r-glance-h">Short book at a glance</div>${glanceTable(og.short)}`;
  return out;
}
function reportExecSummary(r){
  const t=r.thesis||thesis||{};
  const picks=r.picks||[];
  if(r.pmOnly){
    const n=r.predictions?.length||0;
    return `<p class="r-summary">${n?`This report maps the thesis to ${n} live prediction market${n>1?'s':''} on Polymarket whose resolution tracks its outcome.`:'This run searched Polymarket. No contract met the relevance threshold.'}</p>
      <p class="r-dim">This run covered prediction markets only. No listed securities or tokens were screened.</p>`;
  }
  if(!picks.length){
    return `<p class="r-summary">No asset in SyntheTick's universe met every selected criterion.</p>
      <p>No asset met every criterion. Widen one or more filters to run a broader screen.</p>`;
  }
  const groups=groupByCompany(picks);
  const kinds=assetLabel([...new Set(picks.map(p=>p.kind))]);
  const regions=regionLabel([...new Set(picks.filter(p=>p.kind!=='crypto').map(p=>p.region))]);
  const dir=t.direction||'long';
  const top=picks.slice().sort((a,b)=>(+b.score||0)-(+a.score||0))[0];
  const avg=Math.round(picks.reduce((s,p)=>s+(+p.score||0),0)/picks.length);
  return `<p class="r-summary">The screen found <b>${groups.length} compan${groups.length===1?'y':'ies'}</b> across ${picks.length} tradable listing${picks.length>1?'s':''}. It covered ${esc(kinds)}${regions&&regions!=='Any market'?` in ${esc(regions)}`:''} and is ${DIR_NARR[dir]||DIR_NARR.long}.</p>
    <p>Fit is scored from 0 to 100. The average is <b>${avg}/100</b>. <b>${esc(top.name)}</b> (${esc(top.ticker)}) ranks first at <b>${top.score}/100</b>. Every result was checked against the criteria before inclusion.</p>
    ${reportGlance(r)}`;
}
// Disclaimer section (§6, 2026-07-15): pinned to start on the report's second
// page. Explains how SyntheTick produced the report and what it does not do,
// condensed from the in-app FAQ, and links back to it.
function reportDisclaimer(){
  const appUrl=location.origin;
  return `<p class="r-summary">SyntheTick is a research and discovery tool, not an advisor. This page explains how this report was produced and how to read it.</p>
    <p><b>How this report was produced.</b> SyntheTick read the sources listed in this report, identified the investment case with its key themes, direction and constraints, then screened the available universe of stocks, ETFs, bond ETFs, crypto assets, selected pre-IPO companies and Polymarket prediction markets. Eligible results are ranked by how closely they align with the thesis, and each write-up explains that connection.</p>
    <p><b>This is not financial advice.</b> SyntheTick does not recommend what to buy or sell, and it does not assess suitability, valuation, timing, position size or risk. Nothing in this report is a solicitation or a recommendation to trade any asset. Use it as a starting point for your own analysis.</p>
    <p><b>What the fit score means.</b> The 0 to 100 score measures how directly an asset expresses the thesis as written. A higher score means a closer match to the thesis, never that the asset is better, undervalued, less risky or more likely to deliver a return.</p>
    <p><b>AI and data sources.</b> AI is used to interpret the thesis, match assets and write the research rationale in this report. Names, tickers, prices, market caps, volumes, financial ratios and charts come from external market data providers and are not generated by AI. Crypto data provided by <a class="r-url" href="${CG_URL}" target="_blank" rel="noopener">CoinGecko</a> (coingecko.com/en/api). When a value was unavailable it is shown as unavailable, never invented. Figures reflect the moment the research ran and may be delayed.</p>
    <p class="r-dim">For more detail on coverage, ranking and scores, read the FAQ in the app at <a class="r-url" href="${esc(appUrl)}">${esc(appUrl)}</a> (FAQ in the sidebar).</p>`;
}
function reportThesisSection(r){
  const t=r.thesis||thesis||{};
  const dir=t.direction||'long';
  let out=`<p class="r-summary">${esc(t.summary||'')}</p>`;
  out+=`<p><b>Direction.</b> This thesis is ${DIR_NARR[dir]||DIR_NARR.long}.</p>`;
  if((t.themes||[]).length) out+=`<p><b>Key themes.</b> The screen used these themes in priority order: ${t.themes.map(x=>esc(x)).join('; ')}.</p>`;
  if((t.anchors||[]).length) out+=`<p><b>Named investments.</b> ${esc(t.anchors.join(', '))}. These assets were named in the thesis and included in the screen.</p>`;
  if((t.private_entities||[]).length) out+=`<p><b>Referenced but not investable.</b> ${esc(t.private_entities.map(p=>p.note?`${p.name} (${p.note})`:p.name).join('; '))}. The screen looked for listed alternatives with similar exposure.</p>`;
  out+=`<p class="r-req"><b>Screen criteria.</b> The following criteria were applied: ${reportCritList(r.crit).map(esc).join('; ')}.</p>`;
  return out;
}
function reportSourcesSection(){
  const items=reportSources();
  const intro=`<p class="r-lead">The thesis and its criteria were taken from the following source${items.length>1?'s':''}.</p>`;
  return intro+items.map(s=>`<div class="r-source">
    <div class="r-source-h"><b>${esc(s.label)}</b><span class="r-mono r-dim">${s.text.length.toLocaleString()} characters</span></div>
    <p class="r-dim">${esc(excerpt(s.text))}</p>
  </div>`).join('');
}
// Print variant of assetLogo: same source chain (vendor logo, then website
// favicon, then ticker monogram) but eager-loading so printReport can wait on
// it, and without the DuckDuckGo late upgrade (a swap after print would race).
function reportLogo(p){
  const initials=(p.ticker||'?').replace(/[^A-Za-z0-9]/g,'').slice(0,3)||'?';
  let src=p.logo||'';
  if(!src&&p.website){ try{ const host=new URL(p.website).hostname.replace(/^www\./,''); src='https://www.google.com/s2/favicons?sz=128&domain='+encodeURIComponent(host); }catch{} }
  const img=src?`<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">`:'';
  return `<span class="r-logo${src?'':' logo-err'}" aria-hidden="true">${img}<span class="r-l-fb">${esc(initials)}</span></span>`;
}
function reportHolding(p, rank, others){
  const m=p.market||{};
  const short=p.dir==='short';
  const bkt=p.score>=70?'high':p.score>=40?'med':'low';
  const alLabel=short?(bkt==='high'?'Prime short candidate':bkt==='med'?'Moderate short exposure':'Weak short case')
    :(bkt==='high'?'High fit':bkt==='med'?'Medium fit':'Low fit');
  const chg=m.change30d==null?'N/A':((m.change30d>=0?'▲ ':'▼ ')+Math.abs(m.change30d).toFixed(1)+'%');
  const chgCls=m.change30d==null?'r-dim':m.change30d>=0?'r-up':'r-down';
  const priv=p.kind==='private';
  const venues=p.kind==='crypto'
    ? [...(p.cex_venues||[]),...(p.dex_venues||[]).map(v=>v+' (DEX)')].join(', ')||'N/A'
    : priv ? 'Private, not listed'
    : (p.exchange||'N/A');
  const links=[p.website, p.platform?.url].filter(Boolean);
  // Detailed financial data (§6, 2026-07-15): the same fund facts and
  // kind-specific fin rows the app card shows, restyled as print key/value
  // grids. Rows the vendors didn't return are omitted, never guessed.
  const kv=(rows)=>`<div class="r-fin">${rows.map(([k,v])=>`<div><span class="r-f-k">${esc(k)}</span><span class="r-mono">${esc(String(v))}</span></div>`).join('')}</div>`;
  const rng=finRange(p);
  const rangeRow=rng
    ? `<div class="r-f-range"><span class="r-f-k">52-week range</span><span class="r-mono">${esc(fmtMoney(rng.lo,rng.cur))} to ${esc(fmtMoney(rng.hi,rng.cur))}${rng.pos!=null?` <span class="r-dim">(now at ${Math.round(rng.pos)}% of the range)</span>`:''}</span></div>`
    : '';
  const fRows=finRows(p);
  const finBlock=(fRows.length||rangeRow)?`<div class="r-fin-h">Financial data</div>${kv(fRows)}${rangeRow}`:'';
  const fundRows=fundFactRows(p);
  const fundBlock=fundRows.length?`<div class="r-fin-h">Fund facts</div>${kv(fundRows)}`:'';
  return `<div class="r-holding">
    <div class="r-holding-head">
      <div class="r-h-title">${reportLogo(p)}
        <span><b>${rank}. ${esc(p.name)}</b> <span class="r-mono r-dim">${esc(p.ticker)}</span>
        <div class="r-h-sub">${esc(p.kind)}${p.kind!=='crypto'?' · '+esc(p.region):''}${p.sector?' · '+esc(p.sector):''}${short?' · <b class="r-down">SHORT</b>':''}${p.rel&&p.rel!=='adjacent'?' · '+esc(p.rel):''}</div></span>
      </div>
      <div class="r-align">
        <div class="r-align-label">${esc(alLabel)}</div>
        <div class="r-bar"><i style="width:${Math.max(0,Math.min(100,+p.score||0))}%"></i></div>
        <div class="r-mono r-align-num">${p.score}<span class="r-dim">/100</span></div>
      </div>
    </div>
    <div class="r-metrics">
      <div><div class="r-m-k">${priv?'Public price':'Price'}</div><div class="r-m-v">${priv?'Not listed':esc(fmtMoney(m.price, m.currency||'USD'))}</div>${priv?`<div class="r-m-sub">${m.asOf?`Data updated ${new Date(m.asOf).toLocaleDateString()}`:'Private company'}</div>`:m.asOf?`<div class="r-m-sub">as of ${new Date(m.asOf).toLocaleDateString()}${m.stale?' · snapshot':m.delayed?' · delayed':''}</div>`:''}</div>
      ${priv?'':`<div><div class="r-m-k">30 day move</div><div class="r-m-v ${chgCls}">${chg}</div></div>`}
      <div><div class="r-m-k">${priv?'Est. valuation':(p.kind==='etf'||p.kind==='bond')?'AUM':'Market cap'}</div><div class="r-m-v">${esc(fmtCap(m.marketCap))}</div></div>
      ${p.kind==='crypto'?`<div><div class="r-m-k">24h volume</div><div class="r-m-v">${esc(fmtVol(m.volume24h))}</div></div>`:''}
    </div>
    ${fundBlock}${finBlock}
    <div class="r-write">
      ${p.about?`<h4>Company overview</h4><p>${esc(p.about)}</p>`:''}
      <h4>${short?'Short case':'Investment rationale'}</h4>
      <p>${esc(p.why||p.analysis||'No rationale provided.')}</p>
      ${p.analysis&&p.analysis!==p.why?`<h4>Analysis</h4><p>${esc(p.analysis)}</p>`:''}
      <h4>Key risks and watch points</h4>
      <p>${esc(caveatText(p))}</p>
      ${p.news?.headline?`<h4>Recent developments</h4><p>${esc(p.news.headline)}${p.news.source||p.news.date?` <span class="r-dim">· ${esc([p.news.source,p.news.date].filter(Boolean).join(' · '))}</span>`:''}${p.news.summary?`<br>${esc(p.news.summary)}`:''}${p.news.url?`<br><span class="r-url">${esc(p.news.url)}</span>`:''}</p>`:''}
    </div>
    <div class="r-h-foot">
      <span><b>Trades on:</b> ${esc(venues)}${others?.length?` &nbsp;·&nbsp; <b>Also listed as:</b> ${esc(others.map(o=>`${o.ticker} (${o.exchange||o.kind})`).join(', '))}`:''}</span>
      ${links.length?`<span class="r-url">${links.map(esc).join('  ·  ')}</span>`:''}
    </div>
  </div>`;
}
function holdingsTitle(r){
  const dir=r.thesis?.direction||'long';
  return dir==='both'?'Long positions and short candidates':dir==='short'?'Short candidates':'Selected holdings';
}
function reportHoldingsSection(r){
  if(r.pmOnly) return '';
  const picks=r.picks||[];
  if(!picks.length) return `<p>No asset met every requirement. Widen one or more filters to run a broader screen.</p>`;
  const og=orderedGroups(r);
  // The same display-policy note the results area shows.
  const note=r.market_note?`<p class="r-lead">${esc(r.market_note)}</p>`:'';
  if(og.flat){
    const n=og.flat.length;
    const intro=`<p class="r-lead">Results are ranked by thesis fit. Every company met the selected criteria. Market data uses the timestamp shown.</p>`;
    return intro+note+og.flat.map((g,i)=>reportHolding(g[0],i+1,g.slice(1))).join('');
  }
  let out=note;
  if(og.long.length) out+=`<h3 class="r-book"><span class="r-book-dot r-up-bg"></span>Long positions</h3>`+og.long.map((g,i)=>reportHolding(g[0],i+1,g.slice(1))).join('');
  if(og.short.length) out+=`<h3 class="r-book"><span class="r-book-dot r-down-bg"></span>Short candidates</h3>`+og.short.map((g,i)=>reportHolding(g[0],i+1,g.slice(1))).join('');
  return out;
}
function reportPmSection(r){
  if(!r.predictions?.length) return '';
  const pct=(p)=>Math.round((Number(p)||0)*100)+'%';
  const vol=(v)=>v>=1e6?'$'+(v/1e6).toFixed(1)+'M':v>=1e3?'$'+(v/1e3).toFixed(0)+'k':'$'+Math.round(v);
  const intro=`<p class="r-lead">These Polymarket contracts track the thesis outcome. Prices are live market implied probabilities, not SyntheTick estimates. The highlighted outcome is the side aligned with the thesis.</p>`;
  return intro+r.predictions.map(b=>`<div class="r-holding">
    <div class="r-holding-head">
      <div class="r-h-title"><span><b>${esc(b.question)}</b><div class="r-h-sub">${esc(b.eventTitle&&b.eventTitle!==b.question?b.eventTitle:'Polymarket')}</div></span></div>
      <div class="r-align"><div class="r-align-label">Thesis relevance</div><div class="r-bar"><i style="width:${Math.max(0,Math.min(100,+b.score||0))}%"></i></div><div class="r-mono r-align-num">${b.score}<span class="r-dim">/100</span></div></div>
    </div>
    <div class="r-outs">${(b.outcomes||[]).map((o,i)=>`<span class="r-out${i===b.sideIndex?' r-out-on':''}">${esc(o)} ${pct(b.prices?.[i])}</span>`).join('')}</div>
    <div class="r-write"><h4>Thesis outcome: ${esc(b.side)}</h4><p>${esc(b.why)}</p></div>
    <div class="r-h-foot"><span>${[b.volume!=null?`Volume ${vol(b.volume)}`:'', b.endDate?`Ends ${new Date(b.endDate).toLocaleDateString()}`:''].filter(Boolean).join(' · ')}</span><span class="r-url">${esc(b.url)}</span></div>
  </div>`).join('');
}
function reportHTML(r){
  const t=r.thesis||thesis||{};
  const dir=t.direction||'long';
  const picks=r.picks||[];
  const nCompanies=picks.length?groupByCompany(picks).length:0;
  const shortNote=(dir==='short'||dir==='both')
    ? ' Short positions can produce unlimited losses and may involve borrow costs or short squeezes. This research does not model those risks.'
    : '';
  const metaBits=[
    new Date().toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}),
    (mode==='expert'?'Guided':'Quick')+' screen',
    dirLabel(dir)+(r.pmOnly?' · prediction markets':picks.length?` · ${nCompanies} holding${nCompanies>1?'s':''}`:' · no holdings'),
  ];
  // The disclaimer opens on a fresh page (r-break) so it is the report's
  // second page; later sections take their number from their position.
  const secs=[['Executive summary', reportExecSummary(r)], ['Disclaimer', reportDisclaimer(), 'r-break'], ['Investment thesis', reportThesisSection(r)], ['Sources', reportSourcesSection()]];
  const holdings=reportHoldingsSection(r); if(holdings) secs.push([holdingsTitle(r), holdings]);
  const pm=reportPmSection(r); if(pm) secs.push(['Prediction markets', pm]);
  const body=secs.map(([title,html,cls],i)=>`<section class="r-sec${cls?' '+cls:''}"><h2><span class="r-sec-n">${String(i+1).padStart(2,'0')}</span>${esc(title)}</h2>${html}</section>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
  <title>${esc(t.title||'Thesis research')}_Report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{--paper:#fbfaf6; --ink:#191f1b; --muted:#69726a; --line:#e3ddd0; --amber:#b0741a; --amber-soft:#f4ead6; --up:#3f7a4a; --down:#b0503f;
      --display:'Space Grotesk',system-ui,sans-serif; --mono:'IBM Plex Mono',ui-monospace,monospace; --body:'Space Grotesk',system-ui,sans-serif;}
    @page{size:A4; margin:18mm 16mm}
    *{box-sizing:border-box}
    body{font-family:var(--body); font-size:10.25pt; line-height:1.6; color:var(--ink); background:var(--paper); margin:0; -webkit-print-color-adjust:exact; print-color-adjust:exact}
    b{font-weight:600}
    .r-mono{font-family:var(--mono)} .r-dim{color:var(--muted)}
    .r-up{color:var(--up)} .r-down{color:var(--down)}
    .r-up-bg{background:var(--up)} .r-down-bg{background:var(--down)}
    /* Cover */
    .r-cover{border-bottom:2.5px solid var(--amber); padding-bottom:16px; margin-bottom:6px}
    .r-brand{font-family:var(--display); font-weight:700; font-size:13pt; letter-spacing:-.01em}
    .r-brand span{color:var(--amber)}
    .r-doctype{font-family:var(--mono); font-size:8pt; letter-spacing:.22em; text-transform:uppercase; color:var(--amber); margin-top:16px}
    .r-title{font-family:var(--display); font-weight:700; font-size:23pt; line-height:1.12; letter-spacing:-.02em; margin:5px 0 0}
    .r-cover-meta{font-family:var(--mono); font-size:8.5pt; color:var(--muted); margin-top:13px; display:flex; align-items:center; flex-wrap:wrap; gap:9px}
    .r-sep{width:3px; height:3px; border-radius:50%; background:var(--muted); display:inline-block}
    /* Sections */
    .r-sec{margin-top:22px}
    h2{font-family:var(--display); font-weight:600; font-size:14pt; letter-spacing:-.01em; margin:0 0 11px; padding-bottom:7px; border-bottom:1px solid var(--line); break-after:avoid; display:flex; align-items:baseline; gap:11px}
    .r-sec-n{font-family:var(--mono); font-size:9pt; font-weight:600; color:var(--amber)}
    h3.r-book{font-family:var(--display); font-weight:600; font-size:11.5pt; margin:20px 0 9px; break-after:avoid; display:flex; align-items:center; gap:8px}
    .r-book-dot{width:8px; height:8px; border-radius:50%; display:inline-block}
    h4{font-family:var(--mono); font-size:8pt; letter-spacing:.11em; text-transform:uppercase; color:var(--amber); margin:11px 0 3px; break-after:avoid}
    p{margin:7px 0}
    .r-lead{color:var(--muted); font-size:9.75pt}
    .r-summary{font-size:11.5pt; line-height:1.55; font-weight:500}
    .r-req{background:var(--amber-soft); border-radius:6px; padding:10px 13px; font-size:9.5pt; margin-top:13px; break-inside:avoid}
    /* At-a-glance table */
    .r-glance-h{font-family:var(--mono); font-size:8pt; letter-spacing:.11em; text-transform:uppercase; color:var(--muted); margin:17px 0 6px}
    .r-table{width:100%; border-collapse:collapse; font-size:9pt; break-inside:avoid}
    .r-table th{text-align:left; font-family:var(--mono); font-weight:500; font-size:7.5pt; letter-spacing:.07em; text-transform:uppercase; color:var(--muted); padding:5px 8px; border-bottom:1.5px solid var(--line)}
    .r-table td{padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:baseline}
    .r-table tbody tr:last-child td{border-bottom:0}
    .r-table th:nth-child(1),.r-table td:nth-child(1){width:20px}
    .r-table th:nth-child(5),.r-table td:nth-child(5),.r-table th:nth-child(6),.r-table td:nth-child(6),.r-table th:nth-child(7),.r-table td:nth-child(7){text-align:right}
    .r-score-cell{color:var(--amber); font-weight:600}
    /* Holdings */
    .r-holding{border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:12px 0; break-inside:avoid; background:#fff}
    .r-holding-head{display:flex; justify-content:space-between; align-items:flex-start; gap:18px; padding-bottom:11px; border-bottom:1px solid var(--line)}
    .r-h-title{display:flex; gap:10px; align-items:baseline}
    .r-h-title b{font-family:var(--display); font-weight:600; font-size:12pt}
    .r-logo{width:34px; height:34px; border-radius:50%; border:1px solid var(--line); background:#fff; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; flex:none; align-self:center}
    .r-logo img{width:100%; height:100%; object-fit:contain}
    .r-l-fb{display:none; font-family:var(--mono); font-weight:600; font-size:6.5pt; color:var(--muted)}
    .r-logo.logo-err img{display:none}
    .r-logo.logo-err .r-l-fb{display:inline}
    .r-h-sub{font-size:8.5pt; color:var(--muted); margin-top:3px}
    .r-align{text-align:right; flex:none; width:128px}
    .r-align-label{font-family:var(--display); font-weight:600; font-size:9pt}
    .r-bar{height:5px; background:var(--line); border-radius:3px; margin:5px 0 3px; overflow:hidden}
    .r-bar i{display:block; height:100%; background:var(--amber); border-radius:3px}
    .r-align-num{font-size:9pt}
    .r-metrics{display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:6px; overflow:hidden; margin:12px 0}
    .r-metrics>div{background:#fff; padding:8px 11px}
    .r-m-k{font-family:var(--mono); font-size:7pt; letter-spacing:.08em; text-transform:uppercase; color:var(--muted)}
    .r-m-v{font-family:var(--mono); font-size:11pt; font-weight:500; margin-top:2px}
    .r-m-sub{font-family:var(--mono); font-size:7pt; color:var(--muted); margin-top:1px}
    /* Detailed financial data grids (§6, 2026-07-15) */
    .r-fin-h{font-family:var(--mono); font-size:7pt; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:11px 0 4px}
    .r-fin{display:grid; grid-template-columns:repeat(3,1fr); gap:2px 16px; font-size:8.5pt}
    .r-fin .r-mono{font-size:8.5pt}
    .r-fin>div{display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px dotted var(--line); padding:2.5px 0}
    .r-f-k{color:var(--muted)}
    .r-f-range{display:flex; justify-content:space-between; align-items:baseline; gap:8px; border-bottom:1px dotted var(--line); padding:2.5px 0; font-size:8.5pt; margin-top:2px}
    .r-f-range .r-mono{font-size:8.5pt}
    .r-break{break-before:page}
    .r-write{margin-top:10px}
    .r-write h4:first-child{margin-top:2px}
    .r-write p{font-size:9.75pt; margin:2px 0 0}
    .r-h-foot{margin-top:12px; padding-top:9px; border-top:1px solid var(--line); font-size:8.5pt; color:var(--muted); display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap}
    .r-url{font-family:var(--mono); font-size:8pt; color:var(--amber); word-break:break-all}
    /* Sources */
    .r-source{border-left:2px solid var(--amber); padding:1px 0 1px 12px; margin:10px 0; break-inside:avoid}
    .r-source-h{display:flex; justify-content:space-between; gap:12px; align-items:baseline}
    .r-source p{margin:3px 0 0; font-size:9.25pt}
    /* Prediction-market outcomes */
    .r-outs{display:flex; flex-wrap:wrap; gap:6px; margin:11px 0 2px}
    .r-out{font-family:var(--mono); font-size:8.5pt; color:var(--muted); background:var(--paper); border:1px solid var(--line); border-radius:5px; padding:4px 9px}
    .r-out-on{color:var(--amber); border-color:var(--amber); background:var(--amber-soft); font-weight:600}
    footer{margin-top:26px; padding-top:10px; border-top:1px solid var(--line); color:var(--muted); font-size:8pt; line-height:1.55}
  </style></head><body>
  <header class="r-cover">
    <div class="r-brand">SyntheTick<span>.</span></div>
    <div class="r-doctype">Investment research report</div>
    <h1 class="r-title">${esc(t.title||'Thesis research')}</h1>
    <div class="r-cover-meta">${metaBits.map((b,i)=>(i?'<span class="r-sep"></span>':'')+esc(b)).join('')}</div>
  </header>
  ${body}
  <footer>This report is a research starting point, not a recommendation. It does not assess valuation, timing or suitability.${shortNote} Prices come from external market data providers and include an as of time when available.${showsCoinGecko(r)?` Crypto data provided by <a class="r-url" href="${CG_URL}" target="_blank" rel="noopener">CoinGecko</a> (coingecko.com/en/api).`:''} This is not financial advice.</footer>
  </body></html>`;
}
// A PDF download costs 1 credit (spec §12): debit first, then print. With auth
// off the endpoint answers ok without charging, so dev flows are unchanged.
async function downloadReport(r){
  try{
    const res=await apiFetch('/api/pdf-credit',{method:'POST'});
    const j=await res.json().catch(()=>({}));
    if(res.status===402){ if(window.setCredits)setCredits(j); flashNote(CREDITS_OUT_MSG); return; }
    if(!res.ok){ flashNote(j.error||'Could not start the download. Try again.'); return; }
    if(window.setCredits)setCredits(j);
  }catch(err){ flashNote(err.message); return; }
  printReport(r);
}
function printReport(r){
  const frame=document.createElement('iframe');
  frame.setAttribute('aria-hidden','true');
  frame.style.cssText='position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden';
  document.body.appendChild(frame);
  const doc=frame.contentDocument;
  doc.open(); doc.write(reportHTML(r)); doc.close();
  // The report document has its own listeners (document.open() clears them);
  // images that already failed before this point get the monogram directly.
  bindLogoFallbacks(doc);
  for(const i of doc.images) if(i.complete && !i.naturalWidth) i.closest('.r-logo')?.classList.add('logo-err');
  const go=()=>{ try{ frame.contentWindow.focus(); frame.contentWindow.print(); }catch{ frame.remove(); } };
  frame.contentWindow.addEventListener('afterprint', ()=>setTimeout(()=>frame.remove(), 500), {once:true});
  // Wait for the brand webfonts to load so the PDF uses them, but never block
  // forever; afterprint doesn't fire for iframe printing in some browsers,
  // hence the long safety-net removal.
  const fonts=doc.fonts;
  const fontsReady=fonts?.ready||Promise.resolve();
  // Wait for holding logos too, or they print as blanks; error counts as
  // settled (the monogram fallback takes over). Capped so a dead CDN can
  // never hold the print dialog hostage.
  const imgsReady=Promise.all([...doc.images].filter(i=>!i.complete)
    .map(i=>new Promise(res=>{ i.addEventListener('load',res,{once:true}); i.addEventListener('error',res,{once:true}); })));
  Promise.race([Promise.all([fontsReady,imgsReady]), new Promise(res=>setTimeout(res,3000))]).then(()=>setTimeout(go,60));
  setTimeout(()=>frame.remove(), 120000);
}

// Errors are never dead ends (spec §6, 2026-07-09): each action is a
// [label, fn] pair rendered as a button; clicking removes the error first.
// The optional hint renders as a softer line under the message (2026-07-15).
function renderError(msg, actions, hint){
  view.querySelector('.run-status')?.remove(); // drop the dock status pulse on failure
  const d=document.createElement('section'); d.className='block err'; d.textContent='Research failed: '+msg;
  if(hint){ const h=document.createElement('div'); h.className='err-hint'; h.textContent=hint; d.appendChild(h); }
  if(actions?.length){
    const row=document.createElement('div'); row.className='err-actions';
    actions.forEach(([label, fn])=>{
      const b=document.createElement('button'); b.type='button'; b.textContent=label;
      b.onclick=()=>{ d.remove(); fn(); };
      row.appendChild(b);
    });
    d.appendChild(row);
  }
  view.appendChild(d);
}

// Same-company collapse (spec §6): picks whose names normalize to the same
// company (BIDU ADR + BAIDF OTC line → "Baidu Inc") render as one card; the
// "n options" button cycles the other listings into the same rank slot.
const normName=(s)=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function groupByCompany(picks){
  const groups=[], byName=new Map();
  for(const p of picks){
    const k=normName(p.name);
    const g=byName.get(k);
    if(g) g.push(p); else { const ng=[p]; byName.set(k,ng); groups.push(ng); }
  }
  return groups;
}
// Sort a card container by the given <select>, renumbering the displayed rank
// badges to the visible order so "#1" is always the top card (spec §6).
function wireSort(selectEl, container){
  const apply=()=>{
    const sort=selectEl.value;
    const holders=[...container.children];
    const sorted=holders.slice().sort((a,b)=>{
      if(sort==='score') return Number(b.dataset.score)-Number(a.dataset.score);
      if(sort==='cap') return Number(b.dataset.cap)-Number(a.dataset.cap);
      if(sort==='move') return Number(b.dataset.move)-Number(a.dataset.move);
      return Number(a.dataset.rank)-Number(b.dataset.rank);
    });
    sorted.forEach(h=>container.appendChild(h));
    let pos=0;
    sorted.forEach(h=>{
      if(h.style.display==='none') return;
      pos++;
      h.dataset.shown=String(pos);
      const sym=h.querySelector('.sym');
      if(sym) sym.textContent=sym.textContent.replace(/^#\d+/, '#'+pos);
    });
  };
  selectEl.addEventListener('change',apply);
}
function addResultTools(container, groups){
  const tools=document.createElement('section');
  tools.className='block result-tools';
  tools.innerHTML=`<label>Sort <select data-act="sort"><option value="rank">rank</option><option value="score">thesis fit</option><option value="cap">market cap</option><option value="move">30 day move</option></select></label>`;
  // container lives inside the run's own .run-view since the background-
  // continuation refactor (§6 2026-07-11) — inserting into the global feed
  // threw "not a child of this node" and killed every result render.
  container.parentNode.insertBefore(tools, container);
  wireSort(tools.querySelector('[data-act="sort"]'), container);
}
function appendPickCards(groups, opts){
  const container=document.createElement('div');
  container.className='pick-list';
  view.appendChild(container);
  // sortInBasket: the Sort control already lives inside this run's summary box
  // (basket) — wire it to this list instead of adding a separate tools box.
  const basketSort = opts?.sortInBasket ? [...view.querySelectorAll('.has-sort [data-act="sort"]')].pop() : null;
  if(basketSort) wireSort(basketSort, container);
  else addResultTools(container, groups);
  groups.forEach((g,i)=>{
    const holder=document.createElement('div');
    const primary=g[0]||{};
    holder.dataset.rank=String(i+1);
    holder.dataset.score=String(primary.score||0);
    holder.dataset.cap=String(primary.market?.marketCap||0);
    holder.dataset.move=String(primary.market?.change30d ?? -9999);
    holder.dataset.price=String(!!primary.market?.price);
    container.appendChild(holder);
    let idx=0;
    const paint=()=>{
      const shown=holder.dataset.shown?Number(holder.dataset.shown):i+1;
      const alt=g.length>1?`<button type="button" class="alt-btn" title="View other listings for this company">${g.length} listings · ${idx+1}/${g.length}</button>`:'';
      holder.innerHTML=card(g[idx], shown, alt, g.length);
      holder.querySelector('.alt-btn')?.addEventListener('click',()=>{ idx=(idx+1)%g.length; paint(); });
      activateGauges(holder);
    };
    paint();
  });
}

// Prediction markets (spec §5.8) — only when something genuinely relates;
// honest empty state when the user asked for Polymarket only.
// Strategy breadth (§6): Diversified results grouped under strategy headers —
// groups ordered by their best score, unattributed picks in a final "Other
// approaches" group. Cards, gauges and per-section sort tools are the standard
// ones; scores stay absolute, so a weaker strategy visibly scores lower.
function renderStrategySections(r, dir){
  const names=[...new Set(r.picks.map(p=>p.strategy).filter(Boolean))];
  const sections=names.map(n=>({name:n, picks:r.picks.filter(p=>p.strategy===n)}))
    .sort((a,b)=>Math.max(...b.picks.map(p=>p.score||0))-Math.max(...a.picks.map(p=>p.score||0)));
  const other=r.picks.filter(p=>!p.strategy);
  if(other.length) sections.push({name:null, picks:other});
  const groupsAll=groupByCompany(r.picks);
  view.insertAdjacentHTML('beforeend', `<section class="block res-head"><h2>${names.length} investment approaches</h2>
    <div class="recap">${groupsAll.length} companies across ${r.picks.length} tradable listings. Results cover ${names.length} distinct strategies and are ranked on the same fit scale. Prices and 30 day history come from market data providers.</div></section>`);
  view.insertAdjacentHTML('beforeend', basketSummary(groupsAll, dir));
  sections.forEach(sec=>{
    const g=groupByCompany(sec.picks);
    const best=Math.max(...sec.picks.map(p=>p.score||0));
    view.insertAdjacentHTML('beforeend', `<section class="block res-head"><h2 style="font-size:18px;color:var(--amber)">${sec.name?esc(sec.name):'Other approaches'}</h2>
      <div class="recap">${g.length} compan${g.length===1?'y':'ies'} · best fit ${best}/100${dir==='short'?' · short side':''}</div></section>`);
    appendPickCards(g);
  });
}

function renderPredictionsSection(r){
  if(r.predictions?.length){
    view.insertAdjacentHTML('beforeend', `<section class="block res-head"><h2 style="font-size:18px">Prediction markets</h2>
      <div class="recap">${r.predictions.length} live Polymarket contract${r.predictions.length>1?'s':''} tied to the thesis outcome. Prices are current market implied probabilities.</div></section>`);
    r.predictions.forEach(b=>view.insertAdjacentHTML('beforeend', pmCard(b)));
  } else if(r.pmOnly){
    view.insertAdjacentHTML('beforeend', `<section class="block empty-state">
      <h3>No related prediction markets</h3>
      <p>No live Polymarket contract is closely tied to this thesis. A more specific event or outcome may produce better results.</p></section>`);
  }
}

function jumpToEditInput(){
  const editBtn = document.getElementById('editBtn');
  if(editBtn){
    editBtn.scrollIntoView({behavior:'smooth', block:'center'});
    setTimeout(()=>editBtn.focus(), 300);
    return;
  }
  restoreComposer();
  requestAnimationFrame(()=>{
    composer.scrollIntoView({behavior:'smooth', block:'start'});
    ta.focus();
  });
}

function render(r){
  view.appendChild(sectionHead('results','03','Results',SEC_INFO.results));
  const audit=auditSummary(r);
  if(audit) view.insertAdjacentHTML('beforeend', audit);
  // Data display policy (server-decided): one line when this run's market
  // data for some picks is not shown; their cards keep the usual empty state.
  if(r.market_note) view.insertAdjacentHTML('beforeend', `<section class="block market-note" role="note">${esc(r.market_note)}</section>`);
  // Bets-first ordering (§5.8): when the user specifically asked for
  // Polymarket, the bets section leads and the asset picks follow.
  if(r.pmFirst) renderPredictionsSection(r);
  // Requirements stay enforced + visible via audit status lines; the "final
  // binding requirements" recap section was removed 2026-07-06 (spec §6).
  if(r.pmOnly){
    // Polymarket-only research (spec §5.8): no asset section at all.
  } else if(r.path==='empty' || r.picks.length===0){
    view.insertAdjacentHTML('beforeend', emptyResearchState(r));
    // Same stale-feed reference class as the Sort toolbar: with background
    // runs, feed.lastElementChild can be a NEWER run's view — wire the
    // empty-state actions inside this run's own view.
    wireEmptyActions(view.lastElementChild);
  } else {
    const dir = r.thesis?.direction || 'long';
    if (dir === 'both') {
      const longs = groupByCompany(r.picks.filter(p=>p.dir!=='short'));
      const shorts = groupByCompany(r.picks.filter(p=>p.dir==='short'));
      view.insertAdjacentHTML('beforeend', `<section class="block res-head"><h2>Long positions and short candidates</h2>
        <div class="recap">${longs.length} long companies and ${shorts.length} short candidates across ${r.picks.length} tradable listings. Every result met the selected criteria. Prices and 30 day history come from market data providers.</div></section>`);
      view.insertAdjacentHTML('beforeend', basketSummary([...longs,...shorts], dir));
      if (longs.length) {
        view.insertAdjacentHTML('beforeend', `<section class="block res-head"><h2 style="font-size:18px;color:var(--up)">Long positions</h2></section>`);
        appendPickCards(longs);
      }
      if (shorts.length) {
        view.insertAdjacentHTML('beforeend', `<section class="block res-head"><h2 style="font-size:18px;color:var(--down)">Short candidates</h2></section>`);
        appendPickCards(shorts);
      }
    } else if (r.breadth==='diversified' && r.picks.some(p=>p.strategy)) {
      renderStrategySections(r, dir);
    } else {
      const groups = groupByCompany(r.picks);
      const heading = dir==='short'
        ? `${groups.length} short candidate compan${groups.length===1?'y':'ies'}`
        : `${groups.length} compan${groups.length===1?'y':'ies'} matched`;
      const recap = dir==='short'
        ? `${groups.length} companies across ${r.picks.length} tradable listings. Ranked by short fit. Every result met the selected criteria.`
        : `${groups.length} companies across ${r.picks.length} tradable listings. Ranked by thesis fit. Every result met the selected criteria.`;
      view.insertAdjacentHTML('beforeend', resultsCard(groups, dir, heading, recap));
      appendPickCards(groups, {sortInBasket:true});
    }
  }
  if(!r.pmFirst) renderPredictionsSection(r);
  // Report export (spec §6, 2026-07-09): every completed run — including empty
  // and Polymarket-only ones — can be saved as a PDF recap.
  const rr=document.createElement('section'); rr.className='block report-row';
  rr.innerHTML=`<div><div class="rr-t">Research report</div><div class="rr-sub">Download the sources, thesis, criteria and results as a PDF.</div></div>
    <button class="btn-ghost" type="button">Download report (PDF)</button>`;
  rr.querySelector('button').addEventListener('click',()=>downloadReport(r));
  view.appendChild(rr);
  const editRow=document.createElement('section'); editRow.className='block report-row';
  editRow.innerHTML=`<div><div class="rr-t">Change the thesis or criteria</div><div class="rr-sub">Return to the review card and run an updated screen.</div></div>
    <div class="report-actions"><button class="btn-ghost" type="button" data-act="edit">Edit input</button></div>`;
  editRow.querySelector('[data-act="edit"]').addEventListener('click',()=>{
    editRow.innerHTML=`<div><div class="rr-t">Want to download this list as a report?</div><div class="rr-sub">Save the current list before editing, or continue without a PDF.</div></div>
      <div class="report-actions">
        <button class="btn-primary" type="button" data-act="yes">Yes</button>
        <button class="btn-ghost" type="button" data-act="no">No</button>
      </div>`;
    editRow.querySelector('[data-act="yes"]').addEventListener('click',()=>{
      downloadReport(r);
      setTimeout(jumpToEditInput, 350);
    });
    editRow.querySelector('[data-act="no"]').addEventListener('click',jumpToEditInput);
  });
  view.appendChild(editRow);
  const shortNote = (r.thesis?.direction === 'short' || r.thesis?.direction === 'both')
    ? ' Short positions can produce unlimited losses and may involve borrow costs or short squeezes. This research does not model those risks.'
    : '';
  const cgNote = showsCoinGecko(r) ? ` Crypto data provided by <a href="${CG_URL}" target="_blank" rel="noopener">CoinGecko</a>.` : '';
  view.insertAdjacentHTML('beforeend', `<footer class="block">This is a research starting point, not a recommendation. SyntheTick does not assess valuation, timing or suitability.${shortNote} Prices come from external market data providers and include an as of time when available.${cgNote} This is not financial advice.</footer>`);
}

startBtn.addEventListener('click', async ()=>{
  const url = pastedUrl(ta.value);
  if (url) {
    startBtn.disabled = true;
    try {
      await loadLinkSource(url);
      ta.value = '';
      const linkedText = srcText().trim();
      if (linkedText) startResearch(linkedText, srcLog().trim());
    } catch (err) {
      fileName.textContent = '⚠ ' + err.message;
      refreshReady();
    }
    return;
  }
  const t=[ta.value.trim(), srcText()].filter(Boolean).join('\n\n').trim();
  if(!t) return; // button is disabled while empty
  startResearch(t, [ta.value.trim(), srcLog()].filter(Boolean).join('\n\n').trim());
});
// ---- app shell: sidebar, theme, recents, coming-soon notes (2026-07-11) ----
// New research is a soft reset (no reload): background runs keep streaming
// into their hidden containers and still land in Recents.
newBtn.addEventListener('click', ()=>{
  feed.querySelectorAll(':scope > .run-view').forEach(v=>{ v.style.display='none'; });
  view=feed;
  currentRunId=null; docText=''; thesis=null; sources=[];
  renderSrcChips(); ta.value=''; refreshReady();
  fileName.textContent='';
  composer.style.display=''; feed.classList.add('empty');
  showView('home');
  ta.focus();
});

const THEME_KEY='sd-theme';
function applyTheme(t){
  if(t==='light') document.documentElement.dataset.theme='light';
  else delete document.documentElement.dataset.theme;
  try{ localStorage.setItem(THEME_KEY, t) }catch{}
  document.getElementById('themeDark')?.setAttribute('aria-pressed', t==='light'?'false':'true');
  document.getElementById('themeLight')?.setAttribute('aria-pressed', t==='light'?'true':'false');
}
applyTheme((()=>{ try{ return localStorage.getItem(THEME_KEY)||'dark' }catch{ return 'dark' } })());
document.getElementById('themeDark')?.addEventListener('click', ()=>applyTheme('dark'));
document.getElementById('themeLight')?.addEventListener('click', ()=>applyTheme('light'));

const settingsBtn=document.getElementById('settingsBtn');
const settingsPop=document.getElementById('settingsPop');
function setSettings(open){
  settingsPop.hidden=!open;
  settingsBtn.setAttribute('aria-expanded', open?'true':'false');
}
settingsBtn?.addEventListener('click',(e)=>{ e.stopPropagation(); setSettings(settingsPop.hidden); });
document.getElementById('sideUser')?.addEventListener('click',(e)=>{ e.stopPropagation(); setSettings(true); });
document.getElementById('settingsClose')?.addEventListener('click',()=>setSettings(false));
settingsPop?.addEventListener('click',(e)=>{ if(e.target===settingsPop) setSettings(false); });

// Terms and Conditions modal, opened from inside the settings modal and from
// the homepage disclaimer link.
const termsModal=document.getElementById('termsModal');
const setTerms=(open)=>{ if(termsModal) termsModal.hidden=!open; };
document.getElementById('termsOpen')?.addEventListener('click',()=>setTerms(true));
document.getElementById('discTerms')?.addEventListener('click',()=>setTerms(true));
document.getElementById('termsClose')?.addEventListener('click',()=>setTerms(false));
termsModal?.addEventListener('click',(e)=>{ if(e.target===termsModal) setTerms(false); });

document.addEventListener('keydown',(e)=>{
  if(e.key!=='Escape') return;
  if(termsModal && !termsModal.hidden){ setTerms(false); return; }
  setSettings(false); setSidebar(false); setDino(false);
});

// Recents: local, per-browser research history. Each entry keeps the thesis
// snapshot (so the review card can be restored, edited and re-run) and, once
// a run completes, the full result payload so the report can be downloaded
// again without any new API calls. Single-user for now; server persistence
// arrives with the beta.
let RECENTS_KEY='sd-recents-v2';
// Recents are per signed-in account (2026-07-14): sd-auth.js calls this after
// /api/me resolves. The legacy unscoped list predates accounts and belongs to
// this browser's owner — the first account to sign in claims it.
window.sdSetRecentsUser=(email)=>{
  const scoped='sd-recents-v2:'+String(email||'').toLowerCase();
  if(scoped===RECENTS_KEY) return;
  try{
    if(!localStorage.getItem(scoped)){
      const legacy=localStorage.getItem('sd-recents-v2');
      if(legacy){ localStorage.setItem(scoped, legacy); localStorage.removeItem('sd-recents-v2'); }
    }
  }catch{}
  RECENTS_KEY=scoped;
  renderRecents();
};
const snap=(v)=>{ try{ return JSON.parse(JSON.stringify(v)) }catch{ return null } };
let currentRunId=null;
// Live containers by run id: lets a recents click re-show a run that is still
// streaming (with its progress) instead of rebuilding a static saved card.
const runViews=new Map();
const isLiveRun=(id)=>{ const v=runViews.get(id); return !!(v?.isConnected && v.querySelector('.source-loading, .btn-running')); };
function loadRecents(){ try{ return JSON.parse(localStorage.getItem(RECENTS_KEY))||[] }catch{ return [] } }
function persistRecents(list){
  // Quota safety: drop oldest entries (they carry result payloads) until it fits.
  for(let n=list.length;n>0;n--){
    try{ localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0,n))); return; }catch{}
  }
}
function titleFrom(text){
  return text.replace(/\[Source:[^\]]*\]\s*/g,' ').trim().replace(/\s+/g,' ').slice(0,64)||'Untitled research';
}
function recentStart(text){
  currentRunId=Date.now();
  recentUpdate({ title:titleFrom(text), docText:text });
}
function recentUpdate(patch, id=currentRunId){
  if(!id) return;
  const list=loadRecents();
  let e=list.find(r=>r.id===id);
  if(!e){ e={id}; list.unshift(e); }
  Object.assign(e, patch, {at:Date.now()});
  list.sort((a,b)=>b.at-a.at);
  persistRecents(list.slice(0,8));
  renderRecents();
}
function deleteRecent(id){
  persistRecents(loadRecents().filter(r=>r.id!==id));
  if(currentRunId===id) currentRunId=null;
  renderRecents();
}
// Deleting asks first, offering the saved report as a last download; the
// entry and everything it stores go away together.
function confirmDeleteRecent(row, r){
  row.innerHTML='';
  const box=document.createElement('div'); box.className='sr-confirm';
  const q=document.createElement('div'); q.className='sr-q';
  q.textContent=r.result
    ? 'Are you sure? This research and its saved report will be deleted. You can download the report first.'
    : 'Are you sure? This research will be deleted.';
  const acts=document.createElement('div'); acts.className='sr-actions';
  const mk=(label,cls,fn)=>{
    const btn=document.createElement('button');
    btn.type='button'; btn.className='sr-btn'+(cls?' '+cls:''); btn.textContent=label;
    btn.addEventListener('click',(e)=>{ e.stopPropagation(); fn(); });
    acts.appendChild(btn);
  };
  if(r.result) mk('Download report','',()=>downloadReport(r.result));
  mk('Delete','danger',()=>deleteRecent(r.id));
  mk('Cancel','',()=>renderRecents());
  box.append(q, acts);
  row.appendChild(box);
}
function renderRecents(){
  const el=document.getElementById('recentList'); if(!el) return;
  const list=loadRecents();
  el.innerHTML='';
  if(!list.length){ el.innerHTML='<div class="side-empty">No research yet</div>'; return; }
  list.forEach(r=>{
    const row=document.createElement('div'); row.className='side-recent';
    const b=document.createElement('button');
    b.type='button'; b.className='sr-open';
    const live=isLiveRun(r.id);
    b.innerHTML=`<span class="sr-t"></span><span class="sr-d">${new Date(r.at).toLocaleDateString()}${live?' · <span class="sr-live">screen progress…</span>':r.result?' · report saved':''}</span>`;
    b.querySelector('.sr-t').textContent=r.title||'Untitled research';
    b.title=live?'This research is still running. Open it to watch the progress.':r.thesis?'Open this saved research':'Open this thesis in the editor';
    // No reload: an in-flight run keeps streaming into its own hidden
    // container, completes and lands in its Recents entry.
    b.addEventListener('click',()=>{
      setSidebar(false);
      const entry=loadRecents().find(x=>x.id===r.id);
      const liveV=runViews.get(r.id);
      // A run still streaming re-shows its LIVE container, progress included —
      // rebuilding the saved card would hide the run and invite a duplicate.
      if(liveV?.isConnected && isLiveRun(r.id)){
        feed.querySelectorAll(':scope > .run-view').forEach(v=>{ v.style.display='none'; });
        liveV.style.display='';
        view=liveV;
        currentRunId=r.id;
        composer.style.display='none'; feed.classList.remove('empty');
        showView('home');
      }
      else if(entry?.thesis) openSavedResearch(entry);
      else if(entry){
        feed.querySelectorAll(':scope > .run-view').forEach(v=>{ v.style.display='none'; });
        view=feed;
        composer.style.display=''; feed.classList.add('empty');
        showView('home');
        currentRunId=entry.id;
        ta.value=entry.docText||''; refreshReady(); ta.focus();
      }
      window.scrollTo({top:0, behavior:'smooth'});
    });
    const x=document.createElement('button');
    x.type='button'; x.className='sr-x'; x.textContent='×';
    x.title='Delete this research';
    x.setAttribute('aria-label','Delete '+(r.title||'this research'));
    x.addEventListener('click',(e)=>{ e.stopPropagation(); confirmDeleteRecent(row, r); });
    row.append(b, x);
    el.appendChild(row);
  });
}
// Restore a saved research: the review card comes back editable and
// re-runnable (an explicit action, never automatic) and a saved report is
// downloadable as it was produced. Runs that never finished extraction fall
// back to the composer with the text restored.
function openSavedResearch(entry){
  currentRunId=entry.id; // edits and re-runs update the same entry
  docText=entry.docText||'';
  thesis=snap(entry.thesis);
  sources=(entry.sources||[]).map(s=>({label:s.label, text:s.text}));
  composer.style.display='none'; feed.classList.remove('empty');
  showView('home');
  newView();
  runViews.set(entry.id, view);
  const dock=document.createElement('div'); dock.className='docked block';
  dock.innerHTML=`<span class="k">Saved research</span> ${esc(new Date(entry.at).toLocaleString())}<span class="m">Recents</span>`;
  view.appendChild(dock);
  renderThesisReview({savedRun:true});
  if(entry.result){
    const rr=document.createElement('section'); rr.className='block report-row';
    rr.innerHTML=`<div><div class="rr-t">Saved report</div><div class="rr-sub">Download the report from this research as it was produced.</div></div>
      <button class="btn-ghost" type="button">Download report (PDF)</button>`;
    rr.querySelector('button').addEventListener('click',()=>downloadReport(entry.result));
    view.appendChild(rr);
  }
}
renderRecents();

// View switching: the FAQ and API pages live off the homepage as their own
// views; Home (tab, New research, Dino's FAQ link) always returns to the
// research surface.
const faqSection=document.getElementById('faq');
const apiSection=document.getElementById('apiView');
const mcpSection=document.getElementById('mcpView');
function showView(v){
  const isFaq=v==='faq', isApi=v==='api', isMcp=v==='mcp';
  if(faqSection) faqSection.hidden=!isFaq;
  if(apiSection) apiSection.hidden=!isApi;
  if(mcpSection) mcpSection.hidden=!isMcp;
  feed.style.display=(isFaq||isApi||isMcp)?'none':'';
  window.scrollTo({top:0, behavior:'smooth'});
  setSidebar(false);
}

// Home / Chat tabs and the coming-soon notes. Chat, Routine and Compare each
// toggle a small description box instead of navigating.
const chatNote=document.getElementById('chatNote');
const soonNotes=[['tabChat','chatNote'],['navRoutine','routineNote'],['navCompare','compareNote']];
soonNotes.forEach(([btnId,noteId])=>{
  const note=document.getElementById(noteId);
  document.getElementById(btnId)?.addEventListener('click',()=>{
    const show=note.hidden;
    soonNotes.forEach(([,id])=>{ const n=document.getElementById(id); if(n) n.hidden=true; });
    note.hidden=!show;
  });
});
document.getElementById('tabHome')?.addEventListener('click',()=>{
  if(chatNote) chatNote.hidden=true;
  showView('home');
});
document.getElementById('navFaq')?.addEventListener('click',()=>showView('faq'));
document.getElementById('navApi')?.addEventListener('click',()=>{ showView('api'); loadApiKeys(); });
// Deep link used by the universe page: synthetick.org/#api opens the API section.
if(location.hash==='#api'){ showView('api'); loadApiKeys(); }
document.getElementById('navMcp')?.addEventListener('click',()=>showView('mcp'));
document.getElementById('mcpToApi')?.addEventListener('click',()=>{ showView('api'); loadApiKeys(); });

// ---- API keys (spec §13): management UI inside the API view. The full key
// appears exactly once, in the reveal box right after creation; the list only
// ever shows prefixes. On auth-off servers (localhost) /api/keys answers 503
// with an explanation, which becomes the note text.
const apiKeysNote=document.getElementById('apiKeysNote');
const apiKeysList=document.getElementById('apiKeysList');
const apiKeyCreate=document.getElementById('apiKeyCreate');
const apiKeyReveal=document.getElementById('apiKeyReveal');
const fmtDay=(iso)=>iso?new Date(iso).toISOString().slice(0,10):'';
function renderApiKeys(keys,maxActive){
  apiKeysList.innerHTML='';
  const active=keys.filter(k=>!k.revoked_at);
  apiKeysNote.textContent=active.length
    ? `Requests authenticate with Authorization: Bearer <key>. You can hold up to ${maxActive} active keys.`
    : 'No keys yet. Create one to call the API. Keep keys secret: anyone holding a key spends your credits.';
  keys.forEach(k=>{
    const row=document.createElement('div');
    row.className='api-key-row'+(k.revoked_at?' revoked':'');
    const meta=k.revoked_at
      ? `${k.key_prefix}… · revoked ${fmtDay(k.revoked_at)}`
      : `${k.key_prefix}… · created ${fmtDay(k.created_at)} · ${k.last_used_at?'last used '+fmtDay(k.last_used_at):'never used'}`;
    const info=document.createElement('div');
    const nm=document.createElement('div'); nm.className='api-key-name'; nm.textContent=k.name||'Unnamed key';
    const mt=document.createElement('div'); mt.className='api-key-meta'; mt.textContent=meta;
    info.append(nm,mt); row.appendChild(info);
    if(!k.revoked_at){
      const btn=document.createElement('button'); btn.className='btn-ghost'; btn.type='button'; btn.textContent='Revoke';
      btn.addEventListener('click',async()=>{
        if(!confirm(`Revoke "${k.name||'Unnamed key'}"? Requests using it will stop working immediately.`)) return;
        btn.disabled=true;
        try{
          const res=await apiFetch('/api/keys/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:k.id})});
          if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error||'Revoke failed.');
          loadApiKeys();
        }catch(err){ flashNote(err.message||'Revoke failed.'); btn.disabled=false; }
      });
      row.appendChild(btn);
    }
    apiKeysList.appendChild(row);
  });
}
async function loadApiKeys(){
  apiKeyReveal.hidden=true;
  try{
    const res=await apiFetch('/api/keys');
    const data=await res.json().catch(()=>({}));
    if(!res.ok){
      apiKeysNote.textContent=data.error||'API keys are unavailable right now.';
      apiKeyCreate.hidden=true; apiKeysList.innerHTML='';
      return;
    }
    if(data.warning){
      apiKeysNote.textContent=data.warning;
      apiKeyCreate.hidden=true; apiKeysList.innerHTML='';
      return;
    }
    apiKeyCreate.hidden=false;
    renderApiKeys(data.keys||[],data.maxActive||5);
  }catch(err){
    apiKeysNote.textContent=err.message||'API keys are unavailable right now.';
    apiKeyCreate.hidden=true; apiKeysList.innerHTML='';
  }
}
document.getElementById('apiKeyCreateBtn')?.addEventListener('click',async()=>{
  const nameEl=document.getElementById('apiKeyName');
  const btn=document.getElementById('apiKeyCreateBtn');
  btn.disabled=true;
  try{
    const res=await apiFetch('/api/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:nameEl.value.trim()})});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'Could not create the key.');
    nameEl.value='';
    document.getElementById('apiKeyValue').textContent=data.key;
    apiKeyReveal.hidden=false;
    const listRes=await apiFetch('/api/keys');
    const listData=await listRes.json().catch(()=>({}));
    if(listRes.ok&&!listData.warning){ apiKeyCreate.hidden=false; renderApiKeys(listData.keys||[],listData.maxActive||5); }
  }catch(err){ flashNote(err.message||'Could not create the key.'); }
  btn.disabled=false;
});
document.getElementById('apiKeyCopyBtn')?.addEventListener('click',async()=>{
  const key=document.getElementById('apiKeyValue').textContent||'';
  try{ await navigator.clipboard.writeText(key); flashNote('Key copied to the clipboard.'); }
  catch{ flashNote('Copy failed. Select the key text and copy it manually.'); }
});

// ---- Dino, the FAQ helper (2026-07-11): a strictly scoped mascot chat. It
// answers only questions about how SyntheTick works, matching against the
// FAQ content client side. No API calls, no market questions, no advice.
const DINO_KB=[
  {keys:['how','work','works','use','start','flow','screen','research','thesis','run'],
   a:'You add a thesis, an article, a link, a note or a voice recording. SyntheTick identifies the investment case, the key themes and your constraints. You review that interpretation, then it screens the universe, ranks the matches by thesis alignment and explains why each result may fit. At the end you can download a PDF report.'},
  {keys:['stage','version','beta','roadmap','coming','next','future'],
   a:'SyntheTick is at v0.1. This early version mainly tests how well the service matches assets against your thesis and constraints. An MCP server and a public API are already available from the sidebar; future versions will add a conversational chat mode and other features shaped by feedback.'},
  {keys:['advice','recommend','recommendation','buy','sell','suitability','financial'],
   a:'SyntheTick does not provide financial advice. It is a research and discovery tool: it matches your thesis and constraints with relevant assets and shows why each one may fit. It never tells you what to buy or sell, and it does not judge valuation, timing, position size or risk.'},
  {keys:['ai','llm','model','generated','hallucinate','data','source','prices'],
   a:'AI is used to understand your thesis, identify themes and constraints, match assets and explain fits. Names, tickers, prices, market caps, volumes and charts come from external market data providers, not from AI. When data is unavailable, SyntheTick says so instead of inventing a value.'},
  {keys:['rank','ranking','score','order','alignment','fit'],
   a:'Results are ordered by how closely each asset matches your thesis and constraints. A higher rank means stronger alignment with what you described. It does not mean the asset is better, undervalued, less risky or more likely to deliver a return.'},
  {keys:['score','scores','92','52','number','gauge','high','medium','low','stretch','mean','means','scale','100'],
   a:'The score measures how directly an asset expresses your thesis, on an absolute 0 to 100 scale. A 92 is a very direct, central expression of what you described, while a 52 relates more partially, for example through one theme. 70 and above reads as high alignment, 40 to 69 as medium, below 40 as low, and picks below 35 are marked as stretch ideas. The score compares the asset with your thesis, never with other assets, so a 92 is a closer match, not a better investment.'},
  {keys:['cover','coverage','assets','universe','stocks','etf','etfs','bond','bonds','crypto','polymarket','prediction','preipo','pre','ipo','private','markets','which'],
   a:'Right now you can screen listed stocks and ETFs across the US, Europe and China through HKEX and US listed ADRs, bond ETFs, crypto on centralized and decentralized exchanges, a selected pre IPO watchlist and relevant Polymarket prediction markets.'},
  {keys:['not','missing','unavailable','options','futures','derivatives','shares','broker','brokerage','trade','execute'],
   a:'Individual corporate or government bonds, mainland China A shares, options, futures and other derivatives are not included yet. Pre IPO coverage is a curated watchlist. SyntheTick does not connect to a brokerage and does not execute trades.'},
  {keys:['mcp','claude','assistant','agent','integration'],
   a:'The MCP server is live. Assistants and agents powered by Claude or other MCP enabled models can send a thesis to SyntheTick and work with its matched assets inside their own workflows. Open the MCP section in the sidebar for the endpoint and connection instructions.'},
  {keys:['api','programmatic','developer','endpoint','integrate'],
   a:'The public API is live. Developers can submit a thesis and constraints, run a screen programmatically and receive structured matches with their research rationale, plus market data where data licences allow it. Open the API section in the sidebar to create a key and see the docs.'},
  {keys:['routine','cadence','schedule','scheduled','automatic','automatically','recurring','daily','weekly','monthly'],
   a:'Routine mode is coming soon. You will be able to receive a research report automatically on the cadence you choose, on the same sector or a different one each time.'},
  {keys:['credit','credits','cost','costs','limit','quota','balance','pay','price','pricing','plan','plans','increase','upgrade'],
   a:'Every account receives 10 free credits per day. Running a research costs 1 credit and downloading the PDF report costs 1 credit. Your balance refreshes back to the daily amount at midnight UTC, unused credits do not carry over, and a failed run returns its credit. Options to increase your daily credits are coming soon.'},
];
const DINO_INTRO='Hi, I am Dino, your friendly financial analyst. I can only help you understand how this tool works, or you can read the FAQ directly.';
const DINO_SOON='Soon you will also be able to chat with me to go deeper into each company: financials, business, technology and more.';
const DINO_FALLBACK='That is outside what I can help with. I only answer questions about how SyntheTick works. Try asking about coverage, ranking, the MCP server, the API or financial advice, or open the FAQ.';
const dinoFab=document.getElementById('dinoFab');
const dinoPanel=document.getElementById('dinoPanel');
const dinoMsgs=document.getElementById('dinoMsgs');
const dinoChips=document.getElementById('dinoChips');
function dinoSay(text, me){
  const d=document.createElement('div');
  d.className='dm '+(me?'dm-me':'dm-bot');
  d.textContent=text;
  dinoMsgs.appendChild(d);
  dinoMsgs.scrollTop=dinoMsgs.scrollHeight;
}
function dinoAnswer(q){
  const words=q.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
  if(!words.length) return DINO_FALLBACK;
  if(words.every(w=>['hi','hello','hey','ciao','yo','dino'].includes(w))) return DINO_INTRO;
  let best=null, bestScore=0;
  for(const e of DINO_KB){
    const s=words.reduce((n,w)=>n+(e.keys.includes(w)?1:0),0);
    if(s>bestScore){ best=e; bestScore=s; }
  }
  return bestScore>0?best.a:DINO_FALLBACK;
}
function setDino(open){
  if(!dinoPanel) return;
  dinoPanel.hidden=!open;
  dinoFab?.setAttribute('aria-expanded', open?'true':'false');
  if(open && !dinoMsgs.childElementCount){
    dinoSay(DINO_INTRO);
    dinoSay(DINO_SOON);
    const mk=(label,fn)=>{
      const c=document.createElement('button');
      c.type='button'; c.className='chip'; c.textContent=label;
      c.addEventListener('click',fn);
      dinoChips.appendChild(c);
    };
    mk('Open the FAQ',()=>{ showView('faq'); setDino(false); });
    mk('How does it work?',()=>dinoAsk('How does it work?'));
    mk('Which assets are covered?',()=>dinoAsk('Which assets are covered?'));
    mk('Is this financial advice?',()=>dinoAsk('Is this financial advice?'));
  }
  if(open) document.getElementById('dinoText')?.focus();
}
function dinoAsk(q){
  dinoSay(q, true);
  setTimeout(()=>dinoSay(dinoAnswer(q)), 220);
}
dinoFab?.addEventListener('click',()=>setDino(dinoPanel.hidden));
document.getElementById('dinoClose')?.addEventListener('click',()=>setDino(false));
document.getElementById('dinoForm')?.addEventListener('submit',(e)=>{
  e.preventDefault();
  const inp=document.getElementById('dinoText');
  const q=inp.value.trim(); if(!q) return;
  inp.value='';
  dinoAsk(q);
});

// Mobile drawer
const sidebar=document.getElementById('sidebar');
const sideBackdrop=document.getElementById('sideBackdrop');
const menuBtn=document.getElementById('menuBtn');
function setSidebar(open){
  if(!sidebar) return;
  sidebar.classList.toggle('open', open);
  sideBackdrop.hidden=!open;
  menuBtn?.setAttribute('aria-expanded', open?'true':'false');
}
menuBtn?.addEventListener('click',()=>setSidebar(!sidebar.classList.contains('open')));
sideBackdrop?.addEventListener('click',()=>setSidebar(false));
