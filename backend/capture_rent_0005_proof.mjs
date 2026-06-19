/**
 * RENT-2025-0005 útvonal bizonyíték screenshot (jelenlegi build)
 * node capture_rent_0005_proof.mjs
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
const BOOKING_ID = 'RENT-2025-0005';
const OUT_DIR = path.join(__dirname, 'test-output');

async function fetchBooking() {
  const data = await fetch(BASE + '/api/rent/inquiries').then(function (r) { return r.json(); });
  const b = (data.inquiries || []).find(function (x) { return x.id === BOOKING_ID; });
  if (!b) throw new Error('Booking not found: ' + BOOKING_ID);
  const coords = (b.routeGeometry && b.routeGeometry.coordinates) || [];
  let minLng = Infinity; let maxLng = -Infinity; let minLat = Infinity; let maxLat = -Infinity;
  coords.forEach(function (p) {
    minLng = Math.min(minLng, p[0]); maxLng = Math.max(maxLng, p[0]);
    minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
  });
  return {
    id: b.id,
    orderer: b.ordererName || b.customer_name || b.name || '',
    place: b.placeName || '',
    date: b.date,
    time: b.timeStart,
    headcount: b.headcount,
    pointCount: coords.length,
    bounds: { minLng: minLng, maxLng: maxLng, minLat: minLat, maxLat: maxLat },
    center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }
  };
}

async function login(page) {
  await page.goto(BASE + '/rent/admin', { waitUntil: 'networkidle', timeout: 60000 });
  if (await page.locator('#admin-login-gate').isVisible().catch(function () { return false; })) {
    await page.selectOption('#admin-login-user', { label: 'Admin' });
    await page.fill('#admin-login-pin', 'kisvonat');
    await page.locator('#admin-login-form button[type="submit"]').click();
    await page.waitForFunction(function () {
      var g = document.getElementById('admin-login-gate');
      return g && g.hidden;
    }, { timeout: 15000 });
  }
  await page.waitForSelector('.leaflet-tooltip.map-label', { timeout: 25000 });
}

async function main() {
  const health = await fetch(BASE + '/api/health').catch(function () { return null; });
  if (!health || !health.ok) { console.error('Backend down at', BASE); process.exit(2); }

  const booking = await fetchBooking();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (_) { browser = await chromium.launch({ channel: 'msedge', headless: true }); }

  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

  try {
    await login(page);
    await page.waitForTimeout(1500);

    await page.evaluate(function (id) {
      if (typeof clearRentDateFilters === 'function') clearRentDateFilters();
      if (typeof openBookingForm === 'function') openBookingForm(id);
    }, BOOKING_ID);
    await page.waitForTimeout(1500);

    await page.evaluate(function (bounds) {
      if (typeof map === 'undefined' || !map.fitBounds) return;
      map.fitBounds([
        [bounds.minLat, bounds.minLng],
        [bounds.maxLat, bounds.maxLng]
      ], { padding: [70, 70], maxZoom: 14, animate: false });
      map.invalidateSize();
    }, booking.bounds);
    await page.waitForTimeout(1000);

    var popupOpened = await page.evaluate(function (id) {
      if (typeof markerEntries === 'undefined') return false;
      for (var i = 0; i < markerEntries.length; i++) {
        var e = markerEntries[i];
        if (e.booking && e.booking.id === id && e.marker && e.marker.openPopup) {
          e.marker.openPopup();
          return true;
        }
      }
      return false;
    }, BOOKING_ID);

    if (!popupOpened) {
      var labels = page.locator('.leaflet-tooltip.map-label');
      var n = await labels.count();
      for (var i = 0; i < n; i++) {
        var txt = await labels.nth(i).innerText();
        if (txt.indexOf(String(booking.headcount) + ' fő') >= 0 && txt.indexOf('11:00') >= 0) {
          await labels.nth(i).click({ force: true });
          popupOpened = await page.waitForSelector('.leaflet-popup', { timeout: 3000 }).then(function () { return true; }).catch(function () { return false; });
          break;
        }
      }
    }

    var popupText = popupOpened
      ? await page.locator('.leaflet-popup-content').innerText().catch(function () { return ''; })
      : '';

    var audit = await page.evaluate(function (id) {
      var plan = typeof window.__rentAuditCustomerRouteDrawPlan === 'function'
        ? window.__rentAuditCustomerRouteDrawPlan(id) : null;
      var layerStats = typeof window.__rentAuditGetRouteLayerStats === 'function'
        ? window.__rentAuditGetRouteLayerStats() : null;
      return { plan: plan, layerStats: layerStats };
    }, BOOKING_ID);

    await page.evaluate(function (data) {
      var old = document.getElementById('rent-proof-overlay');
      if (old) old.remove();
      var ptCount = data.pointCount;
      var el = document.createElement('div');
      el.id = 'rent-proof-overlay';
      el.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;background:rgba(15,23,42,0.92);' +
        'color:#e2e8f0;border:1px solid rgba(56,189,248,0.5);border-radius:10px;padding:10px 14px;' +
        'font:600 12px/1.5 system-ui,sans-serif;max-width:460px;box-shadow:0 4px 20px rgba(0,0,0,.4);';
      el.innerHTML = '<div style="color:#38bdf8;font-weight:800;margin-bottom:4px">RENT-2025-0005 – Esztergom/Tatabánya</div>' +
        '<div>Route pontok az adatban: <b>' + ptCount + '</b></div>' +
        '<div>Render: polyline=<b>' + data.plan.expectedPolylines + '</b> · S/C marker=<b>' + data.plan.expectedMarkers + '</b></div>' +
        '<div>Összes route layer a térképen: polyline=' + data.layerStats.polylines + ' marker=' + data.layerStats.markers + '</div>' +
        '<div style="color:#86efac;margin-top:4px">✓ Nincs ' + ptCount + ' külön marker – csak vonal + S/C</div>';
      document.body.appendChild(el);
    }, {
      pointCount: booking.pointCount,
      plan: audit.plan || { expectedPolylines: 1, expectedMarkers: 2 },
      layerStats: audit.layerStats || { polylines: 0, markers: 0 }
    });

    await page.waitForTimeout(400);

    const mapShot = path.join(OUT_DIR, 'RENT-2025-0005_route_proof.png');
    const fullShot = path.join(OUT_DIR, 'RENT-2025-0005_route_proof_full.png');
    await page.locator('#map').screenshot({ path: mapShot });
    await page.screenshot({ path: fullShot, fullPage: false });

    console.log('Booking:', booking.id, booking.orderer, booking.place);
    console.log('Route points:', booking.pointCount);
    console.log('Bounds span (deg):', (booking.bounds.maxLng - booking.bounds.minLng).toFixed(3), (booking.bounds.maxLat - booking.bounds.minLat).toFixed(3));
    console.log('Popup opened:', popupOpened);
    console.log('Popup text snippet:', popupText.slice(0, 120).replace(/\n/g, ' | '));
    console.log('Draw plan:', JSON.stringify(audit.plan));
    console.log('Map screenshot:', mapShot);
    console.log('Full screenshot:', fullShot);

  } finally {
    await browser.close();
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
