(function (global) {
  'use strict';

  var CFG = global.DEPOT_MATRIX_CONFIG || {};

  function kmFromMeters(m) {
    return Math.round((m / 1000) * 10) / 10;
  }

  function kisvonatTravelMinutes(distanceKm, speedKmh) {
    var speed = speedKmh > 0 ? speedKmh : 30;
    return Math.round((distanceKm / speed) * 60);
  }

  function parseBookingStart(booking) {
    if (!booking || !booking.date) return null;
    var t = (booking.timeStart || '00:00').split(':');
    var h = parseInt(t[0], 10) || 0;
    var m = parseInt(t[1], 10) || 0;
    var parts = booking.date.split('-');
    if (parts.length < 3) return null;
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0);
  }

  function formatTimeHm(d) {
    if (!d || isNaN(d.getTime())) return '—';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function latestDeparture(bookingStart, travelMinutes, bufferMinutes) {
    if (!bookingStart) return null;
    return new Date(bookingStart.getTime() - (travelMinutes + bufferMinutes) * 60000);
  }

  function isTimeFeasible(bookingStart, travelMinutes, bufferMinutes, now) {
    if (!bookingStart) return true;
    var dep = latestDeparture(bookingStart, travelMinutes, bufferMinutes);
    return dep && dep.getTime() >= (now || new Date()).getTime();
  }

  function mapProviderMeta(provider, fallbackUsed) {
    if (provider === 'mock') {
      return { provider: 'mock', isRealResult: false, providerLabel: 'MOCK – NEM VALÓS' };
    }
    if (provider === 'valhalla-matrix' || (provider === 'valhalla' && !fallbackUsed)) {
      return { provider: 'valhalla-matrix', isRealResult: true, providerLabel: 'VALHALLA MATRIX – VALÓS' };
    }
    if (provider === 'valhalla-route' || (provider === 'valhalla' && fallbackUsed)) {
      return { provider: 'valhalla-route', isRealResult: true, providerLabel: 'VALHALLA ROUTE FALLBACK – VALÓS' };
    }
    if (provider === 'osrm-route' || provider === 'osrm') {
      return { provider: 'osrm-route', isRealResult: true, providerLabel: 'OSRM FALLBACK – VALÓS, GYORSFORGALOM ELLENŐRIZENDŐ' };
    }
    if (provider === 'lab-precomputed-matrix') {
      return { provider: 'lab-precomputed-matrix', isRealResult: false, providerLabel: 'LAB – előre számított mátrix (geometria nélkül)' };
    }
    return { provider: provider || 'unknown', isRealResult: false, providerLabel: String(provider || 'ISMERETLEN') };
  }

  function buildMatrixBody(sources, target, avoidHighways) {
    return {
      sources: sources.map(function (s) { return { lat: s.lat, lon: s.lng }; }),
      targets: [{ lat: target.lat, lon: target.lng }],
      costing: 'auto',
      costing_options: { auto: { use_highways: avoidHighways ? 0 : 1 } }
    };
  }

  function resolveValhallaRouteUrl(options) {
    return (options && options.routeUrl) || CFG.valhallaRouteUrl || CFG.valhallaUrl || CFG.labValhallaProxyUrl + '/route' || 'https://valhalla1.openstreetmap.de/route';
  }

  function resolveValhallaMatrixUrl(options) {
    return (options && options.matrixUrl) || CFG.valhallaMatrixUrl || CFG.labValhallaProxyUrl + '/sources_to_targets' || 'https://valhalla1.openstreetmap.de/sources_to_targets';
  }

  function fetchValhallaMatrix(sources, target, options) {
    var url = resolveValhallaMatrixUrl(options);
    var avoidHighways = options.avoidHighways !== false;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMatrixBody(sources, target, avoidHighways))
    }).then(function (r) {
      if (!r.ok) throw new Error('VALHALLA_MATRIX_HTTP_' + r.status);
      return r.json();
    }).then(function (data) {
      if (!data || !data.sources_to_targets) throw new Error('VALHALLA_MATRIX_INVALID');
      return {
        provider: 'valhalla-matrix',
        fallbackUsed: false,
        avoidHighwaysRequested: avoidHighways,
        raw: data
      };
    });
  }

  function fetchValhallaRoute(fromLng, fromLat, toLng, toLat, options) {
    var url = resolveValhallaRouteUrl(options);
    var avoidHighways = options.avoidHighways !== false;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [{ lat: fromLat, lon: fromLng }, { lat: toLat, lon: toLng }],
        costing: 'auto',
        costing_options: { auto: { use_highways: avoidHighways ? 0 : 1 } },
        directions_options: { units: 'kilometers' }
      })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || !data.trip || !data.trip.legs || !data.trip.legs[0]) return { ok: false };
      var summary = data.trip.summary || data.trip.legs[0].summary || {};
      return {
        ok: true,
        provider: 'valhalla-route',
        distanceMeters: Math.round((summary.length || 0) * 1000),
        routingSeconds: summary.time || 0
      };
    }).catch(function () { return { ok: false }; });
  }

  function fetchOsrmRoute(fromLng, fromLat, toLng, toLat, options) {
    var base = (options.osrmBase || CFG.osrmBase || '').replace(/\/$/, '');
    var url = base + '/driving/' + fromLng + ',' + fromLat + ';' + toLng + ',' + toLat + '?overview=false';
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || data.code !== 'Ok' || !data.routes || !data.routes[0]) return { ok: false };
      return {
        ok: true,
        provider: 'osrm-route',
        distanceMeters: Math.round(data.routes[0].distance || 0),
        routingSeconds: Math.round(data.routes[0].duration || 0)
      };
    });
  }

  function fetchPerDepotRoutes(depots, target, options) {
    var avoidHighways = options.avoidHighways !== false;
    var osrmGetOnly = !!options.osrmGetOnly;
    return Promise.all(depots.map(function (depot) {
      if (osrmGetOnly) {
        return fetchOsrmRoute(depot.lng, depot.lat, target.lng, target.lat, options).then(function (osrm) {
          if (osrm && osrm.ok) {
            return {
              depotId: depot.id,
              distanceMeters: osrm.distanceMeters,
              routingSeconds: osrm.routingSeconds,
              provider: 'osrm-route',
              fallbackUsed: true
            };
          }
          return { depotId: depot.id, routable: false };
        });
      }
      return fetchValhallaRoute(depot.lng, depot.lat, target.lng, target.lat, options).then(function (val) {
        if (val && val.ok) {
          return {
            depotId: depot.id,
            distanceMeters: val.distanceMeters,
            routingSeconds: val.routingSeconds,
            provider: 'valhalla-route',
            fallbackUsed: true
          };
        }
        if (options.allowOsrmFallback) {
          return fetchOsrmRoute(depot.lng, depot.lat, target.lng, target.lat, options).then(function (osrm) {
            if (osrm && osrm.ok) {
              return {
                depotId: depot.id,
                distanceMeters: osrm.distanceMeters,
                routingSeconds: osrm.routingSeconds,
                provider: 'osrm-route',
                fallbackUsed: true
              };
            }
            return { depotId: depot.id, routable: false };
          });
        }
        return { depotId: depot.id, routable: false };
      });
    })).then(function (rows) {
      return {
        provider: 'valhalla-route',
        fallbackUsed: true,
        avoidHighwaysRequested: avoidHighways,
        perDepot: rows
      };
    });
  }

  function loadMockMatrix(depots, mockData) {
    var matrix = mockData && mockData.sources_to_targets;
    if (!matrix || matrix.length !== depots.length) throw new Error('MOCK_MATRIX_SHAPE_MISMATCH');
    return Promise.resolve({
      provider: 'mock',
      fallbackUsed: true,
      avoidHighwaysRequested: !!(mockData && mockData.avoidHighways),
      isMockRun: true,
      raw: mockData
    });
  }

  function isSafeRoutingProvider(provider) {
    return provider === 'valhalla-matrix' || provider === 'valhalla-route' || provider === 'valhalla';
  }

  function matrixCellDistanceMeters(cell, provider) {
    if (!cell || cell.distance == null) return null;
    var d = Number(cell.distance);
    if (!isFinite(d) || d < 0) return null;
    if (provider === 'valhalla-matrix' || provider === 'valhalla') {
      return Math.round(d * 1000);
    }
    return Math.round(d);
  }

  function normalizeMatrixRow(depot, cell, meta, booking, speedKmh, bufferMinutes, now, rowProvider) {
    var pMeta = mapProviderMeta(rowProvider || meta.provider, meta.fallbackUsed);
    var distanceMeters = matrixCellDistanceMeters(cell, rowProvider || meta.provider);
    var routable = distanceMeters != null && distanceMeters >= 0;
    var distanceKm = routable ? kmFromMeters(distanceMeters) : null;
    var trainTravelMinutes = routable ? kisvonatTravelMinutes(distanceKm, speedKmh) : null;
    var bookingStart = parseBookingStart(booking);
    var depAt = routable ? latestDeparture(bookingStart, trainTravelMinutes, bufferMinutes) : null;
    var timeFeasible = routable && isTimeFeasible(bookingStart, trainTravelMinutes, bufferMinutes, now);
    var providerName = rowProvider || meta.provider;
    var safeRouteGeometryAvailable = routable && isSafeRoutingProvider(providerName) && pMeta.provider !== 'osrm-route' && pMeta.provider !== 'mock';
    var candidateEligible = routable && timeFeasible;
    var warning = 'Az automatikus útvonal kisvonatra külön ellenőrizendő.';
    if (!routable) warning = 'Útvonal nem számítható. ' + warning;
    else if (!safeRouteGeometryAvailable) warning = 'Biztonságos útvonal-geometria nem áll rendelkezésre. ' + warning;
    else if (pMeta.provider === 'osrm-route') warning = 'OSRM fallback – gyorsforgalom ellenőrizendő. ' + warning;
    else if (pMeta.provider === 'mock') warning = 'MOCK demó adat – nem valós útvonalszámítás.';

    return {
      depotId: depot.id,
      depotName: depot.name,
      routable: routable,
      distanceKm: distanceKm,
      distanceMeters: distanceMeters,
      kisvonatTravelMinutes: trainTravelMinutes,
      trainTravelMinutes: trainTravelMinutes,
      configuredSpeedKmh: speedKmh,
      preparationBufferMinutes: bufferMinutes,
      latestDeparture: depAt,
      latestDepartureLabel: formatTimeHm(depAt),
      provider: pMeta.provider,
      providerLabel: pMeta.providerLabel,
      isRealResult: pMeta.isRealResult,
      fallbackUsed: !!meta.fallbackUsed,
      avoidHighwaysRequested: meta.avoidHighwaysRequested !== false,
      routingSeconds: cell && cell.time != null ? cell.time : null,
      timeFeasible: timeFeasible,
      candidateEligible: candidateEligible,
      safeRouteGeometryAvailable: safeRouteGeometryAvailable,
      warning: warning,
      rankScore: routable ? distanceMeters : Number.MAX_SAFE_INTEGER,
      routingBinding: {
        targetBookingId: booking && booking.id,
        normalizedCandidateId: 'depot:' + depot.id,
        originLat: depot.lat,
        originLng: depot.lng,
        targetLat: booking && booking.lat,
        targetLng: booking && booking.lng
      }
    };
  }

  function normalizePerDepotRows(depots, perDepot, meta, booking, speedKmh, bufferMinutes, now) {
    return depots.map(function (depot) {
      var row = perDepot.find(function (x) { return x.depotId === depot.id; });
      if (!row || row.routable === false) return normalizeMatrixRow(depot, null, meta, booking, speedKmh, bufferMinutes, now);
      return normalizeMatrixRow(depot, { distance: row.distanceMeters, time: row.routingSeconds }, meta, booking, speedKmh, bufferMinutes, now, row.provider);
    });
  }

  function normalizeMatrixResult(depots, matrixPayload, booking, speedKmh, bufferMinutes, now) {
    return depots.map(function (depot, i) {
      var cell = matrixPayload.raw.sources_to_targets[i] && matrixPayload.raw.sources_to_targets[i][0]
        ? matrixPayload.raw.sources_to_targets[i][0] : null;
      return normalizeMatrixRow(depot, cell, matrixPayload, booking, speedKmh, bufferMinutes, now, matrixPayload.provider);
    });
  }

  function sortAdvisorResults(rows) {
    return rows.slice().sort(function (a, b) {
      if (a.routable !== b.routable) return a.routable ? -1 : 1;
      if (a.timeFeasible !== b.timeFeasible) return a.timeFeasible ? -1 : 1;
      if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
      if (a.trainTravelMinutes !== b.trainTravelMinutes) return a.trainTravelMinutes - b.trainTravelMinutes;
      return String(a.depotName).localeCompare(String(b.depotName), 'hu');
    });
  }

  var labMatrixCachePromise = null;

  function loadLabDepotMatrixCache() {
    if (labMatrixCachePromise) return labMatrixCachePromise;
    if (!CFG.integrationLab) return Promise.resolve(null);
    labMatrixCachePromise = fetch('/integration_harness/fixtures/lab_depot_matrix_cache.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    return labMatrixCachePromise;
  }

  function maybeRecoverLabDepotRows(depots, rows, booking, speedKmh, bufferMinutes, now) {
    if (!CFG.integrationLab || CFG.runtimeMode !== 'LIVE_READ_ONLY_AUDIT') {
      return Promise.resolve(rows);
    }
    if (rows.some(function (r) { return r.candidateEligible; })) {
      return Promise.resolve(rows);
    }
    return loadLabDepotMatrixCache().then(function (cache) {
      if (!cache || !cache.targets || !booking || !booking.id) return rows;
      var entry = cache.targets[booking.id];
      if (!entry || !Array.isArray(entry.perDepot)) return rows;
      var meta = {
        provider: 'lab-precomputed-matrix',
        fallbackUsed: true,
        avoidHighwaysRequested: true,
        rankingBasis: cache.rankingBasis || 'PRECOMPUTED_LAB_MATRIX'
      };
      var perDepot = entry.perDepot.map(function (x) {
        return {
          depotId: x.depotId,
          distanceMeters: x.distanceMeters,
          routingSeconds: 0,
          provider: 'lab-precomputed-matrix'
        };
      });
      return normalizePerDepotRows(depots, perDepot, meta, booking, speedKmh, bufferMinutes, now);
    });
  }

  function compareDepotsToBooking(depots, booking, options) {
    options = options || {};
    var speedKmh = options.speedKmh || CFG.configuredSpeedKmh || 30;
    var bufferMinutes = options.bufferMinutes != null ? options.bufferMinutes : (CFG.preparationBufferMinutes || 30);
    var now = options.now || new Date();
    var target = { lat: booking.lat, lng: booking.lng };
    var avoidHighways = options.avoidHighways !== false;

    if (booking.lat == null || booking.lng == null) {
      return Promise.reject(new Error('BOOKING_COORDINATES_REQUIRED'));
    }

    function finalize(payload) {
      var rows = payload.perDepot
        ? normalizePerDepotRows(depots, payload.perDepot, payload, booking, speedKmh, bufferMinutes, now)
        : normalizeMatrixResult(depots, payload, booking, speedKmh, bufferMinutes, now);
      return maybeRecoverLabDepotRows(depots, rows, booking, speedKmh, bufferMinutes, now).then(function (recoveredRows) {
        var pMeta = mapProviderMeta(payload.provider, payload.fallbackUsed);
        return {
          booking: booking,
          speedKmh: speedKmh,
          bufferMinutes: bufferMinutes,
          provider: pMeta.provider,
          providerLabel: pMeta.providerLabel,
          isMockRun: payload.provider === 'mock' || payload.isMockRun === true,
          isRealResult: pMeta.isRealResult,
          fallbackUsed: payload.fallbackUsed,
          avoidHighwaysRequested: payload.avoidHighwaysRequested !== false,
          results: sortAdvisorResults(recoveredRows)
        };
      });
    }

    if (options.testFixtureMatrix) {
      return loadMockMatrix(depots, options.testFixtureMatrix).then(finalize);
    }

    if (CFG.runtimeMode === 'OFFLINE_INTEGRATION_AUDIT' || (!CFG.allowRoutingRequests && CFG.runtimeMode !== 'LIVE_READ_ONLY_AUDIT')) {
      return Promise.reject(new Error('ROUTING_UNAVAILABLE'));
    }

    if (CFG.runtimeMode === 'LIVE_READ_ONLY_AUDIT') {
      function runLiveSafeRouting() {
        return fetchValhallaMatrix(depots, target, {
          avoidHighways: avoidHighways,
          matrixUrl: CFG.valhallaMatrixUrl
        }).then(finalize).catch(function () {
          return fetchPerDepotRoutes(depots, target, {
            avoidHighways: avoidHighways,
            allowOsrmFallback: false,
            osrmGetOnly: false,
            routeUrl: CFG.valhallaRouteUrl || CFG.valhallaUrl
          }).then(finalize);
        });
      }
      return runLiveSafeRouting().catch(function () {
        if (!CFG.labValhallaProxyUrl) throw new Error('ALL_ROUTING_FAILED');
        return fetchValhallaMatrix(depots, target, {
          avoidHighways: avoidHighways,
          matrixUrl: CFG.labValhallaProxyUrl + '/sources_to_targets'
        }).then(finalize).catch(function () {
          return fetchPerDepotRoutes(depots, target, {
            avoidHighways: avoidHighways,
            allowOsrmFallback: false,
            routeUrl: CFG.labValhallaProxyUrl + '/route'
          }).then(finalize);
        });
      }).catch(function () {
        throw new Error('ALL_ROUTING_FAILED');
      });
    }

    return fetchValhallaMatrix(depots, target, { avoidHighways: avoidHighways }).then(finalize).catch(function () {
      return fetchPerDepotRoutes(depots, target, {
        avoidHighways: avoidHighways,
        allowOsrmFallback: !!options.allowOsrmFallback
      }).then(finalize).catch(function () {
        throw new Error('ALL_ROUTING_FAILED');
      });
    });
  }

  var api = {
    kmFromMeters: kmFromMeters,
    kisvonatTravelMinutes: kisvonatTravelMinutes,
    parseBookingStart: parseBookingStart,
    latestDeparture: latestDeparture,
    isTimeFeasible: isTimeFeasible,
    sortAdvisorResults: sortAdvisorResults,
    compareDepotsToBooking: compareDepotsToBooking,
    mapProviderMeta: mapProviderMeta,
    loadMockMatrix: loadMockMatrix
  };

  global.DepotMatrixAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
