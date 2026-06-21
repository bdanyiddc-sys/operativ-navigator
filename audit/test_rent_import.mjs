import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.RENT_TEST_BASE || 'http://localhost:3000';
const BACKUPS = {
  b2224: 'd:/cursor_safety/Github_safe/rent_backup_20260618_2224.json',
  b2120: 'd:/cursor_safety/Github_safe/rent_backup_20260618_2120.json',
  b2046: 'd:/cursor_safety/Github_safe/rent_backup_20260618_2046.json',
};

function loadBackup(key) {
  const raw = JSON.parse(fs.readFileSync(BACKUPS[key], 'utf8'));
  return raw.inquiries || [];
}

async function api(path, body) {
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function getInquiries() {
  const resp = await fetch(BASE + '/api/rent/inquiries');
  const data = await resp.json();
  return data.inquiries || [];
}

async function waitForServer(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(BASE + '/api/rent/inquiries');
      if (r.ok) return true;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function testIdGeneration() {
  const before = await getInquiries();
  const ids = new Set(before.map((b) => b.id));
  const resp = await fetch(BASE + '/api/rent/inquiries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ID Gen Test',
      ordererName: 'ID Gen Test',
      phone: '+36701234567',
      date: '2026-12-01',
      timeStart: '10:00',
      timeEnd: '12:00',
      headcount: 1,
      city: 'Tata',
      lat: 47.65,
      lng: 18.32,
    }),
  });
  const data = await resp.json();
  const newId = data.inquiry && data.inquiry.id;
  const ok = resp.ok && data.ok && newId && !ids.has(newId) && /^RENT-\d{4}-\d+$/.test(newId);
  console.log('ID generation:', ok ? 'OK' : 'FAIL', newId || data.error);
  return { ok, newId };
}

async function run() {
  const ready = await waitForServer();
  if (!ready) {
    console.error('Server not ready at', BASE);
    process.exit(1);
  }

  console.log('=== RENT IMPORT/RESTORE TESTS ===\n');

  const current = await getInquiries();
  console.log('Current API count:', current.length);

  const p2224 = await api('/api/rent/import/preview', { inquiries: loadBackup('b2224') });
  console.log('\n2224 preview:', JSON.stringify({
    imported: p2224.data.imported,
    updated: p2224.data.updated,
    skipped: p2224.data.skipped,
    conflicts: p2224.data.conflicts,
  }));

  const p2120 = await api('/api/rent/import/preview', { inquiries: loadBackup('b2120') });
  console.log('2120 preview:', JSON.stringify({
    imported: p2120.data.imported,
    updated: p2120.data.updated,
    skipped: p2120.data.skipped,
    conflicts: p2120.data.conflicts,
  }));

  const p2046 = await api('/api/rent/import/preview', { inquiries: loadBackup('b2046') });
  console.log('2046 preview:', JSON.stringify({
    imported: p2046.data.imported,
    updated: p2046.data.updated,
    skipped: p2046.data.skipped,
    conflicts: p2046.data.conflicts,
  }));

  const sample2120 = loadBackup('b2120').find((x) => x.id === 'RENT-2026-0001');
  if (sample2120) {
    const onePreview = await api('/api/rent/import/preview', { inquiries: [sample2120] });
    console.log('\n0001 from 2120 preview action:', onePreview.data.items && onePreview.data.items[0]);
  }

  const newProbe = {
    id: 'RENT-TEST-UPSERT-' + Date.now(),
    ordererName: 'Upsert Probe',
    name: 'Upsert Probe',
    phone: '+36701112233',
    date: '2026-12-15',
    timeStart: '09:00',
    timeEnd: '10:00',
    headcount: 3,
    city: 'Eger',
    lat: 47.902,
    lng: 20.377,
    routePoints: [{ lat: 47.902, lng: 20.377 }],
    updatedAt: new Date().toISOString(),
  };
  const probeImport = await api('/api/rent/import', { inquiries: [newProbe], mode: 'upsert' });
  console.log('\nNew ID probe import:', probeImport.data);

  const idTest = await testIdGeneration();

  const routeSample = loadBackup('b2224').find((x) => x.id === 'RENT-2026-0009');
  if (routeSample) {
    const afterList = await getInquiries();
    const live = afterList.find((x) => x.id === 'RENT-2026-0009');
    const routeOk = !!(live && live.routePoints && live.routePoints.length);
    console.log('\nRoute preserve 0009 routePoints:', routeOk ? 'OK' : 'CHECK', live && live.routePoints && live.routePoints.length);
  }

  console.log('\n=== SUMMARY ===');
  console.log('ID generator:', idTest.ok ? 'PASS' : 'FAIL');
  console.log('Preview API:', p2224.data.ok && p2120.data.ok ? 'PASS' : 'FAIL');
  console.log('Upsert new ID:', probeImport.data.imported === 1 ? 'PASS' : 'FAIL');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
