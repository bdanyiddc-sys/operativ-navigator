/**
 * Rent admin stabilizálás V3 audit
 * node test_rent_admin_audit_v3.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium;
for (const p of [
  path.join(__dirname, '..', 'node_modules', 'playwright'),
  path.join(__dirname, '..', '..', 'frontend', 'public', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
if (!chromium) { console.error('Playwright missing'); process.exit(2); }

const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '..', 'test-output');
const results = { A: [], B: [], C: [], D: [] };

function record(block, name, pass, detail) {
  results[block].push({ name, pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + ' [' + block + '] ' + name + (detail ? ' – ' + detail : ''));
}

async function login(page) {
  await page.goto(BASE + '/rent/admin', { waitUntil: 'networkidle', timeout: 60000 });
  if (await page.locator('#admin-login-gate').isVisible().catch(() => false)) {
    await page.selectOption('#admin-login-user', { label: 'Admin' });
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.locator('#admin-login-form button[type="submit"]').click();
    await page.waitForFunction(function () {
      var g = document.getElementById('admin-login-gate');
      return g && g.hidden;
    }, { timeout: 15000 });
  }
  await page.waitForSelector('#admin-debug-banner', { timeout: 20000 });
}

async function openBookingViaMap(page, index) {
  index = index || 0;
  const labels = page.locator('.leaflet-tooltip.map-label');
  await labels.nth(index).click({ force: true });
  await page.waitForSelector('.leaflet-popup', { timeout: 8000 });
  await page.locator('.popup-open-form').click();
  await page.waitForFunction(function () {
    return document.getElementById('editId') && document.getElementById('editId').value;
  }, { timeout: 10000 });
  return page.inputValue('#editId');
}

async function main() {
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || !health.ok) { console.error('Backend down'); process.exit(2); }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (_) { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const configLogs = [];
  const routeLogs = [];
  page.on('console', function (msg) {
    const t = msg.text();
    if (t.indexOf('[CONFIG SOURCE]') >= 0) configLogs.push(t);
    if (t.indexOf('[ROUTE TARGET]') >= 0) routeLogs.push(t);
  });

  try {
    await login(page);
    await page.waitForTimeout(2000);

    const banner = await page.locator('#admin-debug-banner').innerText();
    const cfgMatch = banner.match(/CONFIG: vehicles=(\d+), drivers=(\d+)/);
    const vehCount = cfgMatch ? parseInt(cfgMatch[1], 10) : -1;
    const drvCount = cfgMatch ? parseInt(cfgMatch[2], 10) : -1;
    record('B', 'debug banner not hardcoded fallback (6/0)', !(vehCount === 6 && drvCount === 0),
      'vehicles=' + vehCount + ' drivers=' + drvCount);
    record('B', 'CONFIG SOURCE console log emitted', configLogs.length > 0,
      configLogs[0] ? configLogs[0].replace(/\n/g, ' ') : 'none');

    const apiCfg = await fetch(BASE + '/api/config').then(function (r) { return r.json(); });
    record('B', 'server /api/config has drivers', (apiCfg.drivers || []).length > 0,
      'server drivers=' + (apiCfg.drivers || []).length);
    record('B', 'frontend driver count matches server', drvCount === (apiCfg.drivers || []).length,
      'frontend=' + drvCount + ' server=' + (apiCfg.drivers || []).length);

    await openBookingViaMap(page, 0);
    await page.locator('.form-tab[data-form-tab="resources"]').click();
    await page.waitForTimeout(500);
    const drvHint = await page.locator('#driverSuggestList .hint').count();
    const drvChips = await page.locator('#driverSuggestList .suggest-chip').count();
    const vehChips = await page.locator('#vehicleSuggestList .suggest-chip').count();
    record('C', 'resources tab shows vehicle chips', vehChips > 0, 'chips=' + vehChips);
    record('C', 'resources tab shows driver chips', drvChips > 0 && drvHint === 0,
      'driver chips=' + drvChips + ' hint=' + drvHint);

    const routeOptions = await page.evaluate(function () {
      var sel = document.getElementById('routeBookingId');
      if (!sel) return [];
      return Array.from(sel.options).map(function (o) { return o.value; }).filter(function (v) {
        return v && v !== '__ROUTE_DRAFT__';
      });
    });

    if (routeOptions.length >= 2) {
      await openBookingViaMap(page, 0);
      const idA = await page.inputValue('#editId');
      const idB = routeOptions.find(function (id) { return id !== idA; }) || routeOptions[1];
      await page.locator('.main-nav-btn[data-main-module="routes"]').click();
      await page.waitForTimeout(300);
      await page.selectOption('#routeBookingId', idB);
      await page.waitForTimeout(200);
      const editBeforeCalc = await page.inputValue('#editId');
      await page.locator('#btnCalcRoute').click();
      await page.waitForTimeout(3000);
      const lastRouteLog = routeLogs.length ? routeLogs[routeLogs.length - 1] : '';
      record('A', 'ROUTE TARGET log uses dropdown id (not stale editId)',
        lastRouteLog.indexOf('bookingId=' + idB) >= 0,
        'dropdown=' + idB + ' editId=' + editBeforeCalc + ' log=' + lastRouteLog.replace(/\n/g, ' | '));
      record('A', 'editId may differ from route target (expected)',
        editBeforeCalc === idA,
        'editId=' + editBeforeCalc + ' target=' + idB);
    } else {
      record('A', 'route target test needs 2 geo bookings', false, 'found=' + routeOptions.length);
    }

    const heavyId = await fetch(BASE + '/api/rent/inquiries').then(function (r) { return r.json(); }).then(function (d) {
      var hit = (d.inquiries || []).find(function (b) {
        var n = 0;
        if (b.routeGeometry && b.routeGeometry.coordinates) n = b.routeGeometry.coordinates.length;
        else if (b.routePoints) n = b.routePoints.length;
        return n >= 300;
      });
      return hit ? { id: hit.id, pts: (hit.routeGeometry && hit.routeGeometry.coordinates ? hit.routeGeometry.coordinates.length : 0) } : null;
    });

    if (heavyId) {
      await page.evaluate(function (id) {
        if (typeof openBookingForm === 'function') openBookingForm(id);
      }, heavyId.id);
      await page.waitForTimeout(2500);
      const mapStats = await page.evaluate(function () {
        return typeof window.__rentAuditGetRouteLayerStats === 'function'
          ? window.__rentAuditGetRouteLayerStats()
          : { polylines: -1, markers: -1, layers: -1 };
      });
      const shotPath = path.join(OUT_DIR, 'audit_338_route.png');
      await page.locator('#map').screenshot({ path: shotPath });
      const drawPlan = await page.evaluate(function (id) {
        return typeof window.__rentAuditCustomerRouteDrawPlan === 'function'
          ? window.__rentAuditCustomerRouteDrawPlan(id)
          : null;
      }, heavyId.id);
      record('D', '959-pt booking draw plan (1 polyline, 2 markers)', drawPlan &&
        drawPlan.pointCount >= 300 &&
        drawPlan.expectedPolylines === 1 &&
        drawPlan.expectedMarkers === 2 &&
        drawPlan.showPointMarkers === false,
        drawPlan ? JSON.stringify(drawPlan) : 'null');
      record('D', '959-pt booking not 300+ point markers', mapStats.markers < 50,
        'markers=' + mapStats.markers + ' totalLayers=' + mapStats.layers);
      record('D', 'map screenshot saved', fs.existsSync(shotPath), shotPath);
    } else {
      record('D', '300+ point booking on server', false, 'none');
    }

  } catch (err) {
    record('A', 'harness', false, err.message);
  } finally {
    await browser.close();
  }

  console.log('\n=== AUDIT V3 SUMMARY ===');
  ['A', 'B', 'C', 'D'].forEach(function (block) {
    var rows = results[block];
    var ok = rows.filter(function (r) { return r.pass; }).length;
    console.log(block + ': ' + ok + '/' + rows.length + ' PASS');
  });
  const allPass = ['A', 'B', 'C', 'D'].every(function (b) {
    return results[b].every(function (r) { return r.pass; });
  });
  process.exit(allPass ? 0 : 1);
}

main();
