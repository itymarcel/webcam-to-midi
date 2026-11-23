// Copies the runtime files the UI needs out of node_modules into src/vendor/
// and downloads the MediaPipe hand model once. src/vendor/ is git-ignored;
// Tauri runs this automatically before `tauri dev` and `tauri build`.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'src', 'vendor');
const nm = join(root, 'node_modules');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const copies = [
  ['@mediapipe/tasks-vision/vision_bundle.mjs', 'tasks-vision/vision_bundle.mjs'],
  ['@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', 'tasks-vision/wasm/vision_wasm_internal.js'],
  ['@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', 'tasks-vision/wasm/vision_wasm_internal.wasm'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', 'fonts/jetbrains-mono-500.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2', 'fonts/jetbrains-mono-700.woff2'],
];

const exists = (p) => stat(p).then(() => true, () => false);

for (const [from, to] of copies) {
  const dest = join(vendor, to);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(nm, from), dest);
}

const model = join(vendor, 'models', 'hand_landmarker.task');
if (!(await exists(model))) {
  console.log('Downloading hand landmark model…');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  await mkdir(dirname(model), { recursive: true });
  await writeFile(model, Buffer.from(await res.arrayBuffer()));
}

console.log('Assets ready in src/vendor/');
