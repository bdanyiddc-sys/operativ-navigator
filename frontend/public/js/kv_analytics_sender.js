/**
 * Kisvonat Navigator – public analitikai sender (v2)
 * Hozzájárulás + VISITOR mintavételezés + kv_analytics_event interakciók Firestore-ba.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js';
import { getFirestore, collection, addDoc } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';

const VERSION = '2.0';
const POPUP_DEDUP_MS = 5000;
const POPUP_OPEN_EVENT_TYPES = new Set([
  'ROUTE_VIEW',
  'STOP_POPUP_OPEN',
  'TRAIN_POPUP_OPEN',
  'BOARDING_SHEET_OPEN',
]);
const CONSENT_STORAGE_KEY = 'kv_analytics_consent_v1';
const SESSION_STORAGE_KEY = 'kv_analytics_session_v1';
const ENTRY_SOURCE_STORAGE_KEY = 'kv_analytics_entry_source_v1';

let config = null;
let firebaseApp = null;
let firestoreDb = null;
let firebaseAuth = null;
let authReadyPromise = null;
let sampleTimerId = null;
let initialized = false;
let analyticsListenerRegistered = false;
const popupDedupMap = new Map();

function getConfig() {
  if (!config) {
    config = window.KV_ANALYTICS_CONFIG || {};
  }
  return config;
}

function logStatus(...args) {
  console.info('[KV Analytics]', ...args);
}

function debugLog(...args) {
  if (getConfig().debug) {
    console.info('[KV Analytics]', ...args);
  }
}

function debugError(...args) {
  if (getConfig().debug) {
    console.error('[KV Analytics]', ...args);
  }
}

function reportAnalyticsError(label, error) {
  const msg = error && error.message ? error.message : String(error || 'ismeretlen hiba');
  const code = error && error.code ? error.code : '';
  console.error('[KV Analytics]', label, msg, code ? '(' + code + ')' : '');
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') {
    console.warn('[KV Analytics] → Firebase Console: Authentication → Sign-in method → Anonymous → Enable');
  }
  if (code === 'permission-denied') {
    console.warn('[KV Analytics] → Firebase Console: Firestore Rules → engedélyezd a create-et request.auth != null esetén az analytics_events kollekcióra');
  }
}

function readConsent() {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !['geo', 'no_location', 'denied'].includes(parsed.mode)) return null;
    return parsed.mode;
  } catch {
    return null;
  }
}

function saveConsent(mode) {
  localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ mode, savedAt: Date.now() }));
}

function getOrCreateSessionId() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.id) {
        ensureEntrySourceForSession(parsed.id);
        return parsed.id;
      }
    }
  } catch {
    /* új session */
  }
  const id = crypto.randomUUID();
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ id, createdAt: Date.now() }));
  captureEntrySourceForSession(id);
  return id;
}

function readPageQueryParams() {
  try {
    return new URLSearchParams(window.location.search || '');
  } catch {
    return new URLSearchParams();
  }
}

function buildPageUrlWithQuery() {
  const path = window.location.pathname || '/';
  const search = window.location.search || '';
  return search ? path + search : path;
}

function captureEntrySourceForSession(sessionId) {
  if (!sessionId) return null;
  const storageKey = ENTRY_SOURCE_STORAGE_KEY + '_' + sessionId;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return JSON.parse(existing);
  } catch {
    /* új rögzítés */
  }

  const params = readPageQueryParams();
  const qrId = params.get('qr_id') || params.get('src') || params.get('qr') || null;
  const utmSource = params.get('utm_source') || null;
  const utmMedium = params.get('utm_medium') || null;
  const utmCampaign = params.get('utm_campaign') || null;
  const campaignId = params.get('campaign_id') || utmCampaign || null;
  const entryCity = params.get('city') || null;
  const entryStopId = params.get('stop_id') || null;

  let entrySource = null;
  if (qrId) entrySource = 'qr';
  else if (utmSource || utmMedium || utmCampaign || campaignId) entrySource = 'campaign';
  else if (safeReferrerOrigin()) entrySource = 'referrer';
  else if (params.toString()) entrySource = 'direct';

  const snapshot = {
    entry_source: entrySource,
    qr_id: qrId,
    campaign_id: campaignId,
    entry_city: entryCity,
    entry_stop_id: entryStopId,
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    captured_at: Date.now(),
  };

  const hasData = Object.keys(snapshot).some(function (key) {
    return key !== 'captured_at' && snapshot[key] != null && snapshot[key] !== '';
  });
  if (!hasData) return null;

  try {
    sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    /* sessionStorage teli */
  }
  return snapshot;
}

