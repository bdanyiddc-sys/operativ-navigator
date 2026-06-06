'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(__dirname, 'data', 'events.db');
const routesDir = path.resolve(__dirname, 'routes');
const vehiclesPath = path.join(__dirname, 'data', 'vehicles.json');
const driversPath = path.join(__dirname, 'data', 'drivers.json');
const ROUTES_SAMPLE_GEOJSON = 'Tata_utvonal2.geojson';
const MASTER_DEFAULT_CAPACITY = 56;
const DEFAULT_VEHICLES = [
  { id: 'KV01', name: 'Kisvonat 1', capacity: 56, local: 'Tata' },
  { id: 'KV02', name: 'Kisvonat 2', capacity: 56, local: 'Tata' },
  { id: 'KV03', name: 'Kisvonat 3', capacity: 56, local: 'Tata' },
  { id: 'KV04', name: 'Kisvonat 4', capacity: 56, local: 'Székesfehérvár' },
  { id: 'KV05', name: 'Kisvonat 5', capacity: 56, local: 'Eger' },
  { id: 'KV06', name: 'Kisvonat 6', capacity: 56, local: 'Győr' },
];
const DEFAULT_DRIVERS = [
  { id: 'DRV01', name: 'Teszt Elek', pin: '1234' },
  { id: 'DRV02', name: 'Minta Béla', pin: '1234' },
  { id: 'DRV03', name: 'Próba János', pin: '1234' },
];

function normalizeMasterVehicle(v) {
  const vehicleId = String(v.vehicle_id || v.id || '').trim();
  if (!vehicleId) return null;
  const vehicleName = String(v.vehicle_name || v.name || '').trim();
  const local = v.local != null ? String(v.local).trim() : '';
  return {
    vehicle_id: vehicleId,
    vehicle_name: vehicleName,
    capacity: Math.max(1, parseInt(v.capacity, 10) || MASTER_DEFAULT_CAPACITY),
    local,
  };
}

function normalizeMasterDriver(d) {
  const driverId = String(d.driver_id || d.id || '').trim();
  if (!driverId) return null;
  const driverName = String(d.driver_name || d.name || '').trim();
  return {
    driver_id: driverId,
    driver_name: driverName,
  };
}

function readVehicles() {
  try {
    if (!fs.existsSync(vehiclesPath)) {
      ensureDataDir(vehiclesPath);
      fs.writeFileSync(vehiclesPath, JSON.stringify(DEFAULT_VEHICLES, null, 2), 'utf8');
      return DEFAULT_VEHICLES.map(normalizeMasterVehicle).filter(Boolean);
    }
    const raw = JSON.parse(fs.readFileSync(vehiclesPath, 'utf8'));
    if (!Array.isArray(raw)) {
      return DEFAULT_VEHICLES.map(normalizeMasterVehicle).filter(Boolean);
    }
    return raw.map(normalizeMasterVehicle).filter(Boolean);
  } catch (err) {
    console.error('[vehicles] read failed:', err);
    return DEFAULT_VEHICLES.map(normalizeMasterVehicle).filter(Boolean);
  }
}

function readDrivers() {
  try {
    if (!fs.existsSync(driversPath)) {
      ensureDataDir(driversPath);
      fs.writeFileSync(driversPath, JSON.stringify(DEFAULT_DRIVERS, null, 2), 'utf8');
      return DEFAULT_DRIVERS.map(normalizeMasterDriver).filter(Boolean);
    }
    const raw = JSON.parse(fs.readFileSync(driversPath, 'utf8'));
    if (!Array.isArray(raw)) {
      return DEFAULT_DRIVERS.map(normalizeMasterDriver).filter(Boolean);
    }
    return raw.map(normalizeMasterDriver).filter(Boolean);
  } catch (err) {
    console.error('[drivers] read failed:', err);
    return DEFAULT_DRIVERS.map(normalizeMasterDriver).filter(Boolean);
  }
}

function writeVehicles(list) {
  ensureDataDir(vehiclesPath);
  const normalized = (Array.isArray(list) ? list : [])
    .map(normalizeMasterVehicle)
    .filter(Boolean);
  const fileRows = normalized.map((v) => ({
    id: v.vehicle_id,
    name: v.vehicle_name || undefined,
    capacity: v.capacity,
    local: v.local || undefined,
  }));
  fs.writeFileSync(vehiclesPath, JSON.stringify(fileRows, null, 2), 'utf8');
  return normalized;
}

function logRoutesStartup() {
  const samplePath = path.join(routesDir, ROUTES_SAMPLE_GEOJSON);
  const dirOk = fs.existsSync(routesDir);
  const fileOk = fs.existsSync(samplePath);
  console.log('[ROUTES] routesDir:', routesDir);
  console.log('[ROUTES] fs.existsSync(routesDir):', dirOk);
  console.log('[ROUTES] fs.existsSync(Tata_utvonal2.geojson):', fileOk);
  if (dirOk && fileOk) {
    console.log('[ROUTES] OK');
    console.log('[ROUTES] Tata_utvonal2.geojson found');
  } else {
    console.warn('[ROUTES] NOT READY — missing directory or sample GeoJSON');
  }
}

const TRIP_START_TYPES = new Set(['trip_start', 'jarat_inditas', 'indulas']);
const TRIP_END_TYPES = new Set(['trip_end', 'jarat_zaras']);

