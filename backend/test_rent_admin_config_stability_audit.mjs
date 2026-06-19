/**
 * CONFIG stabilítási audit – 10 egymás utáni hard refresh (Ctrl+F5 szimuláció)
 * node test_rent_admin_config_stability_audit.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium;
for (const p of [
  path.join(__dirname, 'node_modules', 'playwright'),
  path.join(__dirname, '..', 'frontend', 'public', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
if (!chromium) { console.error('Playwright missing'); process.exit(2); }

const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';
const RUNS = parseInt(process.env.CONFIG_AUDIT_RUNS || '10', 10);
const OUT_DIR = path.join(__dirname, 'test-output');
const OUT_JSON = path.join(OUT_DIR, 'config_stability_audit.json');
const OUT_MD = path.join(OUT_DIR, 'config_stability_audit.md');

function parseConfigLog(text) {
  const get = (key) => {
    const m = text.match(new RegExp('^' + key + '=(.+)$', 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    path: get('path'),
    status: get('status'),
    vehicles: parseInt(get('vehicles'), 10),
    drivers: parseInt(get('drivers'), 10),
    via: get('via'),
    api_base: get('api_base'),
  };
}

async function launchBrowser() {
  try { return await chromium.launch({ headless: true }); }
  catch (_) { return chromium.launch({ channel: 'msedge', headless: true }); }
}

async function runHardRefreshSeries(label, opts) {
  const {
    disableSw = true,
    localStorageRsvApiBase = null,
    keepLoggedIn = false,
  } = opts;

  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  if (disableSw) {
    await page.addInitScript(function () {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          regs.forEach(function (r) { r.unregister(); });
        });
      }
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) {
          keys.forEach(function (k) { caches.delete(k); });
        });
      }
    });
  }

  const configTimings = [];
  page.on('request', function (req) {
    if (req.url().indexOf('/api/config') >= 0) {
      req.__t0 = Date.now();
    }
  });
  page.on('response', async function (res) {
    const req = res.request();
    if (req.url().indexOf('/api/config') >= 0 && req.__t0) {
      configTimings.push({
        url: req.url(),
        ms: Date.now() - req.__t0,
        status: res.status(),
        fromServiceWorker: res.fromServiceWorker ? res.fromServiceWorker() : false,
      });
    }
  });

  const rows = [];
  let loggedIn = false;

  for (let i = 1; i <= RUNS; i += 1) {
    const configLogs = [];
    const consoleOrder = [];
    const handler = (msg) => {
      const t = msg.text();
      if (t.indexOf('[CONFIG SOURCE]') >= 0) configLogs.push(t);
      if (t.indexOf('[CONFIG SOURCE]') >= 0 || t.indexOf('renderResourceSuggestions') >= 0) {
        consoleOrder.push({ at: Date.now(), text: t.slice(0, 120) });
      }
    };
    page.on('console', handler);

    const navStart = Date.now();
    const url = BASE + '/rent/admin?audit=' + label + '&run=' + i + '&t=' + Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (localStorageRsvApiBase !== null) {
      await page.evaluate(function (v) {
        if (v === '') localStorage.removeItem('rsv_api_base');
        else localStorage.setItem('rsv_api_base', v);
      }, localStorageRsvApiBase);
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    if (!loggedIn || !keepLoggedIn) {
      const gateVisible = await page.locator('#admin-login-gate:not([hidden])').isVisible().catch(function () { return false; });
      if (gateVisible) {
        await page.selectOption('#admin-login-user', { label: 'Admin' });
        await page.fill('#admin-login-pin', 'kisvonat');
        await page.locator('#admin-login-form button[type="submit"]').click();
      }
      loggedIn = true;
    }

    await page.waitForFunction(function () {
      var el = document.getElementById('admin-debug-banner');
      if (!el) return false;
      var t = el.textContent || '';
      return t.indexOf('(ok)') >= 0 || t.indexOf('(fail)') >= 0;
    }, { timeout: 25000 });

    const snapshot = await page.evaluate(function () {
      var banner = document.getElementById('admin-debug-banner');
      var text = banner ? banner.textContent : '';
      var veh = (text.match(/vehicles=(\d+)/) || [])[1];
      var drv = (text.match(/drivers=(\d+)/) || [])[1];
      var status = (text.match(/\((ok|fail|loading|pending)\)/) || [])[1] || '';
      var api = (text.match(/API:\s*([^\|]+)/) || [])[1];
      var stored = '';
      try { stored = localStorage.getItem('rsv_api_base') || ''; } catch (e) {}
      var sw = '';
      try {
        sw = navigator.serviceWorker && navigator.serviceWorker.controller
          ? (navigator.serviceWorker.controller.scriptURL || 'active')
          : 'none';
      } catch (e2) { sw = 'err'; }
      return {
        banner: text.trim(),
        title: banner ? banner.title : '',
        vehicles: veh ? parseInt(veh, 10) : -1,
        drivers: drv ? parseInt(drv, 10) : -1,
        status: status,
        apiBanner: api ? api.trim() : '',
        rsv_api_base: stored,
        swController: sw,
      };
    });

    const log = configLogs.length ? parseConfigLog(configLogs[configLogs.length - 1]) : null;
    const timing = configTimings.length ? configTimings[configTimings.length - 1] : null;

    rows.push({
      run: i,
      label: label,
      elapsedMs: Date.now() - navStart,
      banner: snapshot.banner,
      bannerTitle: snapshot.title,
      vehicles: snapshot.vehicles,
      drivers: snapshot.drivers,
      status: snapshot.status,
      apiBanner: snapshot.apiBanner,
      rsv_api_base: snapshot.rsv_api_base,
      swController: snapshot.swController,
      configSource: log,
      configFetchMs: timing ? timing.ms : null,
      configFetchStatus: timing ? timing.status : null,
      configFromSw: timing ? timing.fromServiceWorker : null,
    });

    page.off('console', handler);

    if (i < RUNS) {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  }

  await browser.close();
  return rows;
}

async function probeApiConfigDirect() {
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/config', { headers: { Accept: 'application/json' } });
  const ms = Date.now() - t0;
  const data = await res.json();
  return {
    ms,
    status: res.status,
    vehicles: Array.isArray(data.vehicles) ? data.vehicles.length : 0,
    drivers: Array.isArray(data.drivers) ? data.drivers.length : 0,
    ok: !!data.ok,
  };
}

async function main() {
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || !health.ok) {
    console.error('Backend down at', BASE);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('=== CONFIG STABILITÁSI AUDIT ===');
  console.log('BASE:', BASE, '| runs:', RUNS);

  const direct = await probeApiConfigDirect();
  console.log('\nDirect GET /api/config:', direct);

  console.log('\n--- Sorozat A: 10x hard refresh, SW off, tiszta localStorage ---');
  const seriesA = await runHardRefreshSeries('A-clean', {
    disableSw: true,
    localStorageRsvApiBase: '',
  });

  console.log('\n--- Sorozat B: 10x hard refresh, SW engedélyezve ---');
  const seriesB = await runHardRefreshSeries('B-sw-on', {
    disableSw: false,
  });

  console.log('\n--- Sorozat C: 1x rossz localStorage.rsv_api_base (versenyhelyzet repro) ---');
  const seriesC = await runHardRefreshSeries('C-bad-ls', {
    disableSw: true,
    localStorageRsvApiBase: 'http://localhost:3999',
    keepLoggedIn: false,
  });
  seriesC.splice(1);

  const allSeries = [
    { name: 'A-clean (10x Ctrl+F5, SW off)', rows: seriesA },
    { name: 'B-sw-on (10x Ctrl+F5, SW on)', rows: seriesB },
    { name: 'C-bad-ls (rossz rsv_api_base)', rows: seriesC },
  ];

  function summarize(rows) {
    const zeros = rows.filter(function (r) { return r.vehicles === 0 || r.drivers === 0; });
    const ok20 = rows.filter(function (r) { return r.vehicles === 20 && r.drivers === 20 && r.status === 'ok'; });
    return {
      total: rows.length,
      ok20: ok20.length,
      anyZero: zeros.length,
      zeroRuns: zeros.map(function (r) { return r.run; }),
    };
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    runsPerSeries: RUNS,
    directApiConfig: direct,
    series: allSeries.map(function (s) {
      return { name: s.name, summary: summarize(s.rows), rows: s.rows };
    }),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

  let md = '# CONFIG stabilítási audit\n\n';
  md += '- Időpont: ' + report.at + '\n';
  md += '- BASE: `' + BASE + '`\n';
  md += '- Direct `/api/config`: ' + direct.vehicles + ' vehicles, ' + direct.drivers + ' drivers, ' + direct.ms + ' ms\n\n';

  for (const s of report.series) {
    const sum = s.summary;
    md += '## ' + s.name + '\n\n';
    md += '| Run | vehicles | drivers | status | API (banner) | CONFIG via | /api/config ms | rsv_api_base |\n';
    md += '|-----|----------|---------|--------|--------------|------------|----------------|-------------|\n';
    for (const r of s.rows) {
      md += '| ' + r.run + ' | ' + r.vehicles + ' | ' + r.drivers + ' | ' + r.status + ' | '
        + (r.apiBanner || '—') + ' | '
        + (r.configSource ? r.configSource.via : '—') + ' | '
        + (r.configFetchMs != null ? r.configFetchMs : '—') + ' | '
        + (r.rsv_api_base || '(üres)') + ' |\n';
    }
    md += '\n**Eredmény:** ' + sum.ok20 + '/' + sum.total + ' × vehicles=20, drivers=20 (ok)\n';
    if (sum.anyZero) {
      md += '**FIGYELEM:** vehicles=0 vagy drivers=0 előfordult: run ' + sum.zeroRuns.join(', ') + '\n';
    } else {
      md += '**Nincs 0/0 állapot a végleges bannerben.**\n';
    }
    md += '\n';
  }

  md += '## Vizsgált mechanizmusok\n\n';
  md += '- `localStorage.rsv_api_base`: API_BASE feloldás; a **config fetch** `adminApiUrl()` → same-origin `/api/config`\n';
  md += '- `resolveRentApiBase()`: bannerben látszik (API: …); localhoston → `http://localhost:3000`\n';
  md += '- Service Worker: sorozat B-ben aktív; HTML cache nem érinti `/api/config` (network-first)\n';
  md += '- `loadFleetConfig()`: primary `/api/config` → fallback `/api/vehicles` + `/api/drivers`\n';
  md += '- Render sorrend: `bootApplication()` → `loadFleetConfig().finally()` → bookings → `render()`\n';

  fs.writeFileSync(OUT_MD, md);

  console.log('\n=== ÖSSZEFOGLALÓ ===');
  for (const s of report.series) {
    const sum = s.summary;
    console.log(sum.ok20 + '/' + sum.total + ' OK | ' + s.name
      + (sum.anyZero ? ' | ZERO runs: ' + sum.zeroRuns.join(',') : ''));
  }
  console.log('\nJSON:', OUT_JSON);
  console.log('MD:', OUT_MD);

  const primaryOk = report.series[0].summary.ok20 === RUNS && report.series[0].summary.anyZero === 0;
  process.exit(primaryOk ? 0 : 1);
}

main().catch(function (err) {
  console.error(err);
  process.exit(2);
});
