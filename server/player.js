'use strict';

/**
 * player.js — Player entity (pure data + pure game-logic methods).
 *
 * No I/O, no socket references, no side effects.
 * This class is the core of the game simulation.
 * It can be instantiated per-arena and moved to a worker thread
 * in Stage B without any changes to this file.
 */

const { v4: uuidv4 } = require('uuid');
const cfg = require('./config');

// Neon colour palette — one assigned per player, visible on dark background
const WORM_COLORS = [
  '#00ff88', // neon green
  '#ff3860', // hot pink
  '#ff6b35', // neon orange
  '#a855f7', // electric purple
  '#00d4ff', // cyan
  '#ffee00', // yellow
  '#ff1493', // deep pink
  '#00fff9', // turquoise
  '#ff6ec7', // bubblegum
  '#7dff4f', // lime
  '#f97316', // amber
  '#38bdf8', // sky blue
  '#e879f9', // fuchsia
  '#4ade80', // green
  '#fb923c', // peach
];

let colorIndex = 0;

function assignColor() {
  const color = WORM_COLORS[colorIndex % WORM_COLORS.length];
  colorIndex++;
  return color;
}

/** Normalise an angle to the range (-π, π]. */
function normaliseAngle(a) {
  while (a > Math.PI)  { a -= 2 * Math.PI; }
  while (a < -Math.PI) { a += 2 * Math.PI; }
  return a;
}

/**
 * The signed shortest angular difference from `from` to `to`.
 * Result is in (-π, π].
 */
function angleDiff(to, from) {
  return normaliseAngle(to - from);
}