function ensureEntrySourceForSession(sessionId) {
  try {
    const storageKey = ENTRY_SOURCE_STORAGE_KEY + '_' + sessionId;
    if (sessionStorage.getItem(storageKey)) return;
  } catch {
    /* */
  }
  captureEntrySourceForSession(sessionId);
}

function readEntrySourceSnapshot() {
  const sessionId = getOrCreateSessionId();
  if (!sessionId) return null;
  const storageKey = ENTRY_SOURCE_STORAGE_KEY + '_' + sessionId;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return captureEntrySourceForSession(sessionId);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function attachEntrySourceFields(payload) {
  const snap = readEntrySourceSnapshot();
  if (!snap) return payload;
  if (snap.entry_source) payload.entry_source = snap.entry_source;
  if (snap.qr_id) payload.qr_id = snap.qr_id;
  if (snap.campaign_id) payload.campaign_id = snap.campaign_id;
  if (snap.entry_city) payload.entry_city = snap.entry_city;
  if (snap.entry_stop_id) payload.entry_stop_id = snap.entry_stop_id;
  if (snap.utm_source) payload.utm_source = snap.utm_source;
  if (snap.utm_medium) payload.utm_medium = snap.utm_medium;
  if (snap.utm_campaign) payload.utm_campaign = snap.utm_campaign;
  return payload;
}

function clearSessionAndTimers() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  if (sampleTimerId != null) {
    clearInterval(sampleTimerId);
    sampleTimerId = null;
  }
}

function isRentSurface() {
  return getConfig().analyticsMode === 'rent';
}

function readRentContext() {
  const cfg = getConfig();
  return {
    viewed_city: String(cfg.viewedCity || 'berles'),
    viewed_city_label: String(cfg.viewedCityLabel || 'Bérlés'),
    route_id: String(cfg.routeId || 'berles_inquiry'),
    route_label: String(cfg.routeLabel || 'Kisvonat bérlés – árajánlat'),
    train_id: null,
  };
}

