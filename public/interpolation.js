/**
 * interpolation.js — Client-side entity interpolation.
 *
 * Problem: The server broadcasts state at 20Hz, but we render at 60fps.
 * Without interpolation, worms appear to snap/jitter between positions.
 *
 * Solution (from CLAUDE.md §6a):
 *   Store the last 2 received snapshots per entity.
 *   Each render frame, draw entities at a position lerped between
 *   prev and current snapshot, based on time elapsed since last update.
 *
 * This is entirely client-side — zero server changes, zero extra traffic.
 * The server doesn't even know this exists.
 *
 * Additionally tracks food state — food is drawn from the latest snapshot
 * (no interpolation needed, food doesn't move).
 */

'use strict';

const InterpolationBuffer = (() => {
  // How far in the past we render (in ms). A bit of lag trades smoothness for
  // jitter-immunity: if we render at t-50ms we almost always have two snapshots.
  // 40ms render delay: enough to always have 2 snapshots at 20Hz (50ms interval)
  // while staying responsive. 80ms felt sluggish.
  const RENDER_DELAY_MS = 40;

  /**
   * @typedef {Object} SnapSegment
   * @property {number} x
   * @property {number} y
   */

  /**
   * @typedef {Object} EntitySnap
   * @property {number}        time     — wall-clock ms when received
   * @property {string}        id
   * @property {string}        name
   * @property {string}        color
   * @property {string}        skin
   * @property {SnapSegment[]} segments — [[x,y], ...]
   * @property {number}        angle
   * @property {number}        score
   * @property {number}        b        — boosting flag
   * @property {number}        l        — length
   * @property {number}        hr       — head radius
   * @property {number}        br       — body radius
   */

  /** @type {Map<string, EntitySnap[]>} entityId → [prev, current] */
  const _buffer  = new Map();
  /** @type {Map<string, object>} foodId → food packet */
  const _food    = new Map();
  /** @type {Set<string>} IDs seen in the latest snapshot (for removal) */
  let _activeIds = new Set();

  let _localPlayerId = null;

  // ── Ingest snapshots from server ─────────────────────────────────────

  /**
   * Call this when a new 'game:snapshot' arrives.
   * @param {object} snapshot — raw payload from server
   * @param {number} now      — performance.now()
   */
  function ingest(snapshot, now) {
    const newActive = new Set();

    // ── Players ────────────────────────────────────────────────────
    for (const p of (snapshot.p || [])) {
      newActive.add(p.i);
      const snap = { time: now, ...p };
      const existing = _buffer.get(p.i);
      if (existing) {
        // Shift: current → prev, new → current
        _buffer.set(p.i, [existing[existing.length - 1], snap]);
      } else {
        // First time seeing this entity — duplicate as prev for stable lerp start
        _buffer.set(p.i, [snap, snap]);
      }
    }

    // Remove entities that disappeared from the snapshot
    for (const id of _buffer.keys()) {
      if (!newActive.has(id)) {
        _buffer.delete(id);
      }
    }
    _activeIds = newActive;

    // ── Food: merge delta ──────────────────────────────────────────
    // Apply full AOI food list
    const snapshotFoodIds = new Set();
    for (const f of (snapshot.f || [])) {
      const id = f[0];
      snapshotFoodIds.add(id);
      if (!_food.has(id)) {
        _food.set(id, _foodPacketToObj(f));
      }
    }
    // Remove eaten food (fe = array of eaten food ids)
    for (const id of (snapshot.fe || [])) {
      _food.delete(id);
    }
    // Add spawned food (fs = array of food packets, e.g. from death drops)
    for (const f of (snapshot.fs || [])) {
      _food.set(f[0], _foodPacketToObj(f));
    }
    // Prune food not in AOI anymore (they left the view)
    for (const id of _food.keys()) {
      if (!snapshotFoodIds.has(id) && !(snapshot.fs || []).some(f => f[0] === id)) {
        _food.delete(id);
      }
    }
  }

  function _foodPacketToObj([id, x, y, value, color, radius]) {
    return { id, x, y, value, color, radius };
  }

  // ── Interpolation ─────────────────────────────────────────────────────

  const _lerp = (a, b, t) => a + (b - a) * t;

  function _lerpAngle(from, to, t) {
    let diff = to - from;
    while (diff > Math.PI)  { diff -= 2 * Math.PI; }
    while (diff < -Math.PI) { diff += 2 * Math.PI; }
    return from + diff * t;
  }

  function _lerpSegments(prev, curr, t) {
    const len    = Math.max(prev.length, curr.length);
    const result = [];
    for (let i = 0; i < len; i++) {
      const ps = prev[Math.min(i, prev.length - 1)];
      const cs = curr[Math.min(i, curr.length - 1)];
      result.push([
        _lerp(ps[0], cs[0], t),
        _lerp(ps[1], cs[1], t),
      ]);
    }
    return result;
  }

  /**
   * Compute interpolated render state for all entities.
   * Call this every render frame (60fps).
   * @param {number} now — performance.now()
   * @returns {{ players: object[], food: object[] }}
   */
  function getRenderState(now) {
    const renderTime = now - RENDER_DELAY_MS;
    const players    = [];

    for (const [id, snaps] of _buffer.entries()) {
      const [prev, curr] = snaps;
      // Time fraction: 0=at prev, 1=at curr, >1=extrapolating
      const interval = curr.time - prev.time;
      const t = interval > 0
        ? Math.min(1.5, (renderTime - prev.time) / interval) // allow slight extrapolation
        : 1;

      const segments = _lerpSegments(prev.s, curr.s, Math.min(t, 1));

      players.push({
        id:       id,
        name:     curr.n,
        color:    curr.c,
        skin:     curr.sk,
        segments: segments,
        angle:    id === _localPlayerId && typeof InputManager !== 'undefined'
          ? InputManager.getAngle()
          : _lerpAngle(prev.a, curr.a, Math.min(t, 1)),
        score:    curr.sc,
        boosting: curr.b === 1,
        length:   curr.l,
        hr:       curr.hr,
        br:       curr.br,
        isLocal:  id === _localPlayerId,
      });
    }

    return {
      players,
      food: [..._food.values()],
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  function setLocalPlayerId(id) { _localPlayerId = id; }

  function clear() {
    _buffer.clear();
    _food.clear();
    _activeIds.clear();
  }

  function getLocalPlayer() {
    const snaps = _buffer.get(_localPlayerId);
    if (!snaps) { return null; }
    return snaps[snaps.length - 1]; // most recent snapshot
  }

  return { ingest, getRenderState, setLocalPlayerId, clear, getLocalPlayer };
})();
