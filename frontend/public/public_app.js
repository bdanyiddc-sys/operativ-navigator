(function () {
    'use strict';

    var DATA = window.KVN_PUBLIC;
    if (!DATA) return;

    var WALK_SPEED_M_PER_MIN = 80;
    var TRAIN_APPROACH_M_PER_MIN = 220;
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
        popupContext: { stopId: '', selectedTime: '', showBoard: false }
    };

    var map, routeLayers, vehicleLayer, stopLayer, poiLayer, userLayer;
    var stopMarkers = {};
    var openPopupStopId = null;

    var elStatusLine, elPeekStop, elPeekStopMeta;
    var elToast, elVersion;

    function $(id) { return document.getElementById(id); }

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

    function getTrainDistanceM() {
        var v = state.activeVehicle;
        if (!v || !state.userPos || v.lat == null) return null;
        return haversineM(state.userPos.lat, state.userPos.lng, v.lat, v.lng);
    }

    function getTrainProximityLabel() {
        var dist = getTrainDistanceM();
        if (dist == null) return null;
        if (dist <= 40) return 'Megérkezett';
        if (dist <= 250) return 'A közelben';
        if (dist <= 700) return 'Hamarosan érkezik';
        return 'Közlekedik';
    }

    function getTrainArrivalLine() {
        var dist = getTrainDistanceM();
        if (dist == null) return null;
        if (dist <= 40) return 'Megérkezett';
        var acc = state.userAccuracy;
        var gpsReliable = acc != null && acc <= GPS_ACCURACY_TRUST_M;
        if (gpsReliable && dist <= 1500) {
            var min = Math.max(1, Math.round(dist / TRAIN_APPROACH_M_PER_MIN));
            return 'kb. ' + min + ' perc';
        }
        return getTrainProximityLabel();
    }

    function popupSeatsLine() {
        var v = state.activeVehicle;
        if (!v || !v.active || v.freeSeats == null) return '🟢 Van hely';
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

    function getStopNextDeparture(stop) {
        if (stop && stop.departures && stop.departures.length) return stop.departures[0];
        return nextDepartureFromVehicle() || '—';
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

        var defCity = DATA.CITIES.find(function (c) { return c.default; }) || DATA.CITIES[0];
        var startCenter = defCity && defCity.center ? defCity.center : [47.649, 18.318];

        map = L.map('map', {
            center: startCenter,
            zoom: 14,
            zoomSnap: 0.25,
            maxZoom: 22,
            layers: [cartoLight]
        });

        L.control.layers({ Voyager: cartoLight, OSM: osm }, null, { position: 'bottomleft', collapsed: true }).addTo(map);

        routeLayers = { black: null, red: null, hit: null };
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
        window.addEventListener('resize', function () { map.invalidateSize(); });
        window.addEventListener('orientationchange', function () {
            setTimeout(function () { map.invalidateSize(); }, 300);
        });
    }

    function mapTopPadding() {
        return 110;
    }

    function styleOutline() {
        return { color: '#111111', weight: 9, opacity: 1, lineCap: 'round', lineJoin: 'round' };
    }

    function styleRed() {
        return { color: '#e53935', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' };
    }

    function clearRoute() {
        if (routeLayers.black) { map.removeLayer(routeLayers.black); routeLayers.black = null; }
        if (routeLayers.red) { map.removeLayer(routeLayers.red); routeLayers.red = null; }
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

        routeLayers.hit = L.geoJSON(geoData, {
            interactive: true,
            style: function (feature) {
                var g = feature.geometry;
                if (g.type === 'LineString' || g.type === 'MultiLineString') {
                    return { color: 'transparent', weight: 22, opacity: 0.01 };
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
        if (routeLayers.red) routeLayers.red.bringToFront();
        if (routeLayers.hit) routeLayers.hit.bringToFront();
        if (state.routeBoardMode && routeLayers.hit) {
            routeLayers.hit.bringToFront();
        }
    }

    function updateRouteBoardModeUi() {
        var btn = $('btn-peek-board');
        if (btn) btn.classList.toggle('is-route-pick', !!state.routeBoardMode);
        syncRouteLayerOrder();
    }

    function setRouteBoardMode(on) {
        state.routeBoardMode = !!on;
        updateRouteBoardModeUi();
        if (state.routeBoardMode) {
            toast('Koppints az útvonalra vagy egy megállóra');
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

    function trainMarkerHtml(v) {
        var cap = v.capacity || 56;
        var free = v.freeSeats != null ? v.freeSeats : '—';
        var st = v.active ? seatStatus(v.freeSeats, cap) : null;
        var freeCls = 'tm-free-ok';
        if (st && st.cls === 'warn') freeCls = 'tm-free-warn';
        if (st && st.cls === 'bad') freeCls = 'tm-free-bad';
        return '<div class="train-marker-wrap">' +
            '<div class="train-marker-min" aria-hidden="true">🚂</div>' +
            '<div class="train-marker-seats ' + freeCls + '">' +
            '<span class="tm-free-num">' + escapeHtml(String(free)) + '</span>' +
            '<span class="tm-free-lbl">szabad</span>' +
            '</div></div>';
    }

    function renderVehicles() {
        vehicleLayer.clearLayers();
        state.vehicles.forEach(function (v) {
            if (v.lat == null || v.lng == null) return;
            var icon = L.divIcon({
                className: 'train-marker-root',
                html: trainMarkerHtml(v),
                iconSize: [132, 56],
                iconAnchor: [28, 28]
            });
            var marker = L.marker([v.lat, v.lng], { icon: icon, zIndexOffset: 350 });
            var cap = v.capacity || 56;
            var liveTag = v.live ? 'Élő GPS' : 'Bemutató pozíció';
            marker.bindPopup(
                '<div class="train-popup">' +
                '<p class="tp-title">🚂 ' + escapeHtml(v.id) + '</p>' +
                '<p class="tp-meta">' + escapeHtml(liveTag) + '</p>' +
                '<p class="tp-seats">Szabad: <strong class="tp-free-strong">' + escapeHtml(String(v.freeSeats)) + '</strong> / ' + escapeHtml(String(cap)) + ' fő</p>' +
                '</div>'
            );
            marker.addTo(vehicleLayer);
        });
        state.activeVehicle = state.vehicles.find(function (v) { return v.active; }) || state.vehicles[0] || null;
        updateUi();
    }

    function popupChromePadding() {
        var style = getComputedStyle(document.documentElement);
        var top = (parseFloat(style.getPropertyValue('--status-panel-h')) || 88) +
            (parseFloat(style.getPropertyValue('--city-strip-h')) || 52) + 12;
        var bottom = (parseFloat(style.getPropertyValue('--stop-bar-h')) || 58) + 10;
        return {
            topLeft: L.point(10, Math.ceil(top)),
            bottomRight: L.point(10, Math.ceil(bottom))
        };
    }

    function stopPopupLeafletOptions() {
        var pad = popupChromePadding();
        return {
            maxWidth: Math.min(300, window.innerWidth - 20),
            className: 'stop-popup-wrap',
            autoPan: true,
            autoPanPaddingTopLeft: pad.topLeft,
            autoPanPaddingBottomRight: pad.bottomRight,
            keepInView: true
        };
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
        var trainLine = getTrainArrivalLine();
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
            var icon = L.divIcon({
                className: '',
                html: '<div class="stop-marker' + (isNear ? ' is-near' : '') + '">🚏</div>',
                iconSize: [44, 44],
                iconAnchor: [22, 22]
            });
            var m = L.marker([stop.lat, stop.lng], { icon: icon, zIndexOffset: 800 });
            var ctx = (reopenId === stop.id) ? reopenCtx : { selectedTime: '', showBoard: false };
            m.bindPopup(L.popup(stopPopupLeafletOptions()).setContent(stopPopupHtml(enriched, ctx)));
            m.on('click', function () {
                state.selectedStopId = stop.id;
                var ctx = {
                    stopId: stop.id,
                    selectedTime: '',
                    showBoard: !!state.routeBoardMode
                };
                state.popupContext = ctx;
                openPopupStopId = stop.id;
                if (state.routeBoardMode) {
                    state.routeBoardMode = false;
                    updateRouteBoardModeUi();
                }
                setStopPopup(stop.id, ctx, true);
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
        setStopPopup(stopId, ctx, true);
        updateUi();
    }

    function openQuickBook() {
        var stop = getDisplayStop();
        if (!stop) { toast('Válassz megállót a térképen'); return; }
        openStopOnMap(stop.id, { selectedTime: '', showBoard: false });
    }

    function openQuickBoard() {
        setRouteBoardMode(true);
        var stop = getDisplayStop();
        if (stop) {
            map.panTo([stop.lat, stop.lng], { animate: true });
        }
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
            map.closePopup();
            toast('Foglalás rögzítve');
        }).catch(function () { toast('Foglalás sikertelen'); });
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
        var popup = L.popup({ className: 'route-board-wrap', maxWidth: 300, closeButton: true })
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
            map.closePopup();
            state.routeBoardMode = false;
            updateRouteBoardModeUi();
            toast('Felszállási jelzés elküldve (útvonal menti)');
        }).catch(function () { toast('Küldés sikertelen'); });
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
        DATA.submitBoardingRequest({
            city: state.cityLabel,
            stop_id: stopId,
            stop_name: stopName,
            count: count,
            phone: phone,
            created_at: new Date().toISOString()
        }).then(function () {
            map.closePopup();
            toast('Felszállási jelzés elküldve');
        }).catch(function () { toast('Küldés sikertelen'); });
    }

    /* ── UI ── */
    function updateStatusLine() {
        if (!elStatusLine) return;
        var v = state.activeVehicle;
        var stop = getDisplayStop();
        var dep = getStopNextDeparture(stop);
        var st = v && v.active ? seatStatus(v.freeSeats, v.capacity) : null;
        var emoji = seatEmoji(st);
        var seats = seatsCountLabel(v);
        var seatCls = st && st.cls ? ' seat-' + st.cls : '';
        var freeNum = (v && v.active && v.freeSeats != null) ? String(v.freeSeats) : '—';
        var trainLine = getTrainArrivalLine();
        var line =
            '🚂 ' + escapeHtml(state.cityLabel) +
            ' • ' + escapeHtml(dep) +
            ' • ' + emoji + ' <span class="seat-free-num' + seatCls + '">' + escapeHtml(freeNum) + '</span> / ' + escapeHtml(String(v && v.capacity ? v.capacity : 56)) + ' szabad';
        if (trainLine) line += ' • 🚂 ' + escapeHtml(trainLine);
        elStatusLine.innerHTML = line;
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
        state.vehicles = (DATA.MOCK_VEHICLES[city.id] || []).slice();
        state.schedule = (DATA.MOCK_SCHEDULES[city.id] || []).slice();
        state.activeVehicle = state.vehicles.find(function (v) { return v.active; }) || state.vehicles[0] || null;
        state.selectedStopId = null;
        state.routeBoardMode = false;
        state.popupContext = { stopId: '', selectedTime: '', showBoard: false };
        openPopupStopId = null;
        updateRouteBoardModeUi();
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
            findNearestStop();
            renderVehicles();
            renderStops();
            renderScheduleList();
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

    function startMyLocation() {
        if (!navigator.geolocation) { toast('GPS nem elérhető'); return; }
        var btn = $('btn-my-location');
        if (btn) btn.classList.add('is-on');
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                updateUserMarker(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
                map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 16), { animate: true });
                startGpsWatch();
            },
            function () { toast('Engedélyezd a helymeghatározást'); },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
        );
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

    function bindUi() {
        elStatusLine = $('status-line');
        elPeekStop = $('peek-stop');
        elPeekStopMeta = $('peek-stop-meta');
        elToast = $('toast');
        elVersion = $('version-footer');

        $('btn-my-location').addEventListener('click', startMyLocation, { passive: true });
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
                if (popupB) setStopPopup(popupB.dataset.stopId, { selectedTime: '', showBoard: true }, true);
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

        DATA.loadPoiCatalog().then(function (pois) { state.pois = pois; });

        var def = DATA.CITIES.find(function (c) { return c.default; }) || DATA.CITIES[0];
        selectCity(def.id);
        startVehiclePoll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
