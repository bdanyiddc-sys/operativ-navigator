(function () {
  'use strict';

  var RTA = window.RouteTypeAdapter;
  var customerRouteLayer = null;
  var transferRouteLayer = null;
  var legendControl = null;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function getMap() {
    return window.__rentMap || null;
  }

  function getBridge() {
    return window.__RENT_DEPOT_INTEGRATION_BRIDGE || null;
  }

  function getVisibilityPolicy() {
    var bridge = getBridge();
    if (bridge && bridge.getMapRouteVisibilityPolicy) {
      return bridge.getMapRouteVisibilityPolicy();
    }
    return { showTransfer: false, showCustomer: false, bookingId: null };
  }

  function resolveDisplayBooking() {
    var policy = getVisibilityPolicy();
    if (!policy.showTransfer && !policy.showCustomer) return null;
    var bridge = getBridge();
    if (!bridge) return null;
    if (policy.bookingId && bridge.getBookingById) {
      return bridge.getBookingById(policy.bookingId);
    }
    if (bridge.getRouteTargetBooking) return bridge.getRouteTargetBooking();
    var fx = window.__INTEGRATION_TEST_FIXTURES;
    return fx && fx.booking ? fx.booking : null;
  }

  function getCalculatedState() {
    var bridge = getBridge();
    return bridge && bridge.getCalculatedRouteState ? bridge.getCalculatedRouteState() : null;
  }

  function countTransferPolylines() {
    if (!transferRouteLayer || !transferRouteLayer.getLayers) return 0;
    return transferRouteLayer.getLayers().filter(function (layer) {
      return layer instanceof L.Polyline;
    }).length;
  }

  function buildPopupHtml(popup) {
    if (!popup) return '';
    var rows = [
      ['Típus', popup.routeTypeLabel || popup.routeType],
      ['Távolság', popup.distanceKm != null ? popup.distanceKm + ' km' : '—'],
      ['Menetidő', popup.estimatedDurationMinutes != null ? popup.estimatedDurationMinutes + ' perc' : '—']
    ];
    if (popup.originLabel) rows.push(['Indulás', popup.originLabel]);
    return rows.map(function (r) {
      return '<div><strong>' + escapeHtml(r[0]) + ':</strong> ' + escapeHtml(r[1]) + '</div>';
    }).join('');
  }

  function drawTypedRoute(routeNorm, layer, style) {
    if (!layer || !routeNorm || !routeNorm.geometry || !RTA) return;
    layer.clearLayers();
    var coords = routeNorm.geometry.coordinates.map(function (c) {
      return [c[1], c[0]];
    });
    var line = L.polyline(coords, style).addTo(layer);
    line.bindPopup(buildPopupHtml(routeNorm.popup));
    return line;
  }

  function clearAllRouteLayers() {
    if (customerRouteLayer) customerRouteLayer.clearLayers();
    if (transferRouteLayer) transferRouteLayer.clearLayers();
    var exportCustomer = $('btnGisExportCustomerRoute');
    var exportTransfer = $('btnGisExportTransferRoute');
    if (exportCustomer) exportCustomer.disabled = true;
    if (exportTransfer) exportTransfer.disabled = true;
  }

  function refreshDualRoutes() {
    if (!RTA) return;
    var policy = getVisibilityPolicy();
    if (!policy.showTransfer && !policy.showCustomer) {
      clearAllRouteLayers();
      return;
    }
    var booking = resolveDisplayBooking();
    var bridge = getBridge();
    var formState = (bridge && bridge.getRouteFormState && booking && booking.id)
      ? bridge.getRouteFormState(booking.id)
      : {};
    var calc = getCalculatedState();
    var customer = policy.showCustomer
      ? RTA.normalizeCustomerServiceRoute(booking, formState)
      : null;
    var transfer = policy.showTransfer
      ? RTA.normalizeTransferRoute(booking, formState, calc)
      : null;
    if (customerRouteLayer) customerRouteLayer.clearLayers();
    if (transferRouteLayer) transferRouteLayer.clearLayers();
    if (customer) {
      drawTypedRoute(customer, customerRouteLayer, {
        color: '#a855f7',
        weight: 5,
        opacity: 0.92
      });
    }
    if (transfer) {
      drawTypedRoute(transfer, transferRouteLayer, {
        color: '#f97316',
        weight: 5,
        opacity: 0.9,
        dashArray: '10 8'
      });
    }
    var exportCustomer = $('btnGisExportCustomerRoute');
    var exportTransfer = $('btnGisExportTransferRoute');
    if (exportCustomer) exportCustomer.disabled = !customer;
    if (exportTransfer) exportTransfer.disabled = !transfer;
    if (window.IntegrationRouteWorkflow && window.IntegrationRouteWorkflow.renderDualRouteDetails) {
      window.IntegrationRouteWorkflow.renderDualRouteDetails();
    }
  }

  function downloadGeoJson(routeType, routeNorm, booking) {
    if (!RTA || !routeNorm) return;
    RTA.downloadRouteGeoJson(routeType, routeNorm, booking, {
      originLabel: routeNorm.originLabel || null
    });
  }

  function bindExportButtons() {
    var btnC = $('btnGisExportCustomerRoute');
    var btnT = $('btnGisExportTransferRoute');
    if (btnC) {
      btnC.addEventListener('click', function () {
        var booking = resolveDisplayBooking();
        var bridge = getBridge();
        var formState = (bridge && bridge.getRouteFormState && booking && booking.id)
          ? bridge.getRouteFormState(booking.id)
          : {};
        var customer = RTA.normalizeCustomerServiceRoute(booking, formState);
        downloadGeoJson(RTA.ROUTE_TYPE.CUSTOMER_SERVICE_ROUTE, customer, booking);
      });
    }
    if (btnT) {
      btnT.addEventListener('click', function () {
        var booking = resolveDisplayBooking();
        var bridge = getBridge();
        var formState = (bridge && bridge.getRouteFormState && booking && booking.id)
          ? bridge.getRouteFormState(booking.id)
          : {};
        var calc = getCalculatedState();
        var transfer = RTA.normalizeTransferRoute(booking, formState, calc);
        downloadGeoJson(RTA.ROUTE_TYPE.TRANSFER_ROUTE, transfer, booking);
      });
    }
  }

  function addLegend(map) {
    if (!map || legendControl) return;
    legendControl = L.control({ position: 'bottomright' });
    legendControl.onAdd = function () {
      var div = L.DomUtil.create('details', 'map-route-legend');
      div.innerHTML =
        '<summary>Jelmagyarázat</summary>' +
        '<div class="map-route-legend__row"><span class="map-route-legend__swatch is-customer"></span><span>Megrendelői útvonal</span></div>' +
        '<div class="map-route-legend__row"><span class="map-route-legend__swatch is-transfer"></span><span>Kiállás</span></div>';
      return div;
    };
    legendControl.addTo(map);
  }

  function initLayers(map) {
    customerRouteLayer = L.layerGroup().addTo(map);
    transferRouteLayer = L.layerGroup().addTo(map);
    addLegend(map);
    bindExportButtons();
    refreshDualRoutes();
  }

  function waitForAdminReady() {
    function tryInit() {
      var map = getMap();
      if (!map || !RTA) return false;
      initLayers(map);
      window.__RENT_DEPOT_ROUTE_INTEGRATION = {
        refreshDualRoutes: refreshDualRoutes,
        clearAllRouteLayers: clearAllRouteLayers,
        countTransferPolylines: countTransferPolylines,
        getCustomerLayer: function () { return customerRouteLayer; },
        getTransferLayer: function () { return transferRouteLayer; },
        getRouteFormState: function (bookingId) {
          var bridge = window.__RENT_DEPOT_INTEGRATION_BRIDGE;
          return bridge && bridge.getRouteFormState ? bridge.getRouteFormState(bookingId) : {};
        }
      };
      return true;
    }
    if (tryInit()) return;
    window.addEventListener('rent-admin-ready', function () { tryInit(); });
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (tryInit() || attempts > 50) clearInterval(timer);
    }, 200);
  }

  waitForAdminReady();
})();
