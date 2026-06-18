/**
 * Operativ Navigator – központi környezetfelismerés (alias: opnav-config.js ugyanez).
 * LOCAL: localhost / 127.0.0.1 → http://localhost:3000
 * PRODUCTION: minden más → https://operativ-navigator.onrender.com
 */
(function (global) {
    if (global.OPNAV_ENV) return;

    var PRODUCTION_API = 'https://operativ-navigator.onrender.com';

    function isLocalHost() {
        var host = global.location && global.location.hostname;
        return !host || host === 'localhost' || host === '127.0.0.1';
    }

    function isLocalApiUrl(url) {
        if (!url) return false;
        return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(String(url).trim());
    }

    function getApiBase() {
        if (global.OPNAV_API_BASE) {
            return String(global.OPNAV_API_BASE).replace(/\/+$/, '');
        }
        if (isLocalHost()) {
            return 'http://localhost:3000';
        }
        return PRODUCTION_API;
    }

    function resolveApiBase(override) {
        var v = override != null ? String(override).trim() : '';
        if (v && !isLocalHost() && isLocalApiUrl(v)) {
            v = '';
        }
        if (v) return v.replace(/\/+$/, '');
        return getApiBase();
    }

    if (!global.OPNAV_API_BASE && !isLocalHost()) {
        global.OPNAV_API_BASE = PRODUCTION_API;
    }

    global.OPNAV_ENV = {
        PRODUCTION_API: PRODUCTION_API,
        isLocalHost: isLocalHost,
        isLocalApiUrl: isLocalApiUrl,
        getApiBase: getApiBase,
        resolveApiBase: resolveApiBase
    };
})(typeof window !== 'undefined' ? window : this);
