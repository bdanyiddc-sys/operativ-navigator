import fs from 'fs';
import path from 'path';

const ref = fs.readFileSync('d:/cursor/design_reference/kisvonat_hibrid_premium_v6_JAVITOTT.html', 'utf8');
const m = ref.match(/class="wheel-img" src="(data:image\/png;base64,[^"]+)"/);
if (!m) {
  console.error('wheel-img base64 not found');
  process.exit(1);
}
const b64 = m[1].replace(/^data:image\/png;base64,/, '');
const out = path.resolve('assets/ui/varos102.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
console.log('written', out, fs.statSync(out).size, 'bytes');
