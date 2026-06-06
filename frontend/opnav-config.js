/**
 * Operativ Navigator – production API URL (Render).
 * Localhost-on nem ír felül: a frontends getApiBase() → http://localhost:3000
 *
 * Netlify / éles: állítsd be a Render backend URL-t (vagy Netlify env injekció).
 */
(function (global) {
    if (global.OPNAV_API_BASE) return;
    var host = global.location && global.location.hostname;
    if (!host || host === 'localhost' || host === '127.0.0.1') return;
    global.OPNAV_API_BASE = 'https://operativ-navigator.onrender.com';
})(typeof window !== 'undefined' ? window : this);
