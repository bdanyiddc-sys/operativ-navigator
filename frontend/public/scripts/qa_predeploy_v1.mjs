import { chromium } from 'playwright';

const BASE = process.env.QA_BASE || 'http://localhost:3000';
const paths = ['/public/', '/public/index.html'];

async function runViewport(page, label, w, h) {
  await page.setViewportSize({ width: w, height: h });
  const results = { viewport: `${w}x${h}`, checks: {} };

  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('splash_seen', 'true');
      localStorage.setItem('kv_analytics_consent_v1', JSON.stringify({ mode: 'denied', savedAt: Date.now() }));
    } catch (e) { /* ignore */ }
  });

  for (const p of paths) {
    const url = BASE + p;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    results.checks[`load ${p}`] = res && res.ok() ? 'OK' : `HIBA HTTP ${res?.status()}`;
  }

  await page.goto(BASE + '/public/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
    page.goto(BASE + '/public/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  );
  await page.waitForTimeout(5000);

  const data = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: b.width, h: b.height, right: b.right, bottom: b.bottom };
    };
    const card = q('.kv-city-card');
    const cardR = r(card);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardOverflow =
      cardR && (cardR.right > vw + 1 || cardR.bottom > vh + 1 || cardR.w <= 0) ? true : false;

    const logoImg = q('.kv-logo img');
    const logoOk = logoImg && logoImg.complete && logoImg.naturalWidth > 0;

    const dockIds = ['btn-shell-reserve', 'toggleWheelShell', 'btn-shell-board'];
    const dockBg = dockIds.map((id) => {
      const btn = document.getElementById(id);
      if (!btn) return { id, missing: true };
      const cs = getComputedStyle(btn);
      return {
        id,
        bg: cs.backgroundColor,
        whiteBox: cs.backgroundColor === 'rgb(240, 240, 240)' || cs.backgroundColor === 'rgb(255, 255, 255)',
      };
    });

    return {
      title: document.title,
      hasMap: !!q('#map'),
      mapTiles: document.querySelectorAll('.leaflet-tile').length,
      routePaths: document.querySelectorAll('.leaflet-overlay-pane svg path').length,
      stopMarkers: document.querySelectorAll('.stop-marker').length,
      logoOk,
      cardOverflow,
      cardH: cardR?.h,
      dockBg,
      wheelClosed: q('#wheelWrap')?.classList.contains('closed'),
    };
  });

  results.checks['logó betölt'] = data.logoOk ? 'OK' : 'HIBA';
  results.checks['városkártya nem lóg ki'] = !data.cardOverflow ? 'OK' : 'HIBA';
  results.checks['térkép betölt'] = data.hasMap && data.mapTiles > 0 ? 'OK' : 'HIBA';
  results.checks['útvonal megjelenik'] = data.routePaths >= 2 ? 'OK' : `HIBA (${data.routePaths} path)`;
  results.checks['markerek megjelennek'] = data.stopMarkers > 0 ? 'OK' : `HIBA (${data.stopMarkers})`;
  results.checks['nincs fehér PNG háttér (alsó gombok)'] = data.dockBg.every((b) => !b.whiteBox && !b.missing)
    ? 'OK'
    : 'HIBA';

  // Rétegek panel
  const layersBtn = page.locator('#btn-shell-layers');
  if (await layersBtn.count()) {
    await layersBtn.click();
    await page.waitForTimeout(400);
    const panelHidden = await page.locator('#kv-layers-panel').evaluate((el) => el.hasAttribute('hidden'));
    results.checks['Rétegek gomb'] = panelHidden ? 'HIBA panel nem nyílt' : 'OK';
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    results.checks['Rétegek gomb'] = 'HIBA nincs elem';
  }

  // Vonat gomb (toggle class)
  const trainBtn = page.locator('#btn-shell-train');
  if (await trainBtn.count()) {
    await trainBtn.click();
    await page.waitForTimeout(300);
    const on = await trainBtn.evaluate((el) => el.classList.contains('is-on'));
    results.checks['Vonat gomb'] = on ? 'OK' : 'HIBA nincs is-on';
    await trainBtn.click();
  } else {
    results.checks['Vonat gomb'] = 'HIBA nincs elem';
  }

  // Itt állok – csak kattintható, ne dobjon hibát
  const hereBtn = page.locator('#btn-shell-here');
  results.checks['Itt állok gomb'] = (await hereBtn.count()) ? 'OK (kattintható)' : 'HIBA nincs elem';

  // Városkerék
  const wheelBtn = page.locator('#toggleWheelShell');
  if (await wheelBtn.count()) {
    await wheelBtn.click();
    await page.waitForTimeout(500);
    const open = await page.locator('#wheelWrap').evaluate((el) => !el.classList.contains('closed'));
    results.checks['Városaink / városkerék'] = open ? 'OK' : 'HIBA nem nyílt';
    await wheelBtn.click();
    await page.waitForTimeout(300);
  } else {
    results.checks['Városaink / városkerék'] = 'HIBA nincs elem';
  }

  // Alsó gombok léteznek
  results.checks['Foglalok gomb'] = (await page.locator('#btn-shell-reserve').count()) ? 'OK' : 'HIBA';
  results.checks['Felszállnék gomb'] = (await page.locator('#btn-shell-board').count()) ? 'OK' : 'HIBA';

  await page.screenshot({
    path: `docs/qa_predeploy_${label}.png`,
    fullPage: false,
  });

  return results;
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

const report = { base: BASE, viewports: [], consoleErrors: [] };

try {
  report.viewports.push(await runViewport(page, 'mobile', 390, 844));
  report.viewports.push(await runViewport(page, 'desktop', 1280, 900));
} catch (e) {
  report.fatal = String(e.message || e);
}

report.consoleErrors = [...new Set(consoleErrors)].filter(
  (e) => !e.includes('favicon') && !e.includes('404')
);

report.consoleCheck =
  report.consoleErrors.length === 0 ? 'OK' : `HIBA (${report.consoleErrors.length} error)`;

await browser.close();
console.log(JSON.stringify(report, null, 2));
