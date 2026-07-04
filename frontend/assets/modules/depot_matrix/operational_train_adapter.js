(function (global) {
  'use strict';

  var CFG = global.DEPOT_MATRIX_CONFIG || {};
  var Origin = global.ProjectOriginAdapter;
  var Norm = global.AdvisorCandidateNormalizer;
  var MAX_GAP_MINUTES = 1440;
  var TRIP_END_TYPES = { trip_end: true, jarat_zaras: true };
  var TRIP_START_TYPES = { trip_start: true, muszak_inditas: true };
  var SHIFT_END_TYPES = { shift_end: true };

  function parseTs(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function resolveEvaluationTime(params) {
    var src = params && params.evaluationTime;
    if (!src && global.__DEPOT_ADVISOR_EVALUATION_TIME) {
      src = global.__DEPOT_ADVISOR_EVALUATION_TIME;
    }
    if (src) {
      var d = src instanceof Date ? src : new Date(src);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  function getClosurePositionMaxLagMinutes() {
    if (CFG.advisorClosurePositionMaxLagMinutes != null) {
      return Number(CFG.advisorClosurePositionMaxLagMinutes);
    }
    if (CFG.advisorPositionFreshnessMaxMinutes != null) {
      return Number(CFG.advisorPositionFreshnessMaxMinutes);
    }
    return 120;
  }

  function getOperationalPositionMaxAgeMinutes() {
    if (CFG.advisorOperationalPositionMaxAgeMinutes != null) {
      return Number(CFG.advisorOperationalPositionMaxAgeMinutes);
    }
    return 120;
  }

  function getDeploymentWindowMinutes(options) {
    if (options && options.windowMinutes != null) return Number(options.windowMinutes);
    var hours = CFG.advisorPreviousProjectWindowHours != null
      ? Number(CFG.advisorPreviousProjectWindowHours)
      : 24;
    if (isNaN(hours)) hours = 24;
    return hours * 60;
  }

  function resolveEventVehicleId(ev, tripStarts) {
    var p = ev.payload || ev;
    if (p.vehicle_id || ev.vehicle_id) {
      return String(p.vehicle_id || ev.vehicle_id).toUpperCase();
    }
    if (ev.shift) {
      var sv = parseShiftVehicleId(ev.shift);
      if (sv) return sv;
    }
    var trip = ev.trip != null ? String(ev.trip).trim() : '';
    if (trip && tripStarts && tripStarts[trip] && tripStarts[trip].vehicleId) {
      return String(tripStarts[trip].vehicleId).toUpperCase();
    }
    return null;
  }

  function hasLaterVehicleActivity(events, vehicleId, afterEndedAt, boundaryTime, tripStarts) {
    if (!vehicleId || !afterEndedAt || !events || !events.length) return false;
    var vid = String(vehicleId).toUpperCase();
    var afterMs = afterEndedAt.getTime();
    var beforeMs = boundaryTime ? boundaryTime.getTime() : Infinity;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var ts = parseTs(ev.timestamp || ev.created_at);
      if (!ts) continue;
      var t = ts.getTime();
      if (t <= afterMs || t >= beforeMs) continue;
      var evVid = resolveEventVehicleId(ev, tripStarts);
      if (!evVid || evVid !== vid) continue;
      var type = String(ev.type || '').toLowerCase();
      if (TRIP_START_TYPES[type] || TRIP_END_TYPES[type] || SHIFT_END_TYPES[type]
        || type === 'track' || type === 'shift_start') {
        return true;
      }
    }
    return false;
  }

  function parseShiftVehicleId(shift) {
    if (!shift) return null;
    var m = String(shift).match(/^shift_(KV\d+)_/i);
    return m ? m[1].toUpperCase() : null;
  }

  function resolveEndCoords(row) {
    if (!row) return { lat: null, lng: null };
    if (row.lat != null && row.lng != null) return { lat: Number(row.lat), lng: Number(row.lng) };
    if (row.end_lat != null && row.end_lng != null) return { lat: Number(row.end_lat), lng: Number(row.end_lng) };
    if (row.routeGeometry && row.routeGeometry.coordinates && row.routeGeometry.coordinates.length) {
      var c = row.routeGeometry.coordinates[row.routeGeometry.coordinates.length - 1];
      return { lat: Number(c[1]), lng: Number(c[0]) };
    }
    if (Array.isArray(row.routePoints) && row.routePoints.length) {
      var p = row.routePoints[row.routePoints.length - 1];
      if (p && p.lat != null && p.lng != null) return { lat: Number(p.lat), lng: Number(p.lng) };
    }
    return { lat: null, lng: null };
  }

  function buildTripStartIndex(events) {
    var byTrip = {};
    (events || []).forEach(function (ev) {
      var trip = ev.trip != null ? String(ev.trip).trim() : '';
      if (!trip) return;
      var type = String(ev.type || '').toLowerCase();
      if (!TRIP_START_TYPES[type]) return;
      var p = ev.payload || ev;
      byTrip[trip] = {
        tripId: trip,
        vehicleId: p.vehicle_id || ev.vehicle_id || null,
        startedAt: parseTs(ev.timestamp || ev.created_at),
        lat: ev.lat != null ? Number(ev.lat) : (p.lat != null ? Number(p.lat) : null),
        lng: ev.lng != null ? Number(ev.lng) : (p.lng != null ? Number(p.lng) : null)
      };
    });
    return byTrip;
  }

  function lastTrackBefore(events, tripId, endTs) {
    var best = null;
    (events || []).forEach(function (ev) {
      if (String(ev.trip || '').trim() !== tripId) return;
      if (String(ev.type || '').toLowerCase() !== 'track') return;
      var ts = parseTs(ev.timestamp || ev.created_at);
      if (!ts || (endTs && ts.getTime() > endTs.getTime())) return;
      if (!best || ts.getTime() > best.ts.getTime()) {
        best = {
          ts: ts,
          lat: ev.lat != null ? Number(ev.lat) : null,
          lng: ev.lng != null ? Number(ev.lng) : null,
          source: 'events.track'
        };
      }
    });
    return best;
  }

  function lastTrackBeforeShift(events, shiftId, endTs) {
    var best = null;
    (events || []).forEach(function (ev) {
      var evShift = ev.shift || (ev.payload && ev.payload.shift) || null;
      if (!shiftId || String(evShift || '') !== String(shiftId)) return;
      if (String(ev.type || '').toLowerCase() !== 'track') return;
      var ts = parseTs(ev.timestamp || ev.created_at);
      if (!ts || (endTs && ts.getTime() > endTs.getTime())) return;
      if (!best || ts.getTime() > best.ts.getTime()) {
        best = {
          ts: ts,
          lat: ev.lat != null ? Number(ev.lat) : null,
          lng: ev.lng != null ? Number(ev.lng) : null,
          source: 'events.track'
        };
      }
    });
    return best;
  }

  function buildActualClosures(events) {
    var tripStarts = buildTripStartIndex(events);
    var closures = [];
    (events || []).forEach(function (ev) {
      var type = String(ev.type || '').toLowerCase();
      var ts = parseTs(ev.timestamp || ev.created_at);
      if (!ts) return;
      var p = ev.payload || ev;
      if (TRIP_END_TYPES[type]) {
        var tripId = ev.trip != null ? String(ev.trip).trim() : '';
        var start = tripStarts[tripId] || {};
        var track = lastTrackBefore(events, tripId, ts);
        var lat = ev.lat != null ? Number(ev.lat) : (p.lat != null ? Number(p.lat) : (track ? track.lat : start.lat));
        var lng = ev.lng != null ? Number(ev.lng) : (p.lng != null ? Number(p.lng) : (track ? track.lng : start.lng));
        closures.push({
          eventId: ev.id || p.id || null,
          sourceType: 'trip_end',
          sourceLabel: 'events.trip_end',
          tripId: tripId || null,
          shiftId: null,
          bookingId: p.booking_id || p.bookingId || null,
          vehicleId: p.vehicle_id || ev.vehicle_id || start.vehicleId || null,
          endedAt: ts,
          lat: lat,
          lng: lng,
          lastPositionAt: track ? track.ts : ts,
          lastPositionSource: track ? track.source : (lat != null ? 'events.trip_end' : null),
          dataQuality: 'ACTUAL',
          rawLabel: tripId || null,
          city: p.city || null
        });
      }
      if (SHIFT_END_TYPES[type]) {
        var shiftId = ev.shift || p.shift || null;
        var shiftTrack = lastTrackBeforeShift(events, shiftId, ts);
        var shiftLat = ev.lat != null ? Number(ev.lat) : (p.lat != null ? Number(p.lat) : (shiftTrack ? shiftTrack.lat : null));
        var shiftLng = ev.lng != null ? Number(ev.lng) : (p.lng != null ? Number(p.lng) : (shiftTrack ? shiftTrack.lng : null));
        closures.push({
          eventId: ev.id || p.id || null,
          sourceType: 'shift_end',
          sourceLabel: 'events.shift_end',
          tripId: null,
          shiftId: shiftId,
          bookingId: p.booking_id || p.bookingId || null,
          vehicleId: p.vehicle_id || ev.vehicle_id || parseShiftVehicleId(shiftId),
          endedAt: ts,
          lat: shiftLat,
          lng: shiftLng,
          lastPositionAt: shiftTrack ? shiftTrack.ts : ts,
          lastPositionSource: shiftTrack ? shiftTrack.source : (shiftLat != null ? 'events.shift_end' : null),
          dataQuality: 'ACTUAL',
          rawLabel: shiftId,
          city: p.city || null
        });
      }
    });
    return closures;
  }

  function computePlannedEnd(inquiry) {
    if (!Origin || !Origin.computePreviousEnd) return null;
    return Origin.computePreviousEnd(inquiry);
  }

  function computeTargetStart(target) {
    if (!Origin || !Origin.computeTargetStart) return null;
    return Origin.computeTargetStart(target);
  }

  function projectsOverlap(a, b) {
    if (Origin && Origin.projectsOverlap) return Origin.projectsOverlap(a, b);
    return false;
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    if (Origin && Origin.haversineKm) return Origin.haversineKm(lat1, lng1, lat2, lng2);
    return 0;
  }

  function buildCandidateFromClosure(closure, inquiry, target) {
    var coords = { lat: closure.lat, lng: closure.lng };
    if ((coords.lat == null || coords.lng == null) && inquiry) {
      coords = resolveEndCoords(inquiry);
    }
    var place = inquiry ? shortPlaceLabel(inquiry) : (closure.city || closure.rawLabel || '—');
    return {
      candidateId: 'closure:' + (closure.eventId || closure.tripId || closure.shiftId || closure.endedAt.toISOString()),
      originType: 'DEPLOYABLE_TRAIN',
      bookingId: inquiry ? inquiry.id : (closure.bookingId || null),
      inquiry: inquiry || null,
      closure: closure,
      tripId: closure.tripId || null,
      shiftId: closure.shiftId || null,
      vehicleId: closure.vehicleId || (inquiry && inquiry.vehicle) || null,
      endedAt: closure.endedAt,
      lat: coords.lat,
      lng: coords.lng,
      dataQuality: 'ACTUAL',
      sourceType: closure.sourceType,
      dataQualityLabel: 'TÉNYLEGES',
      endLocationLabel: place,
      endLocationShort: inquiry ? shortPlaceLabel(inquiry) : (closure.city || place),
      sourceLabel: closure.sourceLabel,
      isTestRecord: inquiry ? (Norm && Norm.isTestInquiry(inquiry)) : false
    };
  }

  function shortPlaceLabel(inquiry) {
    if (!inquiry) return '—';
    return inquiry.city || inquiry.placeName || inquiry.address || inquiry.id;
  }

  function buildCandidateFromPlanned(inquiry, target) {
    var coords = resolveEndCoords(inquiry);
    var plannedEnd = computePlannedEnd(inquiry);
    return {
      candidateId: 'planned:' + inquiry.id,
      originType: 'DEPLOYABLE_TRAIN',
      bookingId: inquiry.id,
      inquiry: inquiry,
      closure: null,
      vehicleId: inquiry.vehicle || null,
      endedAt: plannedEnd,
      lat: coords.lat,
      lng: coords.lng,
      dataQuality: 'PLANNED_FALLBACK',
      sourceType: 'planned_end',
      dataQualityLabel: 'TERVEZETT',
      endLocationLabel: shortPlaceLabel(inquiry),
      sourceLabel: 'booking.plannedEnd',
      plannedEndNote: 'Tervezett befejezés – tényleges lezárás nem igazolt.',
      isTestRecord: Norm && Norm.isTestInquiry(inquiry)
    };
  }

  function buildCandidateFromInquiryAudit(inquiry) {
    var coords = resolveEndCoords(inquiry);
    var plannedEnd = computePlannedEnd(inquiry);
    return {
      candidateId: 'audit:' + inquiry.id,
      originType: 'DEPLOYABLE_TRAIN',
      bookingId: inquiry.id,
      inquiry: inquiry,
      closure: null,
      vehicleId: inquiry.vehicle || null,
      endedAt: plannedEnd,
      lat: coords.lat,
      lng: coords.lng,
      dataQuality: 'INQUIRY_AUDIT',
      sourceType: 'inquiry_audit',
      dataQualityLabel: 'FOGLALÁS-AUDIT',
      endLocationLabel: shortPlaceLabel(inquiry),
      sourceLabel: 'booking.inquiryAudit',
      isTestRecord: Norm && Norm.isTestInquiry(inquiry)
    };
  }

  function isEligibleAfterEvaluation(candidate, reasons) {
    var blocking = reasons.filter(function (r) {
      if (r === 'ELIGIBLE') return false;
      if (r === 'NO_TRIP_END' && candidate.dataQuality === 'PLANNED_FALLBACK') return false;
      return true;
    });
    return blocking.length === 0;
  }

  function evaluateCandidate(candidate, target, options) {
    options = options || {};
    var reasons = [];
    var targetStart = computeTargetStart(target);
    var speedKmh = options.speedKmh || CFG.configuredSpeedKmh || 30;
    var bufferMinutes = options.bufferMinutes != null ? options.bufferMinutes : (CFG.preparationBufferMinutes || 30);
    var windowMinutes = options.windowMinutes != null ? options.windowMinutes : getDeploymentWindowMinutes(options);
    var evaluationTime = options.evaluationTime instanceof Date
      ? options.evaluationTime
      : resolveEvaluationTime({ evaluationTime: options.evaluationTime });
    var events = options.events || [];
    var tripStarts = options.tripStarts || buildTripStartIndex(events);

    if (!target || !targetStart) reasons.push('NO_TARGET');
    if (!candidate.endedAt) reasons.push('NOT_FINISHED');
    if (candidate.dataQuality === 'PLANNED_FALLBACK') {
      reasons.push('NO_TRIP_END');
    }
    if (candidate.dataQuality === 'INQUIRY_AUDIT') {
      reasons.push('NO_TRIP_END');
      var st = candidate.inquiry ? String(candidate.inquiry.status || '').toUpperCase() : '';
      if (st === 'ARAJANLATKERES') reasons.push('WRONG_STATUS');
    }
    if (candidate.isTestRecord || (Norm && candidate.inquiry && Norm.isTestInquiry(candidate.inquiry))) {
      reasons.push('TEST_RECORD');
    }
    if (candidate.bookingId && target && String(candidate.bookingId) === String(target.id)) {
      reasons.push('SAME_BOOKING');
    }
    if (candidate.inquiry && target && projectsOverlap(candidate.inquiry, target)) {
      reasons.push('OVERLAP');
    }
    if (candidate.lat == null || candidate.lng == null) {
      reasons.push(candidate.dataQuality === 'ACTUAL' ? 'NO_ACTUAL_POSITION' : 'NO_COORDS');
    }
    if (!candidate.vehicleId) reasons.push('NO_VEHICLE');
    if (candidate.dataQuality === 'ACTUAL' && !candidate.endedAt) reasons.push('NO_COMPLETION_TIME');

    var gapMinutes = null;
    if (candidate.endedAt && targetStart) {
      gapMinutes = Math.round((targetStart.getTime() - candidate.endedAt.getTime()) / 60000);
      if (gapMinutes < 0) reasons.push('TARGET_BEFORE_END');
      else if (gapMinutes > windowMinutes) reasons.push('OUTSIDE_WINDOW');
    }

    if (candidate.dataQuality === 'ACTUAL' && candidate.closure && candidate.endedAt && candidate.closure.lastPositionAt) {
      var posAt = candidate.closure.lastPositionAt instanceof Date
        ? candidate.closure.lastPositionAt
        : new Date(candidate.closure.lastPositionAt);
      if (!isNaN(posAt.getTime())) {
        var closureLagMin = Math.round((candidate.endedAt.getTime() - posAt.getTime()) / 60000);
        var maxClosureLag = getClosurePositionMaxLagMinutes();
        if (isNaN(maxClosureLag)) maxClosureLag = 120;
        if (closureLagMin > maxClosureLag) reasons.push('CLOSURE_POSITION_TOO_OLD');
      }
    }

    if (candidate.dataQuality === 'ACTUAL' && candidate.closure && candidate.closure.lastPositionAt) {
      var latestPosAt = candidate.closure.lastPositionAt instanceof Date
        ? candidate.closure.lastPositionAt
        : new Date(candidate.closure.lastPositionAt);
      if (!isNaN(latestPosAt.getTime())) {
        var operationalAgeMin = Math.round((evaluationTime.getTime() - latestPosAt.getTime()) / 60000);
        var maxOperationalAge = getOperationalPositionMaxAgeMinutes();
        if (isNaN(maxOperationalAge)) maxOperationalAge = 120;
        if (operationalAgeMin > maxOperationalAge) reasons.push('POSITION_TOO_OLD_AT_EVALUATION');
      }
    }

    if (candidate.dataQuality === 'ACTUAL' && candidate.vehicleId && candidate.endedAt && events.length) {
      var activityBoundary = evaluationTime;
      if (targetStart && targetStart.getTime() < activityBoundary.getTime()) {
        activityBoundary = targetStart;
      }
      if (hasLaterVehicleActivity(events, candidate.vehicleId, candidate.endedAt, activityBoundary, tripStarts)) {
        reasons.push('SUPERSEDED_BY_LATER_ACTIVITY');
      }
    }

    var distanceKm = null;
    var travelMinutes = null;
    var feasible = false;
    var targetCoords = { lat: target && target.lat, lng: target && target.lng };
    if (target && (targetCoords.lat == null || targetCoords.lng == null)) {
      var tc = resolveEndCoords(target);
      targetCoords.lat = tc.lat;
      targetCoords.lng = tc.lng;
    }
    if (candidate.lat != null && candidate.lng != null && targetCoords.lat != null && targetCoords.lng != null) {
      distanceKm = Math.round(haversineKm(candidate.lat, candidate.lng, targetCoords.lat, targetCoords.lng) * 10) / 10;
      travelMinutes = Math.round((distanceKm / speedKmh) * 60);
      if (gapMinutes != null && travelMinutes != null) {
        feasible = (travelMinutes + bufferMinutes) <= gapMinutes;
        if (!feasible) reasons.push('INFEASIBLE');
      }
    }

    var eligible = isEligibleAfterEvaluation(candidate, reasons);
    if (eligible) reasons.push('ELIGIBLE');

    var exclusionLabel = (Norm && Norm.EXCLUSION_LABELS)
      ? reasons.filter(function (r) { return r !== 'ELIGIBLE'; }).map(function (r) { return Norm.EXCLUSION_LABELS[r] || r; }).join(' ')
      : reasons.filter(function (r) { return r !== 'ELIGIBLE'; }).join(', ');
    if (eligible) exclusionLabel = Norm && Norm.EXCLUSION_LABELS ? Norm.EXCLUSION_LABELS.ELIGIBLE : 'Jogosult';

    var latestDeparture = null;
    if (feasible && targetStart && travelMinutes != null) {
      latestDeparture = new Date(targetStart.getTime() - (travelMinutes + bufferMinutes) * 60000);
    }

    return Object.assign({}, candidate, {
      targetBookingId: target && target.id,
      targetLabel: target ? (target.placeName || target.address || target.id) : '—',
      gapMinutes: gapMinutes,
      distanceKm: distanceKm,
      transferTravelMinutes: travelMinutes,
      travelMinutes: travelMinutes,
      preparationBufferMinutes: bufferMinutes,
      availableTransitionMinutes: gapMinutes,
      feasible: feasible,
      eligible: eligible,
      exclusionReasons: reasons,
      exclusionLabel: exclusionLabel,
      latestDepartureAt: latestDeparture ? latestDeparture.toISOString() : null,
      latestDepartureLabel: latestDeparture
        ? String(latestDeparture.getHours()).padStart(2, '0') + ':' + String(latestDeparture.getMinutes()).padStart(2, '0')
        : '—'
    });
  }

  function linkClosureToInquiry(closure, inquiries) {
    if (!Array.isArray(inquiries)) return null;
    if (closure.bookingId) {
      var byId = inquiries.find(function (b) { return String(b.id) === String(closure.bookingId); });
      if (byId) return byId;
    }
    if (!closure.vehicleId || !closure.endedAt) return null;
    var best = null;
    inquiries.forEach(function (inq) {
      if (String(inq.vehicle || '') !== String(closure.vehicleId)) return;
      var end = computePlannedEnd(inq);
      if (!end) return;
      var diff = Math.abs(end.getTime() - closure.endedAt.getTime());
      if (!best || diff < best.diff) best = { inq: inq, diff: diff };
    });
    if (best && best.diff <= 6 * 60 * 60 * 1000) return best.inq;
    return null;
  }

  function evaluateCandidates(params) {
    params = params || {};
    var inquiries = params.inquiries || [];
    var events = params.events || [];
    var target = params.targetBooking;
    var evaluationTime = resolveEvaluationTime(params);
    var tripStarts = buildTripStartIndex(events);
    var options = {
      speedKmh: params.speedKmh,
      bufferMinutes: params.bufferMinutes,
      windowMinutes: params.windowMinutes != null ? params.windowMinutes : getDeploymentWindowMinutes(params),
      evaluationTime: evaluationTime,
      events: events,
      tripStarts: tripStarts
    };
    var closures = buildActualClosures(events);
    var seen = {};
    var raw = [];

    closures.forEach(function (closure) {
      var inquiry = linkClosureToInquiry(closure, inquiries);
      var candidate = buildCandidateFromClosure(closure, inquiry, target);
      raw.push(candidate);
    });

    inquiries.forEach(function (inq) {
      var st = String(inq.status || '').toUpperCase();
      if (st === 'LEMONDVA') return;
      if (target && String(inq.id) === String(target.id)) return;
      var hasActual = raw.some(function (c) { return c.bookingId === inq.id && c.dataQuality === 'ACTUAL'; });
      if (hasActual) return;
      if (st === 'MEGRENDELVE' || st === 'TELJESITVE') {
        raw.push(buildCandidateFromPlanned(inq, target));
      } else if (st === 'ARAJANLATKERES') {
        raw.push(buildCandidateFromInquiryAudit(inq));
      }
    });

    var evaluated = raw.map(function (c) {
      return evaluateCandidate(c, target, options);
    });

    var rawCandidateCount = evaluated.length;
    var normalized = Norm
      ? evaluated.map(function (c) { return Norm.normalizeEvaluatedCandidate(c, target && target.id); })
      : evaluated;
    var deduped = Norm ? Norm.dedupeNormalizedCandidates(normalized) : { candidates: normalized, duplicatesRemoved: 0 };
    var finalCandidates = deduped.candidates;
    var vehicleSeen = {};
    var duplicateVehicleInList = 0;
    finalCandidates.forEach(function (c) {
      if (!c.vehicleId) return;
      var vid = String(c.vehicleId).toUpperCase();
      if (vehicleSeen[vid]) duplicateVehicleInList += 1;
      vehicleSeen[vid] = true;
    });

    var exclusionCounts = {};
    finalCandidates.forEach(function (c) {
      (c.exclusionReasons || []).forEach(function (r) {
        if (r === 'ELIGIBLE') return;
        exclusionCounts[r] = (exclusionCounts[r] || 0) + 1;
      });
    });

    var identicalRouteGroups = {};
    finalCandidates.forEach(function (c) {
      if (c.distanceKm == null || c.travelMinutes == null) return;
      var sig = c.distanceKm + '|' + c.travelMinutes + '|' + c.endLat + '|' + c.endLng;
      if (!identicalRouteGroups[sig]) identicalRouteGroups[sig] = [];
      identicalRouteGroups[sig].push(c.normalizedCandidateId);
    });
    var identicalRouteResultCause = null;
    Object.keys(identicalRouteGroups).forEach(function (sig) {
      if (identicalRouteGroups[sig].length > 1) {
        var parts = sig.split('|');
        var sameCoords = parts[2] && parts[3];
        identicalRouteResultCause = sameCoords
          ? 'Azonos indulási koordináta és haversine becslés – duplikált fizikai vonat/jármű (dedup alkalmazva).'
          : 'Azonos távolság/menetidő különböző koordinátákon – routing ellenőrzendő.';
      }
    });

    var nearby0711 = finalCandidates.find(function (c) { return c.bookingId === 'RENT-2025-0004'; }) || null;

    return {
      candidates: finalCandidates,
      candidatesChecked: finalCandidates.length,
      rawCandidateCount: rawCandidateCount,
      normalizedCandidateCount: finalCandidates.length,
      duplicatesRemoved: deduped.duplicatesRemoved || 0,
      duplicateVehicleCount: duplicateVehicleInList,
      eligibleActualTrains: finalCandidates.filter(function (c) { return c.eligible && c.dataQuality === 'ACTUAL'; }).length,
      eligiblePlannedFallback: finalCandidates.filter(function (c) { return c.eligible && c.dataQuality === 'PLANNED_FALLBACK'; }).length,
      plannedFallbackCandidates: finalCandidates.filter(function (c) { return c.dataQuality === 'PLANNED_FALLBACK'; }).length,
      testRecordsFound: finalCandidates.filter(function (c) { return c.isTestRecord; }).length,
      exclusionCounts: exclusionCounts,
      identicalRouteResultCause: identicalRouteResultCause,
      nearby0711Audit: nearby0711 ? {
        bookingId: nearby0711.bookingId,
        eligible: nearby0711.eligible,
        exclusionReasons: nearby0711.exclusionReasons,
        exclusionLabel: nearby0711.exclusionLabel
      } : null,
      sources: {
        events: events.length,
        tripEndCount: closures.filter(function (c) { return c.sourceType === 'trip_end'; }).length,
        shiftEndCount: closures.filter(function (c) { return c.sourceType === 'shift_end'; }).length,
        inquiries: inquiries.length
      }
    };
  }

  function normalizedToOrigin(norm, target) {
    var targetVehicle = target && target.vehicle;
    var sameVehicle = !!(norm.vehicleId && targetVehicle && norm.vehicleId === targetVehicle);
    var completionTime = norm.endAt || null;
    var completionLocation = norm.endLocationShort || norm.endLocationLabel || '—';
  return {
      originType: 'DEPLOYABLE_TRAIN',
      originId: norm.bookingId || norm.normalizedCandidateId,
      normalizedCandidateId: norm.normalizedCandidateId,
      originName: norm.humanDisplayName,
      humanDisplayName: norm.humanDisplayName,
      completionTime: completionTime,
      completionLocation: completionLocation,
      lastPosition: norm.endLat != null && norm.endLng != null ? { lat: norm.endLat, lng: norm.endLng } : null,
      lastPositionTimestamp: norm.lastPositionAt || completionTime,
      lastPositionSource: norm.lastPositionSource || norm.originSource || null,
      lat: norm.endLat,
      lng: norm.endLng,
      distanceKm: norm.distanceKm,
      trainTravelMinutes: norm.travelMinutes,
      transferTravelMinutes: norm.travelMinutes,
      preparationBufferMinutes: norm.preparationBufferMinutes,
      latestDeparture: norm.latestDepartureAt ? new Date(norm.latestDepartureAt) : null,
      latestDepartureLabel: norm.latestDepartureLabel,
      feasible: norm.feasible,
      eligible: norm.eligible,
      provider: norm.dataQuality === 'ACTUAL' ? 'operational-events' : (norm.dataQuality === 'PLANNED_FALLBACK' ? 'planned-fallback' : 'inquiry-audit'),
      isMockRun: false,
      isTestRecord: norm.isTestRecord,
      warning: norm.plannedEndNote || null,
      previousProjectId: norm.bookingId,
      previousProjectEndLabel: norm.endAt ? norm.endAt.replace('T', ' ').slice(0, 16) : '—',
      gapMinutes: norm.gapMinutes,
      transitionWindowMinutes: norm.gapMinutes,
      availableTransitionMinutes: norm.gapMinutes,
      originBookingId: norm.bookingId,
      originProjectName: norm.endLocationShort,
      previousVehicle: norm.vehicleId,
      originVehicleId: norm.vehicleId,
      targetVehicle: targetVehicle,
      sameVehicle: sameVehicle,
      dataQuality: norm.dataQuality,
      dataQualityLabel: norm.dataQuality === 'ACTUAL' ? 'TÉNYLEGES' : (norm.dataQuality === 'PLANNED_FALLBACK' ? 'TERVEZETT' : 'FOGLALÁS-AUDIT'),
      exclusionLabel: norm.exclusionLabel,
      exclusionReasons: norm.exclusionReasons,
      sourceLabel: norm.originSource,
      originEndAt: norm.endAt,
      originEndLocation: norm.endLocationShort,
      closureSourceType: norm.sourceType,
      eventId: norm.eventId,
      tripId: norm.tripId,
      shiftId: norm.shiftId,
      rawBackendLabel: norm.rawBackendLabel,
      targetLabel: norm.targetLabel,
      routingBinding: norm.routingBinding
    };
  }

  function candidateToOrigin(candidate) {
    if (candidate && candidate.normalizedCandidateId && candidate.humanDisplayName) {
      return normalizedToOrigin(candidate, null);
    }
    var inquiry = candidate.inquiry || {};
    return {
      originType: 'DEPLOYABLE_TRAIN',
      originId: candidate.bookingId || candidate.candidateId,
      originName: candidate.endLocationLabel || candidate.vehicleId || candidate.candidateId,
      lat: candidate.lat,
      lng: candidate.lng,
      distanceKm: candidate.distanceKm,
      trainTravelMinutes: candidate.travelMinutes,
      transferTravelMinutes: candidate.travelMinutes,
      preparationBufferMinutes: candidate.preparationBufferMinutes,
      latestDeparture: candidate.latestDepartureAt ? new Date(candidate.latestDepartureAt) : null,
      latestDepartureLabel: candidate.latestDepartureLabel,
      feasible: candidate.feasible,
      eligible: candidate.eligible,
      provider: candidate.dataQuality === 'ACTUAL' ? 'operational-events' : 'planned-fallback',
      isMockRun: false,
      warning: candidate.plannedEndNote || null,
      previousProjectId: candidate.bookingId,
      previousProjectEndLabel: candidate.endedAt
        ? candidate.endedAt.toISOString().replace('T', ' ').slice(0, 16)
        : '—',
      gapMinutes: candidate.gapMinutes,
      transitionWindowMinutes: candidate.gapMinutes,
      availableTransitionMinutes: candidate.availableTransitionMinutes,
      originBookingId: candidate.bookingId,
      originProjectName: candidate.endLocationLabel,
      previousVehicle: candidate.vehicleId,
      targetVehicle: null,
      targetLabel: candidate.targetLabel,
      sameVehicle: false,
      dataQuality: candidate.dataQuality,
      dataQualityLabel: candidate.dataQualityLabel,
      exclusionLabel: candidate.exclusionLabel,
      exclusionReasons: candidate.exclusionReasons,
      sourceLabel: candidate.sourceLabel,
      originEndAt: candidate.endedAt ? candidate.endedAt.toISOString() : null,
      originEndLocation: candidate.endLocationLabel,
      originVehicleId: candidate.vehicleId,
      closureSourceType: candidate.closure ? candidate.closure.sourceType : null
    };
  }

  function buildDeployableOrigins(inquiries, events, target, options) {
    options = options || {};
    var audit = evaluateCandidates({
      inquiries: inquiries,
      events: events,
      targetBooking: target,
      speedKmh: options.speedKmh,
      bufferMinutes: options.bufferMinutes,
      windowMinutes: options.windowMinutes,
      evaluationTime: options.evaluationTime
    });
    if (audit.candidates && audit.candidates[0] && audit.candidates[0].routingBinding) {
      audit.candidates.forEach(function (c) {
        c.routingBinding.targetLat = target && target.lat;
        c.routingBinding.targetLng = target && target.lng;
      });
    }
    return {
      origins: audit.candidates.map(function (c) { return normalizedToOrigin(c, target); }),
      audit: audit
    };
  }

  var api = {
    MAX_GAP_MINUTES: MAX_GAP_MINUTES,
    buildActualClosures: buildActualClosures,
    evaluateCandidates: evaluateCandidates,
    candidateToOrigin: candidateToOrigin,
    buildDeployableOrigins: buildDeployableOrigins,
    resolveEndCoords: resolveEndCoords,
    resolveEvaluationTime: resolveEvaluationTime,
    getClosurePositionMaxLagMinutes: getClosurePositionMaxLagMinutes,
    getOperationalPositionMaxAgeMinutes: getOperationalPositionMaxAgeMinutes,
    hasLaterVehicleActivity: hasLaterVehicleActivity
  };

  global.OperationalTrainAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
