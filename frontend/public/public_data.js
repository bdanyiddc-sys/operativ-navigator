/* KisvonatNavigator – public mock data & API stubs (swap for live API later) */
(function (global) {
    'use strict';

    var PUBLIC_VERSION = 'Public UI v0.9 - 2026.06.06';

    var PUBLIC_DEFAULT_CAPACITY = 56;

    var CITIES = [
        { id: 'tata', label: 'Tata', file: 'Tata_utvonal2.geojson', center: [47.649, 18.318], default: true },
        { id: 'eger', label: 'Eger', file: 'eger3.geojson', center: [47.902, 20.377] },
        { id: 'gyor', label: 'Győr', file: 'gyor1.geojson', center: [47.687, 17.635] },
        { id: 'papa', label: 'Pápa', file: 'papa1.geojson', center: [47.330, 17.467] },
        { id: 'szfv', label: 'Székesfehérvár', file: 'szfv1.geojson', center: [47.192, 18.411] },
        { id: 'vac', label: 'Vác', file: 'vac1.geojson', center: [47.775, 19.134] }
    ];

    var MOCK_STOPS = {
        tata: [
            { id: 'stop_tata_ind', name: 'Indulási pont', lat: 47.64982, lng: 18.31832, departures: ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'] },
            { id: 'stop_varmegallo', name: 'Vármegálló', lat: 47.6468, lng: 18.3285, departures: ['10:08', '11:08', '12:08', '13:08', '14:08', '15:08', '16:08'] },
            { id: 'stop_var', name: 'Tatai vár', lat: 47.64745, lng: 18.3192, departures: ['10:15', '11:15', '12:15', '13:15', '14:15', '15:15', '16:15'] },
            { id: 'stop_veg', name: 'Tata végállomás', lat: 47.64974, lng: 18.31824, departures: ['10:28', '11:28', '12:28', '13:28', '14:28', '15:28', '16:28'] }
        ],
        eger: [
            { id: 'stop_dobo', name: 'Dobó tér', lat: 47.9025, lng: 20.3771, departures: ['10:30', '12:30', '14:30'] },
            { id: 'stop_bazilika', name: 'Egri bazilika', lat: 47.8988, lng: 20.3812, departures: ['10:45', '12:45', '14:45'] }
        ],
        gyor: [
            { id: 'stop_gyor_kozpont', name: 'Városközpont', lat: 47.687, lng: 17.635, departures: ['11:00', '13:00', '16:00'] },
            { id: 'stop_gyor_var', name: 'Győri vár', lat: 47.6902, lng: 17.6385, departures: ['11:12', '13:12', '16:12'] }
        ],
        papa: [
            { id: 'stop_papa_kozpont', name: 'Pápa – Belváros', lat: 47.330, lng: 17.467, departures: ['10:00'] }
        ],
        szfv: [
            { id: 'stop_szfv_varoshaza', name: 'Városháza', lat: 47.192, lng: 18.411, departures: ['11:00', '13:00', '15:30'] },
            { id: 'stop_szfv_var', name: 'Városi liget', lat: 47.195, lng: 18.405, departures: ['11:10', '13:10', '15:40'] }
        ],
        vac: [
            { id: 'stop_vac_allomas', name: 'Vác állomás környéke', lat: 47.775, lng: 19.134, departures: ['10:00', '14:00'] }
        ]
    };

    var SCHEDULES_CACHE = {};

    var MOCK_WAITING = {
        tata: { stop_tata_ind: 0, stop_varmegallo: 4, stop_var: 2, stop_veg: 0 },
        eger: { stop_dobo: 1, stop_bazilika: 0 },
        gyor: { stop_gyor_kozpont: 0, stop_gyor_var: 0 },
        papa: { stop_papa_kozpont: 0 },
        szfv: { stop_szfv_varoshaza: 3, stop_szfv_var: 1 },
        vac: { stop_vac_allomas: 0 }
    };

    function getApiBase() {
        if (window.OPNAV_API_BASE) return window.OPNAV_API_BASE;
        var host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') {
            return 'http://localhost:3000';
        }
        return 'https://operativ-navigator.onrender.com';
    }

    var API_BASE = window.OPNAV_API_BASE || getApiBase();

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function mockStops(cityId) {
        return (MOCK_STOPS[cityId] || []).slice();
    }

    function mockSchedules(cityId) {
        return (SCHEDULES_CACHE[cityId] || []).slice();
    }

    function loadSchedulesCatalog() {
        var url = new URL('data/schedules.json', window.location.href).href;
        return fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                SCHEDULES_CACHE = data && typeof data === 'object' ? data : {};
                return SCHEDULES_CACHE;
            })
            .catch(function () {
                SCHEDULES_CACHE = {};
                return SCHEDULES_CACHE;
            });
    }

    function normalizeHuPhone(raw) {
        if (raw == null) return '';
        var p = String(raw).trim().replace(/[\s().-]/g, '');
        if (!p) return '';
        if (p.indexOf('00') === 0) p = '+' + p.slice(2);
        else if (p.indexOf('06') === 0) p = '+36' + p.slice(2);
        else if (/^36\d{9,}$/.test(p)) p = '+' + p;
        if (!/^\+36\d{9}$/.test(p)) return '';
        return p;
    }

    function isValidHuPhone(raw) {
        return !!normalizeHuPhone(raw);
    }

    function formatHuPhoneDisplay(raw) {
        var n = normalizeHuPhone(raw);
        if (!n) return String(raw || '').trim();
        var m = n.match(/^\+36(\d{2})(\d{3})(\d{3,4})$/);
        if (m) return '+36 ' + m[1] + ' ' + m[2] + ' ' + m[3];
        return n;
    }

    function freeSeatStatus(free, capacity) {
        var cap = capacity || PUBLIC_DEFAULT_CAPACITY;
        if (free <= 0) {
            return { text: 'Betelt', label: '🔴 Betelt', cls: 'bad', free: free, capacity: cap };
        }
        if (free <= Math.max(4, cap * 0.2)) {
            return { text: 'Kevés hely', label: '🟡 Kevés hely', cls: 'warn', free: free, capacity: cap };
        }
        return { text: 'Foglalható', label: '🟢 Foglalható', cls: 'ok', free: free, capacity: cap };
    }

    function getWaitingCount(cityId, stopId) {
        var city = MOCK_WAITING[cityId] || {};
        return city[stopId] != null ? city[stopId] : 0;
    }

    function loadStops(cityId) {
        return fetch(API_BASE + '/api/stops?city=' + encodeURIComponent(cityId || ''), {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) { return data.stops || data; })
            .catch(function () { return mockStops(cityId); });
    }

    function normalizeVehicleFromApi(v, cityId) {
        var cap = Math.max(1, parseInt(v.capacity, 10) || PUBLIC_DEFAULT_CAPACITY);
        var freeRaw = v.free_seats != null ? v.free_seats : (v.free != null ? v.free : v.freeSeats);
        var freeSeats = null;
        if (freeRaw != null && freeRaw !== '') {
            var parsedFree = parseInt(freeRaw, 10);
            if (!isNaN(parsedFree)) freeSeats = Math.max(0, parsedFree);
        }
        var passengers = null;
        if (v.passengers != null && v.passengers !== '') {
            var parsedPax = parseInt(v.passengers, 10);
            if (!isNaN(parsedPax)) passengers = Math.max(0, parsedPax);
        }
        var vid = String(v.vehicle || v.id || v.vehicle_id || '').trim();
        var lat = v.lat != null ? Number(v.lat) : null;
        var lng = v.lng != null ? Number(v.lng) : null;
        var live = v.live === true || (lat != null && lng != null && !isNaN(lat) && !isNaN(lng));
        return {
            id: vid || 'KV',
            trip: v.trip != null ? String(v.trip).trim() : '',
            city: v.city || cityId,
            cityId: cityId,
            lat: live ? lat : null,
            lng: live ? lng : null,
            capacity: cap,
            passengers: passengers,
            freeSeats: freeSeats,
            status: live ? 'Közlekedik' : 'Nem közlekedik',
            nextStop: v.nextStop || '—',
            nextDeparture: v.nextDeparture || '—',
            speedKmh: v.speed_kmh != null ? Number(v.speed_kmh) : null,
            lastGps: v.last_gps || v.timestamp || null,
            active: live,
            live: live
        };
    }

    function dedupeVehicleRowsById(list) {
        var byId = {};
        (list || []).forEach(function (raw) {
            var vid = String(raw.vehicle || raw.id || raw.vehicle_id || '').trim();
            if (!vid) return;
            var ts = raw.last_gps || raw.timestamp || '';
            var prev = byId[vid];
            if (!prev || String(ts) >= String(prev.last_gps || prev.timestamp || '')) {
                byId[vid] = raw;
            }
        });
        return Object.keys(byId).map(function (k) { return byId[k]; });
    }

    function loadVehicles(cityId) {
        return fetch(API_BASE + '/api/vehicle-positions?city=' + encodeURIComponent(cityId || ''), {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                var list = data.vehicles || data;
                if (!Array.isArray(list) || !list.length) return [];
                return dedupeVehicleRowsById(list).map(function (v) {
                    return normalizeVehicleFromApi(v, cityId);
                }).filter(function (v) { return v.live && v.lat != null && v.lng != null; });
            })
            .catch(function () { return []; });
    }

    function loadSchedules(cityId) {
        return fetch(API_BASE + '/api/schedules?city=' + encodeURIComponent(cityId || ''), {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) { return data.schedules || data; })
            .catch(function () { return mockSchedules(cityId); });
    }

    function loadReservations() {
        return fetch(API_BASE + '/api/reservations', {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .catch(function () { return []; });
    }

    function submitReservation(data) {
        return fetch(API_BASE + '/api/reservations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(data || {})
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    function submitBoardingRequest(data) {
        return fetch(API_BASE + '/api/boarding-requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(data || {})
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    function loadPoiCatalog() {
        var url = new URL('poi_catalog.json', window.location.href).href;
        return fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                return Array.isArray(data.pois) ? data.pois : [];
            })
            .catch(function () { return []; });
    }

    global.KVN_PUBLIC = {
        PUBLIC_VERSION: PUBLIC_VERSION,
        CITIES: CITIES,
        MOCK_STOPS: MOCK_STOPS,
        getSchedulesCatalog: function () { return SCHEDULES_CACHE; },
        getApiBase: getApiBase,
        API_BASE: API_BASE,
        normalizeHuPhone: normalizeHuPhone,
        isValidHuPhone: isValidHuPhone,
        formatHuPhoneDisplay: formatHuPhoneDisplay,
        freeSeatStatus: freeSeatStatus,
        getWaitingCount: getWaitingCount,
        loadStops: loadStops,
        loadVehicles: loadVehicles,
        loadSchedules: loadSchedules,
        loadReservations: loadReservations,
        submitReservation: submitReservation,
        submitBoardingRequest: submitBoardingRequest,
        loadPoiCatalog: loadPoiCatalog,
        loadSchedulesCatalog: loadSchedulesCatalog
    };
})(typeof window !== 'undefined' ? window : globalThis);
