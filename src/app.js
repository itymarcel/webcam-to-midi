import { FilesetResolver, HandLandmarker } from './vendor/tasks-vision/vision_bundle.mjs';

const { invoke } = window.__TAURI__.core;

// ---------- constants ----------
const CC_X = 20;
const CC_Y = 21;
const CC_MAX = 127;
const FINGERTIP = 8; // MediaPipe landmark: index finger tip
const LOST_GRACE_MS = 150; // ignore single-frame tracking dropouts
const MAX_SMOOTH_MS = 1000; // time constant at 100% smoothing
const MIDI_POLL_MS = 2000;

// ---------- elements ----------
const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const statusEl = $('status');

// ---------- persisted settings ----------
const settings = {
  smoothing: 30, // 0–100
  lost: 'keep', // 'keep' | 'zero'
  channel: 'all', // 'all' | '1'…'16'
  midi: null, // '__all__' | '__virtual__' | port name (null → backend default)
  camera: null, // deviceId
  sendX: true, // X/Y pills: whether that CC is sent
  sendY: true,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('settings') || '{}'));
} catch { /* fresh start */ }
const save = () => {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* ignore */ }
};

function setStatus(msg) {
  statusEl.textContent = msg || '';
  statusEl.hidden = !msg;
}

// ---------- dropdown component ----------
const ARROW = `<svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true">
  <path d="M6 12V1.5M1.2 6.2 6 1.4l4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
const dropdowns = [];

function dropdown(el, { getOptions, getValue, onChange, emptyLabel = '—' }) {
  el.innerHTML = `<button class="dropdown-button" type="button" aria-haspopup="listbox">
      <span></span>${ARROW}</button><div class="dropdown-menu" role="listbox"></div>`;
  const button = el.querySelector('.dropdown-button');
  const label = button.querySelector('span');
  const menu = el.querySelector('.dropdown-menu');

  const render = () => {
    const options = getOptions();
    const current = options.find((o) => o.value === getValue());
    label.textContent = current ? current.label : emptyLabel;
    menu.innerHTML = '';
    if (!options.length) {
      const item = document.createElement('button');
      item.className = 'dropdown-item';
      item.disabled = true;
      item.textContent = emptyLabel;
      menu.append(item);
    }
    for (const o of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dropdown-item';
      item.role = 'option';
      item.textContent = o.label;
      item.setAttribute('aria-selected', String(o.value === getValue()));
      item.addEventListener('click', () => {
        close();
        onChange(o.value);
        render();
      });
      menu.append(item);
    }
  };
  const close = () => {
    el.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', () => {
    const opening = !el.classList.contains('open');
    dropdowns.forEach((d) => d.close());
    if (opening) {
      render();
      el.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
    }
  });

  const api = { render, close, el };
  dropdowns.push(api);
  render();
  return api;
}

document.addEventListener('pointerdown', (e) => {
  for (const d of dropdowns) if (!d.el.contains(e.target)) d.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dropdowns.forEach((d) => d.close());
});

// ---------- smoothing slider ----------
const slider = $('smoothing');
const sliderFill = slider.querySelector('.slider-fill');
const sliderValue = slider.querySelector('.slider-value');

function setSmoothing(v) {
  settings.smoothing = Math.round(Math.min(100, Math.max(0, v)));
  sliderFill.style.width = `${settings.smoothing}%`;
  sliderValue.textContent = `${settings.smoothing}%`;
  slider.setAttribute('aria-valuenow', settings.smoothing);
  save();
}
function sliderFromPointer(e) {
  const r = slider.getBoundingClientRect();
  setSmoothing(((e.clientX - r.left) / r.width) * 100);
}
slider.addEventListener('pointerdown', (e) => {
  slider.setPointerCapture(e.pointerId);
  sliderFromPointer(e);
});
slider.addEventListener('pointermove', (e) => {
  if (slider.hasPointerCapture(e.pointerId)) sliderFromPointer(e);
});
slider.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setSmoothing(settings.smoothing - step);
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setSmoothing(settings.smoothing + step);
  else return;
  e.preventDefault();
});
setSmoothing(settings.smoothing);

// ---------- X / Y pills: click to toggle sending ----------
for (const axis of ['X', 'Y']) {
  const pill = $(`pill${axis}`);
  const key = `send${axis}`;
  const render = () => {
    pill.classList.toggle('off', !settings[key]);
    pill.setAttribute('aria-pressed', String(settings[key]));
  };
  pill.addEventListener('click', () => {
    settings[key] = !settings[key];
    sent[axis.toLowerCase()] = null; // resend the current value when re-enabled
    save();
    render();
  });
  render();
}

// ---------- LIVE: float window on top + hide controls ----------
const liveButton = $('live');
liveButton.addEventListener('click', async () => {
  const live = liveButton.getAttribute('aria-pressed') !== 'true';
  dropdowns.forEach((d) => d.close());
  liveButton.setAttribute('aria-pressed', String(live));
  document.body.classList.toggle('is-live', live);
  try {
    await invoke('set_live', { live });
  } catch (err) {
    console.error(err);
  }
});

// ---------- "hand lost" behaviour ----------
dropdown($('dd-lost'), {
  getOptions: () => [
    { value: 'keep', label: 'Keep Last Value' },
    { value: 'zero', label: 'Set to 0 / 0' },
  ],
  getValue: () => settings.lost,
  onChange: (v) => { settings.lost = v; save(); },
});

// ---------- MIDI channel ----------
dropdown($('dd-channel'), {
  getOptions: () => [
    { value: 'all', label: 'All Channels' },
    ...Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1), label: `Channel ${i + 1}` })),
  ],
  getValue: () => settings.channel,
  onChange: (v) => { settings.channel = v; save(); resendOutputs(); },
});

// ---------- MIDI output ----------
let midiInfo = { ports: [], virtualPort: null, selection: '__all__', failed: [] };

function applyMidiInfo(info) {
  midiInfo = info;
  if (statusEl.dataset.kind !== 'fatal') {
    setStatus(info.failed.length ? `Couldn't open MIDI port: ${info.failed.join(', ')} (in use by another app?)` : '');
  }
  midiDropdown.render();
}

