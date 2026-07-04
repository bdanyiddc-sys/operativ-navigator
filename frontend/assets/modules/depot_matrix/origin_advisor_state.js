(function (global) {
  'use strict';

  var SAME_VEHICLE_TIEBREAK_KM = 0.25;

  function getOriginKey(origin) {
    if (!origin) return '';
    var type = origin.originType || (origin.depotId ? 'DEPOT' : 'UNKNOWN');
    var id = origin.normalizedCandidateId || origin.originId || origin.depotId || origin.previousProjectId || origin.id || '';
    return type + ':' + String(id);
  }

  function depotRowToOrigin(row) {
    return {
      originType: 'DEPOT',
      originId: row.depotId,
      normalizedCandidateId: 'depot:' + row.depotId,
      originName: row.depotName,
      humanDisplayName: row.depotName,
      depotId: row.depotId,
      depotName: row.depotName,
      lat: row.lat,
      lng: row.lng,
      distanceKm: row.distanceKm,
      transferTravelMinutes: row.trainTravelMinutes,
      trainTravelMinutes: row.trainTravelMinutes,
      preparationBufferMinutes: row.preparationBufferMinutes,
      latestDepartureLabel: row.latestDepartureLabel,
      feasible: row.timeFeasible != null ? row.timeFeasible : row.routable,
      eligible: row.candidateEligible != null ? row.candidateEligible : (row.timeFeasible != null ? row.timeFeasible : row.routable),
      candidateEligible: row.candidateEligible != null ? row.candidateEligible : (row.timeFeasible != null ? row.timeFeasible : row.routable),
      safeRouteGeometryAvailable: row.safeRouteGeometryAvailable === true,
      routable: row.routable,
      provider: row.provider,
      providerLabel: row.providerLabel,
      fallbackUsed: row.fallbackUsed,
      warning: row.warning,
      sameVehicle: false,
      isMockRun: row.provider === 'mock',
      isTestRecord: false,
      gapMinutes: null,
      transitionWindowMinutes: null,
      routingBinding: row.routingBinding || null,
      _sourceIndex: row._sourceIndex
    };
  }

  function buildUnifiedOriginList(payload, unifiedPayload) {
    var list = [];
    var idx = 0;
    if (unifiedPayload && unifiedPayload.origins) {
      unifiedPayload.origins.forEach(function (o) {
        var copy = Object.assign({}, o, { _sourceIndex: idx++ });
        if (!copy.humanDisplayName) copy.humanDisplayName = copy.originName;
        list.push(copy);
      });
    } else if (payload && payload.results) {
      payload.results.forEach(function (row) {
        var o = depotRowToOrigin(row);
        o._sourceIndex = idx++;
        list.push(o);
      });
    }
    return list;
  }

  function splitByType(origins) {
    var depots = [];
    var projects = [];
    var deployableTrains = [];
    origins.forEach(function (o) {
      if (o.originType === 'DEPLOYABLE_TRAIN') deployableTrains.push(o);
      else if (o.originType === 'PREVIOUS_PROJECT') projects.push(o);
      else depots.push(o);
    });
    return { depots: depots, projects: projects, deployableTrains: deployableTrains };
  }

  function unifiedScore(origin) {
    var dist = origin.distanceKm != null ? Number(origin.distanceKm) : 99999;
    var travel = origin.transferTravelMinutes != null ? Number(origin.transferTravelMinutes) : 99999;
    var bonus = origin.sameVehicle ? -SAME_VEHICLE_TIEBREAK_KM : 0;
    return dist + (travel / 1000) + bonus;
  }

  function isTop3Eligible(origin) {
    if (!origin) return false;
    if (origin.isTestRecord) return false;
    if (origin.originType === 'PREVIOUS_PROJECT' && origin.eligible !== true) return false;
    if (origin.originType === 'DEPLOYABLE_TRAIN' && origin.eligible !== true) return false;
    if (origin.originType === 'DEPOT') {
      if (origin.candidateEligible === false) return false;
      if (origin.candidateEligible === true) return true;
    }
    if (origin.feasible === false) return false;
    return true;
  }

  function rankOrigins(origins, enabledKeys) {
    enabledKeys = enabledKeys || new Set();
    var enabled = origins.filter(function (o) { return enabledKeys.has(getOriginKey(o)); });
    return enabled.slice().sort(function (a, b) {
      if (!!a.feasible !== !!b.feasible) return a.feasible ? -1 : 1;
      var aScore = unifiedScore(a);
      var bScore = unifiedScore(b);
      if (aScore !== bScore) return aScore - bScore;
      if (!!a.sameVehicle !== !!b.sameVehicle) return a.sameVehicle ? -1 : 1;
      return (a._sourceIndex || 0) - (b._sourceIndex || 0);
    }).map(function (o, i, arr) {
      var prev = i > 0 ? arr[i - 1] : null;
      var Norm = global.AdvisorCandidateNormalizer;
      o.rankReason = Norm && Norm.buildRankReason
        ? Norm.buildRankReason(o, i, prev)
        : ('Távolság ' + (o.distanceKm != null ? o.distanceKm + ' km' : '—'));
      o.rankScore = unifiedScore(o);
      return o;
    });
  }

  function getTopRecommendations(ranked, maxCount) {
    maxCount = maxCount || 3;
    return ranked.filter(isTop3Eligible).slice(0, maxCount);
  }

  function defaultEnabledKeys(origins) {
    var set = new Set();
    origins.forEach(function (o) {
      if (o.availableVehicleCount === 0) return;
      set.add(getOriginKey(o));
    });
    if (set.size === 0 && origins.length) {
      origins.forEach(function (o) { set.add(getOriginKey(o)); });
    }
    return set;
  }

  function countStats(origins, enabledKeys) {
    var enabled = origins.filter(function (o) { return enabledKeys.has(getOriginKey(o)); });
    var feasible = enabled.filter(function (o) { return o.feasible !== false; });
    var eligible = enabled.filter(isTop3Eligible);
    return { total: origins.length, enabled: enabled.length, feasible: feasible.length, top3Eligible: eligible.length };
  }

  function countGroupDisplayStats(origins) {
    origins = origins || [];
    return {
      total: origins.length,
      eligible: origins.filter(isTop3Eligible).length
    };
  }

  function formatGroupHeaderTitle(baseTitle, origins) {
    var s = countGroupDisplayStats(origins);
    return baseTitle + ' · ' + s.total + ' összesen · ' + s.eligible + ' ajánlható';
  }

  function getExcludedOrigins(origins) {
    return (origins || []).filter(function (o) {
      return o.feasible === false || !isTop3Eligible(o);
    });
  }

  function isMobileViewport() {
    return global.innerWidth <= 768;
  }

  function defaultGroupOpenState() {
    return { recommended: true, depots: false, projects: false, deployableTrains: false, excluded: false };
  }

  var api = {
    SAME_VEHICLE_TIEBREAK_KM: SAME_VEHICLE_TIEBREAK_KM,
    getOriginKey: getOriginKey,
    depotRowToOrigin: depotRowToOrigin,
    buildUnifiedOriginList: buildUnifiedOriginList,
    splitByType: splitByType,
    rankOrigins: rankOrigins,
    getTopRecommendations: getTopRecommendations,
    isTop3Eligible: isTop3Eligible,
    unifiedScore: unifiedScore,
    defaultEnabledKeys: defaultEnabledKeys,
    countStats: countStats,
    countGroupDisplayStats: countGroupDisplayStats,
    formatGroupHeaderTitle: formatGroupHeaderTitle,
    getExcludedOrigins: getExcludedOrigins,
    isMobileViewport: isMobileViewport,
    defaultGroupOpenState: defaultGroupOpenState
  };

  global.OriginAdvisorState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
