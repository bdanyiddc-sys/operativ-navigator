/**
 * Rent public – mobil bottom sheet (Pointer Events, snap: collapsed | half | expanded)
 * Desktop (>900px): nem avatkozik be.
 */
(function () {
  'use strict';

  var MOBILE_MQ = window.matchMedia('(max-width: 900px)');
  var SNAPS = {
    collapsed: 0.30,
    half: 0.58,
    expanded: 0.94
  };
  var SNAP_ORDER = ['collapsed', 'half', 'expanded'];
  var MIN_RATIO = 0.28;
  var MAX_RATIO = 0.95;
  var SWIPE_PX = 48;
  var ANIM_MS = 280;

  var app = null;
  var side = null;
  var handle = null;
  var labelEl = null;
  var arrowEl = null;
  var enabled = false;
  var state = 'collapsed';
  var dragging = false;
  var dragStartY = 0;
  var dragStartHeight = 0;
  var dragPointerId = null;
  var dragMoved = false;
  var resizeTimer = null;
  var layoutNotifyTimer = null;
  var LAYOUT_EVENT = 'rent-mobile-sheet-layout';

  function isActive() {
    return MOBILE_MQ.matches;
  }

  function getAppHeight() {
    if (!app) return window.innerHeight;
    var h = app.clientHeight;
    if (h > 0) return h;
    var vv = window.visualViewport;
    if (vv && vv.height > 0) return vv.height;
    return window.innerHeight;
  }

  function ratioToPx(ratio) {
    var appH = getAppHeight();
    var px = Math.round(appH * ratio);
    var minPx = Math.round(appH * MIN_RATIO);
    var maxPx = Math.round(appH * MAX_RATIO);
    return Math.max(minPx, Math.min(maxPx, px));
  }

  function snapRatio(name) {
    return SNAPS[name] != null ? SNAPS[name] : SNAPS.collapsed;
  }

  function setHeightPx(px, animate) {
    if (!app || !side) return;
    var appH = getAppHeight();
    var minPx = Math.round(appH * MIN_RATIO);
    var maxPx = Math.round(appH * MAX_RATIO);
    var clamped = Math.max(minPx, Math.min(maxPx, Math.round(px)));
    if (animate) {
      document.documentElement.classList.add('rent-sheet-animating');
    } else {
      document.documentElement.classList.remove('rent-sheet-animating');
    }
    app.style.setProperty('--rent-sheet-height', clamped + 'px');
    side.style.height = clamped + 'px';
  }

  function ariaLabelFor(s) {
    if (s === 'collapsed') return 'Adatlap felhúzása';
    if (s === 'half') return 'Adatlap teljes megnyitása';
    return 'Adatlap lehúzása';
  }

  function arrowFor(s) {
    return s === 'expanded' ? '⌄' : '⌃';
  }

  function updateHandleA11y() {
    if (!handle) return;
    var expanded = state !== 'collapsed';
    handle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    handle.setAttribute('aria-label', ariaLabelFor(state));
    if (labelEl) labelEl.textContent = 'Adatlap';
    if (arrowEl) arrowEl.textContent = arrowFor(state);
  }

  function notifySheetLayoutChange(delayMs) {
    clearTimeout(layoutNotifyTimer);
    var wait = delayMs != null ? delayMs : 50;
    layoutNotifyTimer = setTimeout(function () {
      window.dispatchEvent(new CustomEvent(LAYOUT_EVENT));
    }, wait);
  }

  function setState(nextState, animate) {
    if (!SNAPS[nextState]) nextState = 'collapsed';
    state = nextState;
    if (app) app.setAttribute('data-sheet-state', state);
    setHeightPx(ratioToPx(snapRatio(state)), animate !== false);
    updateHandleA11y();
    if (animate !== false) {
      notifySheetLayoutChange(ANIM_MS + 20);
    } else {
      notifySheetLayoutChange(80);
    }
  }

  function nearestSnap(px) {
    var appH = getAppHeight();
    if (appH <= 0) return 'collapsed';
    var ratio = px / appH;
    var best = 'collapsed';
    var bestDist = Infinity;
    for (var i = 0; i < SNAP_ORDER.length; i += 1) {
      var name = SNAP_ORDER[i];
      var dist = Math.abs(ratio - SNAPS[name]);
      if (dist < bestDist) {
        bestDist = dist;
        best = name;
      }
    }
    return best;
  }

  function snapFromVelocity(deltaY) {
    var idx = SNAP_ORDER.indexOf(state);
    if (idx < 0) idx = 0;
    if (deltaY < -SWIPE_PX && idx < SNAP_ORDER.length - 1) {
      return SNAP_ORDER[idx + 1];
    }
    if (deltaY > SWIPE_PX && idx > 0) {
      return SNAP_ORDER[idx - 1];
    }
    return null;
  }

  function currentHeightPx() {
    if (!side) return ratioToPx(SNAPS.collapsed);
    var inline = side.style.height;
    if (inline && inline.indexOf('px') > 0) {
      return parseFloat(inline);
    }
    var varVal = app && app.style.getPropertyValue('--rent-sheet-height');
    if (varVal) return parseFloat(varVal);
    return ratioToPx(SNAPS[state]);
  }

  function onPointerDown(e) {
    if (!enabled || !handle || e.pointerType === 'mouse' && e.button !== 0) return;
    if (!handle.contains(e.target)) return;
    dragging = true;
    dragMoved = false;
    dragPointerId = e.pointerId;
    dragStartY = e.clientY;
    dragStartHeight = currentHeightPx();
    document.documentElement.classList.remove('rent-sheet-animating');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) { /* ignore */ }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging || e.pointerId !== dragPointerId) return;
    var delta = dragStartY - e.clientY;
    if (Math.abs(delta) > 6) dragMoved = true;
    setHeightPx(dragStartHeight + delta, false);
    e.preventDefault();
  }

  function finishDrag(e) {
    if (!dragging) return;
    dragging = false;
    var delta = dragStartY - (e ? e.clientY : dragStartY);
    var px = currentHeightPx();
    var velocitySnap = snapFromVelocity(-delta);
    var target = velocitySnap || nearestSnap(px);
    if (handle && dragPointerId != null) {
      try {
        if (handle.hasPointerCapture(dragPointerId)) {
          handle.releasePointerCapture(dragPointerId);
        }
      } catch (err) { /* ignore */ }
    }
    dragPointerId = null;
    setState(target, true);
  }

  function onPointerUp(e) {
    if (!dragging || e.pointerId !== dragPointerId) return;
    finishDrag(e);
  }

  function onPointerCancel(e) {
    if (!dragging || e.pointerId !== dragPointerId) return;
    finishDrag(e);
  }

  function cycleState() {
    var idx = SNAP_ORDER.indexOf(state);
    if (idx < 0) idx = 0;
    var next = SNAP_ORDER[(idx + 1) % SNAP_ORDER.length];
    setState(next, true);
  }

  function onHandleClick(e) {
    if (!enabled) return;
    if (dragging || dragMoved) {
      dragMoved = false;
      return;
    }
    cycleState();
    e.preventDefault();
  }

  function onHandleKeydown(e) {
    if (!enabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      cycleState();
    }
  }

  function ensureHalfForFocus() {
    if (!enabled || dragging) return;
    if (state === 'collapsed') setState('half', true);
  }

  function onSideFocusIn(e) {
    if (!enabled) return;
    if (handle && handle.contains(e.target)) return;
    ensureHalfForFocus();
  }

  function onViewportResize() {
    if (!enabled) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      setHeightPx(ratioToPx(snapRatio(state)), false);
      notifySheetLayoutChange(50);
    }, 120);
  }

  function bindEvents() {
    if (!handle || !side) return;
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerCancel);
    handle.addEventListener('click', onHandleClick);
    handle.addEventListener('keydown', onHandleKeydown);
    side.addEventListener('focusin', onSideFocusIn);
    window.addEventListener('resize', onViewportResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onViewportResize);
    }
  }

  function unbindEvents() {
    if (!handle || !side) return;
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerUp);
    handle.removeEventListener('pointercancel', onPointerCancel);
    handle.removeEventListener('click', onHandleClick);
    handle.removeEventListener('keydown', onHandleKeydown);
    side.removeEventListener('focusin', onSideFocusIn);
    window.removeEventListener('resize', onViewportResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onViewportResize);
    }
  }

  function clearSheetStyles() {
    if (app) {
      app.removeAttribute('data-sheet-state');
      app.style.removeProperty('--rent-sheet-height');
    }
    if (side) side.style.removeProperty('height');
    document.documentElement.classList.remove('rent-sheet-animating');
  }

  function enable() {
    if (enabled) return;
    app = document.querySelector('.app');
    side = document.querySelector('.side');
    handle = document.getElementById('rentMobileSheetHandle');
    labelEl = handle ? handle.querySelector('[data-sheet-label]') : null;
    arrowEl = handle ? handle.querySelector('[data-sheet-arrow]') : null;
    if (!app || !side || !handle) return;

    enabled = true;
    state = 'collapsed';
    document.documentElement.classList.add('rent-mobile-sheet');
    bindEvents();
    setState('collapsed', false);
  }

  function disable() {
    if (!enabled) return;
    unbindEvents();
    enabled = false;
    dragging = false;
    document.documentElement.classList.remove('rent-mobile-sheet');
    clearSheetStyles();
    notifySheetLayoutChange(80);
  }

  function onMqChange() {
    if (MOBILE_MQ.matches) enable();
    else disable();
  }

  function init() {
    app = document.querySelector('.app');
    side = document.querySelector('.side');
    handle = document.getElementById('rentMobileSheetHandle');
    if (!app || !side || !handle) return;
    MOBILE_MQ.addEventListener('change', onMqChange);
    if (isActive()) enable();
    else disable();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__rentMobileSheetGetState = function rentMobileSheetGetState() {
    return enabled ? state : null;
  };

  window.__rentMobileSheetRestoreState = function rentMobileSheetRestoreState(nextState) {
    if (!enabled || !SNAPS[nextState]) return;
    if (state === nextState) return;
    setState(nextState, false);
  };

  window.__rentMobileSheetEnsureMinState = function rentMobileSheetEnsureMinState(minState) {
    if (!enabled || !SNAPS[minState]) return;
    var minIdx = SNAP_ORDER.indexOf(minState);
    var curIdx = SNAP_ORDER.indexOf(state);
    if (minIdx < 0 || curIdx < 0) return;
    if (curIdx < minIdx) setState(minState, true);
  };
})();
