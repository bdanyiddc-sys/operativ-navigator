import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, '../../../../design_reference/kisvonat_splash_animation_test.html');
const html = fs.readFileSync(src, 'utf8');
const idx = html.indexOf('data:image/png;base64,');
if (idx < 0) throw new Error('base64 png not found');
const start = idx + 'data:image/png;base64,'.length;
const end = html.indexOf('"', start);
const b64 = html.slice(start, end);
const out = path.resolve(__dirname, '../assets/ui/kisvonat_splash_train.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
console.log('written', out, fs.statSync(out).size, 'bytes');
