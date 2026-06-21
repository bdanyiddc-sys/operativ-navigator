(function () {
    'use strict';

    var SPLASH_KEY = 'splash_seen';
    var SPLASH_MS = 5500;

    if (document.documentElement.classList.contains('kv-splash-skip')) return;

    var splash = document.getElementById('kv-splash');
    if (!splash) return;

    var done = false;

    function finish() {
        if (done) return;
        done = true;
        try { sessionStorage.setItem(SPLASH_KEY, 'true'); } catch (e) { /* ignore */ }
        splash.classList.add('kv-splash--out');
        window.setTimeout(function () {
            splash.remove();
            document.documentElement.classList.add('kv-splash-skip');
        }, 550);
    }

    splash.addEventListener('animationend', function (e) {
        if (e.target === splash && e.animationName === 'kv-splash-fade') finish();
    });

    window.setTimeout(finish, SPLASH_MS + 105);
})();
