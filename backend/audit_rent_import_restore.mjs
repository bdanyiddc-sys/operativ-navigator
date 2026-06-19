/**
 * RENT IMPORT/RESTORE AUDIT – read-only verification script (mutates local test DB via API)
 */
import fs from 'fs';
import Database from 'better-sqlite3';

const BASE = process.env.RENT_AUDIT_BASE || 'http://localhost:3000';
const DB_PATH = process.env.RENT_AUDIT_DB || 'd:/cursor/operativ-navigator_260614/backend/data/events.db';
const BACKUPS = {
  b2224: 'd:/cursor_safety/Github_safe/rent_backup_20260618_2224.json',
  b2120: 'd:/cursor_safety/Github_safe/rent_backup_20260618_2120.json',
};

function loadBackup(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  return { inquiries: raw.inquiries || [], exportedAt: raw.exportedAt };
}

async function apiPost(path, body) {
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, data };
}

async function getAll() {
  const resp = await fetch(BASE + '/api/rent/inquiries');
  const data = await resp.json();
  return data.inquiries || [];
}

async function getOne(id) {
  const resp = await fetch(BASE + '/api/rent/inquiries/' + encodeURIComponent(id));
  const data = await resp.json();
  return data.inquiry || null;
}

function stable(v) {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v);
}

function maxRentSeq(ids) {
  let max = 0;
  ids.forEach((id) => {
    const m = String(id).match(/^RENT-(\d{4})-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[2], 10));
  });
  return max;
}

function readPayloadJsonFromDb(id) {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare('SELECT payload_json FROM rent_inquiries WHERE id = ?').get(id);
    db.close();
    return row ? JSON.parse(row.payload_json) : null;
  } catch (e) {
    return { _error: e.message };
  }
}

const results = {};

async function audit1RestoreThenNewId(backup2224) {
  const beforeIds = new Set((await getAll()).map((r) => r.id));
  const restore = await apiPost('/api/rent/restore', {
    inquiries: backup2224.inquiries,
    confirm: true,
  });
  const afterRestore = await getAll();
  const backupIds = new Set(backup2224.inquiries.map((r) => r.id));
  const post = await fetch(BASE + '/api/rent/inquiries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Audit New ID',
      ordererName: 'Audit New ID',
      phone: '+36701234999',
      date: '2026-12-20',
      timeStart: '10:00',
      timeEnd: '12:00',
      headcount: 1,
      city: 'Tata',
      lat: 47.65,
      lng: 18.32,
    }),
  }).then((r) => r.json());

  const newId = post.inquiry && post.inquiry.id;
  const existsInBackup = backupIds.has(newId);
  const existsBefore = beforeIds.has(newId);
  const maxBackupSeq = maxRentSeq([...backupIds]);
  const newSeq = newId && newId.match(/^RENT-\d{4}-(\d+)$/) ? parseInt(newId.match(/^RENT-\d{4}-(\d+)$/)[1], 10) : 0;

  results.audit1 = {
    pass: !!(restore.data.ok && newId && !existsInBackup && !existsBefore && newSeq > maxBackupSeq),
    restoreOk: restore.data.ok,
    newId,
    existsInBackup,
    existsBeforeRestore: existsBefore,
    maxBackupSeq,
    newSeq,
    newSeqAboveMax: newSeq > maxBackupSeq,
  };
}

async function audit2RoutePreservation(backup2224) {
  const rich = backup2224.inquiries.find((r) => r.id === 'RENT-2026-0009')
    || backup2224.inquiries.find((r) => r.routePoints && r.routePoints.length);
  if (!rich) {
    results.audit2 = { pass: false, reason: 'no rich backup row' };
    return;
  }
  await apiPost('/api/rent/import', { inquiries: [rich], mode: 'upsert' });
  const apiRow = await getOne(rich.id);
  const payload = readPayloadJsonFromDb(rich.id);
  const checks = {
    routePoints: stable(rich.routePoints) === stable(apiRow && apiRow.routePoints),
    routeGeometry: stable(rich.routeGeometry) === stable(apiRow && apiRow.routeGeometry),
    routeDraft: stable(rich.routeDraft) === stable(apiRow && apiRow.routeDraft),
    adminCalculatedRoute: stable(rich.adminCalculatedRoute) === stable(apiRow && apiRow.adminCalculatedRoute),
    payload_routePoints: stable(rich.routePoints) === stable(payload && payload.routePoints),
    payload_routeGeometry: stable(rich.routeGeometry) === stable(payload && payload.routeGeometry),
    payload_routeDraft: stable(rich.routeDraft) === stable(payload && payload.routeDraft),
    payload_adminCalculatedRoute: stable(rich.adminCalculatedRoute) === stable(payload && payload.adminCalculatedRoute),
    payload_has_json: !!(payload && typeof payload === 'object' && !payload._error),
  };
  const allPass = Object.values(checks).every(Boolean);
  results.audit2 = { pass: allPass, id: rich.id, checks };
}