function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function initDb(dbPath) {
  ensureDataDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      trip TEXT,
      shift TEXT,
      timestamp TEXT NOT NULL,
      lat REAL,
      lng REAL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_trip ON events(trip);
    CREATE INDEX IF NOT EXISTS idx_events_shift ON events(shift);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      trip_id TEXT,
      type TEXT NOT NULL DEFAULT 'task',
      title TEXT NOT NULL,
      description TEXT,
      lat REAL,
      lng REAL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);
  let taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('vehicle_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN vehicle_id TEXT');
    taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  }
  ['accepted_at', 'picked_up_at', 'done_at', 'cancelled_at'].forEach((col) => {
    if (!taskCols.includes(col)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
      taskCols.push(col);
    }
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_reservations (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      stop_name TEXT NOT NULL,
      stop_id TEXT,
      city TEXT,
      passenger_count INTEGER NOT NULL DEFAULT 1,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      reservation_type TEXT NOT NULL DEFAULT 'scheduled',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sched_res_created ON scheduled_reservations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sched_res_status ON scheduled_reservations(status);
    CREATE TABLE IF NOT EXISTS boarding_requests (
      id TEXT PRIMARY KEY,
      stop_name TEXT NOT NULL,
      stop_id TEXT,
      city TEXT,
      passenger_count INTEGER NOT NULL DEFAULT 1,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_boarding_created ON boarding_requests(created_at DESC);
    CREATE TABLE IF NOT EXISTS custom_orders (
      id TEXT PRIMARY KEY,
      event_date TEXT NOT NULL,
      event_time TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      passenger_count INTEGER NOT NULL DEFAULT 1,
      departure_place TEXT NOT NULL,
      arrival_place TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_created ON custom_orders(created_at DESC);
  `);
  let boardCols = db.prepare('PRAGMA table_info(boarding_requests)').all().map((c) => c.name);
  if (!boardCols.includes('driver_response')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN driver_response TEXT');
    boardCols.push('driver_response');
  }
  if (!boardCols.includes('driver_response_at')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN driver_response_at TEXT');
  }
  if (!boardCols.includes('lat')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN lat REAL');
  }
  if (!boardCols.includes('lng')) {
    db.exec('ALTER TABLE boarding_requests ADD COLUMN lng REAL');
  }
  let schedCols = db.prepare('PRAGMA table_info(scheduled_reservations)').all().map((c) => c.name);
  if (!schedCols.includes('driver_seen_at')) {
    db.exec('ALTER TABLE scheduled_reservations ADD COLUMN driver_seen_at TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_records (
      id TEXT PRIMARY KEY,
      event_date TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      recorded_by TEXT,
      source TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_service_date ON service_records(event_date DESC);
    CREATE TABLE IF NOT EXISTS driver_notes (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      category TEXT NOT NULL,
      note TEXT NOT NULL,
      driver_id TEXT,
      driver_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_driver_notes_created ON driver_notes(created_at DESC);
  `);
  return db;
}

const REPORT_DEFAULT_CAPACITY = 56;
const REPORT_TICKET_PRICE_HUF = 2800;
const SERVICE_TYPES = new Set(['olajcsere', 'fek', 'gumi', 'akkumulátor', 'lampa', 'tisztitas', 'egyeb']);
const SERVICE_STATUSES = new Set(['open', 'in_progress', 'done', 'cancelled']);
const DRIVER_NOTE_CATEGORIES = new Set(['hiba', 'karbantartas', 'tisztitas', 'utaspanasz', 'egyeb']);

const TASK_STATUSES = new Set(['pending', 'accepted', 'picked_up', 'done', 'cancelled']);

const TASK_STATUS_TS_COLUMN = {
  accepted: 'accepted_at',
  picked_up: 'picked_up_at',
  done: 'done_at',
  cancelled: 'cancelled_at',
};

function taskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseTaskStatusQuery(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => TASK_STATUSES.has(s));
  return list.length ? list : null;
}

function normalizeIncomingTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = raw.title != null ? String(raw.title).trim() : '';
  if (!title) return null;
  const lat = raw.lat != null ? Number(raw.lat) : null;
  const lng = raw.lng != null ? Number(raw.lng) : null;
  const tripId = raw.trip_id != null && String(raw.trip_id).trim() !== ''
    ? String(raw.trip_id).trim()
    : raw.trip != null && String(raw.trip).trim() !== ''
      ? String(raw.trip).trim()
      : null;
  const type = raw.type != null && String(raw.type).trim() !== ''
    ? String(raw.type).trim()
    : 'task';
  const statusRaw = raw.status != null ? String(raw.status).trim() : 'pending';
  const status = TASK_STATUSES.has(statusRaw) ? statusRaw : 'pending';
  const vehicleId = raw.vehicle_id != null && String(raw.vehicle_id).trim() !== ''
    ? String(raw.vehicle_id).trim()
    : null;
  return {
    id: raw.id != null && String(raw.id).trim() !== '' ? String(raw.id).trim() : taskId(),
    trip_id: tripId,
    vehicle_id: vehicleId,
    type,
    title,
    description: raw.description != null ? String(raw.description) : '',
    lat: lat != null && !Number.isNaN(lat) ? lat : null,
    lng: lng != null && !Number.isNaN(lng) ? lng : null,
    status,
  };
}

function normalizeTaskUpdate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id != null ? String(raw.id).trim() : '';
  if (!id) return null;
  const title = raw.title != null ? String(raw.title).trim() : '';
  if (!title) return null;
  const statusRaw = raw.status != null ? String(raw.status).trim() : 'pending';
  const status = TASK_STATUSES.has(statusRaw) ? statusRaw : 'pending';
  const lat = raw.lat != null ? Number(raw.lat) : null;
  const lng = raw.lng != null ? Number(raw.lng) : null;
  const tripId = raw.trip_id != null && String(raw.trip_id).trim() !== ''
    ? String(raw.trip_id).trim()
    : raw.trip != null && String(raw.trip).trim() !== ''
      ? String(raw.trip).trim()
      : null;
  const vehicleId = raw.vehicle_id != null && String(raw.vehicle_id).trim() !== ''
    ? String(raw.vehicle_id).trim()
    : null;
  return {
    id,
    trip_id: tripId,
    vehicle_id: vehicleId,
    type: raw.type != null && String(raw.type).trim() !== '' ? String(raw.type).trim() : 'task',
    title,
    description: raw.description != null ? String(raw.description) : '',
    lat: lat != null && !Number.isNaN(lat) ? lat : null,
    lng: lng != null && !Number.isNaN(lng) ? lng : null,
    status,
  };
}

function rowToTaskClient(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    accepted_at: row.accepted_at || null,
    picked_up_at: row.picked_up_at || null,
    done_at: row.done_at || null,
    cancelled_at: row.cancelled_at || null,
    trip_id: row.trip_id,
    vehicle_id: row.vehicle_id || null,
    type: row.type,
    title: row.title,
    description: row.description || '',
    lat: row.lat,
    lng: row.lng,
    status: row.status,
  };
}

