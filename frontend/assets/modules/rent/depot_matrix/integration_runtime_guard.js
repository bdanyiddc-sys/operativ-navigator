(function (global) {
  'use strict';

  var CFG = global.DEPOT_MATRIX_CONFIG || {};
  var blockedCount = 0;
  var writeBlockedCount = 0;
  var swBlocked = 0;
  var WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
  var ROUTING_HOSTS = /valhalla|osrm|nominatim|openstreetmap\.de|router\.project-osrm\.org/i;
  var BUSINESS_API = /\/api\//i;

  function normalizeHost(host) {
    var h = String(host || '').toLowerCase();
    return h === 'localhost' ? '127.0.0.1' : h;
  }

  function resolveBusinessApiBase() {
    if (global.OPNAV_API_BASE) {
      return String(global.OPNAV_API_BASE).replace(/\/+$/, '');
    }
    if (global.OPNAV_ENV && global.OPNAV_ENV.getApiBase) {
      return global.OPNAV_ENV.getApiBase();
    }
    if (CFG.liveApiBase) {
      return String(CFG.liveApiBase).replace(/\/+$/, '');
    }
    if (global.location && global.location.protocol && /^https?:$/i.test(global.location.protocol)) {
      return global.location.origin.replace(/\/+$/, '');
    }
    return '';
  }

  function getLiveApiBase() {
    return resolveBusinessApiBase();
  }

  function parseApiEndpoint(url) {
    try {
      return new URL(url, global.location ? global.location.origin : 'http://127.0.0.1');
    } catch (_err) {
      return null;
    }
  }

  function endpointOriginKey(endpoint) {
    if (!endpoint) return '';
    var port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
    return normalizeHost(endpoint.hostname) + ':' + String(port);
  }

  function isCanonicalBusinessApiEndpoint(url) {
    var endpoint = parseApiEndpoint(url);
    var canonical = resolveBusinessApiBase();
    if (!endpoint || !canonical) return false;
    var canonicalEndpoint = parseApiEndpoint(canonical);
    if (!canonicalEndpoint) return false;
    return endpointOriginKey(endpoint) === endpointOriginKey(canonicalEndpoint);
  }

  function normalizeRequest(input, init) {
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    return { method: method, url: url };
  }

  function rewriteBusinessApiUrl(url) {
    if (!url) return url;
    if (url.indexOf('/api/') === 0) {
      var canonical = resolveBusinessApiBase();
      return canonical ? canonical + url : url;
    }
    if (global.location && url.indexOf(global.location.origin + '/api/') === 0) {
      return url;
    }
    return url;
  }

  function classifyLiveReadOnly(method, url) {
    var m = String(method || 'GET').toUpperCase();
    var u = String(url || '');
    var rewritten = rewriteBusinessApiUrl(u);
    var isBusinessApi = BUSINESS_API.test(rewritten) || BUSINESS_API.test(u);
    var isRouting = ROUTING_HOSTS.test(rewritten) || ROUTING_HOSTS.test(u);

    if (isRouting && CFG.allowRoutingRequests) {
      if (m === 'GET' || m === 'POST') {
        return { ok: true, rewrite: rewritten, routing: true };
      }
    }

    if (WRITE_METHODS.indexOf(m) >= 0) {
      return { ok: false, reason: 'WRITE_BLOCKED', rewrite: rewritten };
    }
    if (m === 'GET' && isBusinessApi && CFG.allowBusinessApiRead) {
      if (!isCanonicalBusinessApiEndpoint(rewritten)) {
        return { ok: false, reason: 'READ_TARGET_NOT_ALLOWED', rewrite: rewritten };
      }
      return { ok: true, rewrite: rewritten };
    }
    if (m === 'GET' && isRouting && CFG.allowRoutingRequests) {
      return { ok: true, rewrite: rewritten };
    }
    if (m === 'GET' && rewritten.indexOf(getLiveApiBase() + '/api/') === 0) {
      return { ok: true, rewrite: rewritten };
    }
    if (m === 'GET' && global.location && u.indexOf(global.location.origin) === 0) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET' && (u.indexOf('/frontend/') === 0 || u.indexOf('/integration_harness/') === 0 || u.indexOf('/assets/') === 0)) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET' && !/^https?:\/\//i.test(u)) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET' && /unpkg\.com|cartocdn\.com|arcgisonline\.com|tile\.openstreetmap/i.test(u)) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET') {
      return { ok: true, rewrite: rewritten };
    }
    return { ok: false, reason: 'LIVE_READ_BLOCKED', rewrite: rewritten };
  }

  function classifyLiveWriteIntegration(method, url) {
    var m = String(method || 'GET').toUpperCase();
    var u = String(url || '');
    var rewritten = rewriteBusinessApiUrl(u);
    var isBusinessApi = BUSINESS_API.test(rewritten) || BUSINESS_API.test(u);
    var isRouting = ROUTING_HOSTS.test(rewritten) || ROUTING_HOSTS.test(u);

    if (isRouting && CFG.allowRoutingRequests) {
      if (m === 'GET' || m === 'POST') {
        return { ok: true, rewrite: rewritten, routing: true };
      }
    }

    if (WRITE_METHODS.indexOf(m) >= 0) {
      if (!CFG.allowBusinessApiWrite) {
        return { ok: false, reason: 'WRITE_BLOCKED', rewrite: rewritten };
      }
      if (isBusinessApi) {
        if (!isCanonicalBusinessApiEndpoint(rewritten)) {
          return { ok: false, reason: 'WRITE_TARGET_NOT_ALLOWED', rewrite: rewritten };
        }
        return { ok: true, rewrite: rewritten };
      }
      return { ok: false, reason: 'WRITE_BLOCKED', rewrite: rewritten };
    }

    if (m === 'GET' && isBusinessApi && CFG.allowBusinessApiRead) {
      if (!isCanonicalBusinessApiEndpoint(rewritten)) {
        return { ok: false, reason: 'READ_TARGET_NOT_ALLOWED', rewrite: rewritten };
      }
      return { ok: true, rewrite: rewritten };
    }
    if (m === 'GET' && isRouting && CFG.allowRoutingRequests) {
      return { ok: true, rewrite: rewritten };
    }
    if (m === 'GET' && global.location && u.indexOf(global.location.origin) === 0) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET' && (u.indexOf('/frontend/') === 0 || u.indexOf('/integration_harness/') === 0 || u.indexOf('/assets/') === 0)) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET' && !/^https?:\/\//i.test(u)) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET' && /unpkg\.com|cartocdn\.com|arcgisonline\.com|tile\.openstreetmap/i.test(u)) {
      return { ok: true, rewrite: u };
    }
    if (m === 'GET') {
      return { ok: true, rewrite: rewritten };
    }
    return { ok: false, reason: 'LIVE_WRITE_BLOCKED', rewrite: rewritten };
  }

  function classifyOffline(method, url) {
    var m = String(method || 'GET').toUpperCase();
    var u = String(url || '');
    var sameOrigin = u.indexOf('http') !== 0 || (global.location && u.indexOf(global.location.origin) === 0);
    if (/\/api\/rent\//i.test(u)) return { ok: false, reason: 'BUSINESS_API_BLOCKED', rewrite: u };
    if (ROUTING_HOSTS.test(u)) return { ok: false, reason: 'ROUTING_BLOCKED', rewrite: u };
    if (WRITE_METHODS.indexOf(m) >= 0) return { ok: false, reason: 'WRITE_BLOCKED', rewrite: u };
    if (m === 'GET' && sameOrigin) return { ok: true, rewrite: u };
    if (!sameOrigin) return { ok: false, reason: 'EXTERNAL_BLOCKED', rewrite: u };
    return { ok: true, rewrite: u };
  }

  function classify(method, url) {
    if (CFG.runtimeMode === 'LIVE_READ_ONLY_AUDIT') return classifyLiveReadOnly(method, url);
    if (CFG.runtimeMode === 'LIVE_WRITE_INTEGRATION') return classifyLiveWriteIntegration(method, url);
    if (CFG.runtimeMode === 'OFFLINE_INTEGRATION_AUDIT') return classifyOffline(method, url);
    return { ok: true, rewrite: url };
  }

  function recordBlock(verdict) {
    blockedCount += 1;
    if (verdict && verdict.reason === 'WRITE_BLOCKED') writeBlockedCount += 1;
  }

  if (global.fetch) {
    var nativeFetch = global.fetch.bind(global);
    global.fetch = function (input, init) {
      var req = normalizeRequest(input, init);
      var verdict = classify(req.method, req.url);
      if (!verdict.ok) {
        recordBlock(verdict);
        return Promise.reject(new Error('INTEGRATION_GUARD_BLOCKED:' + verdict.reason));
      }
      if (verdict.rewrite && verdict.rewrite !== req.url) {
        return nativeFetch(verdict.rewrite, init);
      }
      return nativeFetch(input, init);
    };
  }

  if (global.navigator && global.navigator.sendBeacon) {
    var nativeBeacon = global.navigator.sendBeacon.bind(global.navigator);
    global.navigator.sendBeacon = function (url) {
      var verdict = classify('POST', url);
      if (!verdict.ok) {
        writeBlockedCount += 1;
        blockedCount += 1;
        return false;
      }
      return nativeBeacon(verdict.rewrite || url);
    };
  }

  if (global.XMLHttpRequest && global.XMLHttpRequest.prototype) {
    var nativeOpen = global.XMLHttpRequest.prototype.open;
    var nativeSend = global.XMLHttpRequest.prototype.send;
    global.XMLHttpRequest.prototype.open = function (method, url) {
      this.__integrationGuardMethod = String(method || 'GET').toUpperCase();
      this.__integrationGuardUrl = url;
      return nativeOpen.apply(this, arguments);
    };
    global.XMLHttpRequest.prototype.send = function () {
      var verdict = classify(this.__integrationGuardMethod, this.__integrationGuardUrl);
      if (!verdict.ok) {
        recordBlock(verdict);
        throw new Error('INTEGRATION_GUARD_BLOCKED:' + verdict.reason);
      }
      return nativeSend.apply(this, arguments);
    };
  }

  if (global.document && global.document.addEventListener) {
    global.document.addEventListener('submit', function (evt) {
      var form = evt.target;
      if (form && (form.id === 'admin-login-form' || form.getAttribute('data-live-readonly-allow') === 'true')) {
        return;
      }
      if (CFG.runtimeMode === 'LIVE_WRITE_INTEGRATION' && CFG.allowBusinessApiWrite) {
        return;
      }
      writeBlockedCount += 1;
      blockedCount += 1;
      evt.preventDefault();
      evt.stopPropagation();
    }, true);
  }

  if (CFG.runtimeMode === 'LIVE_READ_ONLY_AUDIT' && global.navigator && global.navigator.serviceWorker) {
    var nativeRegister = global.navigator.serviceWorker.register.bind(global.navigator.serviceWorker);
    global.navigator.serviceWorker.register = function () {
      swBlocked += 1;
      return Promise.reject(new Error('INTEGRATION_GUARD_SW_BLOCKED'));
    };
  }

  if (CFG.runtimeMode === 'OFFLINE_INTEGRATION_AUDIT' && global.navigator && global.navigator.serviceWorker) {
    var nativeRegisterOffline = global.navigator.serviceWorker.register.bind(global.navigator.serviceWorker);
    global.navigator.serviceWorker.register = function () {
      swBlocked += 1;
      return Promise.reject(new Error('INTEGRATION_GUARD_SW_BLOCKED'));
    };
  }

  global.__INTEGRATION_RUNTIME_GUARD_STATS = {
    get blockedCount() { return blockedCount; },
    get writeBlockedCount() { return writeBlockedCount; },
    get serviceWorkerBlocked() { return swBlocked; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
