(function (global) {
  'use strict';

  var GEOJSON_MIME = 'application/geo+json;charset=utf-8';
  var REVOKE_DELAY_MS = 500;

  function downloadJsonBlob(filename, payload) {
    if (!filename) return false;
    var json = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: GEOJSON_MIME });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.style.display = 'none';
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, REVOKE_DELAY_MS);
    return true;
  }

  function sanitizeFilenameSegment(value, fallback) {
    var s = String(value == null ? '' : value);
    s = s.replace(/[\x00-\x1f\\\/:*?"<>|]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[.\s]+|[.\s]+$/g, '');
    if (!s) return fallback || '';
    return s;
  }

  function sanitizeOriginLabelForFilename(label) {
    var s = sanitizeFilenameSegment(label, '');
    if (!s) return '';
    return s.replace(/\s+/g, '_');
  }

  function ensureGeoJsonExtension(filename) {
    var name = String(filename || 'route.geojson');
    if (!/\.geojson$/i.test(name)) name += '.geojson';
    return name;
  }

  function enrichRouteFeatureProperties(properties, extras) {
    var out = Object.assign({}, properties || {});
    extras = extras || {};
    Object.keys(extras).forEach(function (key) {
      if (extras[key] != null) out[key] = extras[key];
    });
    return out;
  }

  function routeMetaToFeatureExtras(meta) {
    if (!meta) return {};
    return {
      targetName: meta.targetName != null ? meta.targetName : null,
      routeType: meta.routeType != null ? meta.routeType : null,
      source: meta.source != null ? meta.source : null,
      isSaved: meta.isSaved != null ? meta.isSaved : null,
      distanceKm: meta.distanceKm != null ? meta.distanceKm : null,
      travelMinutes: meta.travelMinutes != null ? meta.travelMinutes : null,
      roundTripKm: meta.roundTripKm != null ? meta.roundTripKm : null,
      roundTripMinutes: meta.roundTripMinutes != null ? meta.roundTripMinutes : null
    };
  }

  var api = {
    GEOJSON_MIME: GEOJSON_MIME,
    REVOKE_DELAY_MS: REVOKE_DELAY_MS,
    downloadJsonBlob: downloadJsonBlob,
    sanitizeFilenameSegment: sanitizeFilenameSegment,
    sanitizeOriginLabelForFilename: sanitizeOriginLabelForFilename,
    ensureGeoJsonExtension: ensureGeoJsonExtension,
    enrichRouteFeatureProperties: enrichRouteFeatureProperties,
    routeMetaToFeatureExtras: routeMetaToFeatureExtras
  };

  global.GeoJsonDownloadUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