async function audit3PreviewVsImport(backup2120) {
  const preview = await apiPost('/api/rent/import/preview', { inquiries: backup2120.inquiries });
  const imp = await apiPost('/api/rent/import', { inquiries: backup2120.inquiries, mode: 'upsert' });
  const p = preview.data;
  const i = imp.data;
  const fields = ['imported', 'updated', 'skipped', 'conflicts'];
  const match = fields.every((f) => (p[f] || 0) === (i[f] || 0));
  results.audit3 = {
    pass: !!(preview.data.ok && imp.data.ok && match),
    preview: { imported: p.imported, updated: p.updated, skipped: p.skipped, conflicts: p.conflicts },
    import: { imported: i.imported, updated: i.updated, skipped: i.skipped, conflicts: i.conflicts },
    match,
  };
}

async function audit4RestoreCount(backup2224) {
  const restore = await apiPost('/api/rent/restore', {
    inquiries: backup2224.inquiries,
    confirm: true,
  });
  const rows = await getAll();
  const pass = restore.data.ok
    && restore.data.restored === backup2224.inquiries.length
    && rows.length === backup2224.inquiries.length
    && (restore.data.failed || 0) === 0;
  results.audit4 = {
    pass,
    backupCount: backup2224.inquiries.length,
    restored: restore.data.restored,
    failed: restore.data.failed,
    getCount: rows.length,
  };
}

async function audit5ConflictMissingUpdatedAt() {
  const existing = await getOne('RENT-2026-0002');
  const synthetic = {
    id: 'RENT-2026-0002',
    ordererName: 'Conflict Audit Synthetic',
    name: 'Conflict Audit Synthetic',
    phone: '+36701234001',
    date: existing ? existing.date : '2026-06-20',
    timeStart: '10:00',
    timeEnd: '12:00',
    headcount: 99,
    city: 'ConflictCity',
    lat: 1.1,
    lng: 2.2,
  };
  delete synthetic.updatedAt;
  delete synthetic.updated_at;
  const preview = await apiPost('/api/rent/import/preview', { inquiries: [synthetic] });
  const imp = await apiPost('/api/rent/import', { inquiries: [synthetic], mode: 'upsert' });
  const item = preview.data.items && preview.data.items[0];
  const noCrash = preview.data.ok && imp.data.ok;
  const hasDecision = !!(item && item.action && item.decision);
  results.audit5 = {
    pass: !!(noCrash && hasDecision),
    previewOk: preview.data.ok,
    importOk: imp.data.ok,
    action: item && item.action,
    decision: item && item.decision,
    conflicts: preview.data.conflicts,
    errors: preview.data.errors,
    importErrors: imp.data.errors,
  };
}

async function main() {
  const b2224 = loadBackup(BACKUPS.b2224);
  const b2120 = loadBackup(BACKUPS.b2120);

  try {
    await fetch(BASE + '/api/rent/inquiries');
  } catch (e) {
    console.error('FAIL: server not reachable at', BASE);
    process.exit(1);
  }

  console.log('RENT IMPORT/RESTORE AUDIT');
  console.log('Target:', BASE);
  console.log('');

  await audit4RestoreCount(b2224);
  await audit1RestoreThenNewId(b2224);
  await audit2RoutePreservation(b2224);
  await audit3PreviewVsImport(b2120);
  await audit5ConflictMissingUpdatedAt();

  const lines = [
    ['1. Restore + új ID nem ütközik', results.audit1],
    ['2. UPSERT route/payload megmarad', results.audit2],
    ['3. Preview = Import számok', results.audit3],
    ['4. Restore count = backup count', results.audit4],
    ['5. Konfliktus hiányzó updatedAt', results.audit5],
  ];

  lines.forEach(([label, r]) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' – ' + label);
    console.log(JSON.stringify(r, null, 2));
    console.log('');
  });

  const allPass = lines.every(([, r]) => r.pass);
  console.log('=== ÖSSZESÍTÉS:', allPass ? 'PASS' : 'FAIL', '===');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
