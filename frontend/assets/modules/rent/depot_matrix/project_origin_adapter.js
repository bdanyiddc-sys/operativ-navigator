(function (global) {
  'use strict';

  var CFG = global.DEPOT_MATRIX_CONFIG || {};
  var Adapter = global.DepotMatrixAdapter;

  function norm() { return global.AdvisorCandidateNormalizer; }
  function ota() { return global.OperationalTrainAdapter; }
  var ACCEPTABLE_STATUSES = { MEGRENDELVE: true, TELJESITVE: true };

  function parseProjectDateTime(dateStr, timeStr) {
    if (!dateStr) return null;
    var parts = String(dateStr).split('-');
    if (parts.length < 3) return null;
    var t = String(timeStr || '00:00').split(':');
    return new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10),
      parseInt(t[0], 10) || 0,
      parseInt(t[1], 10) || 0,
      0,
      0
    );
  }

  function computePreviousEnd(previous) {
    var start = parseProjectDateTime(previous.date, previous.timeStart);
    var end = parseProjectDateTime(previous.date, previous.timeEnd);
    if (!start || !end) return null;
    if (end.getTime() <= start.getTime()) {
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }
    return end;
  }

  function computeTargetStart(target) {
    return parseProjectDateTime(target.date, target.timeStart);
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

  function hasValidCoords(project) {
    var lat = project && project.lat != null ? Number(project.lat) : NaN;
    var lng = project && project.lng != null ? Number(project.lng) : NaN;
    return isFinite(lat) && isFinite(lng);
  }

  function projectsOverlap(a, b) {
    var aStart = parseProjectDateTime(a.date, a.timeStart);
    var aEnd = computePreviousEnd(a);
    var bStart = parseProjectDateTime(b.date, b.timeStart);
    var bEnd = computePreviousEnd(b);
    if (!aStart || !aEnd || !bStart || !bEnd) return false;
    return aStart < bEnd && bStart < aEnd;
  }

  function getWindowHours(options) {
    var h = options && options.windowHours != null
      ? options.windowHours
      : (CFG.advisorPreviousProjectWindowHours != null ? CFG.advisorPreviousProjectWindowHours : 24);
    h = Number(h);
    if (isNaN(h)) h = 24;
    return Math.max(1, Math.min(72, h));
  }

  function getWindowMinutes(options) {
    return getWindowHours(options) * 60;
  }

  function exclusionLabelFromReasons(reasons) {
    var N = norm();
    var labels = N && N.EXCLUSION_LABELS ? N.EXCLUSION_LABELS : {};
    return (reasons || []).filter(function (r) { return r !== 'ELIGIBLE'; })
      .map(function (r) { return labels[r] || r; }).join(' ') || (labels.ELIGIBLE || 'Jogosult');
  }

  function humanPreviousProjectName(previous) {
    var vehicle = previous.vehicle || '—';
    var place = previous.city || previous.placeName || previous.address || '—';
    var end = computePreviousEnd(previous);
    var time = end && norm() && norm().formatHuDateTime ? norm().formatHuDateTime(end) : '—';
    return vehicle + ' · ' + place + ' · ' + time;
  }

  function findNearestDepotDistance(depots, lat, lng, targetLat, targetLng) {
    var best = null;
    (depots || []).forEach(function (d) {
      if (d.lat == null || d.lng == null) return;
      var toTarget = haversineKm(d.lat, d.lng, targetLat, targetLng);
      if (!best || toTarget < best.toTarget) {
        best = { depotId: d.id, depotName: d.name, toTarget: toTarget };
      }
    });
    return best;
  }

  function findActualClosureForBooking(events, bookingId, vehicleId) {
    var OTA = ota();
    if (!OTA || !OTA.buildActualClosures) return null;
    var closures = OTA.buildActualClosures(events || []);
    var match = closures.find(function (c) {
      return bookingId && c.bookingId && String(c.bookingId) === String(bookingId);
    });
    if (match) return match;
    if (!vehicleId) return null;
    var byVehicle = closures.filter(function (c) {
      return c.vehicleId && String(c.vehicleId).toUpperCase() === String(vehicleId).toUpperCase();
    });
    if (!byVehicle.length) return null;
    byVehicle.sort(function (a, b) { return b.endedAt - a.endedAt; });
    return byVehicle[0];
  }

  function evaluatePreviousProject(previous, target, options) {
    options = options || {};
    var speedKmh = options.speedKmh || CFG.configuredSpeedKmh || 30;
    var bufferMinutes = options.bufferMinutes != null
      ? options.bufferMinutes
      : (CFG.preparationBufferMinutes || 30);
    var windowMinutes = getWindowMinutes(options);
    var windowHours = getWindowHours(options);
    var reasons = [];
    var targetStart = computeTargetStart(target);
    var previousEnd = computePreviousEnd(previous);
    var gapMinutes = null;

    if (!target || !targetStart) reasons.push('NO_TARGET');
    if (!previousEnd) reasons.push('NO_PLANNED_END');
    if (!hasValidCoords(previous)) reasons.push('NO_COORDS');
    if (!previous.vehicle) reasons.push('NO_VEHICLE');
    if (norm() && norm().isTestInquiry(previous)) reasons.push('TEST_RECORD');
    if (previous.id && target && String(previous.id) === String(target.id)) reasons.push('SAME_BOOKING');
    if (projectsOverlap(previous, target)) reasons.push('OVERLAP');

    var st = String(previous.status || '').toUpperCase();
    if (st === 'LEMONDVA' || st === 'ARAJANLATKERES') reasons.push('WRONG_STATUS');
    else if (!ACCEPTABLE_STATUSES[st]) reasons.push('WRONG_STATUS');

    if (previousEnd && targetStart) {
      gapMinutes = Math.round((targetStart.getTime() - previousEnd.getTime()) / 60000);
      if (gapMinutes <= 0) reasons.push('TARGET_BEFORE_END');
      else if (gapMinutes > windowMinutes) reasons.push('OUTSIDE_WINDOW');
    }

    var distanceKm = null;
    var travelMinutes = null;
    var feasible = false;
    if (hasValidCoords(previous) && target && target.lat != null && target.lng != null) {
      distanceKm = Math.round(haversineKm(previous.lat, previous.lng, target.lat, target.lng) * 10) / 10;
      travelMinutes = Adapter
        ? Adapter.kisvonatTravelMinutes(distanceKm, speedKmh)
        : Math.round((distanceKm / speedKmh) * 60);
      if (gapMinutes != null && gapMinutes > 0 && travelMinutes != null) {
        feasible = (travelMinutes + bufferMinutes) <= gapMinutes;
        if (!feasible) reasons.push('INFEASIBLE');
      }
    }

    var eligible = reasons.filter(function (r) { return r !== 'ELIGIBLE'; }).length === 0;
    if (eligible) reasons.push('ELIGIBLE');

    var previousVehicle = previous.vehicle || null;
    var targetVehicle = target.vehicle || null;
    var sameVehicle = !!(previousVehicle && targetVehicle && previousVehicle === targetVehicle);
    var depAt = feasible && targetStart && travelMinutes != null
      ? new Date(targetStart.getTime() - (travelMinutes + bufferMinutes) * 60000)
      : null;

    var depotAlt = (options.depots && target)
      ? findNearestDepotDistance(options.depots, previous.lat, previous.lng, target.lat, target.lng)
      : null;
    var depotAlternativeDistanceKm = depotAlt ? Math.round(depotAlt.toTarget * 10) / 10 : null;
    var savedDistanceKm = depotAlternativeDistanceKm != null && distanceKm != null
      ? Math.round((depotAlternativeDistanceKm - distanceKm) * 10) / 10
      : null;

    return {
      originType: 'PREVIOUS_PROJECT',
      originId: previous.id,
      normalizedCandidateId: 'prev:' + previous.id,
      originName: previous.placeName || previous.address || previous.id,
      humanDisplayName: humanPreviousProjectName(previous),
      lat: Number(previous.lat),
      lng: Number(previous.lng),
      distanceKm: distanceKm,
      trainTravelMinutes: travelMinutes,
      transferTravelMinutes: travelMinutes,
      preparationBufferMinutes: bufferMinutes,
      latestDeparture: depAt,
      latestDepartureLabel: depAt
        ? String(depAt.getHours()).padStart(2, '0') + ':' + String(depAt.getMinutes()).padStart(2, '0')
        : '—',
      feasible: feasible,
      eligible: eligible,
      provider: 'planned-previous-project',
      isMockRun: false,
      isTestRecord: norm() && norm().isTestInquiry(previous),
      warning: null,
      previousProjectId: previous.id,
      previousProjectEnd: previousEnd,
      previousProjectEndLabel: previousEnd && norm() && norm().formatHuDateTime
        ? norm().formatHuDateTime(previousEnd)
        : (previous.date + ' ' + String(previous.timeEnd || '').slice(0, 5)),
      gapMinutes: gapMinutes,
      gapHours: gapMinutes != null ? Math.round((gapMinutes / 60) * 10) / 10 : null,
      transitionWindowMinutes: windowMinutes,
      transitionWindowHours: windowHours,
      availableTransitionMinutes: gapMinutes,
      originBookingId: previous.id,
      originProjectName: previous.placeName || previous.address || previous.id,
      previousProjectEndAt: previousEnd ? previousEnd.toISOString() : null,
      nextProjectStartAt: targetStart ? targetStart.toISOString() : null,
      nextProjectStartLabel: targetStart && norm() && norm().formatHuDateTime
        ? norm().formatHuDateTime(targetStart)
        : '—',
      previousVehicle: previousVehicle,
      originVehicleId: previousVehicle,
      targetVehicle: targetVehicle,
      sameVehicle: sameVehicle,
      vehicleSuggestionOnly: !targetVehicle && !!previousVehicle,
      exclusionReasons: reasons,
      exclusionLabel: eligible ? (norm() && norm().EXCLUSION_LABELS ? norm().EXCLUSION_LABELS.ELIGIBLE : 'Jogosult') : exclusionLabelFromReasons(reasons),
      targetLabel: target ? (target.placeName || target.address || target.id) : '—',
      targetBookingId: target && target.id,
      originEndLocation: previous.city || previous.placeName || previous.address || '—',
      originEndAt: previousEnd ? previousEnd.toISOString() : null,
      dataQuality: 'PLANNED_PREVIOUS_PROJECT',
      dataQualityLabel: 'TERVEZETT ELŐZŐ PROJEKT',
      withinWindow: gapMinutes != null && gapMinutes > 0 && gapMinutes <= windowMinutes,
      depotAlternativeDistanceKm: depotAlternativeDistanceKm,
      depotAlternativeName: depotAlt ? depotAlt.depotName : null,
      savedDistanceKm: savedDistanceKm,
      routingBinding: {
        targetBookingId: target && target.id,
        normalizedCandidateId: 'prev:' + previous.id,
        originLat: previous.lat,
        originLng: previous.lng,
        targetLat: target && target.lat,
        targetLng: target && target.lng
      },
      inquiry: previous
    };
  }

  function dedupePreviousOrigins(origins) {
    var bestByVehicle = {};
    var duplicatesRemoved = 0;
    origins.forEach(function (o) {
      var key = o.originVehicleId
        ? 'vehicle:' + String(o.originVehicleId).toUpperCase()
        : 'booking:' + o.originBookingId;
      var existing = bestByVehicle[key];
      if (!existing) {
        bestByVehicle[key] = o;
        return;
      }
      duplicatesRemoved += 1;
      var keep = o;
      var drop = existing;
      if (existing.eligible && !o.eligible) { keep = existing; drop = o; }
      else if (!existing.eligible && o.eligible) { keep = o; drop = existing; }
      else {
        var aEnd = existing.previousProjectEnd ? existing.previousProjectEnd.getTime() : 0;
        var bEnd = o.previousProjectEnd ? o.previousProjectEnd.getTime() : 0;
        keep = bEnd >= aEnd ? o : existing;
        drop = keep === o ? existing : o;
      }
      drop.eligible = false;
      drop.exclusionReasons = (drop.exclusionReasons || []).concat(['DUPLICATE']);
      drop.exclusionLabel = norm() && norm().EXCLUSION_LABELS ? norm().EXCLUSION_LABELS.DUPLICATE : 'Duplikált';
      bestByVehicle[key] = keep;
    });
    return {
      origins: Object.keys(bestByVehicle).map(function (k) { return bestByVehicle[k]; }),
      duplicatesRemoved: duplicatesRemoved
    };
  }

  function enrichWithOperationalControl(origins, events) {
    if (!events || !events.length) return;
    origins.forEach(function (o) {
      var actual = findActualClosureForBooking(events, o.originBookingId, o.originVehicleId);
      if (!actual || !actual.endedAt || !o.previousProjectEnd) return;
      var deltaMin = Math.round((actual.endedAt.getTime() - o.previousProjectEnd.getTime()) / 60000);
      o.operationalControlNote = 'Terv–tény: tényleges lezárás ' +
        (deltaMin === 0 ? 'egyezik a tervvel' : (deltaMin > 0 ? '+' + deltaMin + ' perc késés' : deltaMin + ' perc korábban'));
      o.planVsActualDeltaMinutes = deltaMin;
      o.actualEndAt = actual.endedAt.toISOString();
    });
  }

  function evaluateAllPreviousProjects(inquiries, target, options) {
    options = options || {};
    var windowHours = getWindowHours(options);
    var windowMinutes = getWindowMinutes(options);
    var raw = (inquiries || []).filter(function (p) {
      return target && String(p.id) !== String(target.id);
    });
    var evaluated = raw.map(function (p) {
      return evaluatePreviousProject(p, target, options);
    });
    var deduped = dedupePreviousOrigins(evaluated);
    var origins = deduped.origins;
    enrichWithOperationalControl(origins, options.operationalEvents);

    var exclusionCounts = {};
    origins.forEach(function (o) {
      (o.exclusionReasons || []).forEach(function (r) {
        if (r === 'ELIGIBLE') return;
        exclusionCounts[r] = (exclusionCounts[r] || 0) + 1;
      });
    });

    var withinWindow = origins.filter(function (o) { return o.withinWindow; });
    var eligible = origins.filter(function (o) { return o.eligible; });
    var outsideWindow = origins.filter(function (o) {
      return (o.exclusionReasons || []).indexOf('OUTSIDE_WINDOW') >= 0;
    });

    var nearby0711 = origins.find(function (o) { return o.originBookingId === 'RENT-2025-0004'; }) || null;

    return {
      origins: origins,
      audit: {
        previousProjectsChecked: raw.length,
        normalizedCandidateCount: origins.length,
        rawCandidateCount: raw.length,
        duplicatesRemoved: deduped.duplicatesRemoved,
        duplicateVehicleCount: 0,
        withinWindowCount: withinWindow.length,
        eligiblePreviousProjects: eligible.length,
        excludedOutsideWindow: outsideWindow.length,
        excludedNoVehicle: origins.filter(function (o) { return (o.exclusionReasons || []).indexOf('NO_VEHICLE') >= 0; }).length,
        excludedNoCoords: origins.filter(function (o) { return (o.exclusionReasons || []).indexOf('NO_COORDS') >= 0; }).length,
        excludedOverlap: origins.filter(function (o) { return (o.exclusionReasons || []).indexOf('OVERLAP') >= 0; }).length,
        excludedNotFeasible: origins.filter(function (o) { return (o.exclusionReasons || []).indexOf('INFEASIBLE') >= 0; }).length,
        transitionWindowHours: windowHours,
        transitionWindowMinutes: windowMinutes,
        exclusionCounts: exclusionCounts,
        advisorStateConsistent: true,
        nearby0711Audit: nearby0711 ? {
          bookingId: nearby0711.originBookingId,
          eligible: nearby0711.eligible,
          gapHours: nearby0711.gapHours,
          exclusionReasons: nearby0711.exclusionReasons,
          exclusionLabel: nearby0711.exclusionLabel
        } : null,
        testRecordsFound: origins.filter(function (o) { return o.isTestRecord; }).length
      }
    };
  }

  function isEligiblePreviousProject(previous, target, options) {
    return evaluatePreviousProject(previous, target, options).eligible;
  }

  function filterPreviousProjectOrigins(previousProjects, targetProject, options) {
    return evaluateAllPreviousProjects(previousProjects, targetProject, options).origins
      .filter(function (o) { return o.eligible; });
  }

  function buildPreviousProjectOrigin(previous, target, options) {
    return evaluatePreviousProject(previous, target, options);
  }

  function depotRowToOrigin(row) {
    return {
      originType: 'DEPOT',
      originId: row.depotId,
      normalizedCandidateId: 'depot:' + row.depotId,
      originName: row.depotName,
      humanDisplayName: row.depotName,
      lat: null,
      lng: null,
      distanceKm: row.distanceKm,
      trainTravelMinutes: row.trainTravelMinutes,
      transferTravelMinutes: row.trainTravelMinutes,
      preparationBufferMinutes: row.preparationBufferMinutes,
      latestDeparture: row.latestDeparture,
      latestDepartureLabel: row.latestDepartureLabel,
      feasible: row.timeFeasible,
      eligible: row.candidateEligible != null ? row.candidateEligible : (row.timeFeasible != null ? row.timeFeasible : row.routable),
      candidateEligible: row.candidateEligible != null ? row.candidateEligible : (row.timeFeasible != null ? row.timeFeasible : row.routable),
      safeRouteGeometryAvailable: row.safeRouteGeometryAvailable === true,
      provider: row.provider,
      isMockRun: row.provider === 'mock',
      warning: row.warning,
      routable: row.routable,
      depotId: row.depotId,
      depotName: row.depotName,
      routingBinding: row.routingBinding || null
    };
  }

  function rankUnifiedOrigins(origins) {
    return origins.slice();
  }

  function suppressPreviousWhenActualTrainExists(deployableOrigins, previousOrigins) {
    var actualByVehicle = {};
    (deployableOrigins || []).forEach(function (o) {
      if (o.originType !== 'DEPLOYABLE_TRAIN' || o.dataQuality !== 'ACTUAL') return;
      var vid = o.originVehicleId || o.previousVehicle || o.vehicleId;
      if (vid) actualByVehicle[String(vid).toUpperCase()] = true;
    });
    return (previousOrigins || []).map(function (o) {
      var vid = o.originVehicleId || o.previousVehicle;
      if (!vid || !actualByVehicle[String(vid).toUpperCase()]) return o;
      var reasons = (o.exclusionReasons || []).filter(function (r) { return r !== 'ELIGIBLE'; });
      if (reasons.indexOf('DUPLICATE') < 0) reasons.push('DUPLICATE');
      return Object.assign({}, o, {
        eligible: false,
        exclusionReasons: reasons,
        exclusionLabel: exclusionLabelFromReasons(reasons)
      });
    });
  }

  function mergeDeployableAudit(previousAudit, deployableAudit, depotCount) {
    var prev = previousAudit || {};
    var dep = deployableAudit || {};
    var sources = dep.sources || {};
    var exclusionCounts = Object.assign({}, prev.exclusionCounts || {}, dep.exclusionCounts || {});
    var actualAll = (dep.candidates || []).filter(function (c) { return c.dataQuality === 'ACTUAL'; });
    var actualEligible = actualAll.filter(function (c) { return c.eligible; });
    var actualExcluded = actualAll.length - actualEligible.length;
    return Object.assign({}, prev, {
      rawEndedEventCount: (sources.tripEndCount || 0) + (sources.shiftEndCount || 0),
      deployableTrainAudit: dep,
      normalizedActualTrainCount: actualAll.length,
      eligibleActualTrains: actualEligible.length,
      excludedActualTrainCount: actualExcluded,
      eligiblePlannedFallback: dep.eligiblePlannedFallback || 0,
      plannedFallbackCandidates: dep.plannedFallbackCandidates || 0,
      deployableDuplicatesRemoved: dep.duplicatesRemoved || 0,
      duplicateVehicleCount: dep.duplicateVehicleCount || 0,
      depotCount: depotCount,
      deployableEventCount: sources.events || 0,
      tripEndCount: sources.tripEndCount || 0,
      shiftEndCount: sources.shiftEndCount || 0
    });
  }

  function buildUnifiedOrigins(depotRows, previousProjects, targetProject, options) {
    options = options || {};
    var depotsById = {};
    (options.depots || []).forEach(function (d) { depotsById[d.id] = d; });
    var depotOrigins = (depotRows || []).map(function (row) {
      var o = depotRowToOrigin(row);
      var d = depotsById[row.depotId];
      if (d) {
        o.lat = d.lat;
        o.lng = d.lng;
      }
      return o;
    });

    var evaluatedPack = options.evaluatedPreviousPack
      ? options.evaluatedPreviousPack
      : evaluateAllPreviousProjects(previousProjects, targetProject, Object.assign({}, options, {
        operationalEvents: options.operationalEvents
      }));
    var previousOrigins = evaluatedPack.origins || [];

    var deployablePack = null;
    var deployableOrigins = [];
    var OTA = ota();
    if (OTA && OTA.buildDeployableOrigins && options.operationalEvents) {
      var windowMinutes = getWindowMinutes(options);
      deployablePack = OTA.buildDeployableOrigins(
        previousProjects,
        options.operationalEvents,
        targetProject,
        {
          speedKmh: options.speedKmh,
          bufferMinutes: options.bufferMinutes,
          windowMinutes: windowMinutes,
          evaluationTime: options.evaluationTime
        }
      );
      deployableOrigins = deployablePack.origins || [];
    }

    var mergedPrevious = suppressPreviousWhenActualTrainExists(deployableOrigins, previousOrigins);
    var all = deployableOrigins.concat(mergedPrevious).concat(depotOrigins);
    var mergedAudit = mergeDeployableAudit(
      evaluatedPack.audit,
      deployablePack ? deployablePack.audit : null,
      depotOrigins.length
    );

    return {
      targetProject: targetProject,
      origins: rankUnifiedOrigins(all),
      previousProjectCount: mergedPrevious.length,
      deployableTrainCount: deployableOrigins.length,
      depotCount: depotOrigins.length,
      deployableAudit: mergedAudit,
      evaluatedPreviousPack: evaluatedPack,
      evaluatedDeployablePack: deployablePack,
      isMockRun: false
    };
  }

  var api = {
    getWindowHours: getWindowHours,
    getWindowMinutes: getWindowMinutes,
    parseProjectDateTime: parseProjectDateTime,
    computePreviousEnd: computePreviousEnd,
    computeTargetStart: computeTargetStart,
    haversineKm: haversineKm,
    isEligiblePreviousProject: isEligiblePreviousProject,
    filterPreviousProjectOrigins: filterPreviousProjectOrigins,
    evaluatePreviousProject: evaluatePreviousProject,
    evaluateAllPreviousProjects: evaluateAllPreviousProjects,
    buildPreviousProjectOrigin: buildPreviousProjectOrigin,
    depotRowToOrigin: depotRowToOrigin,
    rankUnifiedOrigins: rankUnifiedOrigins,
    buildUnifiedOrigins: buildUnifiedOrigins,
    projectsOverlap: projectsOverlap
  };

  global.ProjectOriginAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
