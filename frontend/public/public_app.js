(function () {
    'use strict';

    var DATA = window.KVN_PUBLIC;
    if (!DATA) return;

    var WALK_SPEED_M_PER_MIN = 80;
    var ETA_FALLBACK_SPEED_KMH = 15;
    var GPS_ACCURACY_TRUST_M = 120;

    var state = {
        cityId: 'tata',
        cityLabel: 'Tata',
        vehicles: [],
        activeVehicle: null,
        stops: [],
        nearestStop: null,
        selectedStopId: null,
        schedule: [],
        pois: [],
        userPos: null,
        userAccuracy: null,
        gpsWatchId: null,
        devGis: false,
        routeBoardMode: false,
        bookPickMode: false,
        vehicleDataReady: false,
        popupContext: { stopId: '', selectedTime: '', showBoard: false }
    };

    var map, routeLayers, vehicleLayer, stopLayer, poiLayer, userLayer;
    var baseMapLayers = {};
    var activeBaseMapKey = 'Voyager';
    var geojsonAudit = { loaded: [], missing: [], total: 0, baseMaps: [] };
    var stopMarkers = {};
    var openPopupStopId = null;

    var elStatusLine, elPeekStop, elPeekStopMeta;
    var elToast, elVersion;
    var elBoardSheet, elBoardSheetStopName, elBoardSheetArrival, elBoardSheetMeta;
    var elBoardSheetPhoneWrap, elBoardSheetPhone, elBoardSheetCta;
    var mobileBoardContext = null;
    var BOARD_PHONE_KEY = 'kv_board_phone';

    function $(id) { return document.getElementById(id); }

    function analyticsRouteId() {
        var city = DATA.CITIES.find(function (c) { return c.id === state.cityId; });
        if (!city || !city.file) return state.cityId || null;
        return state.cityId + '_' + String(city.file).replace(/\.geojson$/i, '');
    }

    function emitAnalyticsEvent(detail) {
        document.dispatchEvent(new CustomEvent('kv_analytics_event', {
            detail: Object.assign({
                city: state.cityLabel,
                route_id: analyticsRouteId(),
                source: 'public'
            }, detail || {})
        }));
    }

    function isMobileUi() {
        return window.matchMedia('(max-width: 767px)').matches;
    }

    function routeHitLineWeight() {
        return isMobileUi() ? 44 : 22;
    }

    function stopIconDimensions() {
        if (isMobileUi()) return { size: [26, 26], anchor: [13, 13] };
        return { size: [24, 24], anchor: [12, 12] };
    }

    function refreshRouteHitLayer() {
        if (!routeLayers || !routeLayers.hit) return;
        var w = routeHitLineWeight();
        routeLayers.hit.eachLayer(function (layer) {
            if (layer.setStyle) {
                layer.setStyle({ color: 'transparent', weight: w, opacity: 0.01 });
            }
        });
    }

    function toast(msg) {
        if (!elToast) return;
        elToast.textContent = msg;
        elToast.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(function () { elToast.classList.remove('show'); }, 2800);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function haversineM(lat1, lng1, lat2, lng2) {
        var R = 6371000;
        var p = Math.PI / 180;
        var a = 0.5 - Math.cos((lat2 - lat1) * p) / 2 +
            Math.cos(lat1 * p) * Math.cos(lat2 * p) * (1 - Math.cos((lng2 - lng1) * p)) / 2;
        return R * 2 * Math.asin(Math.sqrt(a));
    }

    function formatWalkTime(m) {
        if (m == null || isNaN(m)) return '—';
        var min = Math.max(1, Math.round(m / WALK_SPEED_M_PER_MIN));
        if (min < 60) return min + ' perc';
        return Math.floor(min / 60) + ' óra ' + (min % 60) + ' perc';
    }

    function seatStatus(free, capacity) {
        return DATA.freeSeatStatus(free, capacity);
    }

    function seatsClass(seats) {
        var s = String(seats || '').toLowerCase();
        if (s.indexOf('telít') >= 0 || s.indexOf('betelt') >= 0 || s.indexOf('nincs') >= 0) return 'bad';
        if (s.indexOf('kevés') >= 0) return 'warn';
        return '';
    }

    function seatEmoji(st) {
        if (!st) return '🟢';
        if (st.cls === 'bad') return '🔴';
        if (st.cls === 'warn') return '🟡';
        return '🟢';
    }

    function seatsCountLabel(v) {
        if (!v || !v.active || v.freeSeats == null) return '— hely';
        var cap = v.capacity || 56;
        return String(v.freeSeats) + ' / ' + cap + ' szabad';
    }

    function estimateEtaMinutes(distanceM, speedKmh) {
        if (distanceM == null || distanceM <= 40) return 0;
        var speed = (speedKmh != null && speedKmh > 1) ? speedKmh : ETA_FALLBACK_SPEED_KMH;
        return (distanceM / 1000) / speed * 60;
    }

    function formatEtaBand(minutes) {
        if (minutes == null || minutes <= 0) return 'Megérkezett';
        if (minutes <= 5) return 'Kb. 3-5 percen belül érkezik';
        if (minutes <= 10) return 'Kb. 5-10 percen belül érkezik';
        if (minutes <= 15) return 'Kb. 10-15 percen belül érkezik';
        return null;
    }

    /** Jármű → kiválasztott / legközelebbi megálló (utas indulási döntéshez) */
    function getVehicleToStopDistanceM() {
        var v = state.activeVehicle;
        var stop = getDisplayStop();
        if (!v || !v.live || v.lat == null || v.lng == null) return null;
        if (!stop || stop.lat == null || stop.lng == null) return null;
        return haversineM(v.lat, v.lng, stop.lat, stop.lng);
    }

    function getTrainProximityLabel() {
        var dist = getVehicleToStopDistanceM();
        if (dist == null) return null;
        if (dist <= 40) return 'Megérkezett';
        if (dist <= 250) return 'A közelben';
        if (dist <= 700) return 'Közeledik';
        return 'Közlekedik';
    }

    function getTrainArrivalLineForStop(stop) {
        var v = state.activeVehicle;
        if (!v || !v.live || v.lat == null || v.lng == null) return null;
        if (!stop || stop.lat == null || stop.lng == null) return null;
        var dist = haversineM(v.lat, v.lng, stop.lat, stop.lng);
        if (dist <= 40) return 'Megérkezett';
        var min = estimateEtaMinutes(dist, v.speedKmh != null ? v.speedKmh : null);
        var band = formatEtaBand(min);
        if (band) return band;
        if (dist <= 250) return 'A közelben';
        if (dist <= 700) return 'Közeledik';
        return 'Közlekedik';
    }

    function getTrainArrivalLine() {
        return getTrainArrivalLineForStop(getDisplayStop());
    }

    function popupSeatsLine() {
        var v = state.activeVehicle;
        if (!state.vehicleDataReady) return 'Adat betöltése…';
        if (!v || !v.active || v.freeSeats == null) return '— szabad hely';
        var st = seatStatus(v.freeSeats, v.capacity);
        if (st.cls === 'bad') return '🔴 Betelt';
        if (st.cls === 'warn') return '🟡 Kevés hely';
        return '🟢 ' + String(v.freeSeats) + ' szabad hely';
    }

    function getWaitingLine(stopId) {
        var n = DATA.getWaitingCount(state.cityId, stopId);
        return '👥 ' + String(n) + ' fő várakozik';
    }

    function nextDepartureFromVehicle() {
        var v = state.activeVehicle;
        return v && v.active ? v.nextDeparture : null;
    }

    function parseScheduleMinutes(timeStr) {
        var m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    function getNextDepartureInfo() {
        var sched = state.schedule || [];
        if (!sched.length) {
            return { text: 'Nincs több indulás ma', kind: 'none' };
        }
        var now = new Date();
        var nowMins = now.getHours() * 60 + now.getMinutes();
        var sorted = sched.slice().sort(function (a, b) {
            return (parseScheduleMinutes(a.time) || 0) - (parseScheduleMinutes(b.time) || 0);
        });
        var i;
        for (i = 0; i < sorted.length; i++) {
            var tm = parseScheduleMinutes(sorted[i].time);
            if (tm != null && tm > nowMins) {
                return { text: sorted[i].time, kind: 'today' };
            }
        }
        if (sorted[0] && sorted[0].time) {
            return { text: 'holnap ' + sorted[0].time, kind: 'tomorrow' };
        }
        return { text: 'Nincs több indulás ma', kind: 'none' };
    }

    function getStopNextDeparture(stop) {
        if (stop && stop.departures && stop.departures.length) return stop.departures[0];
        return nextDepartureFromVehicle() || '—';
    }

    function getNextDepartureFromStop(stop) {
        var times = (stop && stop.departures && stop.departures.length)
            ? stop.departures
            : state.schedule.map(function (r) { return r.time; });
        if (!times.length) return getNextDepartureInfo();
        var now = new Date();
        var nowMins = now.getHours() * 60 + now.getMinutes();
        var sorted = times.slice().sort(function (a, b) {
            return (parseScheduleMinutes(a) || 0) - (parseScheduleMinutes(b) || 0);
        });
        var i;
        for (i = 0; i < sorted.length; i++) {
            var tm = parseScheduleMinutes(sorted[i]);
            if (tm != null && tm > nowMins) {
                return { text: sorted[i], kind: 'today' };
            }
        }
        if (sorted[0]) return { text: 'holnap ' + sorted[0], kind: 'tomorrow' };
        return { text: '—', kind: 'none' };
    }

    function getStopNextArrivalText(stop) {
        var train = getTrainArrivalLineForStop(stop);
        if (train) return train;
        return getNextDepartureFromStop(stop).text || '—';
    }

    function enrichStopDistance(stop) {
        if (!stop) return null;
        if (!state.userPos || stop.lat == null || stop.lng == null) return stop;
        return Object.assign({}, stop, {
            distanceM: haversineM(state.userPos.lat, state.userPos.lng, stop.lat, stop.lng)
        });
    }

    function stopWalkLabel(stop) {
        if (!stop || stop.distanceM == null) return '—';
        return formatWalkTime(stop.distanceM);
    }

    function findNearestStop() {
        if (!state.userPos || !state.stops.length) {
            state.nearestStop = null;
            return null;
        }
        var best = null;
        var bestD = Infinity;
        state.stops.forEach(function (stop) {
            if (stop.lat == null || stop.lng == null) return;
            var d = haversineM(state.userPos.lat, state.userPos.lng, stop.lat, stop.lng);
            if (d < bestD) {
                bestD = d;
                best = Object.assign({}, stop, { distanceM: d });
            }
        });
        state.nearestStop = best;
        return best;
    }

    function getDisplayStop() {
        if (state.selectedStopId) {
            var picked = state.stops.find(function (s) { return s.id === state.selectedStopId; });
            if (picked) return enrichStopDistance(picked);
        }
        if (state.nearestStop) return state.nearestStop;
        if (state.stops.length) return enrichStopDistance(state.stops[0]);
        return null;
    }

    /* ── Map ── */
    function initMap() {
        var cartoLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '© CARTO · © OpenStreetMap',
            maxZoom: 22,
            maxNativeZoom: 19
        });
        var osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap',
            maxZoom: 22,
            maxNativeZoom: 19
        });
        var cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© CARTO · © OpenStreetMap',
            maxZoom: 22,
            maxNativeZoom: 19
        });
        var satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '© Esri · © OpenStreetMap',
            maxZoom: 22,
            maxNativeZoom: 19
        });

        var defCity = DATA.CITIES.find(function (c) { return c.default; }) || DATA.CITIES[0];
        var startCenter = defCity && defCity.center ? defCity.center : [47.649, 18.318];

        baseMapLayers = {
            Voyager: cartoLight,
            OSM: osm,
            Dark: cartoDark,
            'Műhold': satellite
        };
        activeBaseMapKey = 'Voyager';

        map = L.map('map', {
            center: startCenter,
            zoom: 14,
            zoomSnap: 0.25,
            maxZoom: 22,
            layers: [cartoLight]
        });

        routeLayers = { black: null, gold: null, red: null, highlight: null, hit: null };
        vehicleLayer = L.layerGroup().addTo(map);
        stopLayer = L.layerGroup().addTo(map);
        poiLayer = L.layerGroup().addTo(map);
        userLayer = L.layerGroup().addTo(map);

        map.on('popupclose', function () {
            openPopupStopId = null;
            setStopPopupOpenClass(false);
        });
        map.on('popupopen', function (ev) {
            var el = ev.popup && ev.popup.getElement();
            if (el && el.classList.contains('stop-popup-wrap')) {
                setStopPopupOpenClass(true);
            }
        });

        map.whenReady(function () { map.invalidateSize(); });
        window.addEventListener('resize', function () {
            map.invalidateSize();
            refreshRouteHitLayer();
        });
        window.addEventListener('orientationchange', function () {
            setTimeout(function () {
                map.invalidateSize();
                refreshRouteHitLayer();
            }, 300);
        });
    }

    function mapTopPadding() {
        return 110;
    }

    function styleOutline() {
        return { color: '#2A1C1C', weight: 5.5, opacity: 0.25, lineCap: 'round', lineJoin: 'round' };
    }

    function styleGoldRail() {
        return {
            color: '#c9a04a',
            weight: 5,
            opacity: 0,
            lineCap: 'round',
            lineJoin: 'round'
        };
    }

    function styleRed() {
        return { color: '#6B1520', weight: 4, opacity: 0.75, lineCap: 'round', lineJoin: 'round' };
    }

    function styleHighlight() {
        return { color: '#A84552', weight: 1.5, opacity: 0.55, lineCap: 'round', lineJoin: 'round' };
    }

    function clearRoute() {
        if (routeLayers.black) { map.removeLayer(routeLayers.black); routeLayers.black = null; }
        if (routeLayers.gold) { map.removeLayer(routeLayers.gold); routeLayers.gold = null; }
        if (routeLayers.red) { map.removeLayer(routeLayers.red); routeLayers.red = null; }
        if (routeLayers.highlight) { map.removeLayer(routeLayers.highlight); routeLayers.highlight = null; }
        if (routeLayers.hit) { map.removeLayer(routeLayers.hit); routeLayers.hit = null; }
    }

    function onRouteBoardClick(e) {
        if (state.devGis && e.target && e.target.feature && e.target.feature.properties) {
            toast(JSON.stringify(e.target.feature.properties).slice(0, 100));
        }
        state.routeBoardMode = false;
        updateRouteBoardModeUi();
        openRouteBoardingPopup(e.latlng);
    }

    function bindRouteLineClicks(layer) {
        layer.on('click', onRouteBoardClick);
    }

    function addGeoJsonRoute(geoData) {
        clearRoute();
        routeLayers.black = L.geoJSON(geoData, {
            interactive: false,
            style: function (feature) {
                var g = feature.geometry;
                if (g.type === 'LineString' || g.type === 'MultiLineString') return styleOutline();
                return { color: '#111', weight: 2, fillOpacity: 0.1 };
            }
        }).addTo(map);

        routeLayers.gold = L.geoJSON(geoData, {
            interactive: false,
            style: function (feature) {
                var g = feature.geometry;
                if (g.type === 'LineString' || g.type === 'MultiLineString') return styleGoldRail();
                return { opacity: 0, fillOpacity: 0 };
            }
        }).addTo(map);

        routeLayers.red = L.geoJSON(geoData, {
            interactive: true,
            style: function (feature) {
                var g = feature.geometry;
                if (g.type === 'LineString' || g.type === 'MultiLineString') return styleRed();
                return { color: '#e53935', weight: 4 };
            },
            onEachFeature: function (feature, layer) {
                var g = feature.geometry;
                if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return;
                bindRouteLineClicks(layer);
            }
        }).addTo(map);

        routeLayers.highlight = L.geoJSON(geoData, {
            interactive: false,
            style: function (feature) {
                var g = feature.geometry;
                if (g.type === 'LineString' || g.type === 'MultiLineString') return styleHighlight();
                return { opacity: 0, fillOpacity: 0 };
            }
        }).addTo(map);

        routeLayers.hit = L.geoJSON(geoData, {
            interactive: true,
            style: function (feature) {
                var g = feature.geometry;
                if (g.type === 'LineString' || g.type === 'MultiLineString') {
                    return { color: 'transparent', weight: routeHitLineWeight(), opacity: 0.01 };
                }
                return { opacity: 0, fillOpacity: 0 };
            },
            onEachFeature: function (feature, layer) {
                var g = feature.geometry;
                if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return;
                bindRouteLineClicks(layer);
            }
        }).addTo(map);

        syncRouteLayerOrder();

        var bounds = routeLayers.red.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [mapTopPadding(), 28], maxZoom: 16 });
    }

    function syncRouteLayerOrder() {
        if (!map) return;
        if (routeLayers.black) routeLayers.black.bringToBack();
        if (routeLayers.gold) routeLayers.gold.bringToFront();
        if (routeLayers.red) routeLayers.red.bringToFront();
        if (routeLayers.highlight) routeLayers.highlight.bringToFront();
        if (routeLayers.hit) routeLayers.hit.bringToFront();
        if (state.routeBoardMode && routeLayers.hit) {
            routeLayers.hit.bringToFront();
        }
    }

    function countBookableStops() {
        return state.stops.filter(function (s) { return s.lat != null && s.lng != null; }).length;
    }

    function updateBookPickModeUi() {
        var app = $('app');
        if (app) app.classList.toggle('is-book-pick-mode', !!state.bookPickMode);
        var shellBtn = $('btn-shell-reserve');
        if (shellBtn) shellBtn.classList.toggle('is-stop-pick', !!state.bookPickMode);
        var legacyBtn = $('btn-peek-reserve');
        if (legacyBtn) legacyBtn.classList.toggle('is-stop-pick', !!state.bookPickMode);
    }

    function setBookPickMode(on) {
        state.bookPickMode = !!on;
        if (state.bookPickMode) {
            state.routeBoardMode = false;
            updateRouteBoardModeUi();
        }
        updateBookPickModeUi();
    }

    function updateRouteBoardModeUi() {
        var btn = $('btn-peek-board');
        if (btn) btn.classList.toggle('is-route-pick', !!state.routeBoardMode);
        var shellBtn = $('btn-shell-board');
        if (shellBtn) shellBtn.classList.toggle('is-route-pick', !!state.routeBoardMode);
        syncRouteLayerOrder();
    }

    function setRouteBoardMode(on) {
        state.routeBoardMode = !!on;
        if (state.routeBoardMode) setBookPickMode(false);
        updateRouteBoardModeUi();
        if (state.routeBoardMode) {
            toast('Kattints az útvonalra vagy egy megállóra');
        }
    }

    function scheduleSeatsLabel(seats, freeCount) {
        if (freeCount != null) {
            var v = state.activeVehicle;
            var st = v ? seatStatus(v.freeSeats, v.capacity) : null;
            return seatEmoji(st) + ' ' + freeCount + ' hely';
        }
        var s = String(seats || '').toLowerCase();
        if (s.indexOf('telít') >= 0 || s.indexOf('betelt') >= 0) return '🔴 0 hely';
        if (s.indexOf('kevés') >= 0) return '🟡 Kevés hely';
        return '🟢 Foglalható';
    }

    function loadCityRoute(city) {
        var url = new URL(city.file, window.location.href).href;
        return fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (geo) { addGeoJsonRoute(geo); })
            .catch(function () {
                if (state.devGis) toast('Útvonal jelenleg nem érhető el');
            });
    }

    function auditGeoJsonLayers() {
        var cities = DATA.CITIES || [];
        geojsonAudit.total = cities.length;
        geojsonAudit.baseMaps = Object.keys(baseMapLayers);
        return Promise.all(cities.map(function (city) {
            var url = new URL(city.file, window.location.href).href;
            return fetch(url, { method: 'HEAD', cache: 'no-store' })
                .then(function (r) {
                    if (r.ok) return { id: city.id, label: city.label, file: city.file, ok: true };
                    if (r.status === 405 || r.status === 501) {
                        return fetch(url, { cache: 'no-store' }).then(function (r2) {
                            return { id: city.id, label: city.label, file: city.file, ok: r2.ok };
                        });
                    }
                    return { id: city.id, label: city.label, file: city.file, ok: false };
                })
                .catch(function () {
                    return { id: city.id, label: city.label, file: city.file, ok: false };
                });
        })).then(function (results) {
            geojsonAudit.loaded = results.filter(function (r) { return r.ok; });
            geojsonAudit.missing = results.filter(function (r) { return !r.ok; });
            console.log('[LAYERS]', {
                baseLayerCount: geojsonAudit.baseMaps.length,
                baseLayerNames: geojsonAudit.baseMaps.slice(),
                geojsonTotal: geojsonAudit.total,
                geojsonLoaded: geojsonAudit.loaded.length,
                geojsonLoadedFiles: geojsonAudit.loaded.map(function (r) { return r.file; }),
                geojsonMissing: geojsonAudit.missing.map(function (r) { return r.file; })
            });
            return geojsonAudit;
        });
    }

    function setBaseMap(key) {
        if (!map || !baseMapLayers[key]) return false;
        Object.keys(baseMapLayers).forEach(function (name) {
            var layer = baseMapLayers[name];
            if (map.hasLayer(layer)) map.removeLayer(layer);
        });
        baseMapLayers[key].addTo(map);
        activeBaseMapKey = key;
        return true;
    }

    function getLayersPanelModel() {
        var baseMaps = Object.keys(baseMapLayers).map(function (name) {
            return { id: name, label: name, active: name === activeBaseMapKey };
        });
        return {
            baseMaps: baseMaps,
            hasAny: baseMaps.length > 0
        };
    }

    var TRIP_SLUG_TO_ROUTE = {
        Tata1: 'Tata-1', Tata2: 'Tata-2', Tata3: 'Tata-3',
        Teszt01: 'Teszt01', Eger: 'Eger', Gyor: 'Győr', Papa: 'Pápa',
        Szfv: 'Székesfehérvár', Vac: 'Vác', __eseti__: 'Egyedi'
    };

    function routeNameFromVehicle(v) {
        if (!v) return state.cityLabel || 'Járat';
        var trip = v.trip ? String(v.trip).trim() : '';
        if (trip.indexOf('ES_') === 0) return 'Egyedi';
        if (trip) {
            var parts = trip.split('_');
            if (parts.length >= 2) {
                var slug = parts[1];
                return TRIP_SLUG_TO_ROUTE[slug] || slug;
            }
        }
        if (v.city) return String(v.city);
        return state.cityLabel || 'Járat';
    }

    function trainMarkerHtml(v) {
        var cap = v.capacity || 56;
        var free = v.freeSeats != null ? v.freeSeats : '—';
        var st = v.active ? seatStatus(v.freeSeats, cap) : null;
        var freeCls = 'tm-free-ok';
        if (st && st.cls === 'warn') freeCls = 'tm-free-warn';
        if (st && st.cls === 'bad') freeCls = 'tm-free-bad';
        return '<div class="train-marker-wrap">' +
            '<div class="train-marker-aura" aria-hidden="true"></div>' +
            '<div class="train-marker-min" aria-hidden="true">🚂</div>' +
            '<div class="train-marker-seats ' + freeCls + '">' +
            '<span class="tm-free-num">' + escapeHtml(String(free)) + '</span>' +
            '<span class="tm-free-lbl">szabad</span>' +
            '</div></div>';
    }

    function trainPopupHtml(v) {
        var cap = v.capacity || 56;
        var free = v.freeSeats != null ? v.freeSeats : '—';
        var routeName = routeNameFromVehicle(v);
        return '<div class="train-popup">' +
            '<p class="tp-title">🚂 ' + escapeHtml(routeName) + ' járat</p>' +
            '<p class="tp-row"><span class="tp-lbl">Jármű</span> ' + escapeHtml(v.id) + '</p>' +
            '<p class="tp-seats">Szabad: <strong class="tp-free-strong">' + escapeHtml(String(free)) + '</strong> / ' + escapeHtml(String(cap)) + ' fő</p>' +
            '</div>';
    }

    function dedupeVehiclesForMap(vehicles) {
        var byId = {};
        (vehicles || []).forEach(function (v) {
            if (!v || !v.id) return;
            var prev = byId[v.id];
            if (!prev) {
                byId[v.id] = v;
                return;
            }
            var ts = v.lastGps || '';
            var prevTs = prev.lastGps || '';
            if (String(ts) >= String(prevTs)) byId[v.id] = v;
        });
        return Object.keys(byId).map(function (k) { return byId[k]; });
    }

    function renderVehicles() {
        vehicleLayer.clearLayers();
        var mapVehicles = dedupeVehiclesForMap(state.vehicles);
        mapVehicles.forEach(function (v) {
            if (!v.live || v.lat == null || v.lng == null) return;
            var icon = L.divIcon({
                className: 'train-marker-root',
                html: trainMarkerHtml(v),
                iconSize: [198, 84],
                iconAnchor: [42, 42]
            });
            var marker = L.marker([v.lat, v.lng], { icon: icon, zIndexOffset: 350 });
            marker.bindPopup(trainPopupHtml(v));
            marker.on('popupopen', function () {
                emitAnalyticsEvent({
                    event_type: 'TRAIN_POPUP_OPEN',
                    train_id: v.id
                });
            });
            marker.addTo(vehicleLayer);
        });
        state.activeVehicle = mapVehicles.find(function (v) { return v.active; }) || mapVehicles[0] || null;
        updateUi();
    }

    function isShellUi() {
        var app = $('app');
        return !!(app && app.classList.contains('public-ui-shell-v1'));
    }

    function popupChromePadding() {
        var style = getComputedStyle(document.documentElement);
        if (isShellUi()) {
            var top = (parseFloat(style.getPropertyValue('--status-panel-h')) || 286) + 12;
            var right = parseFloat(style.getPropertyValue('--popup-pad-right'));
            if (!right || isNaN(right)) {
                right = Math.ceil(window.innerWidth * 0.50 + 12);
            }
            var bottom = parseFloat(style.getPropertyValue('--popup-pad-bottom'));
            if (!bottom || isNaN(bottom)) {
                bottom = (parseFloat(style.getPropertyValue('--stop-bar-h')) || 88) + 320;
            }
            return {
                topLeft: L.point(12, Math.ceil(top)),
                bottomRight: L.point(Math.ceil(right), Math.ceil(bottom))
            };
        }
        var top = (parseFloat(style.getPropertyValue('--status-panel-h')) || 88) +
            (parseFloat(style.getPropertyValue('--city-strip-h')) || 52) + 12;
        var bottom = (parseFloat(style.getPropertyValue('--stop-bar-h')) || 58) + 10;
        return {
            topLeft: L.point(10, Math.ceil(top)),
            bottomRight: L.point(10, Math.ceil(bottom))
        };
    }

    function shellPopupOffset() {
        var w = window.innerWidth;
        return L.point(-Math.round(Math.min(150, Math.max(90, w * 0.34))), -56);
    }

    function stopPopupLeafletOptions() {
        var pad = popupChromePadding();
        var shell = isShellUi();
        var opts = {
            maxWidth: shell
                ? Math.min(300, Math.max(160, Math.floor(window.innerWidth * 0.46)))
                : Math.min(300, window.innerWidth - 20),
            className: 'stop-popup-wrap',
            autoPan: true,
            autoPanPaddingTopLeft: pad.topLeft,
            autoPanPaddingBottomRight: pad.bottomRight,
            keepInView: true
        };
        if (shell) {
            opts.offset = shellPopupOffset();
        }
        return opts;
    }

    function routePopupLeafletOptions(className) {
        var pad = popupChromePadding();
        var shell = isShellUi();
        var opts = {
            maxWidth: shell
                ? Math.min(300, Math.max(160, Math.floor(window.innerWidth * 0.46)))
                : 300,
            className: className,
            autoPan: true,
            autoPanPaddingTopLeft: pad.topLeft,
            autoPanPaddingBottomRight: pad.bottomRight,
            keepInView: true,
            closeButton: true
        };
        if (shell) opts.offset = shellPopupOffset();
        return opts;
    }

    function setStopPopupOpenClass(on) {
        var app = $('app');
        if (!app) return;
        app.classList.toggle('is-stop-popup-open', !!on);
    }

    function focusStopBookForm(popupRoot) {
        if (!popupRoot) return;
        var form = popupRoot.querySelector('.sp-book-form:not([hidden])') ||
            popupRoot.querySelector('.sp-board-form:not([hidden])');
        var scrollHost = popupRoot.closest('.leaflet-popup-content') || popupRoot;
        if (!form) return;
        setTimeout(function () {
            try {
                form.scrollIntoView({ block: 'end', behavior: 'smooth' });
            } catch (e) {
                scrollHost.scrollTop = Math.max(0, form.offsetTop - 8);
            }
        }, 80);
    }

    function stopPopupHtml(stop, ctx) {
        ctx = ctx || {};
        var selectedTime = ctx.selectedTime || '';
        var showBoard = !!ctx.showBoard;
        var showBookForm = !!selectedTime && !showBoard;
        var trainLine = getTrainArrivalLineForStop(stop);
        var walk = stopWalkLabel(stop);
        var seatsLine = popupSeatsLine();
        var waitingLine = getWaitingLine(stop.id);
        var seatsCls = '';
        var vSeats = state.activeVehicle;
        if (vSeats && vSeats.active) {
            var stPop = seatStatus(vSeats.freeSeats, vSeats.capacity);
            if (stPop.cls === 'warn') seatsCls = ' seats-warn';
            if (stPop.cls === 'bad') seatsCls = ' seats-bad';
        }
        var times = (stop.departures && stop.departures.length)
            ? stop.departures
            : state.schedule.map(function (r) { return r.time; });

        var deps = times.slice(0, 8).map(function (t) {
            var active = selectedTime === t;
            return '<button type="button" class="dep-pick' + (active ? ' is-active' : '') + '" data-time="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>';
        }).join('');

        var bookForm =
            '<div class="sp-book-form"' + (showBookForm ? '' : ' hidden') + '>' +
            '<div class="sp-field"><label>Létszám</label><input type="number" class="sp-count" min="1" max="56" value="2"></div>' +
            '<div class="sp-field"><label>Telefon</label><input type="tel" class="sp-phone" placeholder="+36 30 123 4567" autocomplete="tel" inputmode="tel"></div>' +
            '<button type="button" class="sp-submit-btn sp-book-submit">Foglalok</button>' +
            '</div>';

        var boardBlock;
        if (showBoard) {
            boardBlock =
                '<div class="sp-board-form">' +
                '<p class="sp-lbl">🚂 Felszállnánk</p>' +
                '<div class="sp-field"><label>Létszám</label><input type="number" class="sp-board-count" min="1" max="56" value="2"></div>' +
                '<div class="sp-field"><label>Telefon</label><input type="tel" class="sp-board-phone" placeholder="+36 30 123 4567" autocomplete="tel" inputmode="tel"></div>' +
                '<button type="button" class="sp-submit-btn sp-board-submit">Küldés</button>' +
                '</div>';
        } else {
            boardBlock =
                '<button type="button" class="sp-board-toggle">🚂 Felszállnánk</button>' +
                '<div class="sp-board-form" hidden></div>';
        }

        return (
            '<div class="stop-popup" data-stop-id="' + escapeHtml(stop.id) + '" data-stop-name="' + escapeHtml(stop.name) + '">' +
            '<p class="sp-title">🚏 ' + escapeHtml(stop.name) + '</p>' +
            (trainLine ? '<p class="sp-train">🚂 ' + escapeHtml(trainLine) + '</p>' : '') +
            '<p class="sp-seats' + seatsCls + '">' + escapeHtml(seatsLine) + '</p>' +
            (walk !== '—' ? '<p class="sp-walk">🚶 ' + escapeHtml(walk) + '</p>' : '') +
            (!showBoard ? '<p class="sp-lbl">Időpont – kattints</p><div class="sp-deps-scroll"><div class="sp-deps">' + deps + '</div></div>' : '') +
            bookForm +
            boardBlock +
            '<p class="sp-waiting">' + escapeHtml(waitingLine) + '</p>' +
            '</div>'
        );
    }

    function setStopPopup(stopId, ctx, openPopup) {
        var stop = state.stops.find(function (s) { return s.id === stopId; });
        var m = stopMarkers[stopId];
        if (!stop || !m) return;
        var enriched = enrichStopDistance(stop) || stop;
        state.popupContext = {
            stopId: stopId,
            selectedTime: ctx.selectedTime || '',
            showBoard: !!ctx.showBoard
        };
        m.setPopupContent(stopPopupHtml(enriched, state.popupContext));
        if (openPopup !== false) {
            m.openPopup();
            openPopupStopId = stopId;
            setStopPopupOpenClass(true);
            emitAnalyticsEvent({
                event_type: 'STOP_POPUP_OPEN',
                stop_id: stopId,
                stop_name: stop.name
            });
            var popup = m.getPopup();
            if (popup && popup.isOpen()) popup.update();
            if ((state.popupContext.selectedTime && !state.popupContext.showBoard) || state.popupContext.showBoard) {
                setTimeout(function () {
                    var wrap = popup && popup.getElement();
                    if (wrap) focusStopBookForm(wrap.querySelector('.stop-popup'));
                }, 160);
            }
        }
    }

    function renderStops() {
        var reopenId = openPopupStopId;
        var reopenCtx = Object.assign({}, state.popupContext);
        stopLayer.clearLayers();
        stopMarkers = {};
        var display = getDisplayStop();
        state.stops.forEach(function (stop) {
            if (stop.lat == null || stop.lng == null) return;
            var enriched = enrichStopDistance(stop) || stop;
            var isNear = display && display.id === stop.id;
            var isActive = state.selectedStopId === stop.id || openPopupStopId === stop.id;
            var iconDim = stopIconDimensions();
            var icon = L.divIcon({
                className: '',
                html: '<div class="stop-marker' +
                    (isNear ? ' is-near' : '') +
                    (isActive ? ' is-active' : '') +
                    '">🚏</div>',
                iconSize: iconDim.size,
                iconAnchor: iconDim.anchor
            });
            var m = L.marker([stop.lat, stop.lng], { icon: icon, zIndexOffset: 800 });
            var ctx = (reopenId === stop.id) ? reopenCtx : { selectedTime: '', showBoard: false };
            m.bindPopup(L.popup(stopPopupLeafletOptions()).setContent(stopPopupHtml(enriched, ctx)));
            m.on('click', function () {
                state.selectedStopId = stop.id;
                var clickCtx = {
                    stopId: stop.id,
                    selectedTime: '',
                    showBoard: !!state.routeBoardMode
                };
                state.popupContext = clickCtx;
                if (state.bookPickMode) {
                    setBookPickMode(false);
                    clickCtx.showBoard = false;
                    if (!isMobileUi() || clickCtx.showBoard) openPopupStopId = stop.id;
                    setStopPopup(stop.id, clickCtx, true);
                    if (stop && map) map.panTo([stop.lat, stop.lng], { animate: true });
                    updateUi();
                    return;
                }
                if (!isMobileUi() || clickCtx.showBoard) openPopupStopId = stop.id;
                if (state.routeBoardMode) {
                    state.routeBoardMode = false;
                    updateRouteBoardModeUi();
                }
                if (isMobileUi() && !clickCtx.showBoard) {
                    openMobileBoardSheet({
                        type: 'stop',
                        stopId: stop.id,
                        stopName: stop.name
                    });
                    updateUi();
                    return;
                }
                setStopPopup(stop.id, clickCtx, true);
                updateUi();
            });
            m.addTo(stopLayer);
            stopMarkers[stop.id] = m;
        });
        if (reopenId && stopMarkers[reopenId]) {
            setStopPopup(reopenId, reopenCtx, true);
        }
    }

    function openStopOnMap(stopId, ctx) {
        ctx = ctx || {};
        state.selectedStopId = stopId;
        var stop = state.stops.find(function (s) { return s.id === stopId; });

        if (isMobileUi() && ctx.showBoard && !ctx.selectedTime) {
            if (map) map.closePopup();
            openPopupStopId = null;
            setStopPopupOpenClass(false);
            if (openMobileBoardSheet({
                type: 'stop',
                stopId: stopId,
                stopName: stop ? stop.name : ''
            })) {
                if (stop && map) map.panTo([stop.lat, stop.lng], { animate: true });
                findNearestStop();
                updateStatusLine();
                updateStopBar();
                renderStops();
                return;
            }
        }

        closeMobileBoardSheet();
        state.popupContext = {
            stopId: stopId,
            selectedTime: ctx.selectedTime || '',
            showBoard: !!ctx.showBoard
        };
        openPopupStopId = stopId;
        if (stop && map) map.panTo([stop.lat, stop.lng], { animate: true });
        findNearestStop();
        updateStatusLine();
        updateStopBar();
        renderStops();
    }

    function openMobileBoardSheet(ctx) {
        if (!isMobileUi() || !elBoardSheet) return false;
        mobileBoardContext = ctx;
        if (map) map.closePopup();

        var stop = ctx.stopId
            ? state.stops.find(function (s) { return s.id === ctx.stopId; })
            : null;
        var stopName = ctx.stopName || (stop ? stop.name : '—');

        if (elBoardSheetStopName) {
            elBoardSheetStopName.textContent = ctx.type === 'route' ? 'Útvonal menti felszállás' : stopName;
        }

        var arrival = '—';
        if (ctx.type === 'stop' && stop) {
            arrival = getStopNextArrivalText(enrichStopDistance(stop) || stop);
        } else if (ctx.type === 'route') {
            var disp = getDisplayStop();
            arrival = (disp ? getStopNextArrivalText(disp) : null) || getNextDepartureInfo().text || '—';
        }
        if (elBoardSheetArrival) {
            elBoardSheetArrival.textContent = 'Következő érkezés: ' + arrival;
        }

        var meta = '';
        if (ctx.type === 'stop' && stop) {
            var walk = stopWalkLabel(enrichStopDistance(stop) || stop);
            if (walk !== '—') meta += '🚶 ' + walk + ' · ';
            meta += getWaitingLine(stop.id);
        }
        if (elBoardSheetMeta) elBoardSheetMeta.textContent = meta;

        var savedPhone = '';
        try { savedPhone = sessionStorage.getItem(BOARD_PHONE_KEY) || ''; } catch (e) { savedPhone = ''; }
        if (elBoardSheetPhoneWrap) elBoardSheetPhoneWrap.hidden = !!savedPhone;
        if (elBoardSheetPhone) elBoardSheetPhone.value = savedPhone;
        if (elBoardSheetCta) {
            elBoardSheetCta.disabled = false;
            elBoardSheetCta.textContent = 'FELSZÁLLNÉK ITT';
        }

        elBoardSheet.hidden = false;
        elBoardSheet.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(function () { elBoardSheet.classList.add('is-open'); });
        emitAnalyticsEvent({
            event_type: 'BOARDING_SHEET_OPEN',
            stop_id: ctx.type === 'stop' ? ctx.stopId : null,
            stop_name: ctx.type === 'route' ? 'Útvonal menti felszállás' : stopName,
            sheet_type: ctx.type,
            boarding_type: ctx.type === 'route' ? 'route' : 'stop'
        });
        return true;
    }

    function closeMobileBoardSheet() {
        if (!elBoardSheet) return;
        elBoardSheet.classList.remove('is-open');
        elBoardSheet.setAttribute('aria-hidden', 'true');
        setTimeout(function () {
            elBoardSheet.hidden = true;
            mobileBoardContext = null;
        }, 280);
    }

    function getMobileBoardPhone() {
        var saved = '';
        try { saved = sessionStorage.getItem(BOARD_PHONE_KEY) || ''; } catch (e) { saved = ''; }
        if (saved) {
            var normalized = DATA.normalizeHuPhone(saved);
            if (normalized) return normalized;
        }
        var raw = (elBoardSheetPhone && elBoardSheetPhone.value || '').trim();
        return DATA.normalizeHuPhone(raw);
    }

    function submitMobileBoarding() {
        if (!mobileBoardContext) return;
        var phone = getMobileBoardPhone();
        if (!phone) {
            toast('Telefon: +36 vagy 06 formátum (pl. +36 30 123 4567)');
            if (elBoardSheetPhoneWrap) elBoardSheetPhoneWrap.hidden = false;
            if (elBoardSheetPhone) elBoardSheetPhone.focus();
            return;
        }
        try { sessionStorage.setItem(BOARD_PHONE_KEY, phone); } catch (e) { /* ignore */ }

        if (elBoardSheetCta) {
            elBoardSheetCta.disabled = true;
            elBoardSheetCta.textContent = 'Küldés…';
        }
        toast('Felszállási jelzés küldése…');

        var payload;
        if (mobileBoardContext.type === 'route') {
            payload = {
                city: state.cityLabel,
                stop_id: null,
                stop_name: 'Útvonal menti felszállás',
                boarding_type: 'route',
                lat: mobileBoardContext.latlng.lat,
                lng: mobileBoardContext.latlng.lng,
                count: 2,
                phone: phone,
                created_at: new Date().toISOString()
            };
        } else {
            payload = {
                city: state.cityLabel,
                stop_id: mobileBoardContext.stopId,
                stop_name: mobileBoardContext.stopName,
                count: 2,
                phone: phone,
                created_at: new Date().toISOString()
            };
        }

        emitAnalyticsEvent({
            event_type: 'BOARDING_ATTEMPT',
            stop_id: payload.stop_id,
            stop_name: payload.stop_name,
            boarding_type: mobileBoardContext.type === 'route' ? 'route' : 'stop',
            count: payload.count
        });

        DATA.submitBoardingRequest(payload).then(function () {
            emitAnalyticsEvent({
                event_type: 'BOARDING_SUCCESS',
                stop_id: payload.stop_id,
                stop_name: payload.stop_name,
                boarding_type: mobileBoardContext.type === 'route' ? 'route' : 'stop',
                count: payload.count
            });
            if (elBoardSheetCta) elBoardSheetCta.textContent = '✓ Jelzés elküldve';
            toast(mobileBoardContext.type === 'route'
                ? 'Felszállási jelzés elküldve (útvonal menti)'
                : 'Felszállási jelzés elküldve');
            setTimeout(closeMobileBoardSheet, 900);
        }).catch(function (err) {
            emitAnalyticsEvent({
                event_type: 'BOARDING_FAILED',
                stop_id: payload.stop_id,
                stop_name: payload.stop_name,
                boarding_type: mobileBoardContext.type === 'route' ? 'route' : 'stop',
                count: payload.count,
                error_message: err && err.message ? String(err.message) : 'Küldés sikertelen'
            });
            if (elBoardSheetCta) {
                elBoardSheetCta.disabled = false;
                elBoardSheetCta.textContent = 'FELSZÁLLNÉK ITT';
            }
            toast('Küldés sikertelen');
        });
    }

    function openQuickBook() {
        setRouteBoardMode(false);
        closeMobileBoardSheet();
        var bookable = countBookableStops();
        if (!bookable) { toast('Válassz megállót a térképen'); return; }
        if (bookable > 1) {
            setBookPickMode(true);
            toast('Koppints arra a megállóra, ahol foglalni szeretnél.');
            return;
        }
        var stop = state.stops.find(function (s) { return s.lat != null && s.lng != null; });
        if (!stop) { toast('Válassz megállót a térképen'); return; }
        openStopOnMap(stop.id, { selectedTime: '', showBoard: false });
    }

    function openQuickBoard() {
        setBookPickMode(false);
        setRouteBoardMode(true);
        var stop = getDisplayStop();
        if (stop && map) map.panTo([stop.lat, stop.lng], { animate: true });
    }

    function getSelectedTimeFromPopup(popupEl) {
        var active = popupEl.querySelector('.dep-pick.is-active');
        return active ? active.dataset.time : state.popupContext.selectedTime || '';
    }

    function submitStopBooking(popupEl) {
        var stopId = popupEl.dataset.stopId;
        var stopName = popupEl.dataset.stopName || '';
        var time = getSelectedTimeFromPopup(popupEl);
        var count = parseInt(popupEl.querySelector('.sp-count').value, 10);
        var phoneRaw = (popupEl.querySelector('.sp-phone').value || '').trim();
        var phone = DATA.normalizeHuPhone(phoneRaw);
        if (!time) { toast('Válassz időpontot'); return; }
        if (!count || count < 1) { toast('Érvényes létszám szükséges'); return; }
        if (!phone) { toast('Telefon: +36 vagy 06 formátum (pl. +36 30 123 4567)'); return; }

        emitAnalyticsEvent({
            event_type: 'BOOKING_ATTEMPT',
            stop_id: stopId,
            stop_name: stopName,
            time: time,
            count: count
        });

        DATA.submitReservation({
            city: state.cityLabel,
            stop_id: stopId,
            stop_name: stopName,
            time: time,
            count: count,
            name: '',
            phone: phone,
            note: '',
            reservation_type: 'scheduled',
            created_at: new Date().toISOString()
        }).then(function () {
            emitAnalyticsEvent({
                event_type: 'BOOKING_SUCCESS',
                stop_id: stopId,
                stop_name: stopName,
                time: time,
                count: count
            });
            map.closePopup();
            toast('Foglalás rögzítve');
        }).catch(function (err) {
            emitAnalyticsEvent({
                event_type: 'BOOKING_FAILED',
                stop_id: stopId,
                stop_name: stopName,
                time: time,
                count: count,
                error_message: err && err.message ? String(err.message) : 'Foglalás sikertelen'
            });
            toast('Foglalás sikertelen');
        });
    }

    function routeBoardingPopupHtml() {
        return (
            '<div class="route-board-popup">' +
            '<p class="rbp-title">Itt szállnánk fel</p>' +
            '<div class="sp-field"><label>Létszám</label><input type="number" class="rbp-count" min="1" max="56" value="2"></div>' +
            '<div class="sp-field"><label>Telefon</label><input type="tel" class="rbp-phone" placeholder="+36 30 123 4567" inputmode="tel"></div>' +
            '<button type="button" class="sp-submit-btn rbp-submit">Küldés</button>' +
            '</div>'
        );
    }

    function openRouteBoardingPopup(latlng) {
        if (!map || !latlng) return;
        map.closePopup();
        var popup = L.popup(routePopupLeafletOptions('route-board-wrap'))
            .setLatLng(latlng)
            .setContent(routeBoardingPopupHtml())
            .openOn(map);
        var el = popup.getElement();
        if (!el) return;
        var btn = el.querySelector('.rbp-submit');
        if (btn) {
            btn.addEventListener('click', function () {
                submitRouteBoarding(latlng, el);
            });
        }
    }

    function submitRouteBoarding(latlng, popupEl) {
        var count = parseInt((popupEl.querySelector('.rbp-count') || {}).value, 10);
        var phoneRaw = ((popupEl.querySelector('.rbp-phone') || {}).value || '').trim();
        var phone = DATA.normalizeHuPhone(phoneRaw);
        if (!count || count < 1) { toast('Érvényes létszám szükséges'); return; }
        if (!phone) { toast('Telefon: +36 vagy 06 formátum (pl. +36 30 123 4567)'); return; }

        emitAnalyticsEvent({
            event_type: 'BOARDING_ATTEMPT',
            stop_id: null,
            stop_name: 'Útvonal menti felszállás',
            boarding_type: 'route',
            count: count
        });

        DATA.submitBoardingRequest({
            city: state.cityLabel,
            stop_id: null,
            stop_name: 'Útvonal menti felszállás',
            boarding_type: 'route',
            lat: latlng.lat,
            lng: latlng.lng,
            count: count,
            phone: phone,
            created_at: new Date().toISOString()
        }).then(function () {
            emitAnalyticsEvent({
                event_type: 'BOARDING_SUCCESS',
                stop_id: null,
                stop_name: 'Útvonal menti felszállás',
                boarding_type: 'route',
                count: count
            });
            map.closePopup();
            state.routeBoardMode = false;
            updateRouteBoardModeUi();
            toast('Felszállási jelzés elküldve (útvonal menti)');
        }).catch(function (err) {
            emitAnalyticsEvent({
                event_type: 'BOARDING_FAILED',
                stop_id: null,
                stop_name: 'Útvonal menti felszállás',
                boarding_type: 'route',
                count: count,
                error_message: err && err.message ? String(err.message) : 'Küldés sikertelen'
            });
            toast('Küldés sikertelen');
        });
    }

    function submitStopBoarding(popupEl) {
        var stopId = popupEl.dataset.stopId;
        var stopName = popupEl.dataset.stopName || '';
        var countEl = popupEl.querySelector('.sp-board-count');
        var phoneEl = popupEl.querySelector('.sp-board-phone');
        if (!countEl || !phoneEl) return;
        var count = parseInt(countEl.value, 10);
        var phoneRaw = (phoneEl.value || '').trim();
        var phone = DATA.normalizeHuPhone(phoneRaw);
        if (!count || count < 1) { toast('Érvényes létszám szükséges'); return; }
        if (!phone) { toast('Telefon: +36 vagy 06 formátum (pl. +36 30 123 4567)'); return; }

        emitAnalyticsEvent({
            event_type: 'BOARDING_ATTEMPT',
            stop_id: stopId,
            stop_name: stopName,
            boarding_type: 'stop',
            count: count
        });

        DATA.submitBoardingRequest({
            city: state.cityLabel,
            stop_id: stopId,
            stop_name: stopName,
            count: count,
            phone: phone,
            created_at: new Date().toISOString()
        }).then(function () {
            emitAnalyticsEvent({
                event_type: 'BOARDING_SUCCESS',
                stop_id: stopId,
                stop_name: stopName,
                boarding_type: 'stop',
                count: count
            });
            map.closePopup();
            toast('Felszállási jelzés elküldve');
        }).catch(function (err) {
            emitAnalyticsEvent({
                event_type: 'BOARDING_FAILED',
                stop_id: stopId,
                stop_name: stopName,
                boarding_type: 'stop',
                count: count,
                error_message: err && err.message ? String(err.message) : 'Küldés sikertelen'
            });
            toast('Küldés sikertelen');
        });
    }

    /* ── UI ── */
    function updateStatusLine() {
        if (!elStatusLine) return;
        var v = state.activeVehicle;
        var seatLoading = !state.vehicleDataReady;
        var st = (!seatLoading && v && v.active) ? seatStatus(v.freeSeats, v.capacity) : null;
        var emoji = seatLoading ? '' : seatEmoji(st);
        var seatCls = seatLoading ? ' seat-loading' : (st && st.cls ? ' seat-' + st.cls : '');
        var freeNum = seatLoading
            ? 'Adat betöltése…'
            : ((v && v.active && v.freeSeats != null) ? String(v.freeSeats) : '—');
        var nextDep = getNextDepartureInfo();
        elStatusLine.innerHTML =
            '<span class="status-city">🚂 ' + escapeHtml(state.cityLabel) + '</span>' +
            '<span class="status-seats">' + (emoji ? emoji + ' ' : '') +
            '<span class="seat-free-num' + seatCls + '">' + escapeHtml(freeNum) + '</span> szabad hely</span>' +
            '<span class="status-next-dep">🕒 Következő indulás: ' + escapeHtml(nextDep.text) + '</span>';
    }

    function updateStopBar() {
        var stop = getDisplayStop();
        if (elPeekStop) {
            elPeekStop.textContent = stop ? '🚏 ' + stop.name : '🚏 —';
        }
        if (elPeekStopMeta) {
            elPeekStopMeta.textContent = stop && stop.distanceM != null
                ? '🚶 ' + formatWalkTime(stop.distanceM)
                : '🚶 —';
        }
    }

    function updateUi() {
        findNearestStop();
        updateStatusLine();
        updateStopBar();
        renderStops();
    }

    function bootstrapInstantCity(city) {
        state.cityId = city.id;
        state.cityLabel = city.label;
        state.stops = (DATA.MOCK_STOPS[city.id] || []).slice();
        state.vehicles = [];
        state.schedule = ((DATA.getSchedulesCatalog() || {})[city.id] || []).slice();
        state.activeVehicle = state.vehicles.find(function (v) { return v.active; }) || state.vehicles[0] || null;
        state.selectedStopId = null;
        state.routeBoardMode = false;
        state.bookPickMode = false;
        state.vehicleDataReady = false;
        state.popupContext = { stopId: '', selectedTime: '', showBoard: false };
        openPopupStopId = null;
        updateRouteBoardModeUi();
        updateBookPickModeUi();
        if (map && city.center) map.setView(city.center, 14, { animate: false });
        findNearestStop();
        renderStops();
        renderVehicles();
        renderScheduleList();
        updateUi();
    }

    var vehiclePollTimer = null;

    function startVehiclePoll() {
        if (vehiclePollTimer) clearInterval(vehiclePollTimer);
        vehiclePollTimer = setInterval(function () {
            if (!state.cityId) return;
            refreshCityData(state.cityId);
        }, 12000);
    }

    function refreshCityData(cityId) {
        return Promise.all([
            DATA.loadVehicles(cityId),
            DATA.loadSchedules(cityId),
            DATA.loadStops(cityId)
        ]).then(function (results) {
            state.vehicles = results[0] || [];
            state.schedule = results[1] || [];
            state.stops = results[2] || [];
            state.vehicleDataReady = true;
            findNearestStop();
            renderVehicles();
            renderStops();
            renderScheduleList();
            updateStatusLine();
        }).catch(function () {
            state.vehicleDataReady = true;
            updateStatusLine();
        });
    }

    function selectCity(cityId) {
        var city = DATA.CITIES.find(function (c) { return c.id === cityId; });
        if (!city) return;
        document.querySelectorAll('.city-chip').forEach(function (btn) {
            btn.classList.toggle('is-active', btn.dataset.city === cityId);
        });
        map.closePopup();
        bootstrapInstantCity(city);
        loadCityRoute(city);
        refreshCityData(cityId);
        emitAnalyticsEvent({
            event_type: 'ROUTE_VIEW',
            city: city.label,
            route_id: city.id + '_' + String(city.file || '').replace(/\.geojson$/i, '')
        });
    }

    function buildCityStrip() {
        var strip = $('city-strip');
        if (!strip) return;
        strip.innerHTML = DATA.CITIES.map(function (c) {
            return '<button type="button" class="city-chip' + (c.default ? ' is-active' : '') + '" data-city="' + c.id + '">' + escapeHtml(c.label) + '</button>';
        }).join('');
        strip.querySelectorAll('.city-chip').forEach(function (btn) {
            btn.addEventListener('click', function () { selectCity(btn.dataset.city); }, { passive: true });
        });
    }

    /* ── GPS ── */
    function updateUserMarker(lat, lng, acc) {
        state.userPos = { lat: lat, lng: lng };
        state.userAccuracy = acc;
        userLayer.clearLayers();
        var ll = L.latLng(lat, lng);
        L.marker(ll, {
            icon: L.divIcon({
                className: '',
                html: '<div class="user-loc-dot"></div>',
                iconSize: [14, 14],
                iconAnchor: [7, 7]
            }),
            zIndexOffset: 900
        }).addTo(userLayer);
        L.circle(ll, {
            radius: acc || 25,
            color: '#3b82f6',
            weight: 1,
            fillColor: '#3b82f6',
            fillOpacity: 0.12
        }).addTo(userLayer);
        updateUi();
        if (openPopupStopId) setStopPopup(openPopupStopId, state.popupContext, true);
    }

    function startGpsWatch() {
        if (state.gpsWatchId != null || !navigator.geolocation) return;
        state.gpsWatchId = navigator.geolocation.watchPosition(
            function (pos) { updateUserMarker(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy); },
            function () {},
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
        );
    }

    function isGpsDevMode() {
        var h = window.location.hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    }

    function gpsQaLog() {
        if (!isGpsDevMode()) return;
        var args = ['[KV GPS QA]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    function gpsDeniedToast() {
        toast('A helymeghatározás tiltva van ennél az oldalnál. Engedélyezd a böngésző címsorában a lakat/hely ikon alatt.');
    }

    function startMyLocation(sourceButtonId) {
        var btn = $('btn-my-location');
        gpsQaLog('clicked button id:', sourceButtonId || 'unknown');
        gpsQaLog('geolocation support:', !!navigator.geolocation);

        if (!navigator.geolocation) {
            toast('Ez a böngésző nem támogatja a helymeghatározást.');
            return;
        }

        function onSuccess(pos) {
            gpsQaLog('success', {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy
            });
            updateUserMarker(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
            map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 16), { animate: true });
            startGpsWatch();
        }

        function onError(err) {
            if (btn) btn.classList.remove('is-on');
            gpsQaLog('error code:', err && err.code, err && err.message ? err.message : '');
            if (err && err.code === 1) {
                gpsDeniedToast();
                return;
            }
            if (err && err.code === 3) {
                toast('GPS időtúllépés – próbáld újra');
                return;
            }
            toast('Engedélyezd a helymeghatározást');
        }

        function runGetCurrentPosition() {
            if (btn) btn.classList.add('is-on');
            navigator.geolocation.getCurrentPosition(onSuccess, onError, {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 15000
            });
        }

        if (navigator.permissions && navigator.permissions.query) {
            navigator.permissions.query({ name: 'geolocation' }).then(function (result) {
                gpsQaLog('permission state:', result.state);
                if (result.state === 'denied') {
                    gpsDeniedToast();
                    return;
                }
                runGetCurrentPosition();
            }).catch(function (err) {
                gpsQaLog('permission query failed:', err && err.message ? err.message : err);
                runGetCurrentPosition();
            });
            return;
        }

        gpsQaLog('permission API unavailable, fallback getCurrentPosition');
        runGetCurrentPosition();
    }

    /* ── Schedule (mini overlay) ── */
    function renderScheduleList() {
        var list = $('schedule-list');
        if (!list) return;
        var v = state.activeVehicle;
        var freeCount = v && v.active ? v.freeSeats : null;
        list.innerHTML = state.schedule.map(function (row) {
            return (
                '<li class="schedule-item" data-time="' + escapeHtml(row.time) + '" data-stop="' + escapeHtml(row.stopId || '') + '">' +
                '<p class="schedule-time">' + escapeHtml(row.time) + '</p>' +
                '<p class="schedule-meta">' + escapeHtml(row.label) + '</p>' +
                '<span class="schedule-seats ' + seatsClass(row.seats) + '">' + escapeHtml(scheduleSeatsLabel(row.seats, freeCount)) + '</span>' +
                '</li>'
            );
        }).join('');
        list.querySelectorAll('.schedule-item').forEach(function (item) {
            item.addEventListener('click', function () {
                var stopId = item.dataset.stop || (getDisplayStop() && getDisplayStop().id);
                if (stopId) {
                    openStopOnMap(stopId, { selectedTime: item.dataset.time, showBoard: false });
                }
                closeOverlay('schedule-panel');
            }, { passive: true });
        });
    }

    function openOverlay(id) {
        var panel = $(id);
        if (panel) panel.classList.add('open');
    }

    function closeOverlay(id) {
        var panel = $(id);
        if (panel) panel.classList.remove('open');
    }

    function initDevToggle() {
        var taps = 0, t = null;
        if (!elVersion) return;
        elVersion.addEventListener('click', function () {
            taps += 1;
            clearTimeout(t);
            t = setTimeout(function () { taps = 0; }, 900);
            if (taps >= 5) {
                state.devGis = !state.devGis;
                taps = 0;
                toast(state.devGis ? 'GIS debug be' : 'GIS debug ki');
                var city = DATA.CITIES.find(function (c) { return c.id === state.cityId; });
                if (city) loadCityRoute(city);
            }
        }, { passive: true });
    }

    function initBoardSheet() {
        elBoardSheet = $('board-sheet');
        elBoardSheetStopName = $('board-sheet-stop-name');
        elBoardSheetArrival = $('board-sheet-arrival');
        elBoardSheetMeta = $('board-sheet-meta');
        elBoardSheetPhoneWrap = $('board-sheet-phone-wrap');
        elBoardSheetPhone = $('board-sheet-phone');
        elBoardSheetCta = $('board-sheet-cta');
        var scrim = $('board-sheet-scrim');
        var closeBtn = $('board-sheet-close');
        if (scrim) scrim.addEventListener('click', closeMobileBoardSheet, { passive: true });
        if (closeBtn) closeBtn.addEventListener('click', closeMobileBoardSheet, { passive: true });
        if (elBoardSheetCta) elBoardSheetCta.addEventListener('click', submitMobileBoarding);
    }

    function bindUi() {
        elStatusLine = $('status-line');
        elPeekStop = $('peek-stop');
        elPeekStopMeta = $('peek-stop-meta');
        elToast = $('toast');
        elVersion = $('version-footer');
        initBoardSheet();

        $('btn-my-location').addEventListener('click', function () {
            startMyLocation('btn-my-location');
        }, { passive: true });
        $('btn-schedule-fab').addEventListener('click', function () { openOverlay('schedule-panel'); }, { passive: true });
        $('btn-peek-reserve').addEventListener('click', openQuickBook, { passive: true });
        $('btn-peek-board').addEventListener('click', openQuickBoard, { passive: true });

        document.querySelectorAll('[data-close]').forEach(function (btn) {
            btn.addEventListener('click', function () { closeOverlay(btn.dataset.close); }, { passive: true });
        });

        document.addEventListener('click', function (e) {
            var chip = e.target.closest('.stop-popup .dep-pick');
            if (chip) {
                var popupEl = chip.closest('.stop-popup');
                if (!popupEl) return;
                var stopId = popupEl.dataset.stopId;
                setStopPopup(stopId, { selectedTime: chip.dataset.time, showBoard: false }, true);
                return;
            }
            var boardToggle = e.target.closest('.sp-board-toggle');
            if (boardToggle) {
                var popupB = boardToggle.closest('.stop-popup');
                if (popupB) {
                    setStopPopup(popupB.dataset.stopId, {
                        selectedTime: getSelectedTimeFromPopup(popupB) || state.popupContext.selectedTime || '',
                        showBoard: true
                    }, true);
                }
                return;
            }
            var bookBtn = e.target.closest('.sp-book-submit');
            if (bookBtn) {
                e.preventDefault();
                var popup = bookBtn.closest('.stop-popup');
                if (popup) submitStopBooking(popup);
                return;
            }
            var boardBtn = e.target.closest('.sp-board-submit');
            if (boardBtn) {
                e.preventDefault();
                var popup2 = boardBtn.closest('.stop-popup');
                if (popup2) submitStopBoarding(popup2);
            }
        });

        var stopBarInfo = $('stop-bar-info');
        if (stopBarInfo) {
            stopBarInfo.addEventListener('click', function () {
                var stop = getDisplayStop();
                if (stop) openStopOnMap(stop.id, { selectedTime: '', showBoard: false });
            }, { passive: true });
            stopBarInfo.style.cursor = 'pointer';
        }
    }

    function init() {
        initMap();
        buildCityStrip();
        bindUi();
        if (elVersion) elVersion.textContent = DATA.PUBLIC_VERSION;
        initDevToggle();

        window.KVN_SHELL = {
            startMyLocation: startMyLocation,
            openQuickBook: openQuickBook,
            openQuickBoard: openQuickBoard,
            selectCity: selectCity,
            setBaseMap: setBaseMap,
            getLayersPanelModel: getLayersPanelModel,
            refreshLayersAudit: auditGeoJsonLayers
        };

        auditGeoJsonLayers();

        DATA.loadPoiCatalog().then(function (pois) { state.pois = pois; });

        DATA.loadSchedulesCatalog().then(function () {
            var def = DATA.CITIES.find(function (c) { return c.default; }) || DATA.CITIES[0];
            selectCity(def.id);
            startVehiclePoll();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
