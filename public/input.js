/**
 * input.js — Mouse input capture and angle computation.
 *
 * Captures:
 *   - Mouse position → target angle (radians) relative to canvas center
 *   - Mouse button → boost state
 *
 * Emits input to the server at INPUT_HZ (30Hz) — not on every mousemove event.
 * This throttle prevents flooding the socket while still being responsive.
 *
 * The client sends only { a: angle, b: boosting } — never coordinates.
 * This is a core security property of the authoritative server model.
 */

'use strict';

const InputManager = (() => {
  const INPUT_HZ      = 30;
  const INPUT_INTERVAL = 1000 / INPUT_HZ;

  let _angle        = 0;      // current target angle in radians
  let _boosting     = false;
  let _lastEmitTime = 0;
  let _dirty        = false;  // has input changed since last emit?
  let _enabled      = false;  // only capture input when in-game
  let _canvas       = null;
  /** @type {Function | null} emit callback — set by client.js */
  let _onInput      = null;

  // ── Canvas centre (updated on resize) ──────────────────────────────
  let _cx = window.innerWidth  / 2;
  let _cy = window.innerHeight / 2;

  // ── Event handlers ─────────────────────────────────────────────────

  function onMouseMove(e) {
    if (!_enabled) { return; }
    const rect = _canvas ? _canvas.getBoundingClientRect() : null;
    const mx   = rect ? e.clientX - rect.left : e.clientX;
    const my   = rect ? e.clientY - rect.top  : e.clientY;

    // Calculate angle relative to the head's actual screen position (compensates for camera lag and offsets)
    let cx = _cx;
    let cy = _cy;
    if (typeof Renderer !== 'undefined' && typeof Renderer.getLocalHeadScreenPos === 'function') {
      const headPos = Renderer.getLocalHeadScreenPos();
      cx = headPos.x;
      cy = headPos.y;
    }

    const newAngle = Math.atan2(my - cy, mx - cx);
    if (newAngle !== _angle) {
      _angle = newAngle;
      _dirty = true;
    }
  }

  function onMouseDown(e) {
    if (!_enabled) { return; }
    if (e.button === 0 || e.button === 2) {
      _boosting = true;
      _dirty    = true;
    }
  }

  function onMouseUp(e) {
    if (e.button === 0 || e.button === 2) {
      _boosting = false;
      _dirty    = true;
    }
  }

  function onContextMenu(e) {
    e.preventDefault(); // prevent right-click menu during boost
  }

  function onResize() {
    if (_canvas) {
      _cx = _canvas.width  / 2;
      _cy = _canvas.height / 2;
    } else {
      _cx = window.innerWidth  / 2;
      _cy = window.innerHeight / 2;
    }
  }

  // ── Flush (called every render frame by client.js) ─────────────────
  // Sends input to server at INPUT_HZ rate, but only when it changed.
  function flush(now) {
    if (!_enabled || !_onInput || !_dirty) { return; }
    if (now - _lastEmitTime < INPUT_INTERVAL) { return; }
    _lastEmitTime = now;
    _dirty        = false;
    _onInput({ a: _angle, b: _boosting });
  }

  // ── Public API ─────────────────────────────────────────────────────

  function init(canvas) {
    _canvas = canvas;
    onResize();
    window.addEventListener('mousemove',    onMouseMove,   { passive: true });
    window.addEventListener('mousedown',    onMouseDown);
    window.addEventListener('mouseup',      onMouseUp);
    window.addEventListener('contextmenu',  onContextMenu);
    window.addEventListener('resize',       onResize,      { passive: true });
  }

  function enable()  { _enabled = true; }
  function disable() { _enabled = false; _boosting = false; _dirty = false; }

  function setCallback(fn) { _onInput = fn; }

  function getAngle()    { return _angle; }
  function isBoosting()  { return _boosting; }

  return { init, enable, disable, setCallback, flush, getAngle, isBoosting };
})();
