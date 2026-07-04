(function (global) {
  'use strict';

  function resolveIntegrationApiBase() {
    if (global.OPNAV_API_BASE) {
      return String(global.OPNAV_API_BASE).replace(/\/+$/, '');
    }
    if (global.OPNAV_ENV && global.OPNAV_ENV.getApiBase) {
      return global.OPNAV_ENV.getApiBase();
    }
    if (global.location && global.location.protocol && /^https?:$/i.test(global.location.protocol)) {
      return global.location.origin.replace(/\/+$/, '');
    }
    return null;
  }

  global.DEPOT_MATRIX_CONFIG = {
    runtimeMode: 'LIVE_WRITE_INTEGRATION',
    integrationLab: false,
    readOnlyIntegration: false,
    allowBusinessApiRead: true,
    allowBusinessApiWrite: true,
    allowRoutingRequests: true,
    allowRoutingGetOnly: true,
    allowMockData: false,
    configuredSpeedKmh: 30,
    preparationBufferMinutes: 30,
    advisorPreviousProjectWindowHours: 24,
    advisorClosurePositionMaxLagMinutes: 120,
    advisorOperationalPositionMaxAgeMinutes: 120,
    advisorPositionFreshnessMaxMinutes: 120,
    businessThresholdReviewRequired: true,
    liveApiBase: resolveIntegrationApiBase(),
    osrmBase: 'https://router.project-osrm.org/route/v1',
    valhallaUrl: 'https://valhalla1.openstreetmap.de/route',
    valhallaRouteUrl: 'https://valhalla1.openstreetmap.de/route',
    valhallaMatrixUrl: 'https://valhalla1.openstreetmap.de/sources_to_targets',
    avoidHighways: true,
    vehicleFuelConfig: {
      source: 'DEPOT_MATRIX_CONFIG.vehicleFuelConfig',
      consumptionLitresPer100Km: null,
      fuelPricePerLitre: null
    },
    liveDepots: [
      { id: 'TATA', name: 'Tata', address: 'Tata', lat: 47.649, lng: 18.318 },
      { id: 'SZFV', name: 'Székesfehérvár', address: 'Székesfehérvár', lat: 47.192, lng: 18.411 },
      { id: 'GYOR', name: 'Győr', address: 'Győr', lat: 47.687, lng: 17.635 },
      { id: 'PAPA', name: 'Pápa', address: 'Pápa', lat: 47.330, lng: 17.467 },
      { id: 'VAC', name: 'Vác', address: 'Vác', lat: 47.775, lng: 19.134 },
      { id: 'EGER', name: 'Eger', address: 'Eger', lat: 47.902, lng: 20.377 }
    ]
  };
})(typeof window !== 'undefined' ? window : this);