function eventTimestamp(ev) {
  return (
    ev.timestamp ||
    ev.start_time ||
    ev.time ||
    new Date().toISOString()
  );
}

function eventTrip(ev) {
  const t = ev.trip || ev.jaratszam || ev.jarat_szam;
  return t != null && String(t).trim() !== '' ? String(t).trim() : null;
}

function eventShift(ev) {
  const s = ev.shift;
  return s != null && String(s).trim() !== '' ? String(s).trim() : null;
}

function eventId(ev) {
  if (ev.id != null && String(ev.id).trim() !== '') {
    return String(ev.id).trim();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeIncomingEvent(raw) {
  if (!raw || typeof raw !== 'object' || !raw.type) {
    return null;
  }
  const type = String(raw.type).trim();
  if (!type) return null;

  const id = eventId(raw);
  const trip = eventTrip(raw);
  const shift = eventShift(raw);
  const timestamp = eventTimestamp(raw);
  const lat = raw.lat != null ? Number(raw.lat) : null;
  const lng = raw.lng != null ? Number(raw.lng) : null;

  return {
    id,
    type,
    trip,
    shift,
    timestamp,
    lat: lat != null && !Number.isNaN(lat) ? lat : null,
    lng: lng != null && !Number.isNaN(lng) ? lng : null,
    payload_json: JSON.stringify(raw),
  };
}

function rowToClient(row) {
  let payload = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = row.payload_json;
  }
  return {
    id: row.id,
    type: row.type,
    trip: row.trip,
    shift: row.shift,
    timestamp: row.timestamp,
    lat: row.lat,
    lng: row.lng,
    created_at: row.created_at,
    payload,
  };
}

const db = initDb(DATABASE_PATH);

const RESERVATION_STATUSES = new Set(['new', 'accepted', 'modified', 'cancelled']);
const BOARDING_DRIVER_RESPONSES = new Set(['can_stop', 'full', 'unsafe', 'not_on_route', 'other']);

function normalizeCityKey(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  return String(raw).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeDbTimestamp(ts) {
  if (ts == null || ts === '') return null;
  const s = String(ts).trim();
  if (!s) return null;
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  return s;
}

function normalizeHuPhone(raw) {
  if (raw == null) return '';
  let p = String(raw).trim().replace(/[\s().-]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('06')) p = '+36' + p.slice(2);
  else if (/^36\d{9,}$/.test(p)) p = '+' + p;
  if (!/^\+36\d{9}$/.test(p)) return '';
  return p;
}

function formatHuPhoneDisplay(phone) {
  const normalized = normalizeHuPhone(phone);
  if (normalized) {
    const m = normalized.match(/^\+36(\d{2})(\d{3})(\d{3,4})$/);
    if (m) return `+36 ${m[1]} ${m[2]} ${m[3]}`;
    return normalized;
  }
  const raw = String(phone || '').trim();
  return raw || '';
}

function bookingId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function seedBookingsIfEmpty() {
  const schedCount = db.prepare('SELECT COUNT(*) AS n FROM scheduled_reservations').get().n;
  if (schedCount === 0) {
    const ins = db.prepare(`
      INSERT INTO scheduled_reservations (id, time, stop_name, stop_id, city, passenger_count, phone, status, reservation_type, note)
      VALUES (@id, @time, @stop_name, @stop_id, @city, @passenger_count, @phone, @status, @reservation_type, @note)
    `);
    [
      { id: 'rsv_demo_1', time: '15:08', stop_name: 'Vármegálló', stop_id: 'stop_varmegallo', city: 'Tata', passenger_count: 2, phone: '+36 30 123 4567', status: 'new', reservation_type: 'scheduled', note: '' },
      { id: 'rsv_demo_2', time: '15:15', stop_name: 'Tatai vár', stop_id: 'stop_var', city: 'Tata', passenger_count: 4, phone: '+36 20 555 1212', status: 'accepted', reservation_type: 'scheduled', note: '' },
      { id: 'rsv_demo_3', time: '16:00', stop_name: 'Indulási pont', stop_id: 'stop_tata_ind', city: 'Tata', passenger_count: 3, phone: '+36 70 111 2233', status: 'new', reservation_type: 'scheduled', note: 'Gyerekülés' },
    ].forEach((row) => ins.run(row));
  }
  const boardCount = db.prepare('SELECT COUNT(*) AS n FROM boarding_requests').get().n;
  if (boardCount === 0) {
    const insB = db.prepare(`
      INSERT INTO boarding_requests (id, stop_name, stop_id, city, passenger_count, phone, status, created_at)
      VALUES (@id, @stop_name, @stop_id, @city, @passenger_count, @phone, @status, @created_at)
    `);
    const now = new Date().toISOString();
    insB.run({
      id: 'brd_demo_1',
      stop_name: 'Tatai vár',
      stop_id: 'stop_var',
      city: 'Tata',
      passenger_count: 4,
      phone: '+36 20 987 6543',
      status: 'active',
      created_at: now,
    });
    insB.run({
      id: 'brd_demo_2',
      stop_name: 'Vármegálló',
      stop_id: 'stop_varmegallo',
      city: 'Tata',
      passenger_count: 2,
      phone: '+36 30 444 7788',
      status: 'active',
      created_at: new Date(Date.now() - 3600000).toISOString(),
    });
  }
  const customCount = db.prepare('SELECT COUNT(*) AS n FROM custom_orders').get().n;
  if (customCount === 0) {
    db.prepare(`
      INSERT INTO custom_orders (id, event_date, event_time, customer_name, phone, passenger_count, departure_place, arrival_place, note, status)
      VALUES (@id, @event_date, @event_time, @customer_name, @phone, @passenger_count, @departure_place, @arrival_place, @note, @status)
    `).run({
      id: 'cst_demo_1',
      event_date: '2026.06.12',
      event_time: '17:00',
      customer_name: 'Esküvő',
      phone: '+36 30 999 0000',
      passenger_count: 32,
      departure_place: 'Tatai vár',
      arrival_place: 'Öreg-tó',
      note: 'Koccintós túra',
      status: 'new',
    });
  }
}

seedBookingsIfEmpty();

const selectScheduled = db.prepare(`
  SELECT * FROM scheduled_reservations
  WHERE status != 'cancelled'
  ORDER BY time ASC, created_at DESC
  LIMIT ?
`);
const selectBoarding = db.prepare(`
  SELECT * FROM boarding_requests
  WHERE status IN ('active', 'responded')
  ORDER BY created_at DESC
  LIMIT ?
`);
const selectBoardingActive = db.prepare(`
  SELECT * FROM boarding_requests
  WHERE status = 'active'
  ORDER BY created_at DESC
  LIMIT ?
`);
const selectCustom = db.prepare(`
  SELECT * FROM custom_orders
  WHERE status != 'cancelled'
  ORDER BY event_date ASC, event_time ASC
  LIMIT ?
`);
const insertScheduled = db.prepare(`
  INSERT INTO scheduled_reservations (id, time, stop_name, stop_id, city, passenger_count, phone, status, reservation_type, note)
  VALUES (@id, @time, @stop_name, @stop_id, @city, @passenger_count, @phone, @status, @reservation_type, @note)
`);
const insertBoarding = db.prepare(`
  INSERT INTO boarding_requests (id, stop_name, stop_id, city, passenger_count, phone, status, created_at, lat, lng)
  VALUES (@id, @stop_name, @stop_id, @city, @passenger_count, @phone, 'active', @created_at, @lat, @lng)
`);
const updateScheduledStatus = db.prepare(`
  UPDATE scheduled_reservations SET status = @status, updated_at = datetime('now') WHERE id = @id
`);
const updateScheduledFields = db.prepare(`
  UPDATE scheduled_reservations
  SET time = @time, stop_name = @stop_name, passenger_count = @passenger_count, phone = @phone,
      status = @status, note = @note, updated_at = datetime('now')
  WHERE id = @id
`);
const dismissBoarding = db.prepare(`
  UPDATE boarding_requests SET status = 'dismissed' WHERE id = @id
`);
const respondBoarding = db.prepare(`
  UPDATE boarding_requests
  SET driver_response = @driver_response, driver_response_at = datetime('now'), status = 'responded'
  WHERE id = @id AND status = 'active'
`);
const markScheduledSeen = db.prepare(`
  UPDATE scheduled_reservations SET driver_seen_at = @seen_at WHERE id = @id AND driver_seen_at IS NULL
`);
const getScheduledById = db.prepare('SELECT * FROM scheduled_reservations WHERE id = ?');
const getBoardingById = db.prepare('SELECT * FROM boarding_requests WHERE id = ?');
const selectServiceRecords = db.prepare(`
  SELECT * FROM service_records ORDER BY event_date DESC, created_at DESC LIMIT ?
`);
const insertServiceRecord = db.prepare(`
  INSERT INTO service_records (id, event_date, vehicle_id, service_type, status, note, recorded_by, source)
  VALUES (@id, @event_date, @vehicle_id, @service_type, @status, @note, @recorded_by, @source)
`);
const selectDriverNotes = db.prepare(`
  SELECT * FROM driver_notes ORDER BY created_at DESC LIMIT ?
`);
const selectDriverNoteById = db.prepare(`
  SELECT * FROM driver_notes WHERE id = ?
`);
const insertDriverNote = db.prepare(`
  INSERT INTO driver_notes (id, vehicle_id, category, note, driver_id, driver_name)
  VALUES (@id, @vehicle_id, @category, @note, @driver_id, @driver_name)
`);

function opsId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseReportDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localDateKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildDailyVehicleReport(dateStr, vehicleIdFilter) {
  const rows = selectEventsChronological.all();
  const byVehicle = {};
  rows.forEach((row) => {
    if (row.type !== 'trip_summary') return;
    const day = localDateKey(row.timestamp);
    if (day !== dateStr) return;
    let p = {};
    try {
      p = JSON.parse(row.payload_json);
    } catch {
      p = {};
    }
    const vid = String(p.vehicle_id || row.trip || '').trim() || 'ismeretlen';
    if (vehicleIdFilter && vid !== vehicleIdFilter) return;
    const pax = Math.max(0, parseInt(p.passenger_total, 10) || 0);
    if (!byVehicle[vid]) {
      byVehicle[vid] = {
        vehicle_id: vid,
        vehicle_name: p.vehicle_name || vid,
        passengers: 0,
        trip_count: 0,
      };
    }
    byVehicle[vid].passengers += pax;
    byVehicle[vid].trip_count += 1;
    if (p.vehicle_name && !byVehicle[vid].vehicle_name) {
      byVehicle[vid].vehicle_name = p.vehicle_name;
    }
  });
  return Object.values(byVehicle).map((v) => {
    const cap = REPORT_DEFAULT_CAPACITY;
    const pax = v.passengers;
    const free = Math.max(0, cap - pax);
    const util = cap > 0 ? Math.round((pax / cap) * 1000) / 10 : 0;
    return {
      date: dateStr,
      vehicle_id: v.vehicle_id,
      vehicle_name: v.vehicle_name,
      trip_count: v.trip_count,
      passengers: pax,
      capacity: cap,
      free_seats: free,
      utilization_pct: util,
      revenue_huf: pax * REPORT_TICKET_PRICE_HUF,
      ticket_price_huf: REPORT_TICKET_PRICE_HUF,
    };
  }).sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id));
}