class Player {
  /**
   * @param {string} socketId — socket.io socket ID (used as player ID)
   * @param {string} name — display name (sanitised by server before passing)
   * @param {number} spawnX
   * @param {number} spawnY
   */
  constructor(socketId, name, spawnX, spawnY) {
    this.id       = socketId;
    this.name     = name.slice(0, 20); // hard length cap
    this.color    = assignColor();
    this.skin     = 'default'; // Stage B: custom skin id from registry

    // ── State ───────────────────────────────────────────────────────
    this.alive     = true;
    this.score     = 0;
    this.boosting  = false;
    this.angle     = Math.random() * Math.PI * 2; // random spawn direction

    // Fractional accumulators (avoid drift from integer rounding)
    this._pendingGrowth = 0; // segments still to be added
    this._boostAccum    = 0; // fractional mass lost while boosting

    // ── Body ─────────────────────────────────────────────────────────
    // Initialise as a straight line pointing against the spawn angle
    this.segments = [];
    const oppositeAngle = this.angle + Math.PI;
    for (let i = 0; i < cfg.INITIAL_LENGTH; i++) {
      this.segments.push({
        x: spawnX + Math.cos(oppositeAngle) * i * cfg.SEGMENT_SPACING,
        y: spawnY + Math.sin(oppositeAngle) * i * cfg.SEGMENT_SPACING,
      });
    }

    // Clamp initial segments to world bounds
    for (const seg of this.segments) {
      seg.x = Math.max(0, Math.min(cfg.WORLD_WIDTH,  seg.x));
      seg.y = Math.max(0, Math.min(cfg.WORLD_HEIGHT, seg.y));
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────

  /** Head position */
  get x() { return this.segments[0].x; }
  get y() { return this.segments[0].y; }

  /** Current body radius — scales slightly with size for visual feedback */
  get bodyRadius() {
    const extra = Math.max(0, this.segments.length - cfg.INITIAL_LENGTH);
    return cfg.BODY_RADIUS + Math.sqrt(extra) * 0.95;
  }

  get headRadius() {
    const extra = Math.max(0, this.segments.length - cfg.INITIAL_LENGTH);
    return cfg.HEAD_RADIUS + Math.sqrt(extra) * 1.05;
  }

  // ── Input ─────────────────────────────────────────────────────────

  /**
   * Apply player input for this tick.
   * The client sends a target angle; the server smoothly steers toward it.
   * This prevents teleportation cheating even if the client sends bad data.
   * @param {number} targetAngle — radians, as computed by client from mouse position
   * @param {boolean} boosting
   */
  applyInput(targetAngle, boosting) {
    if (!this.alive) { return; }
    // Clamp turn rate — worm cannot snap instantly to a new direction
    const diff   = angleDiff(targetAngle, this.angle);
    const clamped = Math.max(-cfg.MAX_TURN_RATE, Math.min(cfg.MAX_TURN_RATE, diff));
    this.angle    = normaliseAngle(this.angle + clamped);
    // Only allow boost if worm is long enough
    this.boosting = boosting && (this.segments.length > cfg.MIN_BOOST_LENGTH);
  }

  // ── Physics ───────────────────────────────────────────────────────

  /**
   * Advance the worm by one physics tick.
   * Returns the new head position (used by the game loop to update the grid).
   * @returns {{ x: number, y: number }} — new head position
   */
  tick() {
    if (!this.alive) { return { x: this.x, y: this.y }; }

    const speed = this.boosting
      ? cfg.BASE_SPEED * cfg.BOOST_SPEED_MULT
      : cfg.BASE_SPEED;

    // ── Move head ──────────────────────────────────────────────────
    const newHead = {
      x: this.segments[0].x + Math.cos(this.angle) * speed,
      y: this.segments[0].y + Math.sin(this.angle) * speed,
    };
    // Hard clamp to world bounds (wall = death in a future mode; for now it's a bounce wall)
    newHead.x = Math.max(cfg.HEAD_RADIUS, Math.min(cfg.WORLD_WIDTH  - cfg.HEAD_RADIUS, newHead.x));
    newHead.y = Math.max(cfg.HEAD_RADIUS, Math.min(cfg.WORLD_HEIGHT - cfg.HEAD_RADIUS, newHead.y));

    // ── Chain segments ─────────────────────────────────────────────
    // Each segment follows the one ahead of it, maintaining SEGMENT_SPACING distance.
    // This produces the classic "rope" movement of worm games.
    const newSegments = [newHead];
    for (let i = 0; i < this.segments.length - 1; i++) {
      const prev = newSegments[i];
      const curr = this.segments[i]; // old position of segment i
      const dx = prev.x - curr.x;
      const dy = prev.y - curr.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= cfg.SEGMENT_SPACING) {
        // Within spacing — stays in place (segment is already close enough)
        newSegments.push({ x: curr.x, y: curr.y });
      } else {
        // Pull toward the segment ahead, maintaining exact spacing
        const ratio = cfg.SEGMENT_SPACING / dist;
        newSegments.push({
          x: prev.x - dx * ratio,
          y: prev.y - dy * ratio,
        });
      }
    }

    // ── Growth / tail ──────────────────────────────────────────────
    if (this._pendingGrowth > 0) {
      // Add extra segment at the tail (duplicate last)
      newSegments.push({ ...this.segments[this.segments.length - 1] });
      this._pendingGrowth--;
    }

    this.segments = newSegments;

    // ── Boost mass loss ────────────────────────────────────────────
    if (this.boosting) {
      this._boostAccum += cfg.BOOST_MASS_COST;
      while (this._boostAccum >= 1 && this.segments.length > cfg.MIN_BOOST_LENGTH) {
        this.segments.pop();
        this._boostAccum -= 1;
        this.score = Math.max(0, this.score - 0.5);
      }
      if (this._boostAccum >= 1) { this._boostAccum = 0; } // safety reset
    }

    return { x: newHead.x, y: newHead.y };
  }

  // ── Grow / score ──────────────────────────────────────────────────

  /**
   * Schedule growth after eating food.
   * @param {number} amount — segments to add
   * @param {number} scoreValue — points to add
   */
  feed(amount, scoreValue) {
    this._pendingGrowth += amount;
    this.score          += scoreValue;
  }

  // ── Death ─────────────────────────────────────────────────────────

  kill() {
    this.alive   = false;
    this.boosting = false;
  }

  // ── Serialisation ─────────────────────────────────────────────────

  /**
   * Compact snapshot for network transmission.
   * Segment positions are integer-rounded to save bandwidth.
   * Short key names ('i', 'n', 's', …) further reduce payload size.
   */
  toSnapshot() {
    return {
      i:  this.id,
      n:  this.name,
      c:  this.color,
      sk: this.skin,
      // Pack segments as [x, y] arrays (saves ~30% vs {x,y} objects)
      s:  this.segments.map(seg => [Math.round(seg.x), Math.round(seg.y)]),
      a:  parseFloat(this.angle.toFixed(4)),
      sc: this.score,
      b:  this.boosting ? 1 : 0,
      l:  this.segments.length,
      hr: parseFloat(this.headRadius.toFixed(2)),
      br: parseFloat(this.bodyRadius.toFixed(2)),
    };
  }

  /**
   * Minimal leaderboard entry.
   */
  toLeaderboardEntry() {
    return { i: this.id, n: this.name, sc: this.score, l: this.segments.length };
  }
}

module.exports = { Player };