function readCurrentPublicContext() {
  if (isRentSurface()) {
    return readRentContext();
  }

  const ctx = {
    viewed_city: null,
    viewed_city_label: null,
    route_id: null,
    route_label: null,
    train_id: null,
  };

  const activeChip = document.querySelector('#city-strip .city-chip.is-active');
  const cityId = activeChip && activeChip.dataset ? activeChip.dataset.city : null;
  if (cityId) ctx.viewed_city = String(cityId);

  const catalog = window.KVN_PUBLIC && window.KVN_PUBLIC.CITIES;
  if (ctx.viewed_city && Array.isArray(catalog)) {
    const city = catalog.find(function (c) { return c.id === ctx.viewed_city; });
    if (city) {
      ctx.viewed_city_label = city.label || null;
      if (city.file) {
        const stem = String(city.file).replace(/\.geojson$/i, '');
        ctx.route_id = ctx.viewed_city + '_' + stem;
        ctx.route_label = city.label ? city.label + ' · ' + stem : stem;
      }
    }
  }

  const popupTitle = document.querySelector('.leaflet-popup-content .train-popup .tp-title');
  if (popupTitle && popupTitle.textContent) {
    const title = popupTitle.textContent
      .replace(/^\s*🚂\s*/, '')
      .replace(/\s+járat\s*$/i, '')
      .trim();
    if (title) ctx.route_label = title;
  }

  document.querySelectorAll('.leaflet-popup-content .train-popup .tp-row').forEach(function (row) {
    const lbl = row.querySelector('.tp-lbl');
    if (lbl && String(lbl.textContent || '').trim() === 'Jármű') {
      const text = String(row.textContent || '').replace(/Jármű\s*/i, '').trim();
      if (text) ctx.train_id = text;
    }
  });

  return ctx;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitForPublicContext(maxMs) {
  const deadline = Date.now() + (maxMs || 10000);
  while (Date.now() < deadline) {
    const ctx = readCurrentPublicContext();
    if (ctx.viewed_city && ctx.route_id) return ctx;
    await sleep(400);
  }
  return readCurrentPublicContext();
}

function hasUsableContext(ctx) {
  return !!(ctx && (ctx.viewed_city || ctx.route_id));
}

function lastVisitStorageKey(ctx) {
  const cfg = getConfig();
  const tenant = String(cfg.tenant || 'kisvonat');
  const project = String(cfg.project || 'route_public');
  const city = ctx.viewed_city || 'none';
  const route = ctx.route_id || 'none';
  return 'kv_analytics_last_visit_' + tenant + '_' + project + '_' + city + '_' + route;
}

function canSendSample(ctx) {
  const cfg = getConfig();
  const interval = Number(cfg.sampleIntervalMs) || (30 * 60 * 1000);
  const key = lastVisitStorageKey(ctx);
  const last = Number(localStorage.getItem(key) || 0);
  return !last || Date.now() - last >= interval;
}

function markSampleSent(ctx) {
  localStorage.setItem(lastVisitStorageKey(ctx), String(Date.now()));
}

let cachedGeoSnapshot = null;
let cachedGeoAt = 0;
const GEO_CACHE_MS = 5 * 60 * 1000;

function attachLocationFields(payload, location) {
  if (!location) return payload;
  payload.lat = location.lat;
  payload.lng = location.lng;
  payload.raw_accuracy_m = location.raw_accuracy_m;
  payload.is_representative = location.is_representative;
  payload.location_mode = location.location_mode;
  payload.cell_size_m = Number(getConfig().cellSizeM) || 50;
  return payload;
}

async function resolveGeoSnapshot(consentMode) {
  if (consentMode !== 'geo') {
    return getLocationForNoLocationConsent();
  }
  const cellSizeM = Number(getConfig().cellSizeM) || 50;
  const maxAccuracyM = Number(getConfig().maxRepresentativeAccuracyM) || 500;
  const now = Date.now();
  if (cachedGeoSnapshot && cachedGeoSnapshot.lat != null && now - cachedGeoAt < GEO_CACHE_MS) {
    return cachedGeoSnapshot;
  }
  const snap = await getLocationForGeoConsent(cellSizeM, maxAccuracyM);
  if (snap.lat != null) {
    cachedGeoSnapshot = snap;
    cachedGeoAt = now;
  }
  return snap;
}

function quantizeToCell(latitude, longitude, cellSizeM) {
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos((latitude * Math.PI) / 180);
  const latStep = cellSizeM / metersPerDegreeLat;
  const lngStep = cellSizeM / metersPerDegreeLng;
  const cellLat = Math.round(latitude / latStep) * latStep;
  const cellLng = Math.round(longitude / lngStep) * lngStep;
  return {
    lat: Number(cellLat.toFixed(6)),
    lng: Number(cellLng.toFixed(6)),
  };
}

function getLocationForGeoConsent(cellSizeM, maxAccuracyM) {
  return new Promise(function (resolve) {
    if (!navigator.geolocation || !window.isSecureContext) {
      resolve({
        lat: null,
        lng: null,
        raw_accuracy_m: null,
        is_representative: false,
        location_mode: 'geolocation_unavailable',
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (position) {
        const rawAccuracy = Number(position.coords.accuracy);
        const cell = quantizeToCell(
          Number(position.coords.latitude),
          Number(position.coords.longitude),
          cellSizeM,
        );
        const accurate = Number.isFinite(rawAccuracy) && rawAccuracy <= maxAccuracyM;
        resolve({
          lat: cell.lat,
          lng: cell.lng,
          raw_accuracy_m: Number.isFinite(rawAccuracy) ? Math.round(rawAccuracy) : null,
          is_representative: accurate,
          location_mode: accurate
            ? 'consented_50m_cell'
            : 'consented_low_accuracy_non_representative',
        });
      },
      function () {
        resolve({
          lat: null,
          lng: null,
          raw_accuracy_m: null,
          is_representative: false,
          location_mode: 'geolocation_denied_or_error',
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 120000,
      },
    );
  });
}

function getLocationForNoLocationConsent() {
  return {
    lat: null,
    lng: null,
    raw_accuracy_m: null,
    is_representative: false,
    location_mode: 'consented_without_location',
  };
}

function safeReferrerOrigin() {
  try {
    if (!document.referrer) return null;
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}

async function ensureFirebaseReady() {
  if (firebaseApp && firestoreDb && firebaseAuth && firebaseAuth.currentUser) return;
  if (authReadyPromise) return authReadyPromise;

  authReadyPromise = (async function () {
    const cfg = getConfig();
    if (!cfg.firebaseConfig) throw new Error('firebaseConfig hiányzik');
    if (!cfg.firebaseConfig.projectId) throw new Error('firebaseConfig.projectId hiányzik');
    logStatus('Firebase inicializálás…', cfg.firebaseConfig.projectId);
    firebaseApp = initializeApp(
      cfg.firebaseConfig,
      'kv-analytics-sender-' + String(cfg.tenant || 'default'),
    );
    firestoreDb = getFirestore(firebaseApp);
    firebaseAuth = getAuth(firebaseApp);
    if (!firebaseAuth.currentUser) {
      logStatus('Anonim bejelentkezés…');
      await signInAnonymously(firebaseAuth);
    }
    logStatus('Firebase kész. UID:', firebaseAuth.currentUser && firebaseAuth.currentUser.uid);
  })();

  try {
    await authReadyPromise;
  } catch (error) {
    reportAnalyticsError('Firebase inicializálás / anonim auth sikertelen.', error);
    throw error;
  } finally {
    authReadyPromise = null;
  }
}

async function buildVisitorPayload(consentMode, context) {
  const cfg = getConfig();
  const cellSizeM = Number(cfg.cellSizeM) || 50;
  const maxAccuracyM = Number(cfg.maxRepresentativeAccuracyM) || 100;

  let location;
  if (consentMode === 'geo') {
    location = await resolveGeoSnapshot('geo');
  } else {
    location = getLocationForNoLocationConsent();
  }

  logStatus('VISITOR hely:', location.location_mode,
    location.lat != null ? (location.lat + ',' + location.lng) : 'nincs koordináta',
    location.raw_accuracy_m != null ? ('±' + location.raw_accuracy_m + 'm') : '');

  return attachEntrySourceFields({
    version: VERSION,
    tenant: String(cfg.tenant || 'kisvonat'),
    project: String(cfg.project || 'route_public'),
    event_type: 'VISITOR',
    sample_type: isRentSurface() ? 'page_open' : '30m_presence',
    source: String(cfg.source || (isRentSurface() ? 'rent' : 'public')),
    geo_role: isRentSurface() ? 'visitor_origin' : null,
    timestamp: new Date().toISOString(),
    viewed_city: context.viewed_city,
    viewed_city_label: context.viewed_city_label,
    route_id: context.route_id,
    route_label: context.route_label,
    train_id: context.train_id,
    lat: location.lat,
    lng: location.lng,
    cell_size_m: cellSizeM,
    raw_accuracy_m: location.raw_accuracy_m,
    is_representative: location.is_representative,
    location_mode: location.location_mode,
    session_id: getOrCreateSessionId(),
    page_url: buildPageUrlWithQuery(),
    referrer_origin: safeReferrerOrigin(),
  });
}

function popupDedupKey(eventType, detail) {
  if (eventType === 'ROUTE_VIEW') {
    return eventType + ':' + String(detail.route_id || detail.city || '');
  }
  if (eventType === 'STOP_POPUP_OPEN') {
    return eventType + ':' + String(detail.stop_id || detail.stop_name || '');
  }
  if (eventType === 'TRAIN_POPUP_OPEN') {
    return eventType + ':' + String(detail.train_id || '');
  }
  if (eventType === 'BOARDING_SHEET_OPEN') {
    return eventType + ':' + String(detail.sheet_type || '') + ':' + String(detail.stop_id || detail.stop_name || '');
  }
  return null;
}

function shouldSkipPopupDedup(eventType, detail) {
  if (!POPUP_OPEN_EVENT_TYPES.has(eventType)) return false;
  const key = popupDedupKey(eventType, detail);
  if (!key) return false;
  const now = Date.now();
  const last = popupDedupMap.get(key);
  if (last != null && now - last < POPUP_DEDUP_MS) return true;
  popupDedupMap.set(key, now);
  return false;
}

async function buildInteractionPayload(detail, consentMode) {
  const cfg = getConfig();
  const context = readCurrentPublicContext();
  const eventType = String(detail.event_type || '');

  const payload = {
    version: VERSION,
    tenant: String(cfg.tenant || 'kisvonat'),
    project: String(cfg.project || (isRentSurface() ? 'berles' : 'route_public')),
    timestamp: new Date().toISOString(),
    event_type: eventType,
    source: String(detail.source || cfg.source || (isRentSurface() ? 'rent' : 'public')),
    session_id: getOrCreateSessionId(),
    city: detail.city || context.viewed_city_label || null,
    route_id: detail.route_id || context.route_id || null,
    stop_id: detail.stop_id != null ? detail.stop_id : null,
    stop_name: detail.stop_name || null,
    viewed_city: context.viewed_city,
    viewed_city_label: context.viewed_city_label,
    route_label: context.route_label,
    train_id: detail.train_id != null ? detail.train_id : (context.train_id || null),
    boarding_type: detail.boarding_type || null,
    sheet_type: detail.sheet_type || null,
    count: detail.count != null ? detail.count : null,
    time: detail.time || null,
    error_message: detail.error_message || null,
    page_url: buildPageUrlWithQuery(),
    referrer_origin: safeReferrerOrigin(),
  };

  if (detail.geo_role) payload.geo_role = detail.geo_role;
  if (detail.booking_type) payload.booking_type = detail.booking_type;
  if (detail.point_index != null) payload.point_index = detail.point_index;
  if (detail.place_role) payload.place_role = detail.place_role;

  if (detail.lat != null && detail.lng != null &&
      (detail.geo_role === 'placed_pin' || String(eventType).indexOf('RENT_') === 0)) {
    payload.lat = Number(detail.lat);
    payload.lng = Number(detail.lng);
    payload.geo_role = detail.geo_role || 'placed_pin';
    payload.location_mode = 'map_placed_pin';
    payload.is_representative = true;
    if (consentMode === 'geo') {
      const visitorLoc = await resolveGeoSnapshot('geo');
      if (visitorLoc.lat != null) {
        payload.visitor_lat = visitorLoc.lat;
        payload.visitor_lng = visitorLoc.lng;
        payload.visitor_accuracy_m = visitorLoc.raw_accuracy_m;
      }
    }
  } else if (consentMode === 'geo') {
    const location = await resolveGeoSnapshot('geo');
    attachLocationFields(payload, location);
  }
  return attachEntrySourceFields(payload);
}

async function handleAnalyticsEvent(detail) {
  if (!detail || !detail.event_type) return;
  if (detail.event_type === 'VISITOR') return;

  if (getConfig().debug) {
    console.log('[ANALYTICS]', detail);
  }

  const consent = readConsent();
  if (!consent || consent === 'denied') {
    logStatus('Interakciós esemény kihagyva (consent:', consent || 'nincs', ')', detail.event_type);
    return;
  }

  if (shouldSkipPopupDedup(detail.event_type, detail)) {
    debugLog('Popup dedup kihagyva.', detail.event_type);
    return;
  }

  try {
    const payload = await buildInteractionPayload(detail, consent);
    if (getConfig().debug) {
      window.__kvAnalyticsPayloadLog = window.__kvAnalyticsPayloadLog || [];
      window.__kvAnalyticsPayloadLog.push(payload);
    }
    await ensureFirebaseReady();
    const collectionName = String(getConfig().collectionName || 'analytics_events');
    await addDoc(collection(firestoreDb, collectionName), payload);
    logStatus('Interakciós esemény elküldve:', detail.event_type);
    debugLog('Interakciós esemény elküldve.', payload);

    if (detail.event_type === 'ROUTE_VIEW' && consent === 'geo') {
      const sent = await sendVisitorEvent('geo', false);
      if (sent) {
        logStatus('Városváltás geo VISITOR elküldve:', readCurrentPublicContext().viewed_city);
      }
    }
  } catch (error) {
    reportAnalyticsError('Interakciós Firestore hiba.', error);
    debugError('Interakciós Firestore hiba.', error);
  }
}

function registerAnalyticsEventListener() {
  if (analyticsListenerRegistered) return;
  analyticsListenerRegistered = true;
  document.addEventListener('kv_analytics_event', function (event) {
    handleAnalyticsEvent(event.detail).catch(function (err) {
      debugError('kv_analytics_event hiba.', err);
    });
  });
}

async function sendVisitorEvent(consentMode, force) {
  if (consentMode === 'denied') return false;
  if (document.visibilityState !== 'visible') return false;

  const context = await waitForPublicContext( force ? 2000 : 10000);
  if (!hasUsableContext(context)) {
    debugLog('Kontextus hiányos, VISITOR esemény kihagyva.', context);
    return false;
  }
  if (!force && !canSendSample(context)) {
    debugLog('30 perces korlát aktív, küldés kihagyva.');
    return false;
  }

  try {
    const payload = await buildVisitorPayload(consentMode, context);
    const collectionName = String(getConfig().collectionName || 'analytics_events');
    if (getConfig().debug) {
      window.__kvAnalyticsPayloadLog = window.__kvAnalyticsPayloadLog || [];
      window.__kvAnalyticsPayloadLog.push(payload);
    }
    await ensureFirebaseReady();
    await addDoc(collection(firestoreDb, collectionName), payload);
    markSampleSent(context);
    logStatus('VISITOR esemény elküldve →', collectionName);
    debugLog('VISITOR esemény elküldve.', payload);
    return true;
  } catch (error) {
    reportAnalyticsError('Firestore küldési hiba (VISITOR). Ellenőrizd: Authentication → Anonymous BE, Firestore Rules.', error);
    debugError('Firestore küldési hiba.', error);
    return false;
  }
}

function startSamplingLoop(consentMode) {
  if (sampleTimerId != null) clearInterval(sampleTimerId);
  const interval = Number(getConfig().sampleIntervalMs) || (30 * 60 * 1000);
  sampleTimerId = setInterval(function () {
    sendVisitorEvent(consentMode, false);
  }, interval);
}

function injectConsentUi() {
  if (document.getElementById('kv-analytics-consent-root')) return;

  const style = document.createElement('style');
  style.textContent = [
    '#kv-analytics-consent-root{position:fixed;inset:0;z-index:2147483000;display:none;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.48);padding:16px;box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    '#kv-analytics-consent-root.kv-analytics-open{display:flex}',
    '.kv-analytics-card{width:min(720px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 24px 70px rgba(0,0,0,.28);color:#172033}',
    '.kv-analytics-title{font-size:21px;font-weight:800;margin:0 0 8px}',
    '.kv-analytics-intro{font-size:14px;line-height:1.55;margin:0;color:#475569}',
    '.kv-analytics-options{display:grid;gap:10px;margin-top:18px}',
    '.kv-analytics-option{border:1px solid #cbd5e1;border-radius:12px;padding:12px 14px;text-align:left;background:#fff;cursor:pointer}',
    '.kv-analytics-option:hover{filter:brightness(.98)}',
    '.kv-analytics-option-title{font-weight:800;font-size:14px;color:#1e293b}',
    '.kv-analytics-option-text{font-size:12px;line-height:1.45;color:#64748b;margin-top:4px}',
    '.kv-analytics-option.kv-analytics-primary{border-color:#0f766e;background:#f0fdfa}',
    '.kv-analytics-footer{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:14px;font-size:12px;color:#64748b}',
    '.kv-analytics-footer a{color:#0f766e;font-weight:700}',
    '#kv-analytics-privacy-btn{position:fixed;left:12px;bottom:12px;z-index:2147482000;border:1px solid #cbd5e1;background:rgba(255,255,255,.94);color:#334155;border-radius:999px;padding:8px 11px;font:600 12px system-ui;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.12)}',
    '@media(max-width:620px){.kv-analytics-card{padding:18px}.kv-analytics-title{font-size:19px}}',
  ].join('');
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'kv-analytics-consent-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = [
    '<section class="kv-analytics-card">',
    '<h2 class="kv-analytics-title" id="kv-analytics-consent-title">Analitikai adatgyűjtés</h2>',
    '<p class="kv-analytics-intro">Segíthet a kisvonat szolgáltatás fejlesztésében névtelen, összesített látogatási adatokkal. A választás később módosítható.</p>',
    '<div class="kv-analytics-options">',
    '<button type="button" class="kv-analytics-option kv-analytics-primary" data-kv-analytics-consent="geo">',
    '<div class="kv-analytics-option-title">Engedélyezem az anonim helyalapú analitikát</div>',
    '<div class="kv-analytics-option-text">A rendszer csak egy körülbelül 50 × 50 méteres területi cellát rögzít. A pontos hely nem kerül mentésre.</div>',
    '</button>',
    '<button type="button" class="kv-analytics-option" data-kv-analytics-consent="no_location">',
    '<div class="kv-analytics-option-title">Engedélyezem az analitikát helyadat nélkül</div>',
    '<div class="kv-analytics-option-text">A rendszer a meglátogatott várost és útvonalat méri, de a készülék helyét nem használja.</div>',
    '</button>',
    '<button type="button" class="kv-analytics-option" data-kv-analytics-consent="denied">',
    '<div class="kv-analytics-option-title">Nem engedélyezem az analitikát</div>',
    '<div class="kv-analytics-option-text">Nem történik analitikai adatküldés.</div>',
    '</button>',
    '</div>',
    '<div class="kv-analytics-footer">',
    '<span>A helymeghatározáshoz a böngésző külön engedélyt is kérhet.</span>',
    '<a href="' + escapeHtml(String(getConfig().privacyPolicyUrl || '/adatvedelem.html')) + '" target="_blank" rel="noopener">Adatkezelési tájékoztató</a>',
    '</div>',
    '</section>',
  ].join('');
  document.body.appendChild(root);

  const privacyBtn = document.createElement('button');
  privacyBtn.id = 'kv-analytics-privacy-btn';
  privacyBtn.type = 'button';
  privacyBtn.textContent = 'Adatvédelmi beállítások';
  privacyBtn.addEventListener('click', openConsentDialog);
  document.body.appendChild(privacyBtn);

  root.addEventListener('click', function (event) {
    const btn = event.target.closest('[data-kv-analytics-consent]');
    if (!btn) return;
    handleConsentChoice(btn.getAttribute('data-kv-analytics-consent'));
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function openConsentDialog() {
  const root = document.getElementById('kv-analytics-consent-root');
  if (root) root.classList.add('kv-analytics-open');
}

function closeConsentDialog() {
  const root = document.getElementById('kv-analytics-consent-root');
  if (root) root.classList.remove('kv-analytics-open');
}

async function handleConsentChoice(mode) {
  saveConsent(mode);
  closeConsentDialog();

  if (mode === 'denied') {
    clearSessionAndTimers();
    return;
  }

  getOrCreateSessionId();
  const forceOpen = isRentSurface();
  await sendVisitorEvent(mode, forceOpen);
  if (!isRentSurface()) {
    startSamplingLoop(mode);
  }
}

async function bootstrapSender() {
  if (initialized) return;
  initialized = true;

  try {
    logStatus('Sender v' + VERSION + ' indul. Oldal:', window.location.href);
    registerAnalyticsEventListener();
    injectConsentUi();
    captureEntrySourceForSession(getOrCreateSessionId());

    if (!isRentSurface()) {
      document.addEventListener('visibilitychange', function () {
        const consent = readConsent();
        if (!consent || consent === 'denied') return;
        if (document.visibilityState === 'visible') {
          sendVisitorEvent(consent, false);
        }
      });
    }

    const consent = readConsent();
    logStatus('Consent állapot:', consent || 'nincs (banner jön)', isRentSurface() ? '(bérlés)' : '');
    if (!consent) {
      openConsentDialog();
      return;
    }
    if (consent === 'denied') {
      logStatus('Analitika tiltva a felhasználó által – nincs küldés.');
      return;
    }

    getOrCreateSessionId();
    if (isRentSurface()) {
      await sendVisitorEvent(consent, true);
      return;
    }
    await sendVisitorEvent(consent, false);
    startSamplingLoop(consent);
  } catch (error) {
    reportAnalyticsError('Inicializálási hiba.', error);
    debugError('Inicializálási hiba.', error);
  }
}

async function testAnalyticsSend() {
  const consent = readConsent();
  if (!consent || consent === 'denied') {
    console.warn('[KV Analytics] Teszt küldéshez válaszd: geo vagy no_location (Adatvédelmi beállítások gomb)');
    return false;
  }
  logStatus('Kézi teszt küldés indul…');
  return sendVisitorEvent(consent, true);
}

if (typeof window !== 'undefined') {
  window.KV_ANALYTICS_TEST_SEND = testAnalyticsSend;
  window.KV_ANALYTICS_STATUS = function () {
    return {
      version: VERSION,
      consent: readConsent(),
      firebaseReady: !!(firebaseAuth && firebaseAuth.currentUser),
      collection: String(getConfig().collectionName || 'analytics_events'),
      projectId: getConfig().firebaseConfig && getConfig().firebaseConfig.projectId,
    };
  };
}

function startWhenReady() {
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        bootstrapSender().catch(function (err) { debugError('Bootstrap hiba.', err); });
      }, { once: true });
    } else {
      bootstrapSender().catch(function (err) { debugError('Bootstrap hiba.', err); });
    }
  } catch (error) {
    debugError('Betöltési hiba.', error);
  }
}

startWhenReady();

export { readCurrentPublicContext };