function rowToServiceRecord(row) {
  return {
    id: row.id,
    event_date: row.event_date,
    vehicle_id: row.vehicle_id,
    service_type: row.service_type,
    status: row.status,
    note: row.note || '',
    recorded_by: row.recorded_by || '',
    source: row.source || 'admin',
    created_at: row.created_at,
  };
}

function rowToDriverNote(row) {
  return {
    id: row.id,
    vehicle_id: row.vehicle_id,
    category: row.category,
    note: row.note,
    driver_id: row.driver_id || '',
    driver_name: row.driver_name || '',
    created_at: normalizeDbTimestamp(row.created_at),
  };
}

function normalizeServiceRecordInput(body) {
  if (!body || typeof body !== 'object') return null;
  const vehicleId = body.vehicle_id != null ? String(body.vehicle_id).trim() : '';
  const serviceType = body.service_type != null ? String(body.service_type).trim() : '';
  const eventDate = body.event_date != null ? String(body.event_date).trim() : parseReportDate(null);
  if (!vehicleId || !serviceType || !SERVICE_TYPES.has(serviceType)) return null;
  const status = body.status != null ? String(body.status).trim() : 'open';
  return {
    id: opsId('svc'),
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : parseReportDate(null),
    vehicle_id: vehicleId,
    service_type: serviceType,
    status: SERVICE_STATUSES.has(status) ? status : 'open',
    note: body.note != null ? String(body.note).trim() : '',
    recorded_by: body.recorded_by != null ? String(body.recorded_by).trim() : '',
    source: 'admin',
  };
}

