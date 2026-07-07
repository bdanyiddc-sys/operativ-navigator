(function (global) {
  'use strict';

  var CFG = global.DEPOT_MATRIX_CONFIG || {};
  var RTA = global.RouteTypeAdapter;
  var selectedTransferByBookingId = {};
  var selectedOriginKeyByBookingId = {};
  var transferDraftPreviewByBookingId = {};
  var routeActionStateByOriginId = new Map();
  var originInvalidatedByBookingId = {};
  var transferPendingByBookingId = {};
  var pendingOriginKeyByBookingId = {};
  var transferRouteRequestSeqByBookingId = {};
  var committedTransferSelectionByBookingId = {};
  var TRANSFER_OPERATIONAL_SPEED_KMH = 30;
  var GEOMETRY_ORIGIN_TOLERANCE_KM = 25;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function isLiveReadOnly() {
    return CFG.runtimeMode === 'LIVE_READ_ONLY_AUDIT';
  }

  function formatBookingLabel(b) {
    return (b.date || '') + ' ' + (b.timeStart || '') + ' · ' + (b.placeName || b.address || b.id);
  }

  function getRouteSelectVisibleBookings() {
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var source = bridge && (bridge.getRouteSelectVisibleBookings || bridge.getListingVisibleBookings)
      ? (bridge.getRouteSelectVisibleBookings ? bridge.getRouteSelectVisibleBookings() : bridge.getListingVisibleBookings())
      : (bridge && bridge.getBookings ? bridge.getBookings() : []);
    return source.map(function (b) {
      var c = resolveBookingCoords(b);
      if (c.lat == null || c.lng == null) return null;
      return Object.assign({}, b, { lat: c.lat, lng: c.lng });
    }).filter(Boolean);
  }

  function buildSelectOptionsHtml(bookings, includePlaceholder) {
    var html = includePlaceholder ? '<option value="">— válassz foglalást —</option>' : '';
    return html + bookings.map(function (b) {
      return '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(formatBookingLabel(b)) + '</option>';
    }).join('');
  }

  function syncBookingSelects(preferredId) {
    var routeSel = $('routeBookingId');
    if (!routeSel) return null;
    var bookings = getRouteSelectVisibleBookings();
    var hadExplicit = arguments.length > 0;
    var routePrev = hadExplicit ? String(preferredId || '') : String(routeSel.value || '');
    routeSel.innerHTML = buildSelectOptionsHtml(bookings, true);
    if (routePrev && bookings.some(function (b) { return b.id === routePrev; })) {
      routeSel.value = routePrev;
    } else if (routePrev && bookings.length) {
      routeSel.value = bookings[0].id;
    } else {
      routeSel.value = '';
    }
    return routeSel.value || null;
  }

  function getSelectedTransferRoute(bookingId) {
    if (!bookingId) return null;
    return selectedTransferByBookingId[bookingId] || null;
  }

  function setSelectedTransferRoute(bookingId, route, originKey, options) {
    options = options || {};
    if (!bookingId) return;
    if (route && !options.skipEligibilityGuard) {
      var guardKey = originKey || getSelectedOriginKey(bookingId);
      if (guardKey) {
        assertOriginEligibleForAssignment(findOriginByKey(guardKey));
      }
    }
    if (route) {
      selectedTransferByBookingId[bookingId] = route;
      if (originKey) selectedOriginKeyByBookingId[bookingId] = originKey;
      transferDraftPreviewByBookingId[bookingId] = {
        selectedTransferRoute: route,
        transferRoute: route,
        note: 'Odaállási útvonal kiválasztva – read-only tesztmódban nincs adatbázisba mentve.'
      };
    } else {
      delete selectedTransferByBookingId[bookingId];
      delete selectedOriginKeyByBookingId[bookingId];
      delete transferDraftPreviewByBookingId[bookingId];
    }
  }

  function getRouteFormState(bookingId) {
    var id = bookingId;
    if (!id) {
      var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
      var b = bridge && bridge.getRouteTargetBooking ? bridge.getRouteTargetBooking() : null;
      id = b && b.id;
    }
    var selected = getSelectedTransferRoute(id);
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var state = {};
    if (selected) {
      state = { selectedTransferRoute: selected, transferRoute: selected };
    } else if (bridge && bridge.getBookingById && id && !isOriginInvalidatedForBooking(id)) {
      var persisted = bridge.getBookingById(id);
      if (persisted && persisted.selectedTransferRoute) {
        state = {
          selectedTransferRoute: persisted.selectedTransferRoute,
          transferRoute: persisted.transferRoute || persisted.selectedTransferRoute
        };
      }
    }
    if (bridge && bridge.getVehicleFuelConfig) {
      var fuel = bridge.getVehicleFuelConfig();
      if (fuel) {
        if (fuel.consumptionLitresPer100Km != null) state.consumptionLitresPer100Km = fuel.consumptionLitresPer100Km;
        if (fuel.fuelPricePerLitre != null) state.fuelPricePerLitre = fuel.fuelPricePerLitre;
      }
    }
    var speedEl = $('routeSpeed');
    if (speedEl && speedEl.value) {
      var speed = parseFloat(speedEl.value);
      if (isFinite(speed) && speed > 0) state.averageSpeedKmh = speed;
    }
    return state;
  }

  function getSelectedOriginKey(bookingId) {
    return bookingId ? (selectedOriginKeyByBookingId[bookingId] || null) : null;
  }

  function getTransferDraftPreview(bookingId) {
    return bookingId ? (transferDraftPreviewByBookingId[bookingId] || null) : null;
  }

  function fetchOsrmRoute(fromLat, fromLng, toLat, toLng) {
    var base = String(CFG.osrmBase || 'https://router.project-osrm.org/route/v1').replace(/\/$/, '');
    var url = base + '/driving/' + fromLng + ',' + fromLat + ';' + toLng + ',' + toLat + '?overview=full&geometries=geojson';
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('OSRM_HTTP_' + r.status);
      return r.json();
    }).then(function (data) {
      if (!data || data.code !== 'Ok' || !data.routes || !data.routes[0]) throw new Error('OSRM_ROUTE_EMPTY');
      var route = data.routes[0];
      return {
        geometry: route.geometry,
        distanceKm: Math.round((route.distance / 1000) * 10) / 10,
        travelMinutes: Math.round(route.duration / 60),
        routingProvider: 'osrm-route',
        provider: 'osrm-route'
      };
    });
  }

  var SAFE_ROUTE_ERROR_MSG = 'Biztonságos, gyorsforgalmi utakat kerülő útvonal most nem számítható. Az útvonal nem használható.';
  var TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG = 'Biztonságos, gyorsforgalmi utakat kerülő kiállási útvonal most nem számítható. Az ajánlott indulási pont továbbra is megmarad, de útvonal nem rajzolható hozzá.';

  function getRouteActionState(originKey) {
    if (!originKey) return { status: 'idle', message: '', geometry: null };
    return routeActionStateByOriginId.get(originKey) || { status: 'idle', message: '', geometry: null };
  }

  function setRouteActionState(originKey, patch) {
    if (!originKey) return;
    var prev = routeActionStateByOriginId.get(originKey) || { status: 'idle', message: '', geometry: null };
    routeActionStateByOriginId.set(originKey, Object.assign({}, prev, patch, {
      originKey: originKey,
      lastAttemptAt: new Date().toISOString()
    }));
  }

  function clearRouteActionState() {
    routeActionStateByOriginId.clear();
  }

  function isNetworkFetchError(err) {
    var msg = err && err.message ? String(err.message) : String(err || '');
    return /Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)
      || (err && err.name === 'TypeError' && /fetch/i.test(msg));
  }

  function classifyTransferRouteError(err) {
    var msg = err && err.message ? String(err.message) : String(err || '');
    if (/STALE_TRANSFER_RESPONSE|STALE_ASYNC/i.test(msg)) {
      return { status: 'stale-response', code: 'STALE_RESPONSE_IGNORED', message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG };
    }
    if (msg.indexOf('TRANSFER_SNAPSHOT_VALIDATION_REJECTED:') === 0) {
      var rejCode = msg.slice('TRANSFER_SNAPSHOT_VALIDATION_REJECTED:'.length) || 'UNKNOWN';
      return {
        status: 'validation-rejected',
        code: 'CLIENT_VALIDATION_REJECTION',
        rejectionCode: rejCode,
        message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG
      };
    }
    if (isNetworkFetchError(err)) {
      return { status: 'network-error', code: 'PROVIDER_NETWORK_ERROR', message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG };
    }
    if (/HTTP_\d{3}|provider.*not ok|VALHALLA_HTTP/i.test(msg)) {
      return { status: 'provider-http', code: 'PROVIDER_HTTP_ERROR', message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG };
    }
    if (/Biztonságos|SAFE_ROUTE|has_highway|HIGHWAY/i.test(msg)) {
      return { status: 'safe-route-unavailable', code: 'ROUTE_RESTRICTIONS_TOO_STRICT', message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG };
    }
    if (/ORIGIN_MISMATCH|ORIGIN_COORDINATES/i.test(msg)) {
      return { status: 'origin-mismatch', code: 'ORIGIN_MISMATCH', message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG };
    }
    if (/geometry|GEOMETRY|EMPTY_ROUTE/i.test(msg)) {
      return { status: 'empty-route', code: 'INVALID_GEOMETRY', message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG };
    }
    return { status: 'unknown', code: 'UNKNOWN', message: TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG };
  }

  function buildOriginRouteSnapshot(origin, originKey) {
    return {
      originKey: originKey,
      originType: origin.originType || 'DEPOT',
      originId: origin.originId || origin.depotId || origin.previousProjectId || null,
      originName: origin.originName || origin.depotName || origin.originId || '—',
      depotId: origin.depotId,
      depotName: origin.depotName,
      lat: Number(origin.lat),
      lng: Number(origin.lng),
      originBookingId: origin.originBookingId || origin.previousProjectId || null,
      originVehicleId: origin.originVehicleId || origin.previousVehicle || null,
      originEndAt: origin.originEndAt || origin.previousProjectEndAt || null,
      originEndLocation: origin.originEndLocation || origin.originName || origin.originLabel || '—',
      latestDeparture: origin.latestDeparture,
      latestDepartureAt: origin.latestDepartureAt,
      gapMinutes: origin.gapMinutes,
      transitionWindowMinutes: origin.transitionWindowMinutes,
      feasible: origin.feasible !== false,
      dataQuality: origin.dataQuality,
      dataQualityLabel: origin.dataQualityLabel,
      eligible: origin.eligible
    };
  }

  function shouldAvoidHighways() {
    return CFG.avoidHighways !== false;
  }

  function decodeValhallaPolyline(encoded, precision) {
    precision = precision || 6;
    var factor = Math.pow(10, precision);
    var coords = [];
    var index = 0;
    var lat = 0;
    var lng = 0;
    while (index < encoded.length) {
      var b;
      var shift = 0;
      var result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      var dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;
      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      var dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;
      coords.push([lng / factor, lat / factor]);
    }
    return { type: 'LineString', coordinates: coords };
  }

  function fetchValhallaRouteWithGeometry(fromLat, fromLng, toLat, toLng, options) {
    options = options || {};
    var url = options.routeUrl || CFG.valhallaUrl || CFG.valhallaRouteUrl || 'https://valhalla1.openstreetmap.de/route';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [{ lat: fromLat, lon: fromLng }, { lat: toLat, lon: toLng }],
        costing: 'auto',
        costing_options: { auto: { use_highways: 0, use_tolls: 0 } },
        units: 'kilometers'
      })
    }).then(function (r) {
      if (!r.ok) throw new Error(SAFE_ROUTE_ERROR_MSG);
      return r.json();
    }).then(function (data) {
      if (!data || !data.trip || !data.trip.legs || !data.trip.legs[0] || !data.trip.legs[0].shape) {
        throw new Error(SAFE_ROUTE_ERROR_MSG);
      }
      var summary = data.trip.summary || {};
      if (summary.has_highway) {
        throw new Error(SAFE_ROUTE_ERROR_MSG);
      }
      var geometry = decodeValhallaPolyline(data.trip.legs[0].shape, 6);
      if (!geometry.coordinates || geometry.coordinates.length < 2) {
        throw new Error(SAFE_ROUTE_ERROR_MSG);
      }
      return {
        geometry: geometry,
        distanceKm: Math.round((summary.length || 0) * 10) / 10,
        travelMinutes: Math.round((summary.time || 0) / 60),
        routingProvider: 'valhalla-route',
        provider: 'valhalla-route',
        highwayMode: 'avoided'
      };
    });
  }

  function normalizeBridgeRouteResult(result) {
    if (!result || !result.ok || !result.geometry) return null;
    if (result.hasHighway) return null;
    var distKm = result.distanceKm != null ? Number(result.distanceKm)
      : (result.distanceMeters != null ? Math.round(Number(result.distanceMeters) / 100) / 10 : null);
    var travelMin = result.travelMinutes != null ? Number(result.travelMinutes)
      : (result.routingSeconds != null ? Math.round(Number(result.routingSeconds) / 60)
        : (result.durationSeconds != null ? Math.round(Number(result.durationSeconds) / 60) : null));
    if (distKm == null || !isFinite(distKm) || travelMin == null || !isFinite(travelMin)) return null;
    return {
      geometry: result.geometry,
      distanceKm: distKm,
      travelMinutes: travelMin,
      routingProvider: result.provider || 'valhalla-route',
      provider: result.provider || 'valhalla-route',
      highwayMode: result.highwayMode || 'avoided'
    };
  }

  function fetchTransferRouteViaBridge(fromLat, fromLng, toLat, toLng) {
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (!bridge || typeof bridge.requestValhallaRoute !== 'function') return null;
    return bridge.requestValhallaRoute(fromLng, fromLat, toLng, toLat).then(function (result) {
      var normalized = normalizeBridgeRouteResult(result);
      if (!normalized) throw new Error(SAFE_ROUTE_ERROR_MSG);
      return normalized;
    });
  }

  function fetchTransferRoute(fromLat, fromLng, toLat, toLng) {
    var bridgeRoute = fetchTransferRouteViaBridge(fromLat, fromLng, toLat, toLng);
    if (bridgeRoute) {
      return bridgeRoute.catch(function (bridgeErr) {
        if (!shouldAvoidHighways()) return Promise.reject(bridgeErr);
        return fetchValhallaRouteWithGeometry(fromLat, fromLng, toLat, toLng).catch(function (firstErr) {
          if (!CFG.labValhallaProxyUrl) return Promise.reject(firstErr);
          var proxyRouteUrl = String(CFG.labValhallaProxyUrl).replace(/\/$/, '') + '/route';
          return fetchValhallaRouteWithGeometry(fromLat, fromLng, toLat, toLng, { routeUrl: proxyRouteUrl });
        });
      });
    }
    if (shouldAvoidHighways()) {
      return fetchValhallaRouteWithGeometry(fromLat, fromLng, toLat, toLng).catch(function (firstErr) {
        if (!CFG.labValhallaProxyUrl) return Promise.reject(firstErr);
        var proxyRouteUrl = String(CFG.labValhallaProxyUrl).replace(/\/$/, '') + '/route';
        return fetchValhallaRouteWithGeometry(fromLat, fromLng, toLat, toLng, { routeUrl: proxyRouteUrl });
      });
    }
    return fetchOsrmRoute(fromLat, fromLng, toLat, toLng);
  }

  function buildSelectedTransferRouteObject(origin, booking, routeData, bufferMinutes) {
    var originBookingId = origin.originBookingId || origin.previousProjectId || null;
    if (!originBookingId && (origin.originType === 'PREVIOUS_PROJECT' || origin.originType === 'DEPLOYABLE_TRAIN')) {
      originBookingId = origin.originId || null;
    }
  var latestDepartureAt = null;
    if (origin.latestDeparture) {
      latestDepartureAt = origin.latestDeparture.toISOString ? origin.latestDeparture.toISOString() : origin.latestDeparture;
    } else if (origin.latestDepartureAt) {
      latestDepartureAt = origin.latestDepartureAt;
    }
    var selected = {
      routeType: 'TRANSFER_ROUTE',
      bookingId: booking.id,
      originType: origin.originType || 'DEPOT',
      originId: origin.originId || origin.depotId || origin.previousProjectId || null,
      originLabel: origin.originName || origin.depotName || origin.originId || '—',
      originBookingId: originBookingId,
      originVehicleId: origin.originVehicleId || origin.previousVehicle || null,
      originEndAt: origin.originEndAt || origin.previousProjectEndAt || null,
      originEndLocation: origin.originEndLocation || origin.originName || origin.originLabel || '—',
      fromLat: origin.lat,
      fromLng: origin.lng,
      toLat: booking.lat,
      toLng: booking.lng,
      geometry: routeData.geometry,
      distanceKm: routeData.distanceKm,
      travelMinutes: routeData.travelMinutes,
      transferTravelMinutes: routeData.travelMinutes,
      preparationBufferMinutes: bufferMinutes,
      availableTransitionMinutes: origin.gapMinutes != null ? origin.gapMinutes : origin.transitionWindowMinutes,
      latestDepartureAt: latestDepartureAt,
      feasible: origin.feasible !== false,
      routingProvider: routeData.routingProvider || routeData.provider || 'valhalla-route',
      provider: routeData.provider || routeData.routingProvider || 'valhalla-route',
      dataQuality: origin.dataQuality || (origin.dataQualityLabel === 'TÉNYLEGES' ? 'ACTUAL' : 'PLANNED_FALLBACK'),
      fallbackUsed: false,
      calculatedAt: new Date().toISOString(),
      assignedAt: new Date().toISOString(),
      isMock: false
    };
    return enrichTransferOperationalMetrics(selected);
  }

  function resolveBookingCoords(booking) {
    if (!booking) return { lat: null, lng: null };
    if (booking.lat != null && booking.lng != null) return { lat: Number(booking.lat), lng: Number(booking.lng) };
    var OTA = global.OperationalTrainAdapter;
    if (OTA && OTA.resolveEndCoords) return OTA.resolveEndCoords(booking);
    return { lat: null, lng: null };
  }

  function getFuelConfig(booking) {
    var cfg = CFG.vehicleFuelConfig || {};
    var consumption = cfg.consumptionLitresPer100Km != null ? Number(cfg.consumptionLitresPer100Km) : null;
    var fuelPrice = cfg.fuelPricePerLitre != null ? Number(cfg.fuelPricePerLitre) : null;
    var source = cfg.source || 'DEPOT_MATRIX_CONFIG.vehicleFuelConfig';
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (bridge && bridge.getVehicleFuelConfig) {
      var fromBridge = bridge.getVehicleFuelConfig(booking && booking.vehicle);
      if (fromBridge) {
        if (fromBridge.consumptionLitresPer100Km != null) consumption = Number(fromBridge.consumptionLitresPer100Km);
        if (fromBridge.fuelPricePerLitre != null) fuelPrice = Number(fromBridge.fuelPricePerLitre);
        if (fromBridge.source) source = fromBridge.source;
      }
    }
    return {
      source: source,
      consumptionLitresPer100Km: consumption,
      fuelPricePerLitre: fuelPrice
    };
  }

  function normalizeTransferLineString(geom) {
    if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) return null;
    var coords = geom.coordinates.filter(function (c) {
      return Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1]);
    });
    if (coords.length < 2) return null;
    return { type: 'LineString', coordinates: coords };
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function geometryMatchesOriginPoint(geometry, fromLat, fromLng) {
    if (fromLat == null || fromLng == null || !geometry || !geometry.coordinates || !geometry.coordinates.length) return false;
    var first = geometry.coordinates[0];
    return haversineKm(Number(fromLat), Number(fromLng), Number(first[1]), Number(first[0])) <= GEOMETRY_ORIGIN_TOLERANCE_KM;
  }

  function enrichTransferOperationalMetrics(route) {
    if (!route || route.distanceKm == null || !isFinite(Number(route.distanceKm))) return route;
    var km = Number(route.distanceKm);
    var providerMin = route.travelMinutes != null && isFinite(Number(route.travelMinutes))
      ? Math.round(Number(route.travelMinutes))
      : (route.providerDurationMinutes != null ? Math.round(Number(route.providerDurationMinutes)) : null);
    var opMin = Math.round((km / TRANSFER_OPERATIONAL_SPEED_KMH) * 60);
    route.providerDurationMinutes = providerMin;
    route.operationalAverageSpeedKmh = TRANSFER_OPERATIONAL_SPEED_KMH;
    route.operationalDurationMinutes = opMin;
    route.roundTripDistanceKm = Math.round(km * 2 * 10) / 10;
    route.roundTripOperationalDurationMinutes = opMin * 2;
    return route;
  }

  function explainTransferSnapshotRejection(route, booking, options) {
    options = options || {};
    if (!route || !booking || !booking.id) {
      return { ok: false, code: 'MISSING_ROUTE_OR_BOOKING', field: 'route/booking' };
    }
    var geom = normalizeTransferLineString(route.geometry);
    if (!geom) {
      return { ok: false, code: 'INVALID_GEOMETRY', field: 'geometry', expected: 'LineString>=2', actual: route.geometry ? route.geometry.type : null };
    }
    if (route.bookingId && route.bookingId !== booking.id) {
      return { ok: false, code: 'BOOKING_ID_MISMATCH', field: 'bookingId', expected: booking.id, actual: route.bookingId };
    }
    var km = route.distanceKm != null ? Number(route.distanceKm) : null;
    if (km == null || !isFinite(km) || km <= 0) {
      return { ok: false, code: 'DISTANCE_INVALID', field: 'distanceKm', expected: '>0', actual: route.distanceKm };
    }
    var travelMin = route.travelMinutes != null ? Number(route.travelMinutes) : Number(route.providerDurationMinutes);
    if (!isFinite(travelMin) || travelMin <= 0) {
      return { ok: false, code: 'DURATION_INVALID', field: 'travelMinutes', expected: '>0', actual: travelMin };
    }
    var fromLat = route.fromLat;
    var fromLng = route.fromLng;
    if (fromLat == null || fromLng == null) {
      return { ok: false, code: 'START_POINT_MISSING', field: 'fromLat/fromLng', expected: 'coordinates', actual: null };
    }
    if (!geometryMatchesOriginPoint(geom, fromLat, fromLng)) {
      var first = geom.coordinates[0];
      var distKm = haversineKm(Number(fromLat), Number(fromLng), Number(first[1]), Number(first[0]));
      return {
        ok: false,
        code: 'ORIGIN_GEOMETRY_MISMATCH',
        field: 'geometry.coordinates[0]',
        expected: '<=' + GEOMETRY_ORIGIN_TOLERANCE_KM + ' km from start',
        actual: distKm.toFixed(3) + ' km'
      };
    }
    var label = route.originLabel || route.fromName || route.originEndLocation;
    if (!label) {
      return { ok: false, code: 'ORIGIN_LABEL_MISSING', field: 'originLabel', expected: 'non-empty', actual: null };
    }
    var originInvalidated = options.originInvalidated != null
      ? options.originInvalidated
      : isOriginInvalidatedForBooking(booking.id);
    if (originInvalidated && !options.allowServerReload && !options.allowFreshProviderRoute
      && !options.committedSelection) {
      return {
        ok: false,
        code: 'ORIGIN_INVALIDATED_PENDING',
        field: 'originInvalidatedByBookingId',
        expected: 'no invalidation or allowFreshProviderRoute',
        actual: 'invalidated'
      };
    }
    if (options.allowFreshProviderRoute && options.pendingOriginKey && options.originKey
      && options.pendingOriginKey !== options.originKey) {
      return {
        ok: false,
        code: 'ORIGIN_MISMATCH',
        field: 'pendingOriginKey',
        expected: options.pendingOriginKey,
        actual: options.originKey
      };
    }
    return { ok: true, code: 'VALID' };
  }

  function isValidTransferSnapshot(route, booking, options) {
    return explainTransferSnapshotRejection(route, booking, options).ok;
  }

  function hasKiallasPreviewData(route) {
    if (!route) return false;
    return route.distanceKm != null && Number(route.distanceKm) > 0;
  }

  function hasKiallasRouteData(route) {
    if (!route) return false;
    return !!normalizeTransferLineString(route.geometry);
  }

  function isOriginInvalidatedForBooking(bookingId) {
    return !!(bookingId && originInvalidatedByBookingId[bookingId]);
  }

  function resolveOriginDisplayLabel(origin, originKey) {
    if (!origin) return originKey || '—';
    return origin.originName || origin.depotName || origin.humanDisplayName
      || origin.originLabel || origin.originEndLocation || originKey || '—';
  }

  function markOriginChangePending(bookingId, originKey, origin) {
    if (!bookingId) return;
    var label = resolveOriginDisplayLabel(origin, originKey);
    originInvalidatedByBookingId[bookingId] = { originKey: originKey || null, at: new Date().toISOString() };
    pendingOriginKeyByBookingId[bookingId] = originKey || null;
    transferPendingByBookingId[bookingId] = 'Kiállási útvonal számítása: ' + label + '…';
    setSelectedTransferRoute(bookingId, null);
    delete selectedOriginKeyByBookingId[bookingId];
    markSelectedAdvisorCard(null);
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (bridge && bridge.clearCalculatedRouteForBooking) bridge.clearCalculatedRouteForBooking(bookingId);
    if (bridge && bridge.clearTransferMapLayers) bridge.clearTransferMapLayers();
    else if (bridge && bridge.refreshDepotRoutes) bridge.refreshDepotRoutes();
  }

  function clearOriginInvalidation(bookingId) {
    if (!bookingId) return;
    delete originInvalidatedByBookingId[bookingId];
    delete transferPendingByBookingId[bookingId];
    delete pendingOriginKeyByBookingId[bookingId];
  }

  function buildTransferValidationOptions(booking, item) {
    var opts = { allowServerReload: true };
    if (!booking || !booking.id || !item || item.source !== 'memory.selectedTransferRoute') return opts;
    var commit = committedTransferSelectionByBookingId[booking.id];
    var originKey = selectedOriginKeyByBookingId[booking.id];
    if (commit && commit.bookingId === booking.id && commit.originKey === originKey
      && commit.requestSeq === transferRouteRequestSeqByBookingId[booking.id]) {
      opts.committedSelection = true;
    }
    return opts;
  }

  function commitFreshTransferRouteSelection(bookingId, originKey, seq, selected, booking) {
    if (!bookingId || !originKey || !selected || !booking) {
      return { ok: false, code: 'MISSING_COMMIT_INPUT' };
    }
    if (transferRouteRequestSeqByBookingId[bookingId] !== seq) {
      return { ok: false, code: 'STALE_REQUEST_SEQ' };
    }
    var pendingKey = pendingOriginKeyByBookingId[bookingId];
    if (pendingKey && pendingKey !== originKey) {
      return { ok: false, code: 'ORIGIN_MISMATCH' };
    }
    var validation = explainTransferSnapshotRejection(selected, booking, {
      allowFreshProviderRoute: true,
      pendingOriginKey: pendingKey,
      originKey: originKey,
      originInvalidated: true
    });
    if (!validation.ok) return validation;
    setSelectedTransferRoute(bookingId, selected, originKey, { skipEligibilityGuard: true });
    clearOriginInvalidation(bookingId);
    committedTransferSelectionByBookingId[bookingId] = {
      bookingId: bookingId,
      originKey: originKey,
      originId: selected.originId || null,
      requestSeq: seq,
      committedAt: new Date().toISOString()
    };
    return { ok: true, code: 'COMMITTED' };
  }

  function resolveValidatedTransferSnapshot(booking, formState, calculatedState) {
    if (!booking || !booking.id) return null;
    if (transferPendingByBookingId[booking.id]) return null;
    var invalidated = isOriginInvalidatedForBooking(booking.id);
    var candidates = [];
    var mem = getSelectedTransferRoute(booking.id);
    if (mem) candidates.push({ route: mem, source: 'memory.selectedTransferRoute' });
    if (!invalidated) {
      if (formState && formState.selectedTransferRoute) {
        candidates.push({ route: formState.selectedTransferRoute, source: 'form.selectedTransferRoute' });
      }
      if (formState && formState.transferRoute) {
        candidates.push({ route: formState.transferRoute, source: 'form.transferRoute' });
      }
      if (booking.transferRoute) candidates.push({ route: booking.transferRoute, source: 'booking.transferRoute' });
      if (booking.selectedTransferRoute) {
        candidates.push({ route: booking.selectedTransferRoute, source: 'booking.selectedTransferRoute' });
      }
    }
    if (!invalidated) {
      if (calculatedState && calculatedState.geometry && calculatedState.bookingId === booking.id) {
        candidates.push({ route: calculatedState, source: 'calculatedState' });
      }
      if (booking.adminCalculatedRoute) {
        candidates.push({ route: booking.adminCalculatedRoute, source: 'booking.adminCalculatedRoute' });
      }
    }
    for (var i = 0; i < candidates.length; i++) {
      var item = candidates[i];
      if (!isValidTransferSnapshot(item.route, booking, buildTransferValidationOptions(booking, item))) continue;
      var snap = enrichTransferOperationalMetrics(Object.assign({}, item.route, {
        geometry: normalizeTransferLineString(item.route.geometry)
      }));
      snap._source = item.source;
      return snap;
    }
    return null;
  }

  function getValidatedTransferSnapshotForSave(booking) {
    if (!booking || !booking.id) return null;
    var formState = getRouteFormState(booking.id);
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var calc = bridge && bridge.getRawCalculatedRouteForBooking
      ? bridge.getRawCalculatedRouteForBooking(booking.id) : null;
    var snap = resolveValidatedTransferSnapshot(booking, formState, calc);
    if (snap) return snap;
    if (!isOriginInvalidatedForBooking(booking.id) && booking.adminCalculatedRoute &&
        isValidTransferSnapshot(booking.adminCalculatedRoute, booking, { allowServerReload: true })) {
      return enrichTransferOperationalMetrics(Object.assign({}, booking.adminCalculatedRoute, {
        geometry: normalizeTransferLineString(booking.adminCalculatedRoute.geometry)
      }));
    }
    return null;
  }

  function buildAdminCalculatedRouteForSave(booking, transferRoute) {
    if (!booking || !transferRoute || !isValidTransferSnapshot(transferRoute, booking)) return null;
    var targetName = booking.placeName || booking.city || booking.address || null;
    var fromName = transferRoute.originEndLocation || transferRoute.originLabel || transferRoute.fromName || null;
    var record = {
      bookingId: booking.id,
      routeType: transferRoute.routeType || 'TRANSFER_ROUTE',
      geometry: transferRoute.geometry,
      distanceKm: transferRoute.distanceKm,
      travelMinutes: transferRoute.travelMinutes,
      providerDurationMinutes: transferRoute.providerDurationMinutes != null
        ? transferRoute.providerDurationMinutes : transferRoute.travelMinutes,
      operationalAverageSpeedKmh: TRANSFER_OPERATIONAL_SPEED_KMH,
      operationalDurationMinutes: transferRoute.operationalDurationMinutes,
      roundTripDistanceKm: transferRoute.roundTripDistanceKm,
      roundTripOperationalDurationMinutes: transferRoute.roundTripOperationalDurationMinutes,
      originId: transferRoute.originId || null,
      originLabel: transferRoute.originLabel || fromName,
      fromName: fromName,
      fromLat: transferRoute.fromLat,
      fromLng: transferRoute.fromLng,
      toLat: transferRoute.toLat != null ? transferRoute.toLat : booking.lat,
      toLng: transferRoute.toLng != null ? transferRoute.toLng : booking.lng,
      targetName: targetName,
      preparationBufferMinutes: transferRoute.preparationBufferMinutes,
      dataQuality: transferRoute.dataQuality,
      routingProvider: transferRoute.routingProvider || transferRoute.provider,
      calculatedAt: transferRoute.calculatedAt || new Date().toISOString()
    };
    if (transferRoute.latestDepartureAt) record.suggestedDeparture = transferRoute.latestDepartureAt;
    else if (transferRoute.suggestedDeparture) record.suggestedDeparture = transferRoute.suggestedDeparture;
    return record;
  }

  function getKiallasRouteForBooking(booking) {
    if (!booking) return null;
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var formState = getRouteFormState(booking.id);
    var calc = bridge && bridge.getRawCalculatedRouteForBooking
      ? bridge.getRawCalculatedRouteForBooking(booking.id) : null;
    return resolveValidatedTransferSnapshot(booking, formState, calc);
  }

  function hydrateKiallasServerStatusFromServerBooking(booking) {
    if (!booking || !booking.id) return booking;
    if (booking.transferRoute) return booking;
    if (booking.adminCalculatedRoute && isValidTransferSnapshot(booking.adminCalculatedRoute, booking, { allowServerReload: true })) {
      booking._kiallasServerSaveStatus = 'saved';
      booking._kiallasAdminRouteFromServer = true;
    }
    return booking;
  }

  function applyKiallasAdminRoutePatchOutcome(booking, outcome) {
    if (!booking) return booking;
    if (outcome === 'saving') {
      booking._kiallasServerSaveStatus = 'saving';
      booking._kiallasAdminRouteFromServer = false;
      return booking;
    }
    if (outcome === 'saved') {
      booking._kiallasServerSaveStatus = 'saved';
      booking._kiallasAdminRouteFromServer = true;
      return booking;
    }
    if (outcome === 'failed') {
      booking._kiallasServerSaveStatus = 'failed';
      booking._kiallasAdminRouteFromServer = false;
    }
    return booking;
  }

  function getKiallasPersistenceState(booking) {
    var empty = {
      hasCalculated: false,
      localSaved: false,
      serverSaved: false,
      serverAdminRoute: false,
      serverBlocked: false,
      serverFailed: false,
      serverSaving: false,
      route: null
    };
    if (!booking || !booking.id) return empty;
    var route = getKiallasRouteForBooking(booking);
    if (!route) return empty;
    empty.route = route;
    empty.hasCalculated = true;
    empty.localSaved = !!(booking._kiallasLocalSaved || booking.transferRoute);
    var status = booking._kiallasServerSaveStatus || 'none';
    empty.serverSaved = status === 'saved';
    empty.serverSaving = status === 'saving';
    empty.serverBlocked = status === 'blocked';
    empty.serverFailed = status === 'failed';
    empty.serverAdminRoute = empty.serverSaved && !!booking.adminCalculatedRoute &&
      hasKiallasRouteData(booking.adminCalculatedRoute) && !booking.transferRoute && !booking._kiallasLocalSaved;
    if (empty.localSaved && !empty.serverSaved && !empty.serverBlocked && !empty.serverFailed && !empty.serverSaving) {
      if (isLiveReadOnly() || CFG.readOnlyIntegration) empty.serverBlocked = true;
    }
    return empty;
  }

  function getSharedKiallasFuelMetrics(distanceKm, booking) {
    var display = resolveDisplayFuelMetrics(distanceKm, booking);
    if (!display || display.estimatedFuelLitres == null || display.estimatedFuelCost == null) return null;
    var fuelCfg = getFuelConfig(booking || null);
    return {
      consumptionLitresPer100Km: fuelCfg.consumptionLitresPer100Km,
      estimatedFuelLitres: display.estimatedFuelLitres,
      estimatedFuelCost: display.estimatedFuelCost
    };
  }

  function resolveDisplayFuelMetrics(distanceKm, booking) {
    var dist = distanceKm != null ? Number(distanceKm) : null;
    if (dist == null || !isFinite(dist) || dist <= 0) return null;
    var fuelCfg = getFuelConfig(booking || null);
    var consumption = fuelCfg.consumptionLitresPer100Km;
    if (consumption == null || !isFinite(Number(consumption)) || Number(consumption) <= 0) return null;
    var litres = Math.round((dist * Number(consumption) / 100) * 10) / 10;
    if (litres <= 0) return null;
    var price = fuelCfg.fuelPricePerLitre;
    var cost = null;
    if (price != null && isFinite(Number(price)) && Number(price) > 0) {
      cost = Math.round(litres * Number(price));
      if (cost <= 0) cost = null;
    }
    return {
      estimatedFuelLitres: litres,
      estimatedFuelCost: cost
    };
  }

  function parseBookingDateTimeParts(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    var parts = String(dateStr).trim().slice(0, 10).split('-');
    if (parts.length < 3) return null;
    var t = String(timeStr).trim().split(':');
    var dt = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10),
      parseInt(t[0], 10) || 0, parseInt(t[1], 10) || 0, 0, 0);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function computeProgramMinutesFromBooking(booking) {
    if (!booking) return null;
    var start = parseBookingDateTimeParts(booking.date || booking.event_date, booking.timeStart || booking.startTime);
    var end = parseBookingDateTimeParts(booking.date || booking.event_date, booking.timeEnd || booking.endTime);
    if (!start || !end || end <= start) return null;
    return Math.round((end.getTime() - start.getTime()) / 60000);
  }

  function resolvePreparationBufferMinutesNumeric(route, booking) {
    route = route || (booking && booking.adminCalculatedRoute) || {};
    if (route.preparationBufferMinutes != null && isFinite(Number(route.preparationBufferMinutes))) {
      return Math.round(Number(route.preparationBufferMinutes));
    }
    var cfgVal = CFG.preparationBufferMinutes;
    if (cfgVal != null && isFinite(Number(cfgVal))) return Math.round(Number(cfgVal));
    return null;
  }

  function resolveDepartureLabelForSavedRoute(route, booking) {
    if (!route) return '—';
    if (route.latestDepartureLabel) return route.latestDepartureLabel;
    if (route.suggestedDeparture != null && route.suggestedDeparture !== '') {
      if (RTA && RTA.mapSuggestedDepartureToLatestDepartureLabel) {
        return RTA.mapSuggestedDepartureToLatestDepartureLabel(route.suggestedDeparture);
      }
      return String(route.suggestedDeparture).replace('T', ' ');
    }
    return resolveLatestDepartureLabelForRender(null, booking);
  }

  function buildSavedRouteFuelLineHtml(fuelMetrics) {
    if (!fuelMetrics || fuelMetrics.estimatedFuelLitres == null) return '';
    var html = String(fuelMetrics.estimatedFuelLitres).replace('.', ',') + ' l';
    if (fuelMetrics.estimatedFuelCost != null) {
      html += ' · ' + formatFuelCostHu(fuelMetrics.estimatedFuelCost);
    }
    return html;
  }

  function buildSavedRouteDetailBodyHtml(booking, route) {
    if (!route) return '';
    route = enrichTransferOperationalMetrics(Object.assign({}, route));
    var dist = route.distanceKm != null && isFinite(Number(route.distanceKm)) ? Number(route.distanceKm) : null;
    var providerMin = route.providerDurationMinutes != null ? Math.round(Number(route.providerDurationMinutes))
      : (route.travelMinutes != null ? Math.round(Number(route.travelMinutes)) : null);
    var opMin = route.operationalDurationMinutes != null ? Math.round(Number(route.operationalDurationMinutes)) : null;
    var roundTripKm = route.roundTripDistanceKm != null ? route.roundTripDistanceKm : (dist != null ? Math.round(dist * 2 * 10) / 10 : null);
    var roundTripOpMin = route.roundTripOperationalDurationMinutes != null
      ? route.roundTripOperationalDurationMinutes
      : (opMin != null ? opMin * 2 : null);
    var oneWayFuel = dist != null && dist > 0 ? resolveDisplayFuelMetrics(dist, booking) : null;
    var roundTripFuel = oneWayFuel && oneWayFuel.estimatedFuelLitres != null
      ? {
        estimatedFuelLitres: Math.round(oneWayFuel.estimatedFuelLitres * 2 * 10) / 10,
        estimatedFuelCost: oneWayFuel.estimatedFuelCost != null ? oneWayFuel.estimatedFuelCost * 2 : null
      }
      : null;
    var prepBuf = resolvePreparationBufferForRender(route);
    var departureLabel = resolveDepartureLabelForSavedRoute(route, booking);
    var html = '';
    html += '<div class="kiallas-card-line">' + formatKiallasOriginDestination(route, booking) + '</div>';
    html += '<div class="kiallas-card-line kiallas-card-meta">Kiállás – egy irány:</div>';
    html += '<div class="kiallas-card-line">' + formatDistanceKmHu(dist) + '</div>';
    html += '<div class="kiallas-card-line kiallas-card-meta">Menetidő (provider, egy irány):</div>';
    html += '<div class="kiallas-card-line">' + (providerMin != null ? providerMin + ' perc' : '—') + '</div>';
    html += '<div class="kiallas-card-line kiallas-card-meta">Operatív menetidő (egy irány):</div>';
    html += '<div class="kiallas-card-line">' + (opMin != null ? opMin + ' perc' : '—') + '</div>';
    html += '<div class="kiallas-card-line kiallas-card-meta">Operatív oda-vissza:</div>';
    html += '<div class="kiallas-card-line">' + formatDistanceKmHu(roundTripKm) + ' · ' +
      (roundTripOpMin != null ? roundTripOpMin + ' perc' : '—') + '</div>';
    if (oneWayFuel && oneWayFuel.estimatedFuelLitres != null) {
      html += '<div class="kiallas-card-line kiallas-card-meta">Üzemanyag – egy irány:</div>';
      html += '<div class="kiallas-card-line">' + buildSavedRouteFuelLineHtml(oneWayFuel) + '</div>';
    }
    if (roundTripFuel && roundTripFuel.estimatedFuelLitres != null) {
      html += '<div class="kiallas-card-line kiallas-card-meta">Üzemanyag – oda-vissza:</div>';
      html += '<div class="kiallas-card-line">' + buildSavedRouteFuelLineHtml(roundTripFuel) + '</div>';
    }
    html += '<div class="kiallas-card-line kiallas-card-meta">Szükséges indulási idő:</div>';
    html += '<div class="kiallas-card-line">' + escapeHtml(departureLabel || '—') + '</div>';
    html += '<div class="kiallas-card-line kiallas-card-meta">Felkészülési tartalék:</div>';
    html += '<div class="kiallas-card-line">' + escapeHtml(prepBuf.display) + '</div>';
    html += '<div class="kiallas-card-line kiallas-card-meta">Adatminőség:</div>';
    html += '<div class="kiallas-card-line">' + escapeHtml(formatDataQualityLabel(route)) + '</div>';
    return html;
  }

  function computeOwnerReportRouteMetrics(booking) {
    var route = booking && booking.adminCalculatedRoute;
    if (!route || route.distanceKm == null || !isFinite(Number(route.distanceKm)) || Number(route.distanceKm) <= 0) {
      return {
        roundTripKm: null,
        roundTripFuelL: null,
        roundTripFuelCost: null,
        estimatedWorkHours: null,
        bufferSource: null,
        bufferMinutes: null
      };
    }
    var distanceKm = Number(route.distanceKm);
    var travelMinutes = route.travelMinutes != null && isFinite(Number(route.travelMinutes))
      ? Math.round(Number(route.travelMinutes)) : null;
    var roundTripKm = Math.round(distanceKm * 2 * 10) / 10;
    var oneWayFuel = resolveDisplayFuelMetrics(distanceKm, booking);
    var roundTripFuelL = oneWayFuel && oneWayFuel.estimatedFuelLitres != null
      ? Math.round(oneWayFuel.estimatedFuelLitres * 2 * 10) / 10 : null;
    var roundTripFuelCost = oneWayFuel && oneWayFuel.estimatedFuelCost != null
      ? oneWayFuel.estimatedFuelCost * 2 : null;
    if (travelMinutes == null) {
      return {
        roundTripKm: roundTripKm,
        roundTripFuelL: roundTripFuelL,
        roundTripFuelCost: roundTripFuelCost,
        estimatedWorkHours: null,
        bufferSource: null,
        bufferMinutes: null
      };
    }
    var programMinutes = computeProgramMinutesFromBooking(booking);
    if (programMinutes == null) {
      return {
        roundTripKm: roundTripKm,
        roundTripFuelL: roundTripFuelL,
        roundTripFuelCost: roundTripFuelCost,
        estimatedWorkHours: null,
        bufferSource: null,
        bufferMinutes: null
      };
    }
    var bufferMinutes = null;
    var bufferSource = null;
    if (route.preparationBufferMinutes != null && isFinite(Number(route.preparationBufferMinutes))) {
      bufferMinutes = Math.round(Number(route.preparationBufferMinutes));
      bufferSource = 'saved';
    } else if (CFG.preparationBufferMinutes != null && isFinite(Number(CFG.preparationBufferMinutes))) {
      bufferMinutes = Math.round(Number(CFG.preparationBufferMinutes));
      bufferSource = 'config';
    }
    var estimatedWorkMinutes = (travelMinutes * 2) + programMinutes + (bufferMinutes != null ? bufferMinutes : 0);
    return {
      roundTripKm: roundTripKm,
      roundTripFuelL: roundTripFuelL,
      roundTripFuelCost: roundTripFuelCost,
      estimatedWorkHours: Math.round((estimatedWorkMinutes / 60) * 100) / 100,
      bufferSource: bufferSource,
      bufferMinutes: bufferMinutes
    };
  }

  function buildOperationalEstimateMetrics(bookingId) {
    var summary = computeOperationalCostSummary(bookingId);
    if (!summary) return null;
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var booking = bookingId && bridge && bridge.getBookingById ? bridge.getBookingById(bookingId) : null;
    if (!booking && bridge && bridge.getRouteTargetBooking) booking = bridge.getRouteTargetBooking();
    var transferKm = summary.TRANSFER_OUTBOUND_DISTANCE_KM;
    var returnKm = summary.ESTIMATED_RETURN_DISTANCE_KM;
    var kiallasFuel = getSharedKiallasFuelMetrics(transferKm, booking);
    var returnFuel = returnKm > 0 ? getSharedKiallasFuelMetrics(returnKm, booking) : null;
    var totalLitres = null;
    var totalCost = null;
    if (kiallasFuel && returnFuel) {
      totalLitres = Math.round((kiallasFuel.estimatedFuelLitres + returnFuel.estimatedFuelLitres) * 10) / 10;
      totalCost = kiallasFuel.estimatedFuelCost + returnFuel.estimatedFuelCost;
    }
    return Object.assign({}, summary, {
      kiallasFuelMetrics: kiallasFuel,
      returnFuelMetrics: returnFuel,
      TOTAL_OPERATIONAL_FUEL_LITRES: totalLitres,
      TOTAL_OPERATIONAL_FUEL_COST: totalCost
    });
  }

  function buildEstimatedReturnBlockHtml(metrics, booking) {
    if (!metrics || metrics.ESTIMATED_RETURN_DISTANCE_KM <= 0) return '';
    var returnFuel = metrics.returnFuelMetrics || getSharedKiallasFuelMetrics(metrics.ESTIMATED_RETURN_DISTANCE_KM, booking);
    var html = '<div class="ops-section ops-section--estimate">';
    html += '<div class="ops-section-label">Becsült visszaállás</div>';
    html += '<div>' + formatDistanceKmHu(metrics.ESTIMATED_RETURN_DISTANCE_KM) + '</div>';
    if (returnFuel && returnFuel.estimatedFuelLitres != null && returnFuel.estimatedFuelCost != null) {
      html += '<div>' + String(returnFuel.estimatedFuelLitres).replace('.', ',') + ' l</div>';
      html += '<div>' + formatFuelCostHu(returnFuel.estimatedFuelCost) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function buildTotalOperationalEstimateHtml(metrics) {
    if (!metrics || metrics.TOTAL_OPERATIONAL_DISTANCE_KM <= 0) return '';
    var html = '<div class="ops-section ops-section--total-estimate">';
    html += '<div class="ops-section-label">Teljes operatív becslés</div>';
    if (metrics.TOTAL_OPERATIONAL_FUEL_LITRES != null && metrics.TOTAL_OPERATIONAL_FUEL_COST != null) {
      html += '<div>' + formatDistanceKmHu(metrics.TOTAL_OPERATIONAL_DISTANCE_KM) + ' · ' +
        String(metrics.TOTAL_OPERATIONAL_FUEL_LITRES).replace('.', ',') + ' l · ' +
        formatFuelCostHu(metrics.TOTAL_OPERATIONAL_FUEL_COST) + '</div>';
    } else {
      html += '<div>' + formatDistanceKmHu(metrics.TOTAL_OPERATIONAL_DISTANCE_KM) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function computeKiallasFuelMetrics(distanceKm, booking) {
    var shared = getSharedKiallasFuelMetrics(distanceKm, booking);
    if (shared) return shared;
    var fuelCfg = getFuelConfig(booking || null);
    return {
      consumptionLitresPer100Km: fuelCfg.consumptionLitresPer100Km,
      estimatedFuelLitres: null,
      estimatedFuelCost: null
    };
  }

  function formatKiallasOriginDestination(route, booking) {
    var origin = route.originEndLocation || route.originLabel || route.fromName || '—';
    var dest = booking ? (booking.placeName || booking.address || booking.id) : (route.bookingId || '—');
    return escapeHtml(origin) + ' → ' + escapeHtml(dest);
  }

  function formatDataQualityLabel(route) {
    if (!route) return '—';
    if (route.dataQuality === 'ACTUAL' || route.dataQualityLabel === 'TÉNYLEGES') return 'TÉNYLEGES';
    if (route.dataQuality === 'PLANNED_FALLBACK' || route.dataQuality === 'PLANNED' || route.dataQualityLabel === 'TERVEZETT') {
      return 'TERVEZETT';
    }
    if (route.dataQualityLabel) return String(route.dataQualityLabel);
    if (route.dataQuality) return String(route.dataQuality);
    return '—';
  }

  function resolvePreparationBufferForRender(routeOrPopup) {
    routeOrPopup = routeOrPopup || {};
    var primary = routeOrPopup.preparationBufferMinutes;
    if (primary != null && isFinite(Number(primary))) {
      return {
        display: Math.round(Number(primary)) + ' perc',
        source: null,
        isFallback: false,
        isMeasuredOrSavedValue: true
      };
    }
    var cfgVal = CFG.preparationBufferMinutes;
    if (cfgVal != null && isFinite(Number(cfgVal))) {
      return {
        display: Math.round(Number(cfgVal)) + ' perc',
        source: 'fallback',
        isFallback: true,
        isMeasuredOrSavedValue: false
      };
    }
    return {
      display: '—',
      source: null,
      isFallback: false,
      isMeasuredOrSavedValue: false
    };
  }

  function resolveLatestDepartureLabelForRender(transfer, booking) {
    var popup = transfer && transfer.popup ? transfer.popup : null;
    if (popup && popup.latestDepartureLabel) return popup.latestDepartureLabel;
    if (transfer && transfer.latestDepartureLabel) return transfer.latestDepartureLabel;
    if (RTA && RTA.resolveLatestDepartureLabel && transfer) {
      var fromMeta = RTA.resolveLatestDepartureLabel(transfer);
      if (fromMeta) return fromMeta;
    }
    var route = booking ? getKiallasRouteForBooking(booking) : null;
    if (route && route.suggestedDeparture != null && route.suggestedDeparture !== '') {
      if (RTA && RTA.mapSuggestedDepartureToLatestDepartureLabel) {
        return RTA.mapSuggestedDepartureToLatestDepartureLabel(route.suggestedDeparture);
      }
      return String(route.suggestedDeparture).replace('T', ' ');
    }
    return '—';
  }

  function resolveDataQualityLabelForRender(transfer, booking) {
    var route = booking ? getKiallasRouteForBooking(booking) : null;
    if (transfer && transfer.isAdminCalculatedRoute) return formatDataQualityLabel(transfer);
    if (transfer && transfer.popup && transfer.popup.isAdminCalculatedRoute) {
      return formatDataQualityLabel(transfer.popup);
    }
    if (route && RTA && RTA.isAdminCalculatedRouteSource && booking && booking.adminCalculatedRoute === route) {
      return formatDataQualityLabel(route);
    }
    return formatDataQualityLabel(route || transfer);
  }

  function formatServerSaveStatusLabel(state) {
    if (!state) return '—';
    if (state.serverSaved) return 'mentve';
    if (state.serverBlocked || state.serverFailed) return 'nem történt meg';
    return '—';
  }

  function buildKiallasFuelLineHtml(distanceKm, booking) {
    var metrics = getSharedKiallasFuelMetrics(distanceKm, booking);
    if (!metrics || metrics.estimatedFuelLitres == null || metrics.estimatedFuelCost == null) return '';
    return '<div class="kiallas-card-line">Üzemanyag: ' +
      String(metrics.estimatedFuelLitres).replace('.', ',') + ' l · ' +
      formatFuelCostHu(metrics.estimatedFuelCost) + '</div>';
  }

  function buildKiallasStatusCardHtml(booking, options) {
    options = options || {};
    var state = getKiallasPersistenceState(booking);
    if (!state.localSaved && !state.serverAdminRoute && !options.showCalculated) return '';
    if (!state.route) return '';
    var route = state.route;
    var header = state.localSaved
      ? 'Kiállás helyileg rögzítve ✓'
      : (state.serverAdminRoute
        ? 'Kiállás szerverről betöltve'
        : (state.hasCalculated ? 'Útvonal kiszámítva' : ''));
    if (!header) return '';
    var html = '<div class="kiallas-status-card' + (options.compact ? ' kiallas-status-card--compact' : '') + '">';
    html += '<div class="kiallas-card-header">' + escapeHtml(header) + '</div>';
    if (state.localSaved && (state.serverBlocked || state.serverFailed)) {
      html += '<div class="kiallas-card-server-warn">Szervermentés nem történt meg.</div>';
    }
    html += buildSavedRouteDetailBodyHtml(booking, route);
    if (state.localSaved) {
      html += '<div class="kiallas-card-line kiallas-card-meta">Szervermentés: ' +
        escapeHtml(formatServerSaveStatusLabel(state)) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function buildKiallasListItemHtml(booking) {
    if (!booking || !getKiallasPersistenceState(booking).localSaved) return '';
    return buildKiallasStatusCardHtml(booking, { compact: true });
  }

  function renderKiallasSaveStatusBadges(bookingId) {
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var booking = null;
    if (bookingId && bridge && bridge.getBookingById) booking = bridge.getBookingById(bookingId);
    if (!booking) {
      var editEl = $('editId');
      var id = editEl && editEl.value;
      if (id && bridge && bridge.getBookingById) booking = bridge.getBookingById(id);
    }
    var badge = $('routeSavedBadge');
    var serverEl = $('kiallasServerSaveStatus');
    var warnEl = $('kiallasServerSaveWarning');
    var state = getKiallasPersistenceState(booking);
    if (badge) {
      badge.hidden = !state.localSaved;
      badge.textContent = 'Kiállás helyileg rögzítve ✓';
    }
    if (serverEl) {
      if (state.serverSaved && (state.localSaved || state.serverAdminRoute)) {
        serverEl.hidden = false;
        serverEl.textContent = 'Szerverre mentve ✓';
        serverEl.className = 'route-server-save-status route-server-save-status--ok';
      } else if (state.serverSaving) {
        serverEl.hidden = false;
        serverEl.textContent = 'Szervermentés folyamatban…';
        serverEl.className = 'route-server-save-status route-server-save-status--warn';
      } else if (state.localSaved && (state.serverBlocked || state.serverFailed)) {
        serverEl.hidden = false;
        serverEl.textContent = 'Szervermentés nem történt meg.';
        serverEl.className = 'route-server-save-status route-server-save-status--warn';
      } else {
        serverEl.hidden = true;
        serverEl.textContent = '';
      }
    }
    if (warnEl) {
      var showWarn = state.localSaved && (state.serverBlocked || state.serverFailed) && !state.serverSaved;
      warnEl.hidden = !showWarn;
      warnEl.textContent = 'A szervermentés nem történt meg. A helyileg rögzített útvonal továbbra is elérhető és exportálható.';
    }
  }

  function computeOperationalCostSummary(bookingId) {
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (!bridge || !bridge.getRouteTargetBooking || !RTA) return null;
    var booking = bookingId
      ? (bridge.getBookingById ? bridge.getBookingById(bookingId) : null)
      : bridge.getRouteTargetBooking();
    if (!booking && bookingId && bridge.getBookings) {
      booking = bridge.getBookings().find(function (b) { return b.id === bookingId; });
    }
    if (!booking) booking = bridge.getRouteTargetBooking();
    if (!booking) return null;
    var formState = getRouteFormState(booking.id);
    var customer = RTA.normalizeCustomerServiceRoute(booking, formState);
    var kiallasRoute = getKiallasRouteForBooking(booking);
    var transfer = formState.selectedTransferRoute || getSelectedTransferRoute(booking.id) || kiallasRoute;
    var customerKm = customer && customer.metrics && customer.metrics.distanceKm != null ? Number(customer.metrics.distanceKm) : 0;
    var transferKm = kiallasRoute && kiallasRoute.distanceKm != null ? Number(kiallasRoute.distanceKm)
      : (transfer && transfer.distanceKm != null ? Number(transfer.distanceKm) : 0);
    var transferMins = kiallasRoute && kiallasRoute.travelMinutes != null ? Number(kiallasRoute.travelMinutes)
      : (transfer && transfer.travelMinutes != null ? Number(transfer.travelMinutes) : null);
    var returnKm = transferKm;
    var totalKm = Math.round((customerKm + transferKm + returnKm) * 10) / 10;
    var fuelCfg = getFuelConfig(booking);
    var missing = [];
    if (fuelCfg.consumptionLitresPer100Km == null) missing.push('consumption');
    if (fuelCfg.fuelPricePerLitre == null) missing.push('fuelPrice');
    var estimatedFuelLitres = null;
    var estimatedFuelCost = null;
    if (fuelCfg.consumptionLitresPer100Km != null && transferKm > 0) {
      var sharedFuel = getSharedKiallasFuelMetrics(transferKm, booking);
      if (sharedFuel) {
        estimatedFuelLitres = sharedFuel.estimatedFuelLitres;
        estimatedFuelCost = sharedFuel.estimatedFuelCost;
      }
    }
    return {
      CUSTOMER_DISTANCE_KM: customerKm,
      TRANSFER_OUTBOUND_DISTANCE_KM: transferKm,
      TRANSFER_TRAVEL_MINUTES: transferMins,
      ESTIMATED_RETURN_DISTANCE_KM: returnKm,
      TOTAL_OPERATIONAL_DISTANCE_KM: totalKm,
      ESTIMATED_FUEL_LITRES: estimatedFuelLitres,
      ESTIMATED_FUEL_COST: estimatedFuelCost,
      VEHICLE_CONSUMPTION_SOURCE: fuelCfg.source,
      FUEL_PRICE_SOURCE: fuelCfg.source,
      MISSING_COST_PARAMETERS: missing,
      returnIsEstimated: true,
      hasCustomerRoute: customerKm > 0
    };
  }

  function renderOperationalCostSummary(bookingId) {
    var el = $('operationalCostSummary');
    if (!el) return;
    var metrics = buildOperationalEstimateMetrics(bookingId);
    if (!metrics) {
      el.hidden = true;
      return;
    }
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var booking = bookingId && bridge && bridge.getBookingById ? bridge.getBookingById(bookingId) : null;
    if (!booking && bridge && bridge.getRouteTargetBooking) booking = bridge.getRouteTargetBooking();
    var parts = ['<h3 class="route-type-details__title">Operatív költség-összesítés</h3>'];
    if (metrics.TRANSFER_OUTBOUND_DISTANCE_KM > 0) {
      parts.push('<div class="ops-section ops-section--kiallas">');
      parts.push('<div class="ops-section-label">Kiállás (számított)</div>');
      parts.push(buildKiallasFuelCompactHtml(metrics.TRANSFER_OUTBOUND_DISTANCE_KM, metrics.TRANSFER_TRAVEL_MINUTES, booking));
      parts.push('</div>');
    }
    if (metrics.hasCustomerRoute) {
      parts.push('<div class="ops-section ops-section--customer">');
      parts.push('<div class="ops-section-label">Megrendelői útvonal (megadott)</div>');
      parts.push('<div>' + formatDistanceKmHu(metrics.CUSTOMER_DISTANCE_KM) + '</div>');
      parts.push('</div>');
    } else {
      parts.push('<div class="route-missing-hint">Megrendelői útvonal: nincs megadva</div>');
    }
    parts.push(buildEstimatedReturnBlockHtml(metrics, booking));
    parts.push(buildTotalOperationalEstimateHtml(metrics));
    if (metrics.MISSING_COST_PARAMETERS && metrics.MISSING_COST_PARAMETERS.length) {
      if (metrics.MISSING_COST_PARAMETERS.indexOf('consumption') >= 0) {
        parts.push('<div class="route-compact-fuel route-compact-fuel--hint">Fogyasztási adat nincs megadva.</div>');
      }
      if (metrics.MISSING_COST_PARAMETERS.indexOf('fuelPrice') >= 0) {
        parts.push('<div class="route-compact-fuel route-compact-fuel--hint">Üzemanyagár nincs megadva.</div>');
      }
    } else if (metrics.kiallasFuelMetrics && metrics.returnFuelMetrics) {
      parts.push('<div class="ops-fuel-note">A teljes operatív liter és költség a Kiállás és a becsült visszaállás összege; a megrendelői útvonalhoz nem számolunk üzemanyagot.</div>');
    }
    el.hidden = false;
    el.innerHTML = parts.join('');
  }

  function renderTransferBookingSummary(bookingId) {
    var el = $('transferBookingSummary');
    if (!el) return;
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var booking = bridge && bridge.getBookingById ? bridge.getBookingById(bookingId) : null;
    var state = getKiallasPersistenceState(booking);
    if (!state.localSaved && !state.hasCalculated && !state.serverAdminRoute) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    if (state.localSaved) {
      el.innerHTML = buildKiallasStatusCardHtml(booking);
      return;
    }
    var route = state.route;
    el.innerHTML =
      '<div class="kiallas-status-card">' +
      '<div class="kiallas-card-header">Útvonal kiszámítva</div>' +
      buildSavedRouteDetailBodyHtml(booking, route) +
      '</div>';
  }

  function assignTransferRouteToBookingAndBack() {
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (!bridge || !bridge.getRouteTargetBooking) return Promise.reject(new Error('BRIDGE_MISSING'));
    var booking = bridge.getRouteTargetBooking();
    if (!booking || !booking.id) return Promise.reject(new Error('BOOKING_REQUIRED'));
    var route = getSelectedTransferRoute(booking.id) || (booking.selectedTransferRoute || null);
    if (!route || !route.geometry) {
      return Promise.reject(new Error('Nincs kiválasztott kiállási útvonal. Előbb jelenítsen meg egyet az ajánlóból.'));
    }
    if (!isValidTransferSnapshot(route, booking)) {
      return Promise.reject(new Error('A kiállási útvonal nem konzisztens. Számítsd újra az indulási helyhez.'));
    }
    var originKey = getSelectedOriginKey(booking.id);
    if (originKey) {
      try {
        assertOriginEligibleForAssignment(findOriginByKey(originKey));
      } catch (guardErr) {
        return Promise.reject(guardErr);
      }
    }
    if (!bridge.applyTransferRouteToBookingDraft) {
      return Promise.reject(new Error('TRANSFER_DRAFT_BRIDGE_MISSING'));
    }
    var ok = bridge.applyTransferRouteToBookingDraft(booking.id, route);
    if (!ok) return Promise.reject(new Error('TRANSFER_DRAFT_ASSIGN_FAILED'));
    if (global.openBookingForm) {
      global.openBookingForm(booking.id);
    } else {
      if (global.setMainModule) global.setMainModule('detail');
      if (global.setFormTab) global.setFormTab('basic');
    }
    renderTransferBookingSummary(booking.id);
    renderOperationalCostSummary(booking.id);
    renderKiallasSaveStatusBadges(booking.id);
    renderTransferDraftPreview(booking.id);
    if (bridge.markKiallasLocallySaved) bridge.markKiallasLocallySaved(booking.id);
    if (bridge.notifyKiallasServerSaveBlocked) bridge.notifyKiallasServerSaveBlocked(booking.id);
    transferDraftPreviewByBookingId[booking.id] = {
      selectedTransferRoute: route,
      transferRoute: route,
      note: 'Odaállási útvonal a foglalási drafthoz rendelve – read-only módban nincs adatbázisba mentve.'
    };
    return Promise.resolve(route);
  }

  function findOriginByKey(key) {
    var state = global.__ORIGIN_ADVISOR_STATE;
    if (!state || !state.getLastOriginList) return null;
    return state.getLastOriginList().find(function (o) {
      return global.OriginAdvisorState && global.OriginAdvisorState.getOriginKey(o) === key;
    }) || null;
  }

  function assertOriginEligibleForAssignment(origin) {
    if (!origin) return;
    if (origin.originType !== 'DEPLOYABLE_TRAIN' && origin.originType !== 'PREVIOUS_PROJECT') return;
    if (origin.eligible === true) return;
    var reasons = origin.exclusionReasons || [];
    if (reasons.indexOf('POSITION_TOO_OLD_AT_EVALUATION') >= 0
      || reasons.indexOf('CLOSURE_POSITION_TOO_OLD') >= 0
      || reasons.indexOf('POSITION_TOO_OLD') >= 0) {
      throw new Error('Nem bevethető – az utolsó ismert pozíció már nem friss.');
    }
    if (reasons.indexOf('SUPERSEDED_BY_LATER_ACTIVITY') >= 0) {
      throw new Error('Nem bevethető – a jármű a lezárás után újabb aktivitást végzett.');
    }
    if (reasons.indexOf('OUTSIDE_WINDOW') >= 0) {
      throw new Error('Nem bevethető – időablakon kívül.');
    }
    var label = origin.exclusionLabel || 'kizárt jelölt';
    throw new Error(label.indexOf('Nem bevethető') === 0 ? label : ('Nem bevethető – ' + label.replace(/^Kizárva:\s*/i, '')));
  }

  function applyAdvisorTransferRoute(originKey) {
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (!bridge || !bridge.getRouteTargetBooking) return Promise.reject(new Error('BRIDGE_MISSING'));
    var booking = bridge.getRouteTargetBooking();
    var coords = resolveBookingCoords(booking);
    if (!booking || coords.lat == null || coords.lng == null) {
      return Promise.reject(new Error('BOOKING_COORDINATES_REQUIRED'));
    }
    booking = Object.assign({}, booking, { lat: coords.lat, lng: coords.lng });
    var origin = findOriginByKey(originKey);
    if (!origin || origin.lat == null || origin.lng == null) {
      return Promise.reject(new Error('ORIGIN_COORDINATES_REQUIRED'));
    }
    try {
      assertOriginEligibleForAssignment(origin);
    } catch (guardErr) {
      return Promise.reject(guardErr);
    }
    var snapshot = buildOriginRouteSnapshot(origin, originKey);
    var bookingId = booking.id;
    var seq = (transferRouteRequestSeqByBookingId[bookingId] || 0) + 1;
    transferRouteRequestSeqByBookingId[bookingId] = seq;
    markOriginChangePending(bookingId, originKey, origin);
    if (bridge.renderDualRouteDetails) bridge.renderDualRouteDetails();
    renderTransferBookingSummary(bookingId);
    setRouteActionState(originKey, { status: 'loading', message: '' });
    var buffer = parseInt(($('advisorBuffer') && $('advisorBuffer').value) || CFG.preparationBufferMinutes || 30, 10);
    return fetchTransferRoute(snapshot.lat, snapshot.lng, booking.lat, booking.lng).then(function (routeData) {
      if (transferRouteRequestSeqByBookingId[bookingId] !== seq) {
        return Promise.reject(new Error('STALE_TRANSFER_RESPONSE'));
      }
      if (!routeData || !routeData.geometry) {
        return Promise.reject(new Error(TRANSFER_ROUTE_SAFE_UNAVAILABLE_MSG));
      }
      setRouteActionState(originKey, {
        status: 'success',
        message: '',
        geometry: routeData.geometry || null
      });
      var selected = buildSelectedTransferRouteObject(snapshot, booking, routeData, buffer);
      var commitResult = commitFreshTransferRouteSelection(bookingId, originKey, seq, selected, booking);
      if (!commitResult.ok) {
        return Promise.reject(new Error('TRANSFER_SNAPSHOT_VALIDATION_REJECTED:' + commitResult.code));
      }
      if (bridge.refreshDepotRoutes) bridge.refreshDepotRoutes();
      if (bridge.renderDualRouteDetails) bridge.renderDualRouteDetails();
      markSelectedAdvisorCard(originKey);
      renderTransferDraftPreview(booking.id);
      renderTransferBookingSummary(booking.id);
      return selected;
    }).catch(function (err) {
      if (transferRouteRequestSeqByBookingId[bookingId] === seq) {
        delete transferPendingByBookingId[bookingId];
        delete pendingOriginKeyByBookingId[bookingId];
        delete selectedOriginKeyByBookingId[bookingId];
        delete committedTransferSelectionByBookingId[bookingId];
        markSelectedAdvisorCard(null);
      }
      var classified = classifyTransferRouteError(err);
      setRouteActionState(originKey, {
        status: classified.status,
        message: classified.message,
        geometry: null
      });
      if (bridge.clearTransferMapLayers) bridge.clearTransferMapLayers();
      else if (bridge.refreshDepotRoutes) bridge.refreshDepotRoutes();
      if (bridge.renderDualRouteDetails) bridge.renderDualRouteDetails();
      renderTransferBookingSummary(bookingId);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[IntegrationRouteWorkflow] transfer route failed:', originKey, err);
      }
      return Promise.reject(new Error(classified.message));
    });
  }

  function markSelectedAdvisorCard(originKey) {
    document.querySelectorAll('.origin-compact-row').forEach(function (row) {
      row.classList.toggle('is-selected-transfer', !!originKey && row.getAttribute('data-origin-key') === originKey);
    });
  }

  function renderTransferDraftPreview(bookingId) {
    var el = $('transferDraftPreview');
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
    el.innerHTML = '';
  }

  function formatDistanceKmHu(km) {
    if (km == null || !isFinite(Number(km))) return '—';
    return String(Math.round(Number(km) * 10) / 10).replace('.', ',') + ' km';
  }

  function formatFuelCostHu(ft) {
    if (ft == null || !isFinite(Number(ft))) return '—';
    return Math.round(Number(ft)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Ft';
  }

  function resolveOneWayKiallasDisplayMetrics(transfer, booking) {
    var route = booking ? getKiallasRouteForBooking(booking) : null;
    if (!route) {
      return { distanceKm: null, travelMinutes: null, operationalDurationMinutes: null, fuelMetrics: null };
    }
    var dist = route.distanceKm != null ? Number(route.distanceKm) : null;
    var providerMin = route.providerDurationMinutes != null ? Math.round(Number(route.providerDurationMinutes))
      : (route.travelMinutes != null ? Math.round(Number(route.travelMinutes)) : null);
    var opMin = route.operationalDurationMinutes != null ? Math.round(Number(route.operationalDurationMinutes)) : null;
    var fuel = dist != null && dist > 0 ? getSharedKiallasFuelMetrics(dist, booking) : null;
    return { distanceKm: dist, travelMinutes: providerMin, operationalDurationMinutes: opMin, fuelMetrics: fuel };
  }

  function buildOneWayKiallasSectionHtml(transfer, booking) {
    var m = resolveOneWayKiallasDisplayMetrics(transfer, booking);
    if (m.distanceKm == null) return '';
    var html = '<div class="ops-section ops-section--kiallas-oneway">';
    html += '<div class="ops-section-label">Kiállás – egy irány</div>';
    html += '<div>' + formatDistanceKmHu(m.distanceKm) + '</div>';
    html += '<div class="ops-section-label">Menetidő (provider, egy irány)</div>';
    html += '<div>' + (m.travelMinutes != null && isFinite(m.travelMinutes) ? m.travelMinutes + ' perc' : '—') + '</div>';
    html += '<div class="ops-section-label">Operatív menetidő (egy irány)</div>';
    html += '<div>' + (m.operationalDurationMinutes != null ? m.operationalDurationMinutes + ' perc' : '—') + '</div>';
    if (m.fuelMetrics && m.fuelMetrics.estimatedFuelLitres != null && m.fuelMetrics.estimatedFuelCost != null) {
      html += '<div>' + String(m.fuelMetrics.estimatedFuelLitres).replace('.', ',') + ' l</div>';
      html += '<div>' + formatFuelCostHu(m.fuelMetrics.estimatedFuelCost) + '</div>';
    } else if (m.distanceKm != null && m.distanceKm > 0) {
      html += '<div class="route-compact-fuel route-compact-fuel--hint">Az üzemanyag-becsléshez add meg a fogyasztást és az üzemanyagárat.</div>';
    }
    html += '</div>';
    return html;
  }

  function buildRoundTripOperationalSectionHtml(transfer, booking) {
    var route = booking ? getKiallasRouteForBooking(booking) : null;
    if (!route || route.distanceKm == null || !isFinite(Number(route.distanceKm)) || Number(route.distanceKm) <= 0) return '';
    var rtDist = route.roundTripDistanceKm != null ? route.roundTripDistanceKm : Math.round(Number(route.distanceKm) * 2 * 10) / 10;
    var rtOpMin = route.roundTripOperationalDurationMinutes != null
      ? route.roundTripOperationalDurationMinutes
      : (route.operationalDurationMinutes != null ? route.operationalDurationMinutes * 2 : null);
    var rtFuel = getSharedKiallasFuelMetrics(rtDist, booking);
    var html = '<div class="ops-section ops-section--kiallas-roundtrip">';
    html += '<div class="ops-section-label">Operatív oda-vissza</div>';
    html += '<div>' + formatDistanceKmHu(rtDist) + ' · ' +
      (rtOpMin != null ? rtOpMin + ' perc' : '—') + '</div>';
    if (rtFuel && rtFuel.estimatedFuelLitres != null && rtFuel.estimatedFuelCost != null) {
      html += '<div>' + String(rtFuel.estimatedFuelLitres).replace('.', ',') + ' l</div>';
      html += '<div>' + formatFuelCostHu(rtFuel.estimatedFuelCost) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function buildKiallasFuelCompactHtml(distanceKm, minutes, booking) {
    var dist = distanceKm != null ? Number(distanceKm) : null;
    var mins = minutes != null ? Number(minutes) : null;
    var html = '<div class="route-compact-summary">Kiállás: ' + formatDistanceKmHu(dist) + ' · ' +
      (mins != null && isFinite(mins) ? Math.round(mins) + ' perc' : '—') + '</div>';
    var fuelMetrics = getSharedKiallasFuelMetrics(dist, booking || null);
    if (fuelMetrics) {
      html += '<div class="route-compact-fuel">Üzemanyag: ' +
        String(fuelMetrics.estimatedFuelLitres).replace('.', ',') + ' l · ' +
        formatFuelCostHu(fuelMetrics.estimatedFuelCost) + '</div>';
    } else {
      html += '<div class="route-compact-fuel route-compact-fuel--hint">Az üzemanyag-becsléshez add meg a fogyasztást és az üzemanyagárat.</div>';
    }
    return html;
  }

  function fuelLine(metrics) {
    if (!metrics) return '<div class="route-compact-fuel route-compact-fuel--hint">Az üzemanyag-becsléshez add meg a fogyasztást és az üzemanyagárat.</div>';
    if (metrics.consumptionLitresPer100Km == null || metrics.estimatedFuelLitres == null) {
      return '<div class="route-compact-fuel route-compact-fuel--hint">Az üzemanyag-becsléshez add meg a fogyasztást és az üzemanyagárat.</div>';
    }
    var cost = metrics.estimatedFuelCost != null ? (' · ' + formatFuelCostHu(metrics.estimatedFuelCost)) : '';
    return '<div class="route-compact-fuel">Üzemanyag: ' + String(metrics.estimatedFuelLitres).replace('.', ',') + ' l' + cost + '</div>';
  }

  function renderDualRouteDetails() {
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var customerEl = $('customerRouteDetails');
    var transferEl = $('transferRouteDetails');
    if (!customerEl || !transferEl || !RTA || !bridge || !bridge.getRouteTargetBooking) return;
    var booking = bridge.getRouteTargetBooking();
    if (!booking) {
      customerEl.hidden = true;
      transferEl.hidden = true;
      return;
    }
    var formState = getRouteFormState(booking.id);
    var calc = bridge.getCalculatedRouteState ? bridge.getCalculatedRouteState() : null;
    var customer = RTA.normalizeCustomerServiceRoute(booking, formState);
    var transfer = RTA.normalizeTransferRoute(booking, formState, calc);
    if (customer) {
      customerEl.hidden = false;
      customerEl.innerHTML =
        '<h3 class="route-type-details__title">Megrendelői útvonal (megadott)</h3>' +
        '<div>Távolság: ' + escapeHtml(customer.metrics.distanceKm != null ? customer.metrics.distanceKm + ' km' : '—') + '</div>' +
        '<div>Becsült menetidő: ' + escapeHtml(customer.metrics.estimatedDurationMinutes != null ? customer.metrics.estimatedDurationMinutes + ' perc' : '—') + '</div>' +
        '<div>Útvonalforrás: ' + escapeHtml(customer.source || '—') + '</div>';
    } else {
      customerEl.hidden = false;
      customerEl.innerHTML = '<div class="route-missing-hint">Megrendelői útvonal: nincs megadva</div>';
    }
    if (transfer) {
      transferEl.hidden = false;
      var popup = transfer.popup || {};
      var departureLabel = resolveLatestDepartureLabelForRender(transfer, booking);
      var prepBuffer = resolvePreparationBufferForRender(popup.preparationBufferMinutes != null ? popup : transfer);
      var dataQualityLabel = resolveDataQualityLabelForRender(transfer, booking);
      transferEl.innerHTML =
        buildOneWayKiallasSectionHtml(transfer, booking) +
        buildRoundTripOperationalSectionHtml(transfer, booking) +
        '<div>Indulási hely: ' + escapeHtml(popup.originLabel || transfer.originLabel || '—') + '</div>' +
        '<div>Célfoglalás: ' + escapeHtml(booking.placeName || booking.id) + '</div>' +
        '<div>Szükséges indulási idő: ' + escapeHtml(departureLabel) + '</div>' +
        '<div>Felkészülési tartalék: ' + escapeHtml(prepBuffer.display) + '</div>' +
        '<div>Teljesíthetőség: ' + escapeHtml(popup.feasible === false ? 'Nem teljesíthető' : 'Teljesíthető') + '</div>' +
        '<div class="kiallas-card-line kiallas-card-meta">Adatminőség: ' + escapeHtml(dataQualityLabel) + '</div>';
    } else if (transferPendingByBookingId[booking.id]) {
      transferEl.hidden = false;
      transferEl.innerHTML = '<div class="route-missing-hint">' + escapeHtml(transferPendingByBookingId[booking.id]) + '</div>';
    } else {
      transferEl.hidden = false;
      transferEl.innerHTML = '<h3 class="route-type-details__title">Kiállás</h3><div>Nincs kiválasztott kiállási útvonal.</div>';
    }
    renderTransferDraftPreview(booking.id);
    renderOperationalCostSummary(booking.id);
  }

  function handlePopupActionClick(ev) {
    var routeBtn = ev.target.closest('[data-route-booking]');
    if (routeBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      var id = routeBtn.getAttribute('data-route-booking');
      var map = global.__rentMap;
      if (map) map.closePopup();
      if (id && id !== '—' && global.selectRouteTarget) {
        global.selectRouteTarget(id, true);
        syncBookingSelects(id);
        var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
        if (bridge && bridge.refreshDepotRoutes) bridge.refreshDepotRoutes();
        if (bridge && bridge.renderDualRouteDetails) bridge.renderDualRouteDetails();
      }
      return true;
    }
    var formBtn = ev.target.closest('[data-open-booking]');
    if (formBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      var bookingId = formBtn.getAttribute('data-open-booking');
      var mapRef = global.__rentMap;
      if (mapRef) mapRef.closePopup();
      if (bookingId && bookingId !== '—' && global.openBookingForm) global.openBookingForm(bookingId);
      return true;
    }
    return false;
  }

  function bindMapPopupDelegation() {
    var map = global.__rentMap;
    if (!map || map.__integrationPopupDelegationBound) return;
    map.__integrationPopupDelegationBound = true;
    map.getContainer().addEventListener('click', function (ev) {
      handlePopupActionClick(ev);
    }, true);
    document.addEventListener('click', function (ev) {
      if (!ev.target.closest('.leaflet-popup')) return;
      handlePopupActionClick(ev);
    }, true);
    map.on('popupopen', function (evt) {
      var el = evt.popup && evt.popup.getElement && evt.popup.getElement();
      if (!el || el.__integrationPopupDirectBound) return;
      el.__integrationPopupDirectBound = true;
      el.addEventListener('click', function (ev) {
        handlePopupActionClick(ev);
      });
    });
  }

  function isIntegrationLabMode() {
    return !!(CFG.integrationLab);
  }

  function resolveRouteSourceLabel(source, isSaved) {
    if (source === 'booking.adminCalculatedRoute' || isSaved) return 'Szerverről visszatöltött';
    if (source === 'booking.transferRoute' || source === 'booking.selectedTransferRoute') return 'Helyileg rögzített';
    if (/calculatedState|calculatedRoutes|form\.selectedTransferRoute|form\.transferRoute/.test(String(source || ''))) {
      return 'Helyi számítás';
    }
    if (/booking\.customerRoute|booking\.routeGeometry|form\.routeGeometry|booking\.routePoints/.test(String(source || ''))) {
      return 'Megadott útvonal';
    }
    return source ? String(source) : '—';
  }

  function buildRouteLayerKey(bookingId, routeType, source) {
    return String(bookingId || '') + ':' + String(routeType || '') + ':' + String(source || '');
  }

  function buildRouteLayerMetadata(opts) {
    opts = opts || {};
    var booking = opts.booking || null;
    var routeType = opts.routeType || (RTA && RTA.ROUTE_TYPE ? RTA.ROUTE_TYPE.TRANSFER_ROUTE : 'TRANSFER_ROUTE');
    var routeTypeLabel = RTA && RTA.getRouteTypeLabel ? RTA.getRouteTypeLabel(routeType) : routeType;
    var source = opts.source || null;
    var record = opts.record || opts.routeNorm || null;
    var routeNorm = opts.routeNorm || null;
    var isTransfer = routeType === (RTA && RTA.ROUTE_TYPE ? RTA.ROUTE_TYPE.TRANSFER_ROUTE : 'TRANSFER_ROUTE');
    var dist = null;
    var mins = null;
    var originLabel = null;
    if (routeNorm) {
      var popup = routeNorm.popup || {};
      originLabel = popup.originLabel || routeNorm.originLabel || null;
      if (isTransfer) {
        var oneWay = resolveOneWayKiallasDisplayMetrics(routeNorm, booking);
        dist = oneWay.distanceKm;
        mins = oneWay.travelMinutes;
      } else if (routeNorm.metrics) {
        dist = routeNorm.metrics.distanceKm;
        mins = routeNorm.metrics.estimatedDurationMinutes;
      }
    }
    if (record) {
      if (dist == null && record.distanceKm != null) dist = Number(record.distanceKm);
      if (mins == null && record.travelMinutes != null) mins = Math.round(Number(record.travelMinutes));
      if (!originLabel && record.fromName) originLabel = record.fromName;
    }
    var fuel = dist != null && dist > 0 ? getSharedKiallasFuelMetrics(dist, booking) : null;
    var roundTripKm = isTransfer && dist != null ? Math.round(dist * 2 * 10) / 10 : null;
    var roundTripMinutes = isTransfer && mins != null ? mins * 2 : null;
    var roundTripFuel = roundTripKm != null ? getSharedKiallasFuelMetrics(roundTripKm, booking) : null;
    var isSaved = !!(source === 'booking.adminCalculatedRoute' || (record && record.suggestedDeparture));
    if (source === 'calculatedRoutes' || source === 'calculatedState') isSaved = false;
    if (source === 'booking.transferRoute' || source === 'booking.selectedTransferRoute') isSaved = true;
    return {
      bookingId: booking && booking.id,
      targetName: booking ? (booking.placeName || booking.address || booking.id) : null,
      routeType: routeType,
      routeTypeLabel: routeTypeLabel,
      source: source,
      sourceLabel: resolveRouteSourceLabel(source, source === 'booking.adminCalculatedRoute'),
      isSaved: source === 'booking.adminCalculatedRoute' ? true : !!opts.isSaved,
      isTransfer: isTransfer,
      originLabel: originLabel,
      distanceKm: dist,
      travelMinutes: mins,
      roundTripKm: roundTripKm,
      roundTripMinutes: roundTripMinutes,
      fuelLitres: fuel && fuel.estimatedFuelLitres != null ? fuel.estimatedFuelLitres : null,
      fuelCost: fuel && fuel.estimatedFuelCost != null ? fuel.estimatedFuelCost : null,
      roundTripFuelLitres: roundTripFuel && roundTripFuel.estimatedFuelLitres != null ? roundTripFuel.estimatedFuelLitres : null,
      roundTripFuelCost: roundTripFuel && roundTripFuel.estimatedFuelCost != null ? roundTripFuel.estimatedFuelCost : null,
      layerKey: buildRouteLayerKey(booking && booking.id, routeType, source)
    };
  }

  function buildRouteLayerMetadataFromNorm(booking, routeNorm, routeType) {
    if (!routeNorm || !booking) return null;
    return buildRouteLayerMetadata({
      booking: booking,
      routeType: routeType,
      source: routeNorm.source || null,
      routeNorm: routeNorm,
      isSaved: routeNorm.source === 'booking.adminCalculatedRoute'
    });
  }

  function buildRouteLayerPopupHtml(meta) {
    if (!meta) return '';
    var rows = [
      ['Foglalás', meta.bookingId || '—'],
      ['Cél', meta.targetName || '—'],
      ['Route típus', meta.routeTypeLabel || meta.routeType || '—'],
      ['Forrás', meta.sourceLabel || '—'],
      ['Indulási hely', meta.originLabel || '—'],
      ['Távolság (egy irány)', formatDistanceKmHu(meta.distanceKm)],
      ['Menetidő (egy irány)', meta.travelMinutes != null ? meta.travelMinutes + ' perc' : '—']
    ];
    if (meta.isTransfer && meta.roundTripKm != null) {
      rows.push(['Operatív oda-vissza', formatDistanceKmHu(meta.roundTripKm) + ' · ' +
        (meta.roundTripMinutes != null ? meta.roundTripMinutes + ' perc' : '—')]);
    }
    if (meta.fuelLitres != null && meta.fuelCost != null) {
      rows.push(['Üzemanyag (egy irány)', String(meta.fuelLitres).replace('.', ',') + ' l · ' + formatFuelCostHu(meta.fuelCost)]);
    }
    if (meta.isTransfer && meta.roundTripFuelLitres != null && meta.roundTripFuelCost != null) {
      rows.push(['Üzemanyag (oda-vissza)', String(meta.roundTripFuelLitres).replace('.', ',') + ' l · ' +
        formatFuelCostHu(meta.roundTripFuelCost)]);
    }
    return '<div class="rent-route-popup">' + rows.map(function (r) {
      return '<div><strong>' + escapeHtml(r[0]) + ':</strong> ' + escapeHtml(String(r[1])) + '</div>';
    }).join('') + '</div>';
  }

  function bindRouteLayerPopup(layer, meta) {
    if (!layer || !meta || !layer.bindPopup) return;
    var html = buildRouteLayerPopupHtml(meta);
    if (!html) return;
    layer.bindPopup(html, { maxWidth: 340, className: 'rent-route-popup' });
    layer.options = layer.options || {};
    layer.options.rentRouteLayerKey = meta.layerKey;
    layer.options.rentRouteMeta = meta;
  }

  function enhanceTypedRouteLayerPopups() {
    if (!RTA || !isIntegrationLabMode()) return;
    var integration = global.__RENT_DEPOT_ROUTE_INTEGRATION;
    if (!integration) return;
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var booking = bridge && bridge.getRouteTargetBooking ? bridge.getRouteTargetBooking() : null;
    if (!booking) return;
    var formState = getRouteFormState(booking.id);
    var calc = bridge.getCalculatedRouteState ? bridge.getCalculatedRouteState() : null;
    var customer = RTA.normalizeCustomerServiceRoute(booking, formState);
    var transfer = RTA.normalizeTransferRoute(booking, formState, calc);
    var customerLayer = integration.getCustomerLayer ? integration.getCustomerLayer() : null;
    var transferLayer = integration.getTransferLayer ? integration.getTransferLayer() : null;
    if (customerLayer && customer) {
      var customerMeta = buildRouteLayerMetadataFromNorm(booking, customer, RTA.ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE);
      customerLayer.eachLayer(function (layer) {
        if (layer instanceof L.Polyline) bindRouteLayerPopup(layer, customerMeta);
      });
    }
    if (transferLayer && transfer) {
      var transferMeta = buildRouteLayerMetadataFromNorm(booking, transfer, RTA.ROUTE_TYPE.TRANSFER_ROUTE);
      transferLayer.eachLayer(function (layer) {
        if (layer instanceof L.Polyline) bindRouteLayerPopup(layer, transferMeta);
      });
    }
  }

  function installDepotRouteRefreshHook() {
    if (!isIntegrationLabMode()) return false;
    var integration = global.__RENT_DEPOT_ROUTE_INTEGRATION;
    if (!integration || integration.__routePopupHookInstalled) return !!integration;
    var nativeRefresh = integration.refreshDualRoutes;
    if (typeof nativeRefresh !== 'function') return false;
    integration.refreshDualRoutes = function () {
      nativeRefresh();
      enhanceTypedRouteLayerPopups();
    };
    integration.__routePopupHookInstalled = true;
    integration.refreshDualRoutes();
    return true;
  }

  function collectVisibleRouteGeoJsonFeatures() {
    var features = [];
    var utils = global.GeoJsonDownloadUtils;
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    var bookings = bridge && bridge.getBookings ? bridge.getBookings() : [];
    var routeTargetId = bridge && bridge.getRouteTargetBooking ? (bridge.getRouteTargetBooking() || {}).id : null;
    bookings.forEach(function (booking) {
      if (!booking || !booking.id) return;
      if (window.getCustomerRoutePoints && window.buildCustomerRouteLayerMeta) {
        var cPts = window.getCustomerRoutePoints(booking);
        if (cPts.length >= 2 && !(routeTargetId && booking.id === routeTargetId && isIntegrationLabMode())) {
          var cMeta = window.buildCustomerRouteLayerMeta(booking);
          if (cMeta && window.lineStringFromBookingRouteForExport) {
            var cGeom = window.lineStringFromBookingRouteForExport(booking);
            if (cGeom) {
              features.push({
                type: 'Feature',
                geometry: cGeom,
                properties: utils && utils.enrichRouteFeatureProperties
                  ? utils.enrichRouteFeatureProperties({ bookingId: booking.id, routeKind: 'customer' }, utils.routeMetaToFeatureExtras(cMeta))
                  : { bookingId: booking.id, routeKind: 'customer' }
              });
            }
          }
        }
      }
      if (window.getAdminRoutePoints && window.buildAdminRouteLayerMeta) {
        var aPts = window.getAdminRoutePoints(booking);
        if (aPts.length >= 2 && !(routeTargetId && booking.id === routeTargetId && isIntegrationLabMode())) {
          var aMeta = window.buildAdminRouteLayerMeta(booking);
          if (aMeta) {
            features.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: aPts.map(function (p) { return [p.lng, p.lat]; }) },
              properties: utils && utils.enrichRouteFeatureProperties
                ? utils.enrichRouteFeatureProperties({ bookingId: booking.id, routeKind: 'admin' }, utils.routeMetaToFeatureExtras(aMeta))
                : { bookingId: booking.id, routeKind: 'admin' }
            });
          }
        }
      }
    });
    if (routeTargetId && RTA && bridge) {
      var target = bridge.getBookingById ? bridge.getBookingById(routeTargetId) : null;
      if (target) {
        var formState = getRouteFormState(target.id);
        var calc = bridge.getCalculatedRouteState ? bridge.getCalculatedRouteState() : null;
        var customer = RTA.normalizeCustomerServiceRoute(target, formState);
        var transfer = RTA.normalizeTransferRoute(target, formState, calc);
        [customer, transfer].forEach(function (routeNorm, idx) {
          if (!routeNorm || !routeNorm.geometry) return;
          var routeType = idx === 0 ? RTA.ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE : RTA.ROUTE_TYPE.TRANSFER_ROUTE;
          var feature = RTA.buildRouteGeoJsonFeature(routeType, routeNorm, target);
          if (!feature) return;
          var meta = buildRouteLayerMetadataFromNorm(target, routeNorm, routeType);
          feature.properties = utils && utils.enrichRouteFeatureProperties
            ? utils.enrichRouteFeatureProperties(feature.properties, utils.routeMetaToFeatureExtras(meta))
            : feature.properties;
          features.push(feature);
        });
      }
    }
    return features;
  }

  function installRouteLayerHooks() {
    if (!isIntegrationLabMode()) return;
    function tryHook() { return installDepotRouteRefreshHook(); }
    if (!tryHook()) {
      global.addEventListener('rent-admin-ready', tryHook);
      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        if (tryHook() || attempts > 50) clearInterval(timer);
      }, 200);
    }
  }

  function clearTransferSelectionForBooking(bookingId) {
    if (!bookingId) return;
    setSelectedTransferRoute(bookingId, null);
    delete pendingOriginKeyByBookingId[bookingId];
    delete transferPendingByBookingId[bookingId];
    delete originInvalidatedByBookingId[bookingId];
    delete committedTransferSelectionByBookingId[bookingId];
    markSelectedAdvisorCard(null);
    clearRouteActionState();
    var el = $('transferDraftPreview');
    if (el) { el.hidden = true; el.textContent = ''; }
  }

  function clearTransferMapUiState(bookingId) {
    if (bookingId) clearTransferSelectionForBooking(bookingId);
    else {
      markSelectedAdvisorCard(null);
      clearRouteActionState();
    }
    var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (bridge && bridge.clearTransferMapLayers) bridge.clearTransferMapLayers();
    else if (bridge && bridge.refreshDepotRoutes) bridge.refreshDepotRoutes();
  }

  function getPendingTransferState(bookingId) {
    if (!bookingId) return null;
    return {
      bookingId: bookingId,
      pendingMessage: transferPendingByBookingId[bookingId] || null,
      pendingOriginKey: pendingOriginKeyByBookingId[bookingId] || null,
      selectedOriginKey: selectedOriginKeyByBookingId[bookingId] || null,
      invalidated: isOriginInvalidatedForBooking(bookingId)
    };
  }

  function bindSelectSync() {
    var routeSel = $('routeBookingId');
    if (!routeSel || routeSel.__integrationSyncBound) return;
    routeSel.__integrationSyncBound = true;
    routeSel.addEventListener('change', function () {
      var advisorState = global.__ORIGIN_ADVISOR_STATE;
      if (advisorState && advisorState.clearForTargetChange) advisorState.clearForTargetChange();
      var bridge = global.__RENT_DEPOT_INTEGRATION_BRIDGE;
      if (bridge && bridge.onRouteTargetChanged) bridge.onRouteTargetChanged();
    });
    var assignTransferBtn = $('btnAssignTransferRoute');
    if (assignTransferBtn && !assignTransferBtn.__integrationBound) {
      assignTransferBtn.__integrationBound = true;
      assignTransferBtn.addEventListener('click', function () {
        assignTransferRouteToBookingAndBack().catch(function (err) {
          alert(err && err.message ? err.message : 'Kiállás hozzárendelése sikertelen.');
        });
      });
    }
  }

  function init() {
    bindSelectSync();
    if (!isLiveReadOnly()) return;
    function tryBind() {
      syncBookingSelects();
      bindMapPopupDelegation();
      renderDualRouteDetails();
      return !!global.__rentMap;
    }
    if (!tryBind()) {
      global.addEventListener('rent-admin-ready', tryBind);
      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        if (tryBind() || attempts > 50) clearInterval(timer);
      }, 200);
    }
    global.addEventListener('rent-booking-selects-sync', function () {
      syncBookingSelects();
      renderDualRouteDetails();
    });
  }

  global.IntegrationRouteWorkflow = {
    syncBookingSelects: syncBookingSelects,
    getRouteFormState: getRouteFormState,
    getSelectedTransferRoute: getSelectedTransferRoute,
    setSelectedTransferRoute: setSelectedTransferRoute,
    getSelectedOriginKey: getSelectedOriginKey,
    getTransferDraftPreview: getTransferDraftPreview,
    applyAdvisorTransferRoute: applyAdvisorTransferRoute,
    getRouteActionState: getRouteActionState,
    clearRouteActionState: clearRouteActionState,
    assignTransferRouteToBookingAndBack: assignTransferRouteToBookingAndBack,
    computeOperationalCostSummary: computeOperationalCostSummary,
    buildOperationalEstimateMetrics: buildOperationalEstimateMetrics,
    renderOperationalCostSummary: renderOperationalCostSummary,
    renderTransferBookingSummary: renderTransferBookingSummary,
    renderKiallasSaveStatusBadges: renderKiallasSaveStatusBadges,
    buildKiallasListItemHtml: buildKiallasListItemHtml,
    getKiallasPersistenceState: getKiallasPersistenceState,
    hydrateKiallasServerStatusFromServerBooking: hydrateKiallasServerStatusFromServerBooking,
    applyKiallasAdminRoutePatchOutcome: applyKiallasAdminRoutePatchOutcome,
    renderDualRouteDetails: renderDualRouteDetails,
    renderTransferDraftPreview: renderTransferDraftPreview,
    markSelectedAdvisorCard: markSelectedAdvisorCard,
    clearTransferSelectionForBooking: clearTransferSelectionForBooking,
    bindMapPopupDelegation: bindMapPopupDelegation,
    buildRouteLayerMetadata: buildRouteLayerMetadata,
    buildRouteLayerMetadataFromNorm: buildRouteLayerMetadataFromNorm,
    buildRouteLayerPopupHtml: buildRouteLayerPopupHtml,
    bindRouteLayerPopup: bindRouteLayerPopup,
    enhanceTypedRouteLayerPopups: enhanceTypedRouteLayerPopups,
    collectVisibleRouteGeoJsonFeatures: collectVisibleRouteGeoJsonFeatures,
    resolveRouteSourceLabel: resolveRouteSourceLabel,
    computeOwnerReportRouteMetrics: computeOwnerReportRouteMetrics,
    buildAdminCalculatedRouteForSave: buildAdminCalculatedRouteForSave,
    isValidTransferSnapshot: isValidTransferSnapshot,
    explainTransferSnapshotRejection: explainTransferSnapshotRejection,
    classifyTransferRouteError: classifyTransferRouteError,
    resolveValidatedTransferSnapshot: resolveValidatedTransferSnapshot,
    getValidatedTransferSnapshotForSave: getValidatedTransferSnapshotForSave,
    enrichTransferOperationalMetrics: enrichTransferOperationalMetrics,
    isOriginInvalidatedForBooking: isOriginInvalidatedForBooking,
    markOriginChangePending: markOriginChangePending,
    clearOriginInvalidation: clearOriginInvalidation,
    commitFreshTransferRouteSelection: commitFreshTransferRouteSelection,
    clearTransferMapUiState: clearTransferMapUiState,
    getPendingTransferState: getPendingTransferState,
    resolveOriginDisplayLabel: resolveOriginDisplayLabel,
    findOriginByKey: findOriginByKey,
    hasKiallasPreviewData: hasKiallasPreviewData,
    TRANSFER_OPERATIONAL_SPEED_KMH: TRANSFER_OPERATIONAL_SPEED_KMH
  };

  installRouteLayerHooks();
  init();
})(typeof window !== 'undefined' ? window : globalThis);
