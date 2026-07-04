(function (global) {
  'use strict';

  var ROUTE_TYPE = {
    CUSTOMER_SERVICE_ROUTE: 'CUSTOMER_SERVICE_ROUTE',
    TRANSFER_ROUTE: 'TRANSFER_ROUTE'
  };

  var ROUTE_TYPE_LABELS = {
    CUSTOMER_SERVICE_ROUTE: 'Megrendelői útvonal',
    TRANSFER_ROUTE: 'Kiállás'
  };
  var DL = null;
  function dl() {
    if (DL) return DL;
    if (typeof global !== 'undefined' && global.GeoJsonDownloadUtils) DL = global.GeoJsonDownloadUtils;
    return DL;
  }

  function isObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  function parseMaybeJson(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch (e) { return null; }
  }

  function normalizeLineStringGeometry(geom) {
    if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) return null;
    var coords = geom.coordinates.filter(function (c) {
      return Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1]);
    });
    if (coords.length < 2) return null;
    return { type: 'LineString', coordinates: coords };
  }

  function coordsFromRoutePoints(routePoints) {
    if (!Array.isArray(routePoints)) return [];
    return routePoints.map(function (item) {
      if (!item) return null;
      if (Array.isArray(item) && item.length >= 2) {
        return { lat: Number(item[1]), lng: Number(item[0]) };
      }
      if (item.lat != null && item.lng != null) {
        return { lat: Number(item.lat), lng: Number(item.lng) };
      }
      return null;
    }).filter(function (p) { return p && isFinite(p.lat) && isFinite(p.lng); });
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

  function lineLengthKmFromGeometry(geometry) {
    var geom = normalizeLineStringGeometry(geometry);
    if (!geom) return null;
    var total = 0;
    for (var i = 1; i < geom.coordinates.length; i += 1) {
      var a = geom.coordinates[i - 1];
      var b = geom.coordinates[i];
      total += haversineKm(a[1], a[0], b[1], b[0]);
    }
    return Math.round(total * 10) / 10;
  }

  function lineEndpoints(geometry) {
    var geom = normalizeLineStringGeometry(geometry);
    if (!geom) return { start: null, end: null };
    var first = geom.coordinates[0];
    var last = geom.coordinates[geom.coordinates.length - 1];
    return {
      start: { lat: first[1], lng: first[0] },
      end: { lat: last[1], lng: last[0] }
    };
  }

  function pickCustomerGeometry(booking, formState) {
    formState = formState || {};
    if (formState.customerServiceRoute) {
      var fromFormCustomer = normalizeLineStringGeometry(
        isObject(formState.customerServiceRoute) ? formState.customerServiceRoute.geometry || formState.customerServiceRoute : formState.customerServiceRoute
      );
      if (fromFormCustomer) return { geometry: fromFormCustomer, source: 'form.customerServiceRoute' };
    }
    if (formState.routeGeometry) {
      var fromFormRoute = normalizeLineStringGeometry(parseMaybeJson(formState.routeGeometry) || formState.routeGeometry);
      if (fromFormRoute) return { geometry: fromFormRoute, source: 'form.routeGeometry' };
    }
    if (!booking) return null;
    if (booking.customerServiceRoute) {
      var g1 = normalizeLineStringGeometry(
        isObject(booking.customerServiceRoute) ? booking.customerServiceRoute.geometry || booking.customerServiceRoute : booking.customerServiceRoute
      );
      if (g1) return { geometry: g1, source: 'booking.customerServiceRoute' };
    }
    if (booking.customerRoute) {
      var g2 = normalizeLineStringGeometry(
        isObject(booking.customerRoute) ? booking.customerRoute.geometry || booking.customerRoute : booking.customerRoute
      );
      if (g2) return { geometry: g2, source: 'booking.customerRoute' };
    }
    var fromStoredGeometry = normalizeLineStringGeometry(booking.routeGeometry);
    if (fromStoredGeometry) return { geometry: fromStoredGeometry, source: 'booking.routeGeometry' };
    if (booking.routePoints && booking.routePoints.length) {
      var pts = coordsFromRoutePoints(booking.routePoints);
      if (pts.length >= 2) {
        return {
          geometry: { type: 'LineString', coordinates: pts.map(function (p) { return [p.lng, p.lat]; }) },
          source: 'booking.routePoints'
        };
      }
    }
    var fromDraft = normalizeLineStringGeometry(booking.routeDraft);
    if (fromDraft) return { geometry: fromDraft, source: 'booking.routeDraft' };
    return null;
  }

  function isAdminCalculatedRouteSource(source) {
    return source === 'booking.adminCalculatedRoute';
  }

  function mapSuggestedDepartureToLatestDepartureLabel(suggestedDeparture) {
    if (suggestedDeparture == null || suggestedDeparture === '') return null;
    return String(suggestedDeparture).replace('T', ' ');
  }

  function resolveLatestDepartureLabel(meta) {
    if (!meta) return null;
    if (meta.latestDepartureLabel) return meta.latestDepartureLabel;
    if (meta.suggestedDeparture != null && meta.suggestedDeparture !== '') {
      return mapSuggestedDepartureToLatestDepartureLabel(meta.suggestedDeparture);
    }
    return null;
  }

  function pickTransferGeometry(booking, formState, calculatedState) {
    formState = formState || {};
    calculatedState = calculatedState || {};
    if (formState.selectedTransferRoute) {
      var sel = formState.selectedTransferRoute;
      var gSel = normalizeLineStringGeometry(sel.geometry || sel);
      if (gSel) return { geometry: gSel, meta: sel, source: 'form.selectedTransferRoute' };
    }
    if (formState.transferRoute) {
      var tr = parseMaybeJson(formState.transferRoute) || formState.transferRoute;
      var gTr = normalizeLineStringGeometry(isObject(tr) ? tr.geometry || tr : tr);
      if (gTr) return { geometry: gTr, meta: isObject(tr) ? tr : null, source: 'form.transferRoute' };
    }
    if (calculatedState && calculatedState.geometry) {
      var gCalc = normalizeLineStringGeometry(calculatedState.geometry);
      if (gCalc) return { geometry: gCalc, meta: calculatedState, source: 'calculatedState' };
    }
    if (!booking) return null;
    if (booking.transferRoute) {
      var bTr = booking.transferRoute;
      var gBtr = normalizeLineStringGeometry(isObject(bTr) ? bTr.geometry || bTr : bTr);
      if (gBtr) return { geometry: gBtr, meta: isObject(bTr) ? bTr : null, source: 'booking.transferRoute' };
    }
    if (booking.selectedTransferRoute) {
      var bSel = booking.selectedTransferRoute;
      var gBsel = normalizeLineStringGeometry(isObject(bSel) ? bSel.geometry || bSel : bSel);
      if (gBsel) return { geometry: gBsel, meta: isObject(bSel) ? bSel : null, source: 'booking.selectedTransferRoute' };
    }
    if (booking.adminCalculatedRoute && booking.adminCalculatedRoute.geometry) {
      var gAdmin = normalizeLineStringGeometry(booking.adminCalculatedRoute.geometry);
      if (gAdmin) return { geometry: gAdmin, meta: booking.adminCalculatedRoute, source: 'booking.adminCalculatedRoute' };
    }
    return null;
  }

  function normalizeCustomerServiceRoute(booking, formState) {
    var picked = pickCustomerGeometry(booking, formState);
    if (!picked) return null;
    var metrics = getRouteMetrics({
      routeType: ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE,
      geometry: picked.geometry,
      distanceKm: isObject(booking) && booking.customerServiceRoute && booking.customerServiceRoute.distanceKm != null
        ? booking.customerServiceRoute.distanceKm
        : null,
      averageSpeedKmh: (formState && formState.averageSpeedKmh) || (booking && booking.averageSpeedKmh) || null,
      consumptionLitresPer100Km: formState && formState.consumptionLitresPer100Km,
      fuelPricePerLitre: formState && formState.fuelPricePerLitre,
      calculationSource: picked.source
    });
    var isMock = !!(booking && booking.isMock) || (picked.source && /mock/i.test(String(picked.source)));
    return {
      routeType: ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE,
      routeTypeLabel: ROUTE_TYPE_LABELS.CUSTOMER_SERVICE_ROUTE,
      geometry: picked.geometry,
      source: picked.source,
      legacySource: picked.source,
      isMock: isMock,
      metrics: metrics,
      popup: {
        routeType: ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE,
        routeTypeLabel: ROUTE_TYPE_LABELS.CUSTOMER_SERVICE_ROUTE,
        distanceKm: metrics.distanceKm,
        estimatedDurationMinutes: metrics.estimatedDurationMinutes,
        source: picked.source,
        bookingId: booking && booking.id,
        averageSpeedKmh: metrics.averageSpeedKmh,
        consumptionLitresPer100Km: metrics.consumptionLitresPer100Km,
        estimatedFuelLitres: metrics.estimatedFuelLitres,
        estimatedFuelCost: metrics.estimatedFuelCost,
        calculationSource: metrics.calculationSource,
        isMock: isMock
      }
    };
  }

  function normalizeTransferRoute(booking, formState, calculatedState) {
    var picked = pickTransferGeometry(booking, formState, calculatedState);
    if (!picked) return null;
    var meta = picked.meta || {};
    var isAdminCalculatedRoute = isAdminCalculatedRouteSource(picked.source);
    var latestDepartureLabel = resolveLatestDepartureLabel(meta);
    var metrics = getRouteMetrics({
      routeType: ROUTE_TYPE.TRANSFER_ROUTE,
      geometry: picked.geometry,
      distanceKm: meta.distanceKm != null ? meta.distanceKm : null,
      averageSpeedKmh: meta.speedKmh || meta.averageSpeedKmh || (formState && formState.averageSpeedKmh) || null,
      travelMinutes: meta.travelMinutes,
      consumptionLitresPer100Km: formState && formState.consumptionLitresPer100Km,
      fuelPricePerLitre: formState && formState.fuelPricePerLitre,
      calculationSource: picked.source,
      provider: meta.routingProvider || meta.provider,
      fallbackUsed: meta.fallbackUsed
    });
    var isMock = !!(meta.isMock || meta.isMockRun || (booking && booking.isMock) || (picked.source && /mock/i.test(String(picked.source))));
    return {
      routeType: ROUTE_TYPE.TRANSFER_ROUTE,
      routeTypeLabel: ROUTE_TYPE_LABELS.TRANSFER_ROUTE,
      geometry: picked.geometry,
      source: picked.source,
      originType: meta.originType || null,
      originId: meta.originId || meta.fromDepotId || null,
      originLabel: meta.fromName || meta.originName || meta.originLabel || null,
      originBookingId: meta.originBookingId || meta.previousProjectId || null,
      originProjectName: meta.originProjectName || meta.originName || null,
      targetId: booking && booking.id,
      provider: meta.routingProvider || meta.provider || null,
      fallbackUsed: !!meta.fallbackUsed,
      assignedAt: meta.assignedAt || meta.calculatedAt || null,
      preparationBufferMinutes: meta.preparationBufferMinutes != null ? meta.preparationBufferMinutes : null,
      latestDepartureLabel: latestDepartureLabel,
      dataQuality: meta.dataQuality != null ? meta.dataQuality : null,
      dataQualityLabel: meta.dataQualityLabel != null ? meta.dataQualityLabel : null,
      isAdminCalculatedRoute: isAdminCalculatedRoute,
      transitionWindowMinutes: meta.transitionWindowMinutes != null ? meta.transitionWindowMinutes : meta.gapMinutes,
      availableTransitionMinutes: meta.availableTransitionMinutes != null ? meta.availableTransitionMinutes : meta.gapMinutes,
      transferTravelMinutes: meta.transferTravelMinutes != null ? meta.transferTravelMinutes : meta.travelMinutes,
      feasible: meta.feasible != null ? meta.feasible : null,
      isMock: isMock,
      metrics: metrics,
      popup: {
        routeType: ROUTE_TYPE.TRANSFER_ROUTE,
        routeTypeLabel: ROUTE_TYPE_LABELS.TRANSFER_ROUTE,
        originType: meta.originType || null,
        originId: meta.originId || null,
        originLabel: meta.fromName || meta.originName || meta.originLabel || null,
        targetId: booking && booking.id,
        distanceKm: metrics.distanceKm,
        estimatedDurationMinutes: metrics.estimatedDurationMinutes,
        provider: meta.routingProvider || meta.provider || null,
        fallbackUsed: !!meta.fallbackUsed,
        assignedAt: meta.assignedAt || meta.calculatedAt || null,
        averageSpeedKmh: metrics.averageSpeedKmh,
        consumptionLitresPer100Km: metrics.consumptionLitresPer100Km,
        estimatedFuelLitres: metrics.estimatedFuelLitres,
        estimatedFuelCost: metrics.estimatedFuelCost,
        preparationBufferMinutes: meta.preparationBufferMinutes != null ? meta.preparationBufferMinutes : null,
        latestDepartureLabel: latestDepartureLabel,
        dataQuality: meta.dataQuality != null ? meta.dataQuality : null,
        dataQualityLabel: meta.dataQualityLabel != null ? meta.dataQualityLabel : null,
        isAdminCalculatedRoute: isAdminCalculatedRoute,
        transitionWindowMinutes: meta.transitionWindowMinutes != null ? meta.transitionWindowMinutes : meta.gapMinutes,
        availableTransitionMinutes: meta.availableTransitionMinutes != null ? meta.availableTransitionMinutes : meta.gapMinutes,
        transferTravelMinutes: meta.transferTravelMinutes != null ? meta.transferTravelMinutes : meta.travelMinutes,
        feasible: meta.feasible != null ? meta.feasible : null,
        calculationSource: metrics.calculationSource,
        isMock: isMock
      }
    };
  }

  function getRouteTypeLabel(routeType) {
    return ROUTE_TYPE_LABELS[routeType] || routeType || '—';
  }

  function getRouteMetrics(route) {
    route = route || {};
    var distanceKm = route.distanceKm != null ? Number(route.distanceKm) : lineLengthKmFromGeometry(route.geometry);
    if (distanceKm != null && !isFinite(distanceKm)) distanceKm = null;
    var averageSpeedKmh = route.averageSpeedKmh != null && Number(route.averageSpeedKmh) > 0
      ? Number(route.averageSpeedKmh) : null;
    var estimatedDurationMinutes = route.travelMinutes != null && isFinite(route.travelMinutes)
      ? Math.round(Number(route.travelMinutes))
      : (distanceKm != null && averageSpeedKmh
        ? Math.round((distanceKm / averageSpeedKmh) * 60)
        : null);
    var consumption = route.consumptionLitresPer100Km != null && Number(route.consumptionLitresPer100Km) > 0
      ? Number(route.consumptionLitresPer100Km) : null;
    var fuelPrice = route.fuelPricePerLitre != null && Number(route.fuelPricePerLitre) > 0
      ? Number(route.fuelPricePerLitre) : null;
    var estimatedFuelLitres = (distanceKm != null && consumption != null)
      ? Math.round((distanceKm / 100 * consumption) * 10) / 10
      : null;
    var estimatedFuelCost = (estimatedFuelLitres != null && fuelPrice != null)
      ? Math.round(estimatedFuelLitres * fuelPrice)
      : null;
    return {
      distanceKm: distanceKm,
      estimatedDurationMinutes: estimatedDurationMinutes,
      averageSpeedKmh: averageSpeedKmh,
      consumptionLitresPer100Km: consumption,
      estimatedFuelLitres: estimatedFuelLitres,
      fuelPricePerLitre: fuelPrice,
      estimatedFuelCost: estimatedFuelCost,
      calculationSource: route.calculationSource || null,
      calculatedAt: route.calculatedAt || new Date().toISOString(),
      fuelParameterized: consumption != null && fuelPrice != null
    };
  }

  function exportFilename(bookingId, routeType, options) {
    options = options || {};
    var utils = dl();
    var sanitize = utils ? utils.sanitizeFilenameSegment.bind(utils) : function (v, fb) {
      return String(v || fb || 'booking').replace(/[^\w.-]+/g, '_');
    };
    var sanitizeOrigin = utils ? utils.sanitizeOriginLabelForFilename.bind(utils) : function (v) {
      return String(v || '').replace(/[^\w.-]+/g, '_');
    };
    var ensureExt = utils ? utils.ensureGeoJsonExtension.bind(utils) : function (n) { return n; };
    var bid = sanitize(bookingId, 'booking') || 'booking';
    if (routeType === ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE) {
      return ensureExt('customer-route_' + bid);
    }
    var origin = sanitizeOrigin(options.originLabel);
    if (origin) {
      return ensureExt('transfer-route_' + bid + '_' + origin);
    }
    return ensureExt('transfer-route_' + bid);
  }

  function buildRouteGeoJsonFeatureCollection(routeType, route, booking) {
    var feature = buildRouteGeoJsonFeature(routeType, route, booking);
    if (!feature) return null;
    return { type: 'FeatureCollection', features: [feature] };
  }

  function downloadRouteGeoJson(routeType, route, booking, options) {
    var fc = buildRouteGeoJsonFeatureCollection(routeType, route, booking);
    if (!fc) return false;
    var utils = dl();
    if (!utils || !utils.downloadJsonBlob) return false;
    var filename = exportFilename(booking && booking.id, routeType, {
      originLabel: (options && options.originLabel) || (route && route.originLabel) || null
    });
    return utils.downloadJsonBlob(filename, fc);
  }

  function extractRouteTypeFromGeoJson(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.properties && data.properties.routeType) return data.properties.routeType;
    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      for (var i = 0; i < data.features.length; i++) {
        var f = data.features[i];
        if (f && f.properties && f.properties.routeType) return f.properties.routeType;
      }
    }
    return null;
  }

  function isCustomerRouteGeoJsonImportAllowed(data) {
    var routeType = extractRouteTypeFromGeoJson(data);
    if (!routeType) return true;
    return routeType === ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE;
  }

  function buildRouteGeoJsonFeature(routeType, route, booking) {
    if (!route || !route.geometry) return null;
    var metrics = route.metrics || getRouteMetrics(route);
    var endpoints = lineEndpoints(route.geometry);
    return {
      type: 'Feature',
      geometry: route.geometry,
      properties: {
        bookingId: booking && booking.id,
        routeType: routeType,
        routeTypeLabel: getRouteTypeLabel(routeType),
        source: route.source || null,
        originType: route.originType || null,
        originId: route.originId || null,
        originLabel: route.originLabel || null,
        targetId: booking && booking.id,
        distanceKm: metrics.distanceKm,
        estimatedDurationMinutes: metrics.estimatedDurationMinutes,
        averageSpeedKmh: metrics.averageSpeedKmh,
        consumptionLitresPer100Km: metrics.consumptionLitresPer100Km,
        estimatedFuelLitres: metrics.estimatedFuelLitres,
        fuelPricePerLitre: metrics.fuelPricePerLitre,
        estimatedFuelCost: metrics.estimatedFuelCost,
        provider: route.provider || null,
        fallbackUsed: route.fallbackUsed != null ? route.fallbackUsed : null,
        isMock: !!(route.isMock || route.isMockRun),
        isMockRun: !!(route.isMock || route.isMockRun),
        exportedAt: new Date().toISOString(),
        startPoint: endpoints.start,
        endPoint: endpoints.end
      }
    };
  }

  function buildDriverRouteTaskPayload(routeType, route, booking) {
    if (!route || !route.geometry) return null;
    var metrics = route.metrics || getRouteMetrics(route);
    var endpoints = lineEndpoints(route.geometry);
    var taskType = routeType === ROUTE_TYPE.TRANSFER_ROUTE ? 'TRANSFER_TASK' : 'CUSTOMER_SERVICE_TASK';
    return {
      taskType: taskType,
      routeType: routeType,
      bookingId: booking && booking.id,
      routeGeometry: route.geometry,
      distanceKm: metrics.distanceKm,
      estimatedDurationMinutes: metrics.estimatedDurationMinutes,
      startPoint: endpoints.start,
      endPoint: endpoints.end,
      originType: route.originType || null,
      originId: route.originId || null,
      title: getRouteTypeLabel(routeType),
      instructions: routeType === ROUTE_TYPE.TRANSFER_ROUTE
        ? 'Odaallasi utvonal - admin altal kivalasztott'
        : 'Megrendeloi szolgaltatasi utvonal',
      isMock: !!(route.isMock || route.isMockRun),
      generatedAt: new Date().toISOString()
    };
  }

  function bookingMarkerPosition(booking, customerRoute, transferRoute) {
    if (booking && booking.lat != null && booking.lng != null) {
      var lat = Number(booking.lat);
      var lng = Number(booking.lng);
      if (isFinite(lat) && isFinite(lng)) return { lat: lat, lng: lng };
    }
    if (customerRoute && customerRoute.geometry) {
      var cEnd = lineEndpoints(customerRoute.geometry).end;
      if (cEnd) return cEnd;
    }
    if (transferRoute && transferRoute.geometry) {
      var tEnd = lineEndpoints(transferRoute.geometry).end;
      if (tEnd) return tEnd;
    }
    return null;
  }

  var api = {
    ROUTE_TYPE: ROUTE_TYPE,
    ROUTE_TYPE_LABELS: ROUTE_TYPE_LABELS,
    normalizeLineStringGeometry: normalizeLineStringGeometry,
    lineLengthKmFromGeometry: lineLengthKmFromGeometry,
    normalizeCustomerServiceRoute: normalizeCustomerServiceRoute,
    isAdminCalculatedRouteSource: isAdminCalculatedRouteSource,
    mapSuggestedDepartureToLatestDepartureLabel: mapSuggestedDepartureToLatestDepartureLabel,
    resolveLatestDepartureLabel: resolveLatestDepartureLabel,
    normalizeTransferRoute: normalizeTransferRoute,
    getRouteTypeLabel: getRouteTypeLabel,
    getRouteMetrics: getRouteMetrics,
    buildRouteGeoJsonFeature: buildRouteGeoJsonFeature,
    buildRouteGeoJsonFeatureCollection: buildRouteGeoJsonFeatureCollection,
    downloadRouteGeoJson: downloadRouteGeoJson,
    extractRouteTypeFromGeoJson: extractRouteTypeFromGeoJson,
    isCustomerRouteGeoJsonImportAllowed: isCustomerRouteGeoJsonImportAllowed,
    buildDriverRouteTaskPayload: buildDriverRouteTaskPayload,
    exportFilename: exportFilename,
    bookingMarkerPosition: bookingMarkerPosition,
    lineEndpoints: lineEndpoints
  };

  global.RouteTypeAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
