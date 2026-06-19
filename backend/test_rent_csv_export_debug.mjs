/**
 * CSV export debug – menü → dispatcher → export függvény → letöltés
 * node test_rent_csv_export_debug.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium;
for (const p of [
  path.join(__dirname, 'node_modules', 'playwright'),
  path.join(__dirname, '..', 'frontend', 'public', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
if (!chromium) {
  console.error('FAIL: Playwright missing');
  process.exit(2);
}

const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';

async function login(page) {
  const gate = await page.locator('#admin-login-gate:not([hidden])').isVisible().catch(() => false);
  if (!gate) return;
  await page.selectOption('#admin-login-user', { label: 'Admin' });
  await page.fill('#admin-login-pin', 'kisvonat');
  await page.locator('#admin-login-form button[type="submit"]').click();
  await page.waitForTimeout(1200);
}

async function testExport(page, action, startMarker, label) {
  const consoleLines = [];
  const dialogMessages = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));
  page.on('dialog', async (d) => {
    dialogMessages.push(d.message());
    await d.accept();
  });

  await page.locator('#btnDataMgmt').click();
  await page.waitForTimeout(150);
  const menuBtn = page.locator(`[data-dm-action="${action}"]`);
  const btnCount = await menuBtn.count();
  if (btnCount === 0) {
    return { label, pass: false, failAt: 'menu HTML', detail: `Nincs [data-dm-action="${action}"] gomb` };
  }

  let download = null;
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);

  await menuBtn.click();
  download = await downloadPromise;
  await page.waitForTimeout(500);

  const startSeen = consoleLines.some((l) => l.includes(startMarker));
  if (!startSeen) {
    return {
      label,
      pass: false,
      failAt: 'export függvény',
      detail: `${startMarker} nem jelent meg a konzolon. Dialogok: ${JSON.stringify(dialogMessages)}`,
      consoleLines: consoleLines.filter((l) => l.includes('CSV_EXPORT') || l.includes('export') || l.includes('failed')),
    };
  }

  if (dialogMessages.some((m) => m.includes('Nincs exportálható'))) {
    return {
      label,
      pass: 'PARTIAL',
      failAt: 'szűrés után üres lista',
      detail: `Függvény fut, de nincs adat a tartományban: "${dialogMessages.find((m) => m.includes('Nincs'))}"`,
      startSeen: true,
    };
  }

  if (!download) {
    return {
      label,
      pass: false,
      failAt: 'letöltés',
      detail: `Függvény elindult (${startMarker}), de download esemény nem jött 8s alatt. Dialogok: ${JSON.stringify(dialogMessages)}`,
      startSeen: true,
    };
  }

  const filename = download.suggestedFilename();
  return { label, pass: true, filename, startSeen: true };
}

async function main() {
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }

  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(`${BASE}/rent/admin?v=csv-debug`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    console.log('FAIL: oldal betöltés', e.message);
    await browser.close();
    process.exit(1);
  }

  await login(page);

  const wiring = await page.evaluate(() => {
    const menu = document.getElementById('dataMgmtMenu');
    const forecastBtn = menu && menu.querySelector('[data-dm-action="export-forecast-90-csv"]');
    const closedBtn = menu && menu.querySelector('[data-dm-action="export-closed-30-csv"]');
    return {
      menuExists: !!menu,
      forecastBtn: !!forecastBtn,
      closedBtn: !!closedBtn,
      forecastText: forecastBtn ? forecastBtn.textContent.trim() : '',
      closedText: closedBtn ? closedBtn.textContent.trim() : '',
      menuParent: menu ? menu.parentElement && menu.parentElement.tagName : null,
    };
  });
  console.log('=== BEKÖTÉS (DOM) ===');
  console.log(JSON.stringify(wiring, null, 2));

  const apiProbe = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/rent/inquiries');
      const d = await r.json();
      const list = d && d.inquiries ? d.inquiries : [];
      const today = new Date();
      const iso = (dt) => {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const day = String(dt.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };
      const addDays = (base, n) => {
        const p = base.split('-').map(Number);
        const dt = new Date(p[0], p[1] - 1, p[2]);
        dt.setDate(dt.getDate() + n);
        return iso(dt);
      };
      const t = iso(today);
      const end90 = addDays(t, 90);
      const start30 = addDays(t, -30);
      let fc = 0;
      let cl = 0;
      list.forEach((b) => {
        const d = String(b.event_date || b.date || '').slice(0, 10);
        if (d && d >= t && d <= end90) fc++;
        if (d && d >= start30 && d < t && String(b.status || '').toUpperCase() !== 'LEMONDVA') cl++;
      });
      return { ok: r.ok, total: list.length, forecastRange: fc, closedRange: cl };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log('=== API ADAT ===');
  console.log(JSON.stringify(apiProbe, null, 2));

  console.log('\n=== EXPORT #1: 90 napos ===');
  const r1 = await testExport(page, 'export-forecast-90-csv', 'CSV_EXPORT_FORECAST_START', 'forecast90');
  console.log(JSON.stringify(r1, null, 2));

  const page2 = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await page2.goto(`${BASE}/rent/admin?v=csv-debug2`, { waitUntil: 'domcontentloaded' });
  await login(page2);

  console.log('\n=== EXPORT #2: Lezárt 30 nap ===');
  const r2 = await testExport(page2, 'export-closed-30-csv', 'CSV_EXPORT_CLOSED_START', 'closed30');
  console.log(JSON.stringify(r2, null, 2));

  await browser.close();

  console.log('\n=== ÖSSZEGZÉS ===');
  const summarize = (r) => {
    if (r.pass === true) return `PASS – ${r.label}: menü → függvény → letöltés (${r.filename})`;
    if (r.pass === 'PARTIAL') return `PARTIAL – ${r.label}: menü → függvény OK, letöltés nincs (${r.detail})`;
    return `FAIL – ${r.label}: ${r.failAt} – ${r.detail}`;
  };
  console.log(summarize(r1));
  console.log(summarize(r2));

  const exitOk = (r1.pass === true || r1.pass === 'PARTIAL') && (r2.pass === true || r2.pass === 'PARTIAL');
  process.exit(exitOk ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: teszt futás', e);
  process.exit(1);
});