function normalizeDriverNoteInput(body) {
  if (!body || typeof body !== 'object') return null;
  const vehicleId = body.vehicle_id != null ? String(body.vehicle_id).trim() : '';
  const category = body.category != null ? String(body.category).trim() : '';
  const note = body.note != null ? String(body.note).trim() : '';
  if (!vehicleId || !category || !note || !DRIVER_NOTE_CATEGORIES.has(category)) return null;
  return {
    id: opsId('dn'),
    vehicle_id: vehicleId,
    category,
    note,
    driver_id: body.driver_id != null ? String(body.driver_id).trim() : '',
    driver_name: body.driver_name != null ? String(body.driver_name).trim() : '',
  };
}

function filterRowsByCity(rows, cityRaw) {
  const key = normalizeCityKey(cityRaw);
  if (!key) return rows;
  return rows.filter((row) => {
    const rowKey = normalizeCityKey(row.city);
    return !rowKey || rowKey === key;
  });
}

function rowToScheduled(row) {
  return {
    id: row.id,
    time: row.time,
    stop_name: row.stop_name,
    stop_id: row.stop_id,
    city: row.city,
    passenger_count: row.passenger_count,
    phone: formatHuPhoneDisplay(row.phone),
    status: row.status,
    reservation_type: row.reservation_type || 'scheduled',
    note: row.note || '',
    created_at: normalizeDbTimestamp(row.created_at),
    updated_at: normalizeDbTimestamp(row.updated_at),
    driver_seen_at: normalizeDbTimestamp(row.driver_seen_at),
  };
}

function rowToBoarding(row) {
  return {
    id: row.id,
    stop_name: row.stop_name,
    stop_id: row.stop_id,
    city: row.city,
    passenger_count: row.passenger_count,
    phone: formatHuPhoneDisplay(row.phone),
    status: row.status,
    lat: row.lat != null ? row.lat : null,
    lng: row.lng != null ? row.lng : null,
    created_at: normalizeDbTimestamp(row.created_at),
    driver_response: row.driver_response || null,
    driver_response_at: normalizeDbTimestamp(row.driver_response_at),
  };
}

function rowToCustom(row) {
  return {
    id: row.id,
    event_date: row.event_date,
    event_time: row.event_time,
    customer_name: row.customer_name,
    phone: formatHuPhoneDisplay(row.phone),
    passenger_count: row.passenger_count,
    departure_place: row.departure_place,
    arrival_place: row.arrival_place,
    note: row.note || '',
    status: row.status,
    created_at: normalizeDbTimestamp(row.created_at),
  };
}

function normalizePublicReservation(body) {
  if (!body || typeof body !== 'object') return null;
  const phone = normalizeHuPhone(body.phone);
  const time = body.time != null ? String(body.time).trim() : '';
  const stopName = body.stop_name != null ? String(body.stop_name).trim()
    : body.stop != null ? String(body.stop).trim() : '';
  if (!phone || !time || !stopName) return null;
  const count = Math.max(1, parseInt(body.count != null ? body.count : body.passenger_count, 10) || 1);
  return {
    id: bookingId('rsv'),
    time,
    stop_name: stopName,
    stop_id: body.stop_id != null ? String(body.stop_id).trim() : null,
    city: body.city != null ? String(body.city).trim() : null,
    passenger_count: count,
    phone,
    status: 'new',
    reservation_type: body.reservation_type != null ? String(body.reservation_type).trim() : 'scheduled',
    note: body.note != null ? String(body.note).trim() : '',
  };
}

function normalizePublicBoarding(body) {
  if (!body || typeof body !== 'object') return null;
  const phone = normalizeHuPhone(body.phone);
  if (!phone) return null;
  const lat = body.lat != null ? Number(body.lat) : null;
  const lng = body.lng != null ? Number(body.lng) : null;
  const isRoutePickup = body.boarding_type === 'route'
    || body.source === 'route'
    || (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng));
  let stopName = body.stop_name != null ? String(body.stop_name).trim() : '';
  if (isRoutePickup && !stopName) stopName = 'Útvonal menti felszállás';
  if (!isRoutePickup && !stopName) return null;
  if (isRoutePickup && (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng))) return null;
  const count = Math.max(1, parseInt(body.count != null ? body.count : body.passenger_count, 10) || 1);
  return {
    id: bookingId('brd'),
    stop_name: stopName,
    stop_id: body.stop_id != null ? String(body.stop_id).trim() : null,
    city: body.city != null ? String(body.city).trim() : null,
    passenger_count: count,
    phone,
    lat: isRoutePickup ? lat : null,
    lng: isRoutePickup ? lng : null,
    created_at: new Date().toISOString(),
  };
}

const insertEvent = db.prepare(`
  INSERT INTO events (id, type, trip, shift, timestamp, lat, lng, payload_json)
  VALUES (@id, @type, @trip, @shift, @timestamp, @lat, @lng, @payload_json)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    trip = excluded.trip,
    shift = excluded.shift,
    timestamp = excluded.timestamp,
    lat = excluded.lat,
    lng = excluded.lng,
    payload_json = excluded.payload_json
`);

const selectRecentEvents = db.prepare(`
  SELECT id, type, trip, shift, timestamp, lat, lng, payload_json, created_at
  FROM events
  ORDER BY timestamp DESC, created_at DESC
  LIMIT ?
`);

