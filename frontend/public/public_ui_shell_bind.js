(function () {
    'use strict';

    var DATA = window.KVN_PUBLIC;
    var CREST_BASE = 'assets/ui/crest_';
    var CREST_IDS = ['tata', 'eger', 'gyor', 'vac', 'papa', 'szfv'];
    var layersPanelOpen = false;

    function $(id) { return document.getElementById(id); }

    function getActiveCityId() {
        var chip = document.querySelector('#city-strip .city-chip.is-active');
        if (chip && chip.dataset.city) return chip.dataset.city;
        if (DATA && DATA.CITIES) {
            var def = DATA.CITIES.find(function (c) { return c.default; });
            if (def) return def.id;
        }
        return 'tata';
    }

    function crestPathForCity(cityId) {
        if (!cityId || cityId === 'center') return null;
        if (CREST_IDS.indexOf(cityId) < 0) return null;
        return CREST_BASE + cityId + '.png';
    }

    function applyCrestToImg(img, path) {
        if (!img) return;
        if (!path) {
            img.style.display = 'none';
            return;
        }
        img.onerror = function () { img.style.display = 'none'; };
        img.onload = function () { img.style.display = ''; };
        if (img.getAttribute('src') !== path) {
            img.src = path;
        } else {
            img.style.display = '';
        }
    }

    function updateShellCrest() {
        var path = crestPathForCity(getActiveCityId());
        applyCrestToImg($('kv-shell-crest'), path);
        applyCrestToImg($('kv-shell-top-crest'), path);
    }

    function syncSeatLed() {
        var seatEl = document.querySelector('#status-line .seat-free-num');
        var led = document.querySelector('.kv-city-card .kv-led');
        if (!seatEl || !led) return;
        led.style.background = '';
        led.style.boxShadow = '';
        if (seatEl.classList.contains('seat-bad')) {
            led.style.background = '#ef4444';
            led.style.boxShadow = '0 0 14px #ef4444';
        } else if (seatEl.classList.contains('seat-warn')) {
            led.style.background = '#eab308';
            led.style.boxShadow = '0 0 14px #eab308';
        }
    }

    function syncCityCardFromStatusLine() {
        var line = $('status-line');
        if (!line) return;

        var cityEl = line.querySelector('.status-city');
        var seatEl = line.querySelector('.seat-free-num');
        var depEl = line.querySelector('.status-next-dep');
        var nameNode = $('kv-shell-city-name');
        var seatNode = $('kv-shell-seat-count');
        var depNode = $('kv-shell-dep-time');
        var routeNode = $('kv-shell-route-title');

        if (nameNode && cityEl) {
            nameNode.textContent = (cityEl.textContent || '').replace(/^\s*🚂\s*/, '').trim();
        }
        if (seatNode && seatEl) {
            var seatLine = seatNode.closest('.kv-seat-line');
            if (seatEl.classList.contains('seat-loading')) {
                seatNode.textContent = 'Adat betöltése…';
                if (seatLine) seatLine.classList.add('is-loading');
            } else {
                seatNode.textContent = (seatEl.textContent || '—').trim();
                if (seatLine) seatLine.classList.remove('is-loading');
            }
        }
        if (depNode && depEl) {
            var txt = depEl.textContent || '';
            var m = txt.match(/Következő indulás:\s*(.+)$/);
            var depText = m ? m[1].trim() : txt.replace(/^\s*🕒\s*/, '').trim();
            depNode.textContent = depText;
            depNode.classList.toggle('kv-dep-time--long', depText.length > 8 || /holnap/i.test(depText));
        }
        if (routeNode && DATA && DATA.CITIES) {
            var cityId = getActiveCityId();
            var city = DATA.CITIES.find(function (c) { return c.id === cityId; });
            if (city) routeNode.textContent = city.label + ' városnéző járat';
        }

        syncSeatLed();
        updateShellCrest();
    }

    function invokeSelectCity(cityId) {
        if (!cityId || cityId === 'center') return;
        if (window.KVN_SHELL && typeof window.KVN_SHELL.selectCity === 'function') {
            window.KVN_SHELL.selectCity(cityId);
            return;
        }
        var chip = document.querySelector('#city-strip .city-chip[data-city="' + cityId + '"]');
        if (chip) chip.click();
    }

    function isWheelOpen() {
        var wheel = $('wheelWrap');
        return !!(wheel && !wheel.classList.contains('closed'));
    }

    function syncWheelButtonState(isOpen) {
        var wheelBtn = $('toggleWheelShell');
        if (!wheelBtn) return;
        wheelBtn.classList.toggle('is-open', !!isOpen);
        wheelBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    function syncWheelAppState(isOpen) {
        var app = $('app');
        if (app) app.classList.toggle('is-wheel-open', !!isOpen);
        syncWheelButtonState(isOpen);
    }

    function openWheelShell() {
        var wheel = $('wheelWrap');
        if (!wheel || isWheelOpen()) return;
        wheel.classList.remove('closed');
        syncWheelAppState(true);
    }

    function openWheel() { openWheelShell(); }

    function closeWheelShell() {
        var wheel = $('wheelWrap');
        if (!wheel || !isWheelOpen()) return;
        wheel.classList.add('closed');
        syncWheelAppState(false);
    }

    function toggleWheelShell(forceOpen) {
        if (typeof forceOpen === 'boolean') {
            if (forceOpen) openWheelShell();
            else closeWheelShell();
            return;
        }
        openWheelShell();
    }

    function syncLayersBtnState() {
        var btn = $('btn-shell-layers');
        if (!btn) return;
        btn.classList.toggle('is-on', layersPanelOpen);
        btn.setAttribute('aria-expanded', layersPanelOpen ? 'true' : 'false');
    }

    function positionLayersPanel() {
        var btn = $('btn-shell-layers');
        var panel = $('kv-layers-panel');
        if (!btn || !panel) return;
        var rect = btn.getBoundingClientRect();
        panel.style.top = Math.round(rect.top) + 'px';
        panel.style.right = Math.round(window.innerWidth - rect.left + 8) + 'px';
    }

    function renderLayersPanel() {
        var list = $('kv-layers-list');
        if (!list) return;

        var shell = window.KVN_SHELL;
        if (!shell || typeof shell.getLayersPanelModel !== 'function') {
            list.innerHTML = '<p class="kv-layers-empty">Nincs elérhető réteg</p>';
            return;
        }

        function buildLayersList(model) {
            if (!model || !model.hasAny || !model.baseMaps.length) {
                list.innerHTML = '<p class="kv-layers-empty">Nincs elérhető réteg</p>';
                return;
            }

            var html = '';
            model.baseMaps.forEach(function (item) {
                html += '<button type="button" class="kv-layer-opt' + (item.active ? ' is-active' : '') +
                    '" data-basemap="' + item.id + '">' + item.label + '</button>';
            });
            list.innerHTML = html;
            list.querySelectorAll('[data-basemap]').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (shell.setBaseMap) shell.setBaseMap(btn.dataset.basemap);
                    renderLayersPanel();
                });
            });
        }

        if (typeof shell.refreshLayersAudit === 'function') {
            shell.refreshLayersAudit().then(function () {
                buildLayersList(shell.getLayersPanelModel());
            });
            return;
        }
        buildLayersList(shell.getLayersPanelModel());
    }

    function openLayersPanel() {
        var panel = $('kv-layers-panel');
        if (!panel) return;
        positionLayersPanel();
        renderLayersPanel();
        panel.hidden = false;
        layersPanelOpen = true;
        syncLayersBtnState();
    }

    function closeLayersPanel() {
        var panel = $('kv-layers-panel');
        if (!panel) return;
        panel.hidden = true;
        layersPanelOpen = false;
        syncLayersBtnState();
    }

    function toggleLayersPanel() {
        if (layersPanelOpen) closeLayersPanel();
        else openLayersPanel();
    }

    function invokeMyLocation(sourceButtonId) {
        if (window.KVN_SHELL && typeof window.KVN_SHELL.startMyLocation === 'function') {
            window.KVN_SHELL.startMyLocation(sourceButtonId || 'btn-shell-here');
            return;
        }
        var btn = $('btn-my-location');
        if (btn) btn.click();
    }

    function invokeQuickBook() {
        if (window.KVN_SHELL && typeof window.KVN_SHELL.openQuickBook === 'function') {
            window.KVN_SHELL.openQuickBook();
            return;
        }
        var btn = $('btn-peek-reserve');
        if (btn) btn.click();
    }

    function invokeQuickBoard() {
        if (window.KVN_SHELL && typeof window.KVN_SHELL.openQuickBoard === 'function') {
            window.KVN_SHELL.openQuickBoard();
            return;
        }
        var btn = $('btn-peek-board');
        if (btn) btn.click();
    }

    function focusActiveTrain() {
        var wrap = document.querySelector('.train-marker-root');
        if (!wrap) return;
        var target = wrap.closest('.leaflet-marker-icon') || wrap;
        if (typeof target.click === 'function') target.click();
    }

    function bindHotspots() {
        document.querySelectorAll('.hotspot--shell[data-city]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var cityId = btn.dataset.city;
                if (cityId === 'center') {
                    closeWheelShell();
                    return;
                }
                invokeSelectCity(cityId);
                closeWheelShell();
            });
        });
    }

    function bindBottomActions() {
        var reserve = $('btn-shell-reserve');
        var board = $('btn-shell-board');
        var wheelBtn = $('toggleWheelShell');

        if (reserve) {
            reserve.addEventListener('click', function (e) {
                e.preventDefault();
                invokeQuickBook();
            });
        }
        if (board) {
            board.addEventListener('click', function (e) {
                e.preventDefault();
                invokeQuickBoard();
            });
        }
        if (wheelBtn) {
            wheelBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                openWheelShell();
            });
        }
    }

    function bindTopActions() {
        var layers = $('btn-shell-layers');
        var here = $('btn-shell-here');
        var train = $('btn-shell-train');

        if (layers) {
            layers.setAttribute('aria-haspopup', 'true');
            layers.setAttribute('aria-expanded', 'false');
            layers.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                toggleLayersPanel();
            });
        }
        if (here) here.addEventListener('click', function () { invokeMyLocation('btn-shell-here'); });
        if (train) train.addEventListener('click', focusActiveTrain);
    }

    function bindLayerOutsideClose() {
        document.addEventListener('click', function (e) {
            if (!layersPanelOpen) return;
            var panel = $('kv-layers-panel');
            var btn = $('btn-shell-layers');
            if (panel && panel.contains(e.target)) return;
            if (btn && btn.contains(e.target)) return;
            closeLayersPanel();
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && layersPanelOpen) closeLayersPanel();
        });

        var mapEl = $('map');
        if (mapEl) {
            mapEl.addEventListener('click', function () {
                if (layersPanelOpen) closeLayersPanel();
            });
        }
    }

    function observeStatusLine() {
        var line = $('status-line');
        if (!line || typeof MutationObserver === 'undefined') return;
        var obs = new MutationObserver(syncCityCardFromStatusLine);
        obs.observe(line, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    }

    function observeCityStrip() {
        var strip = $('city-strip');
        if (!strip || typeof MutationObserver === 'undefined') return;
        var obs = new MutationObserver(syncCityCardFromStatusLine);
        obs.observe(strip, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }

    function init() {
        if (!document.querySelector('.public-ui-shell-v1')) return;

        var wheel = $('wheelWrap');
        if (wheel && !wheel.classList.contains('closed')) {
            wheel.classList.add('closed');
        }
        syncWheelAppState(false);

        bindHotspots();
        bindBottomActions();
        bindTopActions();
        bindLayerOutsideClose();
        observeStatusLine();
        observeCityStrip();
        syncCityCardFromStatusLine();

        window.addEventListener('resize', function () {
            if (layersPanelOpen) positionLayersPanel();
        });
        window.addEventListener('orientationchange', function () {
            setTimeout(function () {
                if (layersPanelOpen) positionLayersPanel();
            }, 300);
        });

        window.addEventListener('load', syncCityCardFromStatusLine);
        setTimeout(syncCityCardFromStatusLine, 600);
        setTimeout(syncCityCardFromStatusLine, 3000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
