(function (global) {
  'use strict';

  var EXCLUSION_LABELS = {
    NO_TARGET: 'Kizárva: célfoglalás hiányzik.',
    NOT_FINISHED: 'Kizárva: még nem fejeződött be.',
    NO_TRIP_END: 'Kizárva: tényleges lezárás nem igazolt.',
    SAME_BOOKING: 'Kizárva: ugyanaz a foglalás.',
    OVERLAP: 'Kizárva: a célfoglalással átfed.',
    NO_COORDS: 'Kizárva: nincs használható utolsó pozíció.',
    NO_ACTUAL_POSITION: 'Kizárva: nincs tényleges utolsó pozíció.',
    NO_COMPLETION_TIME: 'Kizárva: nincs tényleges befejezési idő.',
    POSITION_TOO_OLD: 'Kizárva: a lezárási helyhez túl régi a tényleges pozíció (legacy kód).',
    CLOSURE_POSITION_TOO_OLD: 'Kizárva: a lezárási helyhez túl régi a tényleges pozíció.',
    POSITION_TOO_OLD_AT_EVALUATION: 'Nem bevethető – az utolsó ismert pozíció már nem friss.',
    SUPERSEDED_BY_LATER_ACTIVITY: 'Kizárva: a jármű a lezárás után újabb aktivitást végzett.',
    NO_VEHICLE: 'Kizárva: nincs hozzárendelt jármű.',
    TOO_OLD: 'Kizárva: a továbbküldési időablakon kívül esik.',
    OUTSIDE_WINDOW: 'Kizárva: meghaladja a továbbküldési időablakot.',
    NO_PLANNED_END: 'Kizárva: nincs tervezett befejezési idő.',
    TARGET_BEFORE_END: 'Kizárva: a célfoglalás az előző projekt előtt kezdődik.',
    INFEASIBLE: 'Kizárva: menetidő és tartalék alapján nem ér oda.',
    WRONG_STATUS: 'Kizárva: csak árajánlatkérés – nem bevethető vonat.',
    TEST_RECORD: 'Kizárva: teszt/demó rekord.',
    DUPLICATE: 'Kizárva: duplikált fizikai vonat/jármű.',
    ELIGIBLE: 'Jogosult'
  };

  var QUALITY_RANK = {
    ACTUAL_TRIP_END: 40,
    ACTUAL_SHIFT_END: 30,
    PLANNED_FALLBACK: 10,
    INQUIRY_AUDIT: 5
  };

  function isTestInquiry(inquiry) {
    if (!inquiry) return false;
    if (inquiry.isTest || inquiry.isDemo || inquiry.testRecord) return true;
    var blob = [
      inquiry.id,
      inquiry.placeName,
      inquiry.companyName,
      inquiry.ordererName,
      inquiry.note
    ].filter(Boolean).join(' ').toUpperCase();
    return blob.indexOf('BACKEND PAYLOAD') >= 0 || blob.indexOf('PAYLOAD TESZT') >= 0 || blob.indexOf('PAYLOAD TEST') >= 0;
  }

  function formatHuDateTime(d) {
    if (!d || isNaN(d.getTime())) return '—';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return mm + '.' + dd + '. ' + hh + ':' + mi;
  }

  function shortPlaceLabel(inquiry, coordsLabel) {
    if (inquiry) {
      return inquiry.city || inquiry.placeName || inquiry.address || inquiry.id;
    }
    return coordsLabel || '—';
  }

  function vehicleDisplayLabel(vehicleId, inquiry) {
    if (vehicleId) return String(vehicleId);
    if (inquiry && inquiry.vehicle) return String(inquiry.vehicle);
    return null;
  }

  function buildHumanDisplayName(norm) {
    var vehicle = norm.vehicleLabel || norm.vehicleId || 'Ismeretlen jármű';
    var place = norm.endLocationShort || '—';
    var time = norm.endAt ? formatHuDateTime(new Date(norm.endAt)) : '—';
    if (norm.dataQuality === 'ACTUAL') {
      return vehicle + ' · ' + place + ' · végzett: ' + time;
    }
    return vehicle + ' · ' + place + ' · ' + time;
  }

  function getDedupKey(norm) {
    if (norm.vehicleId) return 'vehicle:' + String(norm.vehicleId).toUpperCase();
    if (norm.tripId) return 'trip:' + norm.tripId;
    if (norm.shiftId) return 'shift:' + norm.shiftId;
    if (norm.bookingId) return 'booking:' + norm.bookingId;
    if (norm.endLat != null && norm.endLng != null) {
      return 'coord:' + norm.endLat.toFixed(4) + ',' + norm.endLng.toFixed(4);
    }
    return 'candidate:' + norm.candidateId;
  }

  function sourceQualityRank(norm) {
    if (norm.dataQuality === 'ACTUAL' && norm.sourceType === 'trip_end') return QUALITY_RANK.ACTUAL_TRIP_END;
    if (norm.dataQuality === 'ACTUAL' && norm.sourceType === 'shift_end') return QUALITY_RANK.ACTUAL_SHIFT_END;
    if (norm.dataQuality === 'PLANNED_FALLBACK') return QUALITY_RANK.PLANNED_FALLBACK;
    return QUALITY_RANK.INQUIRY_AUDIT;
  }

  function normalizeEvaluatedCandidate(candidate, targetBookingId) {
    var inquiry = candidate.inquiry || null;
    var closure = candidate.closure || null;
    var vehicleId = candidate.vehicleId || (inquiry && inquiry.vehicle) || null;
    var sourceType = closure ? closure.sourceType : (candidate.sourceType || (candidate.dataQuality === 'PLANNED_FALLBACK' ? 'planned_end' : 'inquiry_audit'));
    var norm = {
      candidateId: candidate.candidateId,
      normalizedCandidateId: candidate.candidateId,
      sourceType: sourceType,
      bookingId: candidate.bookingId || null,
      eventId: closure && closure.eventId ? closure.eventId : null,
      tripId: closure && closure.tripId ? closure.tripId : (candidate.tripId || null),
      shiftId: closure && closure.shiftId ? closure.shiftId : (candidate.shiftId || null),
      vehicleId: vehicleId,
      vehicleLabel: vehicleDisplayLabel(vehicleId, inquiry),
      endAt: candidate.endedAt ? (candidate.endedAt.toISOString ? candidate.endedAt.toISOString() : candidate.endedAt) : null,
      endLat: candidate.lat,
      endLng: candidate.lng,
      lastPositionAt: closure && closure.lastPositionAt
        ? (closure.lastPositionAt.toISOString ? closure.lastPositionAt.toISOString() : closure.lastPositionAt)
        : null,
      lastPositionSource: closure && closure.lastPositionSource ? closure.lastPositionSource : null,
      dataQuality: candidate.dataQuality || 'INQUIRY_AUDIT',
      originSource: candidate.sourceLabel || sourceType,
      targetBookingId: targetBookingId || candidate.targetBookingId || null,
      inquiry: inquiry,
      eligible: !!candidate.eligible,
      feasible: candidate.feasible !== false,
      exclusionReasons: (candidate.exclusionReasons || []).slice(),
      exclusionLabel: candidate.exclusionLabel,
      distanceKm: candidate.distanceKm,
      travelMinutes: candidate.travelMinutes,
      transferTravelMinutes: candidate.travelMinutes,
      preparationBufferMinutes: candidate.preparationBufferMinutes,
      gapMinutes: candidate.gapMinutes,
      latestDepartureLabel: candidate.latestDepartureLabel,
      latestDepartureAt: candidate.latestDepartureAt,
      targetLabel: candidate.targetLabel,
      plannedEndNote: candidate.plannedEndNote || null,
      isTestRecord: isTestInquiry(inquiry) || !!candidate.isTestRecord,
      rawBackendLabel: inquiry ? (inquiry.placeName || inquiry.id) : (closure && (closure.tripId || closure.shiftId)) || null,
      endLocationShort: candidate.endLocationShort || shortPlaceLabel(inquiry, candidate.endLocationLabel),
      routingBinding: {
        targetBookingId: targetBookingId || candidate.targetBookingId,
        normalizedCandidateId: candidate.candidateId,
        originLat: candidate.lat,
        originLng: candidate.lng,
        targetLat: null,
        targetLng: null
      }
    };
    norm.humanDisplayName = buildHumanDisplayName(norm);
    if (!norm.exclusionLabel || norm.exclusionLabel.indexOf(',') >= 0) {
      norm.exclusionLabel = (norm.exclusionReasons || [])
        .filter(function (r) { return r !== 'ELIGIBLE'; })
        .map(function (r) { return EXCLUSION_LABELS[r] || r; })
        .join(' ') || EXCLUSION_LABELS.ELIGIBLE;
    }
    return norm;
  }

  function dedupeNormalizedCandidates(list) {
    var bestByKey = {};
    var duplicatesRemoved = 0;
    list.forEach(function (norm) {
      var key = getDedupKey(norm);
      var existing = bestByKey[key];
      if (!existing) {
        bestByKey[key] = norm;
        return;
      }
      duplicatesRemoved += 1;
      var aRank = sourceQualityRank(existing);
      var bRank = sourceQualityRank(norm);
      var keep = norm;
      var drop = existing;
      if (aRank > bRank) {
        keep = existing;
        drop = norm;
      } else if (aRank === bRank) {
        var existingEnd = existing.endAt ? new Date(existing.endAt).getTime() : 0;
        var incomingEnd = norm.endAt ? new Date(norm.endAt).getTime() : 0;
        if (incomingEnd > existingEnd) {
          keep = norm;
          drop = existing;
        } else {
          keep = existing;
          drop = norm;
        }
      }
      drop.exclusionReasons = (drop.exclusionReasons || []).concat(['DUPLICATE']);
      drop.eligible = false;
      drop.exclusionLabel = EXCLUSION_LABELS.DUPLICATE;
      bestByKey[key] = keep;
    });
    return {
      candidates: Object.keys(bestByKey).map(function (k) { return bestByKey[k]; }),
      duplicatesRemoved: duplicatesRemoved,
      duplicateVehicleCount: Object.keys(bestByKey).filter(function (k) { return k.indexOf('vehicle:') === 0; }).length
    };
  }

  function buildRankReason(origin, rankIndex, prevOrigin) {
    var parts = [];
    if (origin.feasible === false) parts.push('Nem teljesíthető – hátrébb sorolva');
    else parts.push('Teljesíthető');
    parts.push('Távolság: ' + (origin.distanceKm != null ? origin.distanceKm + ' km' : '—'));
    parts.push('Menetidő: ' + (origin.transferTravelMinutes != null ? origin.transferTravelMinutes + ' perc' : '—'));
    if (origin.sameVehicle) parts.push('sameVehicle bónusz (tie-break)');
    if (origin.dataQuality === 'PLANNED_PREVIOUS_PROJECT' && origin.savedDistanceKm > 0) {
      parts.push('Közvetlen továbbküldés előny: ' + origin.savedDistanceKm + ' km');
    }
    if (prevOrigin && rankIndex === 0) {
      parts.push('Végső score: távolság+menetidő alapú közös rangsor');
    } else if (prevOrigin && origin.distanceKm != null && prevOrigin.distanceKm != null && origin.distanceKm < prevOrigin.distanceKm) {
      parts.push('Közelebbi indulás, mint az előző ajánlott elem');
    }
    return parts.join(' · ');
  }

  var api = {
    EXCLUSION_LABELS: EXCLUSION_LABELS,
    isTestInquiry: isTestInquiry,
    normalizeEvaluatedCandidate: normalizeEvaluatedCandidate,
    dedupeNormalizedCandidates: dedupeNormalizedCandidates,
    getDedupKey: getDedupKey,
    buildHumanDisplayName: buildHumanDisplayName,
    buildRankReason: buildRankReason,
    formatHuDateTime: formatHuDateTime
  };

  global.AdvisorCandidateNormalizer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