const selectEventsChronological = db.prepare(`
  SELECT id, type, trip, shift, timestamp, lat, lng, payload_json, created_at
  FROM events
  ORDER BY timestamp ASC, created_at ASC
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (id, trip_id, vehicle_id, type, title, description, lat, lng, status)
  VALUES (@id, @trip_id, @vehicle_id, @type, @title, @description, @lat, @lng, @status)
`);

const selectTasks = db.prepare(`
  SELECT id, created_at, accepted_at, picked_up_at, done_at, cancelled_at,
    trip_id, vehicle_id, type, title, description, lat, lng, status
  FROM tasks
  WHERE (@status IS NULL OR status = @status)
  ORDER BY created_at DESC
  LIMIT @limit
`);

const updateTaskStatusStmt = db.prepare(`
  UPDATE tasks SET status = @status WHERE id = @id
`);

const updateTaskStmt = db.prepare(`
  UPDATE tasks SET
    trip_id = @trip_id,
    vehicle_id = @vehicle_id,
    type = @type,
    title = @title,
    description = @description,
    lat = @lat,
    lng = @lng,
    status = @status
  WHERE id = @id
`);

const deleteTaskStmt = db.prepare('DELETE FROM tasks WHERE id = @id');

function selectTasksFiltered(statuses, limit) {
  if (!statuses || statuses.length === 0) {
    return selectTasks.all({ status: null, limit });
  }
  if (statuses.length === 1) {
    return selectTasks.all({ status: statuses[0], limit });
  }
  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, created_at, trip_id, vehicle_id, type, title, description, lat, lng, status
    FROM tasks
    WHERE status IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...statuses, limit);
}

function getActiveTrips() {
  const rows = selectEventsChronological.all();
  let openTrip = null;

  for (const row of rows) {
    const tripId = row.trip;
    if (!tripId) continue;

    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }

    if (TRIP_START_TYPES.has(row.type)) {
      openTrip = {
        trip: tripId,
        shift: row.shift || payload.shift || null,
        started_at: row.timestamp,
        driver_id: payload.driver_id || null,
        driver_name: payload.driver_name || null,
        vehicle_id: payload.vehicle_id || null,
        vehicle_name: payload.vehicle_name || null,
        city: payload.city || null,
        schedule: payload.schedule || null,
        start_lat: row.lat,
        start_lng: row.lng,
        active: true,
      };
      continue;
    }

    if (TRIP_END_TYPES.has(row.type)) {
      if (!openTrip) continue;
      if (row.trip === openTrip.trip) {
        openTrip = null;
      }
    }
  }

  return openTrip ? [openTrip] : [];
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/vendor', express.static(path.join(__dirname, 'vendor')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/events', (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : [body];
  const saved = [];
  const errors = [];

  const insertMany = db.transaction((list) => {
    for (let i = 0; i < list.length; i += 1) {
      const normalized = normalizeIncomingEvent(list[i]);
      if (!normalized) {
        errors.push({ index: i, message: 'Invalid event (type required)' });
        continue;
      }
      insertEvent.run(normalized);
      saved.push(normalized.id);
    }
  });

  try {
    insertMany(items);
    res.status(201).json({
      ok: true,
      received: items.length,
      saved: saved.length,
      ids: saved,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('POST /api/events failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to store events' });
  }
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 500);
  const rows = selectRecentEvents.all(limit);
  res.json({
    ok: true,
    count: rows.length,
    events: rows.map(rowToClient),
  });
});

function activeTripIdsFromEvents(events) {
  const open = new Map();
  const sorted = (events || []).slice().sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  sorted.forEach((ev) => {
    const trip = ev.trip != null ? String(ev.trip).trim() : '';
    if (!trip) return;
    const type = String(ev.type || '').trim();
    if (TRIP_START_TYPES.has(type)) open.set(trip, true);
    if (TRIP_END_TYPES.has(type)) open.delete(trip);
  });
  return open;
}

function buildVehiclePositionsFromEvents(events) {
  const vehicles = readVehicles();
  const capById = {};
  vehicles.forEach((v) => {
    const id = v.vehicle_id || v.id;
    if (id) capById[id] = Math.max(1, parseInt(v.capacity, 10) || REPORT_DEFAULT_CAPACITY);
  });
  const activeTrips = activeTripIdsFromEvents(events);
  const tripStart = {};
  const byTrip = {};
  (events || []).forEach((ev) => {
    const trip = ev.trip != null ? String(ev.trip).trim() : '';
    if (!trip) return;
    const type = String(ev.type || '').trim();
    if (type === 'trip_start' || type === 'jarat_inditas') {
      const p = ev.payload || ev;
      tripStart[trip] = {
        vehicle_id: p.vehicle_id || ev.vehicle_id || trip,
        vehicle_name: p.vehicle_name || ev.vehicle_name || null,
        city: p.city || null,
      };
    }
    if (type !== 'track' && type !== 'auto_track') return;
    if (ev.lat == null || ev.lng == null) return;
    const ts = ev.timestamp || '';
    if (!byTrip[trip] || ts > (byTrip[trip].timestamp || '')) {
      byTrip[trip] = ev;
    }
  });
  return Object.keys(byTrip)
    .filter((trip) => activeTrips.has(trip) && tripStart[trip])
    .map((trip) => {
    const ev = byTrip[trip];
    const meta = tripStart[trip] || {};
    const vehicleId = meta.vehicle_id || trip;
    const cap = capById[vehicleId] || REPORT_DEFAULT_CAPACITY;
    let passengers = 0;
    (events || []).forEach((e) => {
      if (e.trip !== trip) return;
      const t = String(e.type || '');
      if (t === 'passenger' || t === 'utas') {
        const p = e.payload || e;
        if (p.passengers_current != null) passengers = p.passengers_current;
      }
    });
    const free = Math.max(0, cap - passengers);
    return {
      vehicle: vehicleId,
      vehicle_name: meta.vehicle_name || vehicleId,
      trip,
      city: meta.city || null,
      passengers,
      free,
      capacity: cap,
      lat: ev.lat,
      lng: ev.lng,
      last_gps: ev.timestamp || null,
      live: true,
    };
  });
}

app.get('/api/vehicles', (_req, res) => {
  const vehicles = readVehicles();
  res.json({ ok: true, count: vehicles.length, vehicles });
});

