/**
 * CSV export bizonyítás – API + ugyanaz a logika mint admin.html
 * node verify_csv_exports.mjs
 */
const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';
const DEFAULT_PENDING = 'FÜGGŐ';

function todayIso() {
  const d = new Date();
  return isoFromDate(d);
}
function isoFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDaysIso(baseIso, days) {
  const p = baseIso.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + days);
  return isoFromDate(d);
}
function isPendingAssign(val) {
  const v = String(val || '').trim().toUpperCase();
  return !v || v === DEFAULT_PENDING;
}
function normalizeStatus(s) {
  const v = String(s || '').trim().toUpperCase();
  return v || 'ARAJANLATKERES';
}
function resolveBookingHeadcount(b) {
  if (!b) return null;
  for (const key of ['headcount', 'passenger_count', 'passengerCount', 'people', 'passengers', 'letszam']) {
    const v = b[key];
    if (v == null || v === '') continue;
    const n = parseInt(v, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return null;
}
function reportInquiryDate(b) {
  return String(b.event_date || b.date || '').trim().slice(0, 10);
}
function reportInquiryVehicle(b) {
  const v = String(b.vehicle || b.vehicle_id || '').trim();
  if (!v || isPendingAssign(v)) return '';
  return v.toUpperCase();
}
function reportInquiryPriceNum(b) {
  if (b.price == null || b.price === '') return null;
  const n = Number(b.price);
  return isFinite(n) ? Math.round(n) : null;
}
function reportInquiryPaymentLabel(b) {
  const raw = String(b.paymentStatus || b.payment_status || b.fizetesStatus || b.fizetes_status || '').trim();
  if (!raw) return '';
  const u = raw.toUpperCase();
  if (/TELJES|FIZETVE|PAID|TELJESEN/.test(u)) return 'Fizetve';
  if (/ELŐLEG|ELOLEG|DEPOSIT|ADVANCE/.test(u)) return 'Előleg';
  if (/RÉSZ|RESZ|PARTIAL/.test(u)) return 'Részben fizetett';
  if (/NYITOTT|OPEN|NINCS/.test(u)) return 'Nyitott';
  return raw;
}
function reportInquiryStatusLabel(b) {
  const labels = {
    ARAJANLATKERES: 'Árajánlatkérés', AJANLAT_KIKULDVE: 'Ajánlat kiküldve', VARAKOZIK: 'Várakozik',
    MEGRENDELVE: 'Megrendelve', LEMONDVA: 'Lemondva', TELJESITVE: 'Teljesítve',
  };
  const s = String(b.status || 'ARAJANLATKERES').trim().toUpperCase();
  return labels[s] || s;
}
function reportInquiryRow(b, dayTotals) {
  const totals = dayTotals || {};
  const hc = resolveBookingHeadcount(b);
  const pr = reportInquiryPriceNum(b);
  return [
    reportInquiryDate(b), String(b.city || '').trim(), reportInquiryVehicle(b),
    hc == null ? '' : String(hc), pr == null ? '' : String(pr),
    reportInquiryStatusLabel(b), reportInquiryPaymentLabel(b),
    totals.isLast ? (totals.hasHc ? String(totals.sumHc) : '') : '',
    totals.isLast ? (totals.hasPrice ? String(totals.sumPrice) : '') : '',
  ].join(';');
}
function buildDailyReportCsvLines(inquiries) {
  const byDate = {};
  inquiries.forEach((b) => {
    const d = reportInquiryDate(b);
    if (!d) return;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(b);
  });
  const dates = Object.keys(byDate).sort();
  const lines = ['DÁTUM;VÁROS;VONAT;UTAS_FŐ;ÁR;ÁLLAPOT;FIZETÉSI_ÁLLAPOT;ÖSSZESEN_FŐ;ÖSSZESEN_ÁR'];
  dates.forEach((d) => {
    const dayRows = byDate[d].slice().sort((a, b) => String(a.city || '').localeCompare(String(b.city || ''), 'hu'));
    let sumHc = 0, sumPrice = 0, hasHc = false, hasPrice = false;
    dayRows.forEach((b) => {
      const hc = resolveBookingHeadcount(b);
      if (hc != null) { sumHc += hc; hasHc = true; }
      const pr = reportInquiryPriceNum(b);
      if (pr != null) { sumPrice += pr; hasPrice = true; }
    });
    dayRows.forEach((b, idx) => {
      lines.push(reportInquiryRow(b, { isLast: idx === dayRows.length - 1, sumHc, sumPrice, hasHc, hasPrice }));
    });
  });
  return lines;
}

const today = todayIso();
const resp = await fetch(`${BASE}/api/rent/inquiries`);
const data = await resp.json();
if (!resp.ok || !data.ok) {
  console.error('FAIL: API', data);
  process.exit(1);
}
const inquiries = data.inquiries;

const end90 = addDaysIso(today, 90);
const start30 = addDaysIso(today, -30);

const forecast = inquiries.filter((b) => {
  const d = reportInquiryDate(b);
  if (!d || d < today || d > end90) return false;
  return normalizeStatus(b.status) !== 'LEMONDVA';
});
const closed = inquiries.filter((b) => {
  const d = reportInquiryDate(b);
  if (!d || d < start30 || d >= today) return false;
  return normalizeStatus(b.status) !== 'LEMONDVA';
});

const forecastLines = buildDailyReportCsvLines(forecast);
const closedLines = buildDailyReportCsvLines(closed);
let totalHc = 0;
let totalPrice = 0;
closed.forEach((b) => {
  const hc = resolveBookingHeadcount(b);
  if (hc != null) totalHc += hc;
  const pr = reportInquiryPriceNum(b);
  if (pr != null) totalPrice += pr;
});
closedLines.push('');
closedLines.push(`TELJES_UTAS;${totalHc}`);
closedLines.push(`TELJES_BEVETEL;${totalPrice}`);

const forecastFile = `rent_elorejelzes_90nap_${today.replace(/-/g, '')}.csv`;
const closedFile = `rent_lezart_30nap_${today.replace(/-/g, '')}.csv`;

console.log('=== MENÜPONTOK ===');
console.log('1. Adatkezelés → 90 napos előrejelzés (CSV)');
console.log('2. Adatkezelés → Lezárt 30 nap (CSV)');
console.log('');
console.log('=== FÁJLNEVEK ===');
console.log('Export #1:', forecastFile, `(${forecast.length} rekord)`);
console.log('Export #2:', closedFile, `(${closed.length} rekord)`);
console.log('');
console.log('=== EXPORT #1 – első 10 sor ===');
forecastLines.slice(0, 10).forEach((l, i) => console.log(`${i + 1}. ${l}`));
console.log('');
console.log('=== EXPORT #2 – teljes tartalom (0 adat is) ===');
closedLines.forEach((l, i) => console.log(`${i + 1}. ${l}`));