const midiDropdown = dropdown($('dd-midi'), {
  getOptions: () => [
    ...(midiInfo.virtualPort ? [{ value: '__virtual__', label: midiInfo.virtualPort }] : []),
    { value: '__all__', label: 'All MIDI Outputs' },
    ...midiInfo.ports.map((p) => ({ value: p, label: p })),
  ],
  getValue: () => midiInfo.selection,
  emptyLabel: 'No MIDI Outputs',
  onChange: async (v) => {
    settings.midi = v;
    save();
    applyMidiInfo(await invoke('midi_select', { selection: v }));
    resendOutputs();
  },
});

async function initMidi() {
  try {
    let info = await invoke('midi_outputs');
    const wanted = settings.midi;
    const valid = wanted === '__all__' || (wanted === '__virtual__' && info.virtualPort) || info.ports.includes(wanted);
    if (wanted && valid && wanted !== info.selection) info = await invoke('midi_select', { selection: wanted });
    applyMidiInfo(info);
    setInterval(async () => applyMidiInfo(await invoke('midi_outputs')), MIDI_POLL_MS);
  } catch (err) {
    setStatus(`MIDI unavailable: ${err}`);
  }
}

// ---------- camera ----------
let cameras = [];
let stream = null;

const cameraDropdown = dropdown($('dd-camera'), {
  getOptions: () => cameras.map((c, i) => ({ value: c.deviceId, label: c.label || `Camera ${i + 1}` })),
  getValue: () => settings.camera,
  emptyLabel: 'No Camera',
  onChange: (id) => startCamera(id),
});

async function refreshCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  cameras = devices.filter((d) => d.kind === 'videoinput');
  cameraDropdown.render();
}

async function startCamera(deviceId) {
  stream?.getTracks().forEach((t) => t.stop());
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, ...size } : size,
      audio: false,
    });
  } catch (err) {
    if (deviceId) return startCamera(null); // saved camera gone → fall back to default
    statusEl.dataset.kind = 'fatal';
    setStatus(`Camera unavailable: ${err.message || err}. Check camera permission in system settings.`);
    return;
  }
  video.srcObject = stream;
  settings.camera = stream.getVideoTracks()[0].getSettings().deviceId || deviceId;
  save();
  await refreshCameras();
}
navigator.mediaDevices.addEventListener('devicechange', refreshCameras);