app.get('/api/drivers', (_req, res) => {
  const drivers = readDrivers();
  res.json({ ok: true, count: drivers.length, drivers });
});

app.get('/api/vehicle-positions', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1500, 1), 500);
  const rows = selectRecentEvents.all(limit);
  const events = rows.map(rowToClient);
  let positions = buildVehiclePositionsFromEvents(events);
  const city = req.query.city != null ? String(req.query.city).trim() : '';
  if (city) {
    positions = filterRowsByCity(positions, city);
  }
  res.json({ ok: true, count: positions.length, vehicles: positions });
});

app.put('/api/vehicles', (req, res) => {
  const body = req.body;
  const list = Array.isArray(body) ? body : (body && body.vehicles);
  if (!Array.isArray(list)) {
    return res.status(400).json({ ok: false, error: 'vehicles array required' });
  }
  try {
    const saved = writeVehicles(list);
    res.json({ ok: true, count: saved.length, vehicles: saved });
  } catch (err) {
    console.error('PUT /api/vehicles failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save vehicles' });
  }
});

app.get('/api/admin/trips', (_req, res) => {
  const trips = getActiveTrips();
  res.json({
    ok: true,
    count: trips.length,
    trips,
  });
});

app.get('/api/tasks', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const statuses = parseTaskStatusQuery(req.query.status);
  const rows = selectTasksFiltered(statuses, limit);
  res.json({
    ok: true,
    count: rows.length,
    tasks: rows.map(rowToTaskClient),
  });
});

app.patch('/api/tasks/:id/status', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ ok: false, error: 'id required' });
  }
  const status = req.body && req.body.status != null ? String(req.body.status).trim() : '';
  if (!TASK_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, error: 'status must be pending, accepted, picked_up, done, or cancelled' });
  }
  try {
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    const prevStatus = String(existing.status || '').trim();
    if (status === 'picked_up' && prevStatus === 'picked_up') {
      return res.json({ ok: true, task: rowToTaskClient(existing) });
    }
    if (status === 'picked_up' && prevStatus !== 'accepted') {
      return res.status(409).json({
        ok: false,
        error: 'picked_up only allowed from accepted',
        current_status: prevStatus,
      });
    }
    const tsCol = TASK_STATUS_TS_COLUMN[status];
    const now = new Date().toISOString();
    let result;
    if (tsCol) {
      result = db.prepare(`UPDATE tasks SET status = ?, ${tsCol} = ? WHERE id = ?`).run(status, now, id);
    } else {
      result = updateTaskStatusStmt.run({ id, status });
    }
    if (!result.changes) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const client = rowToTaskClient(row);
    console.log('[tasks] PATCH status', id, prevStatus, '->', client.status);
    res.json({ ok: true, task: client });
  } catch (err) {
    console.error('PATCH /api/tasks/:id/status failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to update task status' });
  }
});

app.patch('/api/tasks/:id', (req, res) => {
  const paramId = String(req.params.id || '').trim();
  const normalized = normalizeTaskUpdate(Object.assign({}, req.body, { id: paramId }));
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'invalid task update (title required)' });
  }
  try {
    const result = updateTaskStmt.run(normalized);
    if (!result.changes) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(paramId);
    res.json({ ok: true, task: rowToTaskClient(row) });
  } catch (err) {
    console.error('PATCH /api/tasks/:id failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to update task' });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ ok: false, error: 'id required' });
  }
  try {
    const result = deleteTaskStmt.run({ id });
    if (!result.changes) {
      return res.status(404).json({ ok: false, error: 'task not found' });
    }
    res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('DELETE /api/tasks/:id failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete task' });
  }
});

app.post('/api/tasks', (req, res) => {
  const normalized = normalizeIncomingTask(req.body);
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'title required' });
  }
  try {
    insertTask.run(normalized);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(normalized.id);
    res.status(201).json({ ok: true, task: rowToTaskClient(row) });
  } catch (err) {
    console.error('POST /api/tasks failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to store task' });
  }
});

app.get('/api/driver/bookings', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const city = req.query.city != null ? String(req.query.city).trim() : '';
  try {
    const scheduled = filterRowsByCity(selectScheduled.all(limit), city).map(rowToScheduled);
    const boarding = filterRowsByCity(selectBoardingActive.all(limit), city).map(rowToBoarding);
    const custom = filterRowsByCity(selectCustom.all(limit), city).map(rowToCustom);
    res.json({ ok: true, scheduled, boarding, custom });
  } catch (err) {
    console.error('GET /api/driver/bookings failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load bookings' });
  }
});

app.patch('/api/driver/bookings/scheduled/:id/seen', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  try {
    markScheduledSeen.run({ id, seen_at: new Date().toISOString() });
    const updated = getScheduledById.get(id);
    if (!updated) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, reservation: rowToScheduled(updated) });
  } catch (err) {
    console.error('PATCH scheduled seen failed:', err);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

app.patch('/api/driver/bookings/boarding/:id/respond', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const response = req.body && req.body.response != null ? String(req.body.response).trim() : '';
  if (!BOARDING_DRIVER_RESPONSES.has(response)) {
    return res.status(400).json({ ok: false, error: 'response must be can_stop, full, unsafe, not_on_route, or other' });
  }
  try {
    const result = respondBoarding.run({ id, driver_response: response });
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not found or already handled' });
    const updated = getBoardingById.get(id);
    res.json({ ok: true, boarding: rowToBoarding(updated) });
  } catch (err) {
    console.error('PATCH boarding respond failed:', err);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

app.get('/api/admin/bookings', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  try {
    res.json({
      ok: true,
      scheduled: selectScheduled.all(limit).map(rowToScheduled),
      boarding: selectBoarding.all(limit).map(rowToBoarding),
      custom: selectCustom.all(limit).map(rowToCustom),
    });
  } catch (err) {
    console.error('GET /api/admin/bookings failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load bookings' });
  }
});

app.post('/api/reservations', (req, res) => {
  const row = normalizePublicReservation(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'time, stop_name and valid +36 phone required' });
  }
  try {
    insertScheduled.run(row);
    res.status(201).json({ ok: true, reservation: rowToScheduled(row) });
  } catch (err) {
    console.error('POST /api/reservations failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save reservation' });
  }
});

