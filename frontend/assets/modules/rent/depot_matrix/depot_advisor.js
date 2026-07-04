(function () {
  'use strict';

  var CFG = window.DEPOT_MATRIX_CONFIG || {};
  var Adapter = window.DepotMatrixAdapter;
  var Origin = window.ProjectOriginAdapter;
  var OAS = window.OriginAdvisorState;
  var OTA = window.OperationalTrainAdapter;
  var depotsCache = null;
  var previousProjectsCache = null;
  var operationalEventsCache = null;
  var lastDeployableAudit = null;
  var lastCompareTargetId = null;
  var lastAdvisorSnapshot = null;
  var enabledOriginKeys = new Set();
  var lastOriginList = [];
  var lastPayload = null;
  var lastUnifiedPayload = null;
  var groupOpenState = OAS ? OAS.defaultGroupOpenState() : { recommended: true, depots: false, projects: false, deployableTrains: false, excluded: false };

  function defaultDetailOptionsUiState() {
    return {
      outerOpen: false,
      depotGroupOpen: false,
      redeployableGroupOpen: false,
      excludedGroupOpen: false,
      initialized: false
    };
  }

  var detailOptionsUiState = defaultDetailOptionsUiState();
  var advisorRenderCount = 0;

  function captureDetailOptionsUiStateFromDom() {
    var master = document.getElementById('originDetailOptionsMaster');
    if (!master) return;
    detailOptionsUiState.outerOpen = !!master.open;
    var dep = document.getElementById('originGroupDepots');
    if (dep) detailOptionsUiState.depotGroupOpen = !!dep.open;
    var red = document.getElementById('originGroupRedeployable');
    if (red) detailOptionsUiState.redeployableGroupOpen = !!red.open;
    var ex = document.getElementById('originGroupExcluded');
    if (ex) detailOptionsUiState.excludedGroupOpen = !!ex.open;
    detailOptionsUiState.initialized = true;
  }

  function resetDetailOptionsUiState() {
    detailOptionsUiState = defaultDetailOptionsUiState();
  }

  function groupOpenFromState(id, openDefault) {
    if (!detailOptionsUiState.initialized) return !!openDefault;
    if (id === 'originGroupDepots') return detailOptionsUiState.depotGroupOpen;
    if (id === 'originGroupRedeployable') return detailOptionsUiState.redeployableGroupOpen;
    if (id === 'originGroupExcluded') return detailOptionsUiState.excludedGroupOpen;
    return !!openDefault;
  }

  function wireDetailOptionsUiState(root) {
    if (!root) return;
    var master = root.querySelector('#originDetailOptionsMaster');
    if (master) {
      master.addEventListener('toggle', function () {
        detailOptionsUiState.outerOpen = master.open;
        detailOptionsUiState.initialized = true;
      });
    }
    [
      ['originGroupDepots', 'depotGroupOpen'],
      ['originGroupRedeployable', 'redeployableGroupOpen'],
      ['originGroupExcluded', 'excludedGroupOpen']
    ].forEach(function (pair) {
      var el = root.querySelector('#' + pair[0]);
      if (!el) return;
      el.addEventListener('toggle', function () {
        detailOptionsUiState[pair[1]] = el.open;
        detailOptionsUiState.initialized = true;
      });
    });
  }

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function isOfflineIntegration() {
    return CFG.runtimeMode === 'OFFLINE_INTEGRATION_AUDIT';
  }

  function isLiveReadOnly() {
    return CFG.runtimeMode === 'LIVE_READ_ONLY_AUDIT';
  }

  function isLiveDataMode() {
    return CFG.runtimeMode === 'LIVE_READ_ONLY_AUDIT' || CFG.runtimeMode === 'LIVE_WRITE_INTEGRATION';
  }

  function getLiveApiBase() {
    return String(CFG.liveApiBase || 'http://localhost:3000').replace(/\/+$/, '');
  }

  function resolveLiveCoords(row) {
    if (!row) return { lat: null, lng: null };
    if (row.lat != null && row.lng != null) {
      return { lat: Number(row.lat), lng: Number(row.lng) };
    }
    if (row.end_lat != null && row.end_lng != null) {
      return { lat: Number(row.end_lat), lng: Number(row.end_lng) };
    }
    if (row.end_address && row.end_address.lat != null && row.end_address.lng != null) {
      return { lat: Number(row.end_address.lat), lng: Number(row.end_address.lng) };
    }
    if (Array.isArray(row.routePoints) && row.routePoints.length) {
      var endPt = row.routePoints[row.routePoints.length - 1];
      if (endPt && endPt.lat != null && endPt.lng != null) {
        return { lat: Number(endPt.lat), lng: Number(endPt.lng) };
      }
    }
    if (row.routeGeometry && row.routeGeometry.coordinates && row.routeGeometry.coordinates.length) {
      var coord = row.routeGeometry.coordinates[row.routeGeometry.coordinates.length - 1];
      if (coord && coord.length >= 2) {
        return { lat: Number(coord[1]), lng: Number(coord[0]) };
      }
    }
    if (row.start_address && row.start_address.lat != null && row.start_address.lng != null) {
      return { lat: Number(row.start_address.lat), lng: Number(row.start_address.lng) };
    }
    if (Array.isArray(row.routePoints) && row.routePoints.length) {
      var startPt = row.routePoints[0];
      if (startPt && startPt.lat != null && startPt.lng != null) {
        return { lat: Number(startPt.lat), lng: Number(startPt.lng) };
      }
    }
    return { lat: null, lng: null };
  }

  function normalizeLiveInquiry(row) {
    if (!row) return null;
    var coords = resolveLiveCoords(row);
    return {
      id: row.id,
      placeName: row.placeName || row.name || row.address || row.id,
      address: row.address || '',
      date: row.date,
      timeStart: row.timeStart,
      timeEnd: row.timeEnd,
      lat: coords.lat,
      lng: coords.lng,
      status: row.status,
      bookingType: row.bookingType,
      vehicle: row.vehicle,
      driver: row.driver,
      customerServiceRoute: row.customerServiceRoute,
      transferRoute: row.transferRoute,
      routeGeometry: row.routeGeometry,
      routePoints: row.routePoints,
      adminCalculatedRoute: row.adminCalculatedRoute
    };
  }

  function fetchLiveInquiries() {
    return fetch(getLiveApiBase() + '/api/rent/inquiries', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.inquiries)) {
          throw new Error('LIVE_INQUIRIES_LOAD_FAILED');
        }
        return data.inquiries.map(normalizeLiveInquiry).filter(Boolean);
      });
  }

  function getTestFixtures() {
    return window.__INTEGRATION_TEST_FIXTURES || null;
  }

  function loadJson(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('JSON_LOAD_' + path);
      return r.json();
    });
  }

  function getDepots() {
    var fx = getTestFixtures();
    if (fx && fx.depots) return Promise.resolve(fx.depots);
    if (isLiveDataMode() && CFG.liveDepots) {
      depotsCache = CFG.liveDepots;
      return Promise.resolve(depotsCache);
    }
    if (depotsCache) return Promise.resolve(depotsCache);
    if (!isOfflineIntegration()) {
      return Promise.reject(new Error('DEPOTS_UNAVAILABLE'));
    }
    return loadJson('/integration_harness/fixtures/sample_depots.json').then(function (d) {
      depotsCache = d;
      return d;
    });
  }

  function getPreviousProjects() {
    var fx = getTestFixtures();
    if (fx && fx.previousProjects) return Promise.resolve(fx.previousProjects);
    if (isLiveDataMode()) {
      if (previousProjectsCache) return Promise.resolve(previousProjectsCache);
      return fetchLiveInquiries().then(function (rows) {
        previousProjectsCache = rows.filter(function (b) {
          return b.lat != null && b.lng != null;
        });
        return previousProjectsCache;
      });
    }
    if (previousProjectsCache) return Promise.resolve(previousProjectsCache);
    if (!isOfflineIntegration()) {
      return Promise.reject(new Error('PROJECTS_UNAVAILABLE'));
    }
    return loadJson('/integration_harness/fixtures/sample_previous_projects.json').then(function (d) {
      previousProjectsCache = d;
      return d;
    });
  }

  function getOperationalEvents() {
    var fx = getTestFixtures();
    if (fx && fx.operationalEvents) return Promise.resolve(fx.operationalEvents);
    if (isLiveDataMode()) {
      if (operationalEventsCache) return Promise.resolve(operationalEventsCache);
      return fetch(getLiveApiBase() + '/api/events?limit=3000', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          operationalEventsCache = (data && data.events) ? data.events : [];
          return operationalEventsCache;
        });
    }
    return Promise.resolve([]);
  }

  function getMatrixFixture() {
    var fx = getTestFixtures();
    if (fx && fx.matrix) return fx.matrix;
    if (isOfflineIntegration()) return null;
    return null;
  }

  function resolveSelectedBooking() {
    var bridge = window.__RENT_DEPOT_INTEGRATION_BRIDGE;
    if (bridge && bridge.getRouteTargetBooking) {
      var b = bridge.getRouteTargetBooking();
      if (b && b.lat != null && b.lng != null) return b;
    }
    var fx = getTestFixtures();
    if (fx && fx.booking) return fx.booking;
    return null;
  }

  function syncAdvisorBookingSelect() {
    if (window.IntegrationRouteWorkflow && window.IntegrationRouteWorkflow.syncBookingSelects) {
      window.IntegrationRouteWorkflow.syncBookingSelects();
    }
  }

  function isPastTargetBooking() {
    var booking = resolveSelectedBooking();
    if (!booking || !booking.date) return false;
    var endTime = booking.timeEnd || booking.timeStart || '23:59';
    var parts = String(endTime).split(':');
    var d = new Date(
      parseInt(booking.date.split('-')[0], 10),
      parseInt(booking.date.split('-')[1], 10) - 1,
      parseInt(booking.date.split('-')[2], 10),
      parseInt(parts[0], 10) || 23,
      parseInt(parts[1], 10) || 59,
      0
    );
    return d < new Date();
  }

  function formatRedeployableHeader(origins) {
    var eligible = origins.filter(function (o) { return OAS.isTop3Eligible(o); }).length;
    if (!eligible) return 'Továbbküldhető vonatok · jelenleg nincs ajánlható';
    return 'Továbbküldhető vonatok · ' + eligible + ' ajánlható';
  }

  function setStatus(msg, isError) {
    var el = $('advisorStatus');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
    el.style.color = isError ? '#f87171' : '#cbd5e1';
  }

  function originKey(origin) {
    return OAS ? OAS.getOriginKey(origin) : '';
  }

  function isEnabled(origin) {
    return enabledOriginKeys.has(originKey(origin));
  }

  function toggleOrigin(key, on) {
    if (on) enabledOriginKeys.add(key);
    else enabledOriginKeys.delete(key);
    rerenderAdvisorResults();
  }

  function rerenderAdvisorResults() {
    if (lastPayload) renderResults(lastPayload, lastUnifiedPayload, false);
  }

  function selectAllOrigins() {
    lastOriginList.forEach(function (o) { enabledOriginKeys.add(originKey(o)); });
    rerenderAdvisorResults();
  }

  function clearAllOrigins() {
    enabledOriginKeys.clear();
    rerenderAdvisorResults();
  }

  function selectFeasibleOnly() {
    enabledOriginKeys.clear();
    lastOriginList.forEach(function (o) {
      if (o.feasible !== false) enabledOriginKeys.add(originKey(o));
    });
    rerenderAdvisorResults();
  }

  function resetOrigins() {
    enabledOriginKeys = OAS.defaultEnabledKeys(lastOriginList);
    groupOpenState = OAS.defaultGroupOpenState();
    rerenderAdvisorResults();
  }

  function shortSourceType(origin) {
    if (origin.originType === 'DEPLOYABLE_TRAIN') return 'LEZÁRT VONAT';
    if (origin.originType === 'PREVIOUS_PROJECT') return 'ELŐZŐ PROJEKT';
    return 'TELEPHELY';
  }

  function typeBadge(origin) {
    if (origin.originType === 'DEPLOYABLE_TRAIN') {
      return origin.dataQuality === 'ACTUAL'
        ? (origin.eligible ? 'TÉNYLEGES LEZÁRT VONAT' : 'LEZÁRT VONAT')
        : 'TERVEZETT VONAT';
    }
    if (origin.originType === 'PREVIOUS_PROJECT') {
      return origin.eligible ? 'TOVÁBBKÜLDHETŐ ELŐZŐ PROJEKT' : 'ELŐZŐ PROJEKT';
    }
    return 'TELEPHELY';
  }

  function originDisplayName(origin) {
    return origin.humanDisplayName || origin.originName || origin.depotName || origin.originId || origin.depotId || '—';
  }

  function clearAdvisorStateForTargetChange() {
    lastOriginList = [];
    lastPayload = null;
    lastUnifiedPayload = null;
    lastDeployableAudit = null;
    lastAdvisorSnapshot = null;
    enabledOriginKeys = new Set();
    resetDetailOptionsUiState();
    var workflow = window.IntegrationRouteWorkflow;
    if (workflow && workflow.clearRouteActionState) workflow.clearRouteActionState();
    var wrap = $('advisorResults');
    if (wrap) {
      wrap.hidden = true;
      wrap.innerHTML = '';
    }
    var workflow = window.IntegrationRouteWorkflow;
    var booking = resolveSelectedBooking();
    if (workflow && workflow.clearTransferSelectionForBooking && booking && booking.id) {
      workflow.clearTransferSelectionForBooking(booking.id);
    }
  }

  function onAdvisorTargetBookingChanged() {
    var booking = resolveSelectedBooking();
    var id = booking && booking.id;
    if (id !== lastCompareTargetId) {
      clearAdvisorStateForTargetChange();
      lastCompareTargetId = id;
    }
  }

  var groupDisplayFilter = { depots: true, projects: true, deployableTrains: true };

  function renderCompactSummary(origin, rankNum) {
    var disabled = !isEnabled(origin);
    var key = originKey(origin);
    var travel = origin.transferTravelMinutes != null ? origin.transferTravelMinutes : origin.trainTravelMinutes;
    var statusText = origin.feasible !== false
      ? (origin.eligible ? 'Jogosult' : 'Kizárt')
      : 'Nem teljesíthető';
    return (
      '<div class="origin-compact-row' + (disabled ? ' is-disabled' : '') + '" data-origin-key="' + escapeHtml(key) + '">' +
        '<label class="origin-compact-check" title="Kijelölés">' +
          '<input type="checkbox" class="origin-enable-cb" data-origin-key="' + escapeHtml(key) + '"' + (disabled ? '' : ' checked') + ' aria-label="Indulási hely kijelölése" />' +
        '</label>' +
        (rankNum != null ? '<span class="origin-rank">#' + rankNum + '</span>' : '') +
        '<span class="origin-name" title="' + escapeHtml(originDisplayName(origin)) + '">' + escapeHtml(originDisplayName(origin)) + '</span>' +
        '<span class="origin-badge">' + escapeHtml(typeBadge(origin)) + '</span>' +
        '<span class="origin-metric">' + (origin.distanceKm != null ? String(origin.distanceKm).replace('.', ',') + ' km' : '—') + '</span>' +
        '<span class="origin-metric">' + (travel != null ? travel + ' p' : '—') + '</span>' +
        '<span class="origin-status' + (origin.feasible !== false && origin.eligible ? ' origin-feasible' : '') + '">' + escapeHtml(statusText) + '</span>' +
        '<details class="origin-details origin-details--inline">' +
          '<summary>Részletek</summary>' +
          '<div class="origin-details-body">' + renderDetailsBlock(origin) + '</div>' +
        '</details>' +
        '<button type="button" class="btn route xs origin-show-transfer-btn" data-origin-key="' + escapeHtml(key) + '" title="Kiállás – telephely / előző hely → indulási pont (előnézet, nem hozzárendelés)">Kiállás</button>' +
      '</div>'
    );
  }

  function renderRecommendedCard(origin, rankNum) {
    var key = originKey(origin);
    var travel = origin.transferTravelMinutes != null ? origin.transferTravelMinutes : origin.trainTravelMinutes;
    var reason = origin.rankReason || '—';
    return (
      '<div class="origin-rec-card" data-origin-key="' + escapeHtml(key) + '">' +
        '<span class="origin-rec-rank">#' + rankNum + '</span>' +
        '<div class="origin-rec-main">' +
          '<span class="origin-rec-name">' + escapeHtml(originDisplayName(origin)) + '</span>' +
          '<span class="origin-rec-type">' + escapeHtml(shortSourceType(origin)) + '</span>' +
        '</div>' +
        '<span class="origin-rec-metric">' + (origin.distanceKm != null ? String(origin.distanceKm).replace('.', ',') + ' km' : '—') + '</span>' +
        '<span class="origin-rec-metric">' + (travel != null ? travel + ' p' : '—') + '</span>' +
        '<span class="origin-rec-reason" title="' + escapeHtml(reason) + '">' + escapeHtml(reason) + '</span>' +
        '<button type="button" class="btn route xs origin-show-transfer-btn" data-origin-key="' + escapeHtml(key) + '" title="Kiállás – telephely / előző hely → indulási pont (előnézet, nem hozzárendelés)">Kiállás</button>' +
      '</div>'
    );
  }

  function renderExclusionReasonsBlock(origins) {
    var excluded = OAS.getExcludedOrigins(origins);
    if (!excluded.length) return '';
    var lines = excluded.slice(0, 16).map(function (o) {
      var label = o.exclusionLabel || (o.feasible === false ? 'Nem teljesíthető' : 'Kizárt');
      return '<div class="origin-exclusion-line"><strong>' + escapeHtml(originDisplayName(o)) + '</strong> · ' +
        escapeHtml(shortSourceType(o)) + ' – ' + escapeHtml(label) + '</div>';
    });
    return '<details class="origin-exclusion-summary">' +
      '<summary>Kizárási okok megtekintése (' + excluded.length + ')</summary>' +
      '<div class="origin-exclusion-body">' + lines.join('') + '</div></details>';
  }

  function renderRecommendedSection(top3, allOrigins) {
    var section = document.createElement('section');
    section.className = 'origin-recommended-section';
    section.id = 'originRecommendedSection';
    var heading = document.createElement('h4');
    heading.className = 'origin-recommended-heading';
    heading.textContent = 'AJÁNLOTT INDULÁSOK';
    section.appendChild(heading);
    var body = document.createElement('div');
    body.className = 'origin-recommended-body';
    if (isPastTargetBooking()) {
      var past = document.createElement('p');
      past.className = 'origin-past-booking-warn';
      past.textContent = 'Múltbeli célfoglalás – ehhez a foglaláshoz új indulási ajánlás nem készíthető.';
      body.appendChild(past);
    }
    if (!top3.length) {
      var empty = document.createElement('p');
      empty.className = 'origin-empty origin-empty--recommend';
      empty.textContent = 'Nincs jelenleg teljesíthető indulási lehetőség.';
      body.appendChild(empty);
      var exclusionHtml = renderExclusionReasonsBlock(allOrigins);
      if (exclusionHtml) {
        var wrap = document.createElement('div');
        wrap.innerHTML = exclusionHtml;
        while (wrap.firstChild) body.appendChild(wrap.firstChild);
      }
    } else {
      top3.forEach(function (o, i) {
        var div = document.createElement('div');
        div.innerHTML = renderRecommendedCard(o, i + 1);
        body.appendChild(div.firstChild);
      });
      wireTransferButtons(body);
    }
    section.appendChild(body);
    return section;
  }

  function renderDetailOptionsSection(split, actualDeployableTrains, excludedOrigins) {
    var details = document.createElement('details');
    details.className = 'origin-group origin-group--detail-master';
    details.id = 'originDetailOptionsMaster';
    details.open = detailOptionsUiState.initialized ? !!detailOptionsUiState.outerOpen : false;
    details.innerHTML = '<summary class="origin-group-title">Részletes lehetőségek</summary><div class="origin-group-body origin-group-body--nested"></div>';
    var body = details.querySelector('.origin-group-body');
    var redeployable = actualDeployableTrains.concat(split.projects);
    if (groupDisplayFilter.deployableTrains || groupDisplayFilter.projects) {
      body.appendChild(renderGroup(formatRedeployableHeader(redeployable), 'originGroupRedeployable', redeployable, false));
    }
    body.appendChild(renderGroup('Kizárt lehetőségek', 'originGroupExcluded', excludedOrigins, false));
    return details;
  }

  function renderDiagnosticsSection(audit, top3) {
    var details = document.createElement('details');
    details.className = 'origin-group origin-group--diagnostics';
    details.id = 'originDiagnosticsSection';
    details.open = false;
    details.innerHTML = '<summary class="origin-group-title">Részletes szűrők és diagnosztika</summary><div class="origin-group-body"></div>';
    var body = details.querySelector('.origin-group-body');
    body.appendChild(renderBulkToolbar());
    if (audit) {
      var auditBox = renderAuditSummary(audit, top3);
      if (auditBox) body.appendChild(auditBox);
    }
    return details;
  }

  function routeStatusElForBtn(btn) {
    var card = btn.closest('.origin-rec-card, .origin-compact-row');
    if (!card) return null;
    var key = btn.getAttribute('data-origin-key');
    var el = card.querySelector('.origin-route-action-status[data-origin-key="' + key + '"]');
    if (!el) {
      el = document.createElement('span');
      el.className = 'origin-route-action-status';
      el.setAttribute('data-origin-key', key || '');
      btn.parentNode.insertBefore(el, btn);
    }
    return el;
  }

  function setCardRouteActionStatus(el, status, message) {
    if (!el) return;
    el.className = 'origin-route-action-status origin-route-action-status--' + (status || 'idle');
    if (!message || status === 'success' || status === 'idle' || status === 'loading') {
      if (status !== 'loading') {
        el.hidden = true;
        el.textContent = '';
        return;
      }
    }
    el.hidden = false;
    el.textContent = message || '';
  }

  function wireTransferButtons(scope) {
    if (!scope) return;
    var workflow = window.IntegrationRouteWorkflow;
    scope.querySelectorAll('.origin-show-transfer-btn').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var key = btn.getAttribute('data-origin-key');
        var statusEl = routeStatusElForBtn(btn);
        btn.disabled = true;
        setCardRouteActionStatus(statusEl, 'loading', 'Kiállás számítása…');
        if (!workflow || !workflow.applyAdvisorTransferRoute) {
          setCardRouteActionStatus(statusEl, 'error', 'Transfer workflow nem elérhető.');
          btn.disabled = false;
          return;
        }
        workflow.applyAdvisorTransferRoute(key).then(function () {
          setCardRouteActionStatus(statusEl, 'success', '');
          btn.disabled = false;
        }).catch(function (err) {
          var state = workflow.getRouteActionState ? workflow.getRouteActionState(key) : null;
          var msg = (state && state.message) ? state.message : (err && err.message ? err.message : 'Kiállás nem számítható.');
          setCardRouteActionStatus(statusEl, 'error', msg);
          btn.disabled = false;
        });
      });
      if (workflow && workflow.getRouteActionState) {
        var key = btn.getAttribute('data-origin-key');
        var persisted = workflow.getRouteActionState(key);
        if (persisted && persisted.status && persisted.status !== 'idle' && persisted.status !== 'success') {
          setCardRouteActionStatus(routeStatusElForBtn(btn), persisted.status, persisted.message);
        }
      }
    });
  }

  function renderDetailsBlock(origin) {
    var lines = [];
    lines.push('<div class="origin-details-grid">');
    lines.push('<div>Indulás: ' + escapeHtml(originDisplayName(origin)) + '</div>');
    if (origin.originType === 'PREVIOUS_PROJECT') {
      lines.push('<div>Foglalás: ' + escapeHtml(origin.originBookingId || '—') + ' · ' + escapeHtml(origin.originProjectName || '—') + '</div>');
      lines.push('<div>Jármű/vonat: ' + escapeHtml(origin.originVehicleId || origin.previousVehicle || '—') + '</div>');
      lines.push('<div>Tervezett befejezés: ' + escapeHtml(origin.previousProjectEndLabel || '—') + ' @ ' + escapeHtml(origin.originEndLocation || '—') + '</div>');
      lines.push('<div>Következő célfoglalás: ' + escapeHtml(origin.nextProjectStartLabel || origin.targetLabel || '—') + '</div>');
      lines.push('<div>Időkülönbség: ' + (origin.gapHours != null ? origin.gapHours + ' óra (' + origin.gapMinutes + ' perc)' : (origin.gapMinutes != null ? origin.gapMinutes + ' perc' : '—')) + '</div>');
      lines.push('<div>Továbbküldési ablak: ' + (origin.transitionWindowHours != null ? origin.transitionWindowHours + ' óra' : '—') + '</div>');
      if (origin.depotAlternativeDistanceKm != null) {
        lines.push('<div>Telephelyi alternatíva: ' + origin.depotAlternativeDistanceKm + ' km' + (origin.depotAlternativeName ? ' (' + escapeHtml(origin.depotAlternativeName) + ')' : '') + '</div>');
      }
      if (origin.savedDistanceKm != null && origin.savedDistanceKm > 0) {
        lines.push('<div>Megtakarítás (közvetlen vs. telephely): ' + origin.savedDistanceKm + ' km</div>');
      }
      lines.push('<div>Adatminőség: ' + escapeHtml(origin.dataQualityLabel || 'TERVEZETT ELŐZŐ PROJEKT') + '</div>');
      if (origin.operationalControlNote) lines.push('<div class="origin-warn">' + escapeHtml(origin.operationalControlNote) + '</div>');
      lines.push('<div>Elfogadás/kizárás: ' + escapeHtml(origin.exclusionLabel || (origin.eligible ? 'Jogosult' : '—')) + '</div>');
    } else if (origin.originType === 'DEPLOYABLE_TRAIN') {
      lines.push('<div>Jármű: ' + escapeHtml(origin.originVehicleId || origin.previousVehicle || '—') + '</div>');
      lines.push('<div>Befejezés helye: ' + escapeHtml(origin.completionLocation || origin.originEndLocation || '—') + '</div>');
      lines.push('<div>Befejezés ideje: ' + escapeHtml(origin.completionTime ? String(origin.completionTime).replace('T', ' ').slice(0, 16) : (origin.previousProjectEndLabel || '—')) + '</div>');
      if (origin.lastPosition) {
        lines.push('<div>Utolsó pozíció: ' + origin.lastPosition.lat + ', ' + origin.lastPosition.lng + '</div>');
      }
      lines.push('<div>Utolsó pozíció időpontja: ' + escapeHtml(origin.lastPositionTimestamp ? String(origin.lastPositionTimestamp).replace('T', ' ').slice(0, 19) : '—') + '</div>');
      lines.push('<div>Pozíció forrása: ' + escapeHtml(origin.lastPositionSource || origin.sourceLabel || '—') + '</div>');
      lines.push('<div>Adatminőség: ' + escapeHtml(origin.dataQualityLabel || '—') + '</div>');
      lines.push('<div>Lezárás forrása: ' + escapeHtml(origin.closureSourceType || origin.sourceLabel || '—') + '</div>');
      lines.push('<div>Elfogadás/kizárás: ' + escapeHtml(origin.exclusionLabel || (origin.eligible ? 'Jogosult' : '—')) + '</div>');
    }
    lines.push('<div>Felkészülési tartalék: ' + (origin.preparationBufferMinutes != null ? origin.preparationBufferMinutes + ' perc' : '—') + '</div>');
    lines.push('<div>Kiállás távolság: ' + (origin.distanceKm != null ? origin.distanceKm + ' km' : '—') + '</div>');
    lines.push('<div>Kiállás menetidő: ' + (origin.transferTravelMinutes != null ? origin.transferTravelMinutes + ' perc' : (origin.trainTravelMinutes != null ? origin.trainTravelMinutes + ' perc' : '—')) + '</div>');
    lines.push('<div>Legkésőbbi indulás: ' + escapeHtml(origin.latestDepartureLabel || '—') + '</div>');
    lines.push('<div>Teljesíthetőség: ' + (origin.feasible !== false ? 'Teljesíthető' : 'Nem teljesíthető') + '</div>');
    if (origin.sameVehicle) lines.push('<div>Azonos jármű: tie-break bónusz</div>');
    if (origin.rankReason) lines.push('<div>Rangsorolás: ' + escapeHtml(origin.rankReason) + '</div>');
    if (origin.rankScore != null) lines.push('<div>Score: ' + origin.rankScore + '</div>');
    if (origin.eventId || origin.tripId || origin.shiftId || origin.rawBackendLabel) {
      lines.push('</div><details class="origin-tech-details"><summary>Technikai részletek</summary><div class="origin-details-body">' +
        (origin.eventId ? '<div>eventId: ' + escapeHtml(origin.eventId) + '</div>' : '') +
        (origin.tripId ? '<div>tripId: ' + escapeHtml(origin.tripId) + '</div>' : '') +
        (origin.shiftId ? '<div>shiftId: ' + escapeHtml(origin.shiftId) + '</div>' : '') +
        (origin.rawBackendLabel ? '<div>raw label: ' + escapeHtml(origin.rawBackendLabel) + '</div>' : '') +
        (origin.normalizedCandidateId ? '<div>candidateId: ' + escapeHtml(origin.normalizedCandidateId) + '</div>' : '') +
        '</div></details><div class="origin-details-grid">');
    }
    if (origin.warning && origin.originType !== 'PREVIOUS_PROJECT') lines.push('<div class="origin-warn">' + escapeHtml(origin.warning) + '</div>');
    lines.push('</div>');
    return lines.join('');
  }

  function renderAuditSummary(audit, top3) {
    if (!audit) return null;
    var box = document.createElement('details');
    box.className = 'origin-audit-summary origin-audit-summary--compact';
    box.id = 'originAuditSummary';
    var eligiblePrev = audit.eligiblePreviousProjects != null ? audit.eligiblePreviousProjects : 0;
    var normalized = audit.normalizedCandidateCount != null ? audit.normalizedCandidateCount : 0;
    var excluded = Math.max(0, normalized - eligiblePrev);
    var actualNorm = audit.normalizedActualTrainCount != null ? audit.normalizedActualTrainCount : 0;
    var actualEligible = audit.eligibleActualTrains != null ? audit.eligibleActualTrains : 0;
    var compactLine =
      (audit.rawEndedEventCount != null ? audit.rawEndedEventCount + ' lezáró esemény · ' : '') +
      actualNorm + ' ACTUAL vonat · ' + actualEligible + ' jogosult · ' +
      normalized + ' előző projekt · ' + eligiblePrev + ' továbbküldhető · ' +
      (audit.depotCount != null ? audit.depotCount : '—') + ' telephely';
    var countLines = audit.exclusionCounts
      ? Object.keys(audit.exclusionCounts).map(function (k) { return k + ': ' + audit.exclusionCounts[k]; }).join(' · ')
      : '—';
    box.innerHTML =
      '<summary class="origin-audit-summary__compact">' + escapeHtml(compactLine) + ' <span class="origin-audit-summary__more">Részletek</span></summary>' +
      '<div class="origin-audit-summary__body">' +
      '<div>Lezáró események (trip/shift end): ' + (audit.rawEndedEventCount || 0) + '</div>' +
      '<div>ACTUAL vonat normalizálva: ' + actualNorm + ' · Jogosult: ' + actualEligible + ' · Kizárt: ' + (audit.excludedActualTrainCount || Math.max(0, actualNorm - actualEligible)) + '</div>' +
      '<div>Vizsgált előző projektek: ' + (audit.previousProjectsChecked || 0) + '</div>' +
      '<div>Időablakon belül: ' + (audit.withinWindowCount || 0) + ' · Kívül: ' + (audit.excludedOutsideWindow || 0) + '</div>' +
      '<div>Továbbküldhető: ' + eligiblePrev + ' · Nincs jármű: ' + (audit.excludedNoVehicle || 0) + ' · Nincs koordináta: ' + (audit.excludedNoCoords || 0) + '</div>' +
      '<div>Átfedés: ' + (audit.excludedOverlap || 0) + ' · Nem teljesíthető: ' + (audit.excludedNotFeasible || 0) + '</div>' +
      '<div>Továbbküldési ablak: ' + (audit.transitionWindowHours || 24) + ' óra</div>' +
      '<div>Top 3: ' + (top3 ? top3.length : 0) + '</div>' +
      (audit.duplicatesRemoved ? '<div>Deduplikáció: ' + audit.duplicatesRemoved + ' eltávolítva</div>' : '') +
      (audit.nearby0711Audit ? '<div>07.11 foglalás (' + escapeHtml(audit.nearby0711Audit.bookingId) + '): ' + escapeHtml(audit.nearby0711Audit.exclusionLabel) + '</div>' : '') +
      '<div>Technikai kizárások: ' + escapeHtml(countLines) + '</div>' +
      '</div>';
    return box;
  }

  function renderBulkToolbar() {
    var bar = document.createElement('div');
    bar.className = 'origin-bulk-actions';
    bar.innerHTML =
      '<button type="button" class="btn ghost xs" id="btnOriginSelectAll">Mind kijelölése</button>' +
      '<button type="button" class="btn ghost xs" id="btnOriginClearAll">Kijelölések törlése</button>' +
      '<button type="button" class="btn ghost xs" id="btnOriginFeasibleOnly">Csak teljesíthetők</button>' +
      '<button type="button" class="btn ghost xs" id="btnOriginReset">Alaphelyzet</button>' +
      '<span class="origin-bulk-sep"></span>' +
      '<button type="button" class="btn ghost xs" id="btnFilterDepots">Telephelyek</button>' +
      '<button type="button" class="btn ghost xs" id="btnFilterDeployableTrains">Lezárt vonatok</button>' +
      '<button type="button" class="btn ghost xs" id="btnFilterProjects">Előző projektek</button>';
    bar.querySelector('#btnOriginSelectAll').addEventListener('click', selectAllOrigins);
    bar.querySelector('#btnOriginClearAll').addEventListener('click', clearAllOrigins);
    bar.querySelector('#btnOriginFeasibleOnly').addEventListener('click', selectFeasibleOnly);
    bar.querySelector('#btnOriginReset').addEventListener('click', resetOrigins);
    bar.querySelector('#btnFilterDepots').addEventListener('click', function () {
      groupDisplayFilter.depots = !groupDisplayFilter.depots;
      rerenderAdvisorResults();
    });
    bar.querySelector('#btnFilterDeployableTrains').addEventListener('click', function () {
      groupDisplayFilter.deployableTrains = !groupDisplayFilter.deployableTrains;
      rerenderAdvisorResults();
    });
    bar.querySelector('#btnFilterProjects').addEventListener('click', function () {
      groupDisplayFilter.projects = !groupDisplayFilter.projects;
      rerenderAdvisorResults();
    });
    return bar;
  }

  function renderGroup(title, id, origins, openDefault) {
    var details = document.createElement('details');
    details.className = 'origin-group';
    details.id = id;
    details.open = groupOpenFromState(id, openDefault);
    details.innerHTML =
      '<summary class="origin-group-title">' + escapeHtml(OAS.formatGroupHeaderTitle(title, origins)) + '</summary>' +
      '<div class="origin-group-body"></div>';
    var body = details.querySelector('.origin-group-body');
    if (!origins.length) {
      body.innerHTML = '<p class="origin-empty">Nincs elem.</p>';
      return details;
    }
    origins.forEach(function (o) {
      var div = document.createElement('div');
      div.innerHTML = renderCompactSummary(o, null);
      body.appendChild(div.firstChild);
    });
    body.querySelectorAll('.origin-enable-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        toggleOrigin(cb.getAttribute('data-origin-key'), cb.checked);
      });
    });
    wireTransferButtons(body);
    return details;
  }

  function renderResults(payload, unifiedPayload, resetEnabled) {
    var wrap = $('advisorResults');
    if (!wrap || !OAS) return;

    if (resetEnabled === false) {
      captureDetailOptionsUiStateFromDom();
    } else {
      resetDetailOptionsUiState();
    }

    wrap.hidden = false;
    wrap.innerHTML = '';
    advisorRenderCount += 1;

    lastPayload = payload;
    lastUnifiedPayload = unifiedPayload;

    var allOrigins = OAS.buildUnifiedOriginList(payload, unifiedPayload);
    if (resetEnabled !== false) {
      enabledOriginKeys = OAS.defaultEnabledKeys(allOrigins);
      groupOpenState = OAS.defaultGroupOpenState();
    }
    lastOriginList = allOrigins;

    var rankedAll = OAS.rankOrigins(allOrigins, enabledOriginKeys);
    var top3 = OAS.getTopRecommendations(rankedAll, 3);
    var split = OAS.splitByType(allOrigins);
    var actualDeployableTrains = split.deployableTrains.filter(function (o) {
      return o.dataQuality === 'ACTUAL';
    });
    var excludedOrigins = OAS.getExcludedOrigins(allOrigins);

    wrap.appendChild(renderRecommendedSection(top3, allOrigins));
    if (groupDisplayFilter.depots) {
      wrap.appendChild(renderGroup('Telephelyek', 'originGroupDepots', split.depots, false));
    }
    wrap.appendChild(renderDetailOptionsSection(split, actualDeployableTrains, excludedOrigins));

    if (unifiedPayload && unifiedPayload.deployableAudit) {
      unifiedPayload.deployableAudit.top3Count = top3.length;
      unifiedPayload.deployableAudit.depotCount = split.depots.length;
      unifiedPayload.deployableAudit.advisorStateConsistent = top3.every(function (o) {
        return OAS.isTop3Eligible(o);
      });
      lastDeployableAudit = unifiedPayload.deployableAudit;
    }

    lastAdvisorSnapshot = {
      targetBookingId: unifiedPayload && unifiedPayload.targetProject ? unifiedPayload.targetProject.id : lastCompareTargetId,
      top3Count: top3.length,
      eligiblePreviousProjects: lastDeployableAudit ? lastDeployableAudit.eligiblePreviousProjects : 0,
      top3: top3.map(function (o) { return OAS.getOriginKey(o); })
    };

    wrap.appendChild(renderDiagnosticsSection(lastDeployableAudit, top3));
    wireDetailOptionsUiState(wrap);
    var workflow = window.IntegrationRouteWorkflow;
    if (workflow && workflow.getSelectedOriginKey) {
      var booking = resolveSelectedBooking();
      workflow.markSelectedAdvisorCard(workflow.getSelectedOriginKey(booking && booking.id));
    }
  }

  function showUnavailable() {
    var wrap = $('advisorResults');
    if (!wrap) return;
    wrap.hidden = false;
    wrap.innerHTML = '<p class="origin-empty">A telephely-összehasonlítás jelenleg nem érhető el.</p>';
    setStatus('', false);
  }

  function runCompare() {
    setStatus('Számítás folyamatban…', false);
    $('advisorResults').hidden = true;

    Promise.all([getDepots(), getPreviousProjects(), getOperationalEvents()]).then(function (parts) {
      var depots = parts[0];
      var previousProjects = parts[1];
      var operationalEvents = parts[2];
      var booking = resolveSelectedBooking();
      if (!booking) throw new Error('Válasszon célfoglalást az összehasonlításhoz.');
      lastCompareTargetId = booking.id;

      var speed = parseFloat(($('routeSpeed') && $('routeSpeed').value) || CFG.configuredSpeedKmh || 30);
      var buffer = parseInt($('advisorBuffer').value, 10);
      if (isNaN(buffer)) buffer = CFG.preparationBufferMinutes || 30;
      var windowHours = parseFloat($('advisorPreviousProjectWindowHours').value);
      if (isNaN(windowHours)) windowHours = CFG.advisorPreviousProjectWindowHours || 24;
      windowHours = Math.max(1, Math.min(72, windowHours));

      var matrixFixture = getMatrixFixture();
      var compareOpts = {
        speedKmh: speed,
        bufferMinutes: buffer,
        windowHours: windowHours,
        depots: depots,
        operationalEvents: operationalEvents,
        evaluationTime: new Date()
      };
      if (matrixFixture) compareOpts.testFixtureMatrix = matrixFixture;

      return Adapter.compareDepotsToBooking(depots, booking, compareOpts).then(function (payload) {
        var unifiedPayload = null;
        if (Origin && Origin.buildUnifiedOrigins) {
          var evaluatedPack = Origin.evaluateAllPreviousProjects
            ? Origin.evaluateAllPreviousProjects(previousProjects, booking, compareOpts)
            : null;
          unifiedPayload = Origin.buildUnifiedOrigins(payload.results, previousProjects, booking, {
            speedKmh: speed,
            bufferMinutes: buffer,
            windowHours: windowHours,
            depots: depots,
            operationalEvents: operationalEvents,
            evaluatedPreviousPack: evaluatedPack
          });
        }
        return { payload: payload, unifiedPayload: unifiedPayload };
      });
    }).then(function (bundle) {
      renderResults(bundle.payload, bundle.unifiedPayload, true);
      setStatus('', false);
    }).catch(function (err) {
      console.error('[DEPOT ADVISOR]', err);
      if (String(err && err.message).indexOf('ROUTING_UNAVAILABLE') >= 0 && !getMatrixFixture()) {
        showUnavailable();
        return;
      }
      setStatus(err && err.message ? err.message : 'Ismeretlen hiba', true);
      showUnavailable();
    });
  }

  function bindUi() {
    var compareBtn = $('btnAdvisorCompare');
    if (compareBtn) compareBtn.addEventListener('click', runCompare);
    syncAdvisorBookingSelect();
    var routeSel = $('routeBookingId');
    if (routeSel) routeSel.addEventListener('change', onAdvisorTargetBookingChanged);
    var speed = $('routeSpeed');
    var buffer = $('advisorBuffer');
    var windowH = $('advisorPreviousProjectWindowHours');
    function rerunIfVisible() {
      if ($('advisorResults') && !$('advisorResults').hidden) runCompare();
    }
    if (speed) speed.addEventListener('change', rerunIfVisible);
    if (buffer) buffer.addEventListener('change', rerunIfVisible);
    if (windowH) windowH.addEventListener('change', rerunIfVisible);
  }

  window.__ORIGIN_ADVISOR_STATE = {
    getEnabledKeys: function () { return new Set(enabledOriginKeys); },
    getLastOriginList: function () { return lastOriginList.slice(); },
    getLastDeployableAudit: function () { return lastDeployableAudit; },
    getLastAdvisorSnapshot: function () { return lastAdvisorSnapshot; },
    clearForTargetChange: clearAdvisorStateForTargetChange,
    getTop3: function () {
      if (!OAS) return [];
      return OAS.getTopRecommendations(OAS.rankOrigins(lastOriginList, enabledOriginKeys), 3);
    },
    getAdvisorAuditSnapshot: function () {
      var split = OAS ? OAS.splitByType(lastOriginList) : { depots: [], projects: [], deployableTrains: [] };
      var actualTrains = split.deployableTrains.filter(function (o) { return o.dataQuality === 'ACTUAL'; });
      var top3 = OAS ? OAS.getTopRecommendations(OAS.rankOrigins(lastOriginList, enabledOriginKeys), 3) : [];
      var excluded = OAS ? OAS.getExcludedOrigins(lastOriginList) : [];
      return {
        targetBookingId: lastCompareTargetId,
        unifiedOriginCount: lastOriginList.length,
        top3Count: top3.length,
        top3Items: top3.map(function (o) {
          return {
            originKey: OAS.getOriginKey(o),
            originType: o.originType,
            displayName: originDisplayName(o),
            eligible: o.eligible,
            feasible: o.feasible,
            distanceKm: o.distanceKm,
            durationMinutes: o.transferTravelMinutes != null ? o.transferTravelMinutes : o.trainTravelMinutes,
            score: o.rankScore,
            exclusionReasons: o.exclusionReasons || []
          };
        }),
        depotTotalCount: split.depots.length,
        depotEligibleCount: split.depots.filter(OAS.isTop3Eligible).length,
        actualTrainTotalCount: actualTrains.length,
        actualTrainEligibleCount: actualTrains.filter(OAS.isTop3Eligible).length,
        previousProjectTotalCount: split.projects.length,
        previousProjectEligibleCount: split.projects.filter(OAS.isTop3Eligible).length,
        excludedTotalCount: excluded.length
      };
    },
    getAdvisorRenderCount: function () { return advisorRenderCount; }
  };

  function init() {
    if (!Adapter || !OAS) {
      console.error('DepotMatrixAdapter or OriginAdvisorState missing');
      return;
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUi);
    else bindUi();
  }

  init();
})();