// ---------- tracking + smoothing + output ----------
let landmarker = null;
let lastVideoTime = -1;
let lastFrame = performance.now();
let lastSeen = -Infinity;
let raw = null; // {x, y} normalised 0–1, y up; null = no hand
let target = null; // where the smoothed value is heading
let smooth = null; // smoothed value
const sent = { x: null, y: null }; // last values sent per axis (null → resend)
const shown = { x: null, y: null };

async function initTracker() {
  const fileset = await FilesetResolver.forVisionTasks('vendor/tasks-vision/wasm');
  const make = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: 'vendor/models/hand_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numHands: 1,
    });
  try {
    landmarker = await make('GPU');
  } catch {
    landmarker = await make('CPU');
  }
}

/** Visible video rect inside the window (object-fit: cover crops the frame). */
function coverRect(W, H) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(W / vw, H / vh);
  return { w: vw * scale, h: vh * scale, x: (W - vw * scale) / 2, y: (H - vh * scale) / 2 };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function detect(now, W, H) {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const result = landmarker.detectForVideo(video, now);
  const tip = result.landmarks?.[0]?.[FINGERTIP];
  if (tip) {
    const r = coverRect(W, H);
    const sx = W - (r.x + tip.x * r.w); // mirrored, to match the mirrored video
    const sy = r.y + tip.y * r.h;
    raw = { x: clamp01(sx / W), y: clamp01(1 - sy / H) };
    lastSeen = now;
  } else {
    raw = null;
  }
}

function sendCC(controller, value) {
  const channel = settings.channel === 'all' ? null : Number(settings.channel) - 1;
  invoke('midi_cc', { channel, controller, value }).catch(() => {});
}

function resendOutputs() {
  sent.x = sent.y = null;
}

function update(now) {
  const dt = Math.min(now - lastFrame, 100);
  lastFrame = now;

  if (raw) target = { ...raw };
  else if (now - lastSeen > LOST_GRACE_MS && settings.lost === 'zero' && target) target = { x: 0, y: 0 };

  if (!target) return;
  if (!smooth) smooth = { ...target };

  const s = settings.smoothing / 100;
  const tau = MAX_SMOOTH_MS * s * s;
  const a = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  smooth.x += (target.x - smooth.x) * a;
  smooth.y += (target.y - smooth.y) * a;

  const x = Math.round(smooth.x * CC_MAX);
  const y = Math.round(smooth.y * CC_MAX);
  if (x !== shown.x) $('valX').textContent = shown.x = x;
  if (y !== shown.y) $('valY').textContent = shown.y = y;
  if (settings.sendX && x !== sent.x) { sendCC(CC_X, x); sent.x = x; }
  if (settings.sendY && y !== sent.y) { sendCC(CC_Y, y); sent.y = y; }
}

function draw(W, H) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Smoothed value: white dot
  if (smooth) {
    const x = smooth.x * W, y = (1 - smooth.y) * H;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Raw tracking: green cross
  if (raw) {
    const x = raw.x * W, y = (1 - raw.y) * H, r = 34;
    ctx.strokeStyle = '#3ddc2f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    ctx.stroke();
  }
}

let lastTick = 0;
function tick() {
  const now = performance.now();
  lastTick = now;
  const W = window.innerWidth, H = window.innerHeight;
  try {
    detect(now, W, H);
  } catch (err) {
    console.error(err);
  }
  update(now);
  draw(W, H);
}

// rAF drives the loop normally. Some OSes pause rAF for windows hidden behind
// other apps (e.g. a DAW); the interval keeps tracking + MIDI alive then.
function loop() {
  tick();
  requestAnimationFrame(loop);
}
setInterval(() => {
  if (performance.now() - lastTick > 50) tick();
}, 33);

// ---------- boot ----------
(async () => {
  initMidi();
  await startCamera(settings.camera);
  try {
    await initTracker();
  } catch (err) {
    statusEl.dataset.kind = 'fatal';
    setStatus(`Hand tracker failed to load: ${err.message || err}`);
  }
  requestAnimationFrame(loop);
})();