app.post('/api/boarding-requests', (req, res) => {
  const row = normalizePublicBoarding(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'stop_name and valid +36 phone required' });
  }
  try {
    insertBoarding.run(row);
    res.status(201).json({ ok: true, boarding: rowToBoarding({ ...row, status: 'active' }) });
  } catch (err) {
    console.error('POST /api/boarding-requests failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save boarding request' });
  }
});

app.patch('/api/admin/bookings/scheduled/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const existing = getScheduledById.get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'not found' });
  const body = req.body || {};
  const action = body.action != null ? String(body.action).trim() : '';
  try {
    if (action === 'accept') {
      updateScheduledStatus.run({ id, status: 'accepted' });
    } else if (action === 'delete') {
      updateScheduledStatus.run({ id, status: 'cancelled' });
    } else if (action === 'modify') {
      updateScheduledFields.run({
        id,
        time: body.time != null ? String(body.time).trim() : existing.time,
        stop_name: body.stop_name != null ? String(body.stop_name).trim() : existing.stop_name,
        passenger_count: Math.max(1, parseInt(body.passenger_count != null ? body.passenger_count : existing.passenger_count, 10) || 1),
        phone: body.phone != null ? (normalizeHuPhone(body.phone) || existing.phone) : existing.phone,
        status: 'modified',
        note: body.note != null ? String(body.note).trim() : (existing.note || ''),
      });
    } else if (body.status && RESERVATION_STATUSES.has(String(body.status))) {
      updateScheduledStatus.run({ id, status: String(body.status) });
    } else {
      return res.status(400).json({ ok: false, error: 'action must be accept, modify, or delete' });
    }
    const updated = getScheduledById.get(id);
    res.json({ ok: true, reservation: rowToScheduled(updated) });
  } catch (err) {
    console.error('PATCH scheduled booking failed:', err);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

app.patch('/api/admin/bookings/boarding/:id/dismiss', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  try {
    const result = dismissBoarding.run({ id });
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('PATCH boarding dismiss failed:', err);
    res.status(500).json({ ok: false, error: 'Dismiss failed' });
  }
});

app.get('/api/reports/daily', (req, res) => {
  const date = parseReportDate(req.query.date);
  const vehicleId = req.query.vehicle_id != null ? String(req.query.vehicle_id).trim() : '';
  try {
    const rows = buildDailyVehicleReport(date, vehicleId || null);
    const totals = rows.reduce((acc, r) => {
      acc.passengers += r.passengers;
      acc.revenue_huf += r.revenue_huf;
      return acc;
    }, { passengers: 0, revenue_huf: 0 });
    res.json({
      ok: true,
      date,
      vehicle_id: vehicleId || null,
      capacity_default: REPORT_DEFAULT_CAPACITY,
      ticket_price_huf: REPORT_TICKET_PRICE_HUF,
      rows,
      totals,
    });
  } catch (err) {
    console.error('GET /api/reports/daily failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to build report' });
  }
});

app.get('/api/reports/daily.csv', (req, res) => {
  const date = parseReportDate(req.query.date);
  const vehicleId = req.query.vehicle_id != null ? String(req.query.vehicle_id).trim() : '';
  try {
    const rows = buildDailyVehicleReport(date, vehicleId || null);
    const header = ['datum', 'jarmu_id', 'jarmu_nev', 'utasszam', 'kapacitas', 'szabad_hely', 'kihasznaltsag_pct', 'bevetel_huf'];
    const lines = [header.join(';')];
    rows.forEach((r) => {
      lines.push([
        r.date,
        r.vehicle_id,
        r.vehicle_name,
        r.passengers,
        r.capacity,
        r.free_seats,
        r.utilization_pct,
        r.revenue_huf,
      ].join(';'));
    });
    const csv = '\uFEFF' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="napi_report_${date}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('GET /api/reports/daily.csv failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to export CSV' });
  }
});

app.get('/api/service-records', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  try {
    res.json({
      ok: true,
      records: selectServiceRecords.all(limit).map(rowToServiceRecord),
    });
  } catch (err) {
    console.error('GET /api/service-records failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load service records' });
  }
});

app.post('/api/service-records', (req, res) => {
  const row = normalizeServiceRecordInput(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'vehicle_id, service_type required' });
  }
  try {
    insertServiceRecord.run(row);
    res.status(201).json({ ok: true, record: rowToServiceRecord(row) });
  } catch (err) {
    console.error('POST /api/service-records failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save service record' });
  }
});

app.get('/api/driver-notes', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  try {
    res.json({
      ok: true,
      notes: selectDriverNotes.all(limit).map(rowToDriverNote),
    });
  } catch (err) {
    console.error('GET /api/driver-notes failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load driver notes' });
  }
});

app.post('/api/driver-notes', (req, res) => {
  const row = normalizeDriverNoteInput(req.body);
  if (!row) {
    return res.status(400).json({ ok: false, error: 'vehicle_id, category, note required' });
  }
  try {
    insertDriverNote.run(row);
    const saved = selectDriverNoteById.get(row.id);
    res.status(201).json({ ok: true, note: rowToDriverNote(saved || row) });
  } catch (err) {
    console.error('POST /api/driver-notes failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save driver note' });
  }
});

app.get('/routes/:filename', (req, res, next) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename !== req.params.filename) {
    return res.status(400).json({ ok: false, error: 'Invalid filename' });
  }
  const filePath = path.join(routesDir, filename);
  if (!fs.existsSync(filePath)) {
    return next();
  }
  if (filename.toLowerCase().endsWith('.geojson')) {
    res.type('application/geo+json');
  }
  return res.sendFile(filePath, (err) => {
    if (err) next(err);
  });
});

app.use(
  '/routes',
  express.static(routesDir, {
    index: false,
    dotfiles: 'deny',
    fallthrough: true,
  })
);

app.get(['/admin.html', '/admin'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Operativ Navigator API listening on port ${PORT}`);
  console.log(`Database: ${DATABASE_PATH}`);
  logRoutesStartup();
});
