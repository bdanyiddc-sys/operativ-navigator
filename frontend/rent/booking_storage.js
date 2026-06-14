/**
 * Operatív Navigator – Foglalási térkép közös localStorage réteg
 * Admin (index.html) és publikus (public_booking.html) ugyanazt az adatbázist használja.
 * Egy foglalás = egy rekord; státusz: ERDEKLODES → AJANLAT → VEGLEGES → TELJESITVE.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'opnav_foglalasi_terkep_v3';
  var STORAGE_KEY_LEGACY = 'opnav_foglalasi_terkep_v1';
  var MODULE_VERSION = '4.0.0';
  var DEFAULT_STATUS = 'ERDEKLODES';
  var DEFAULT_PENDING = 'FÜGGŐ';
  var DEFAULT_GEOMETRY_TYPE = 'POINT';

  function normalizeStatus(s) {
    var allowed = { ERDEKLODES: 1, AJANLAT: 1, VEGLEGES: 1, TELJESITVE: 1 };
    var v = String(s || DEFAULT_STATUS).toUpperCase();
    return allowed[v] ? v : DEFAULT_STATUS;
  }

  function normalizeBooking(b) {
    if (!b) return b;
    if (!b.vehicle) b.vehicle = DEFAULT_PENDING;
    if (!b.driver) b.driver = DEFAULT_PENDING;
    b.status = normalizeStatus(b.status);
    b.geometryType = b.geometryType === 'ROUTE' ? 'ROUTE' : DEFAULT_GEOMETRY_TYPE;
    return b;
  }

  function parseStorage(raw) {
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      return {
        version: data.version || MODULE_VERSION,
        bookings: (data.bookings || []).map(normalizeBooking),
        calculatedRoutes: Array.isArray(data.calculatedRoutes) ? data.calculatedRoutes : []
      };
    } catch (e) {
      return null;
    }
  }

  function loadAll() {
    var cur = parseStorage(global.localStorage.getItem(STORAGE_KEY));
    if (cur) return cur;
    var legacy = parseStorage(global.localStorage.getItem(STORAGE_KEY_LEGACY));
    if (legacy) return legacy;
    return { version: MODULE_VERSION, bookings: [], calculatedRoutes: [] };
  }

  function saveAll(data) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: data.version || MODULE_VERSION,
      updatedAt: new Date().toISOString(),
      bookings: (data.bookings || []).map(normalizeBooking),
      calculatedRoutes: data.calculatedRoutes || []
    }));
  }

  function nextBookingId(bookings) {
    var year = new Date().getFullYear();
    var n = (bookings || []).length + 1;
    (bookings || []).forEach(function (b) {
      var m = String(b.id || '').match(/FOG-\d{4}-(\d+)/);
      if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    });
    return 'FOG-' + year + '-' + String(n).padStart(4, '0');
  }

  /**
   * Publikus érdeklődés – nem listázza a meglévő foglalásokat, csak hozzáad.
   */
  function normalizeRouteDraft(draft) {
    if (!draft || draft.type !== 'LineString' || !Array.isArray(draft.coordinates)) return null;
    var coords = draft.coordinates.filter(function (c) {
      return Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1]);
    });
    if (coords.length < 2) return null;
    return { type: 'LineString', coordinates: coords };
  }

  function addPublicInquiry(payload) {
    var data = loadAll();
    var now = new Date().toISOString();
    var city = String(payload.city || '').trim();
    var address = String(payload.address || '').trim();
    var routeDraft = normalizeRouteDraft(payload.routeDraft);
    var isRoute = !!routeDraft;
    var lat = payload.lat != null ? payload.lat : null;
    var lng = payload.lng != null ? payload.lng : null;
    if (isRoute && routeDraft.coordinates.length) {
      lat = routeDraft.coordinates[0][1];
      lng = routeDraft.coordinates[0][0];
    }
    var note = String(payload.note || '').trim();
    if (isRoute) {
      note = (note ? note + '\n\n' : '') + '[Publikus útvonalterv – ' + routeDraft.coordinates.length + ' pont]';
    }
    var booking = normalizeBooking({
      id: nextBookingId(data.bookings),
      placeName: city || address,
      city: city,
      address: address,
      date: payload.date,
      timeStart: payload.timeStart,
      timeEnd: payload.timeEnd,
      headcount: parseInt(payload.headcount, 10) || 0,
      ordererName: String(payload.name || '').trim(),
      contact: String(payload.name || '').trim(),
      phone: String(payload.phone || '').trim(),
      email: String(payload.email || '').trim(),
      note: note,
      companyName: '',
      taxId: '',
      price: 0,
      status: DEFAULT_STATUS,
      vehicle: DEFAULT_PENDING,
      driver: DEFAULT_PENDING,
      geometryType: isRoute ? 'ROUTE' : DEFAULT_GEOMETRY_TYPE,
      routeGeometry: routeDraft,
      routeDraft: routeDraft,
      lat: lat,
      lng: lng,
      source: 'public',
      createdAt: now,
      updatedAt: now
    });
    data.bookings.push(booking);
    saveAll(data);
    return booking;
  }

  global.OPNAV_BOOKING_STORE = {
    STORAGE_KEY: STORAGE_KEY,
    MODULE_VERSION: MODULE_VERSION,
    DEFAULT_STATUS: DEFAULT_STATUS,
    DEFAULT_PENDING: DEFAULT_PENDING,
    DEFAULT_GEOMETRY_TYPE: DEFAULT_GEOMETRY_TYPE,
    loadAll: loadAll,
    saveAll: saveAll,
    addPublicInquiry: addPublicInquiry,
    nextBookingId: nextBookingId,
    normalizeBooking: normalizeBooking
  };
})(typeof window !== 'undefined' ? window : globalThis);
