'use strict';

/**
 * world.js — Arena state container.
 *
 * Owns the canonical game state for one arena instance:
 *   - Player map
 *   - FoodManager (food + food spatial grid)
 *   - Leaderboard
 *   - AOI snapshot builder (Area-of-Interest filtering)
 *
 * Stage B: This entire class becomes one arena instance.
 * Multiple World instances run in parallel (worker threads or separate processes).
 * No changes needed to this file for that transition.
 */

const { Player }       = require('./player');
const { FoodManager }  = require('./food');
const cfg              = require('./config');

class World {
  constructor(arenaId = 'default') {
    this.arenaId = arenaId;

    /** @type {Map<string, Player>} socketId → Player */
    this.players     = new Map();

    this.foodManager  = new FoodManager();

    /** Cached leaderboard — recalculated every LEADERBOARD_UPDATE_TICKS */
    this._leaderboard = [];
    this._lbDirty     = true; // force first build

    // Fill food on startup
    this.foodManager.initialFill();
  }

  // ── Player lifecycle ───────────────────────────────────────────────────

  /**
   * Add a new player to the arena.
   * Finds a safe spawn point (no nearby worms).
   * @param {string} socketId
   * @param {string} name
   * @returns {Player}
   */
  addPlayer(socketId, name) {
    const { x, y } = this._safeSpawnPoint();
    const player   = new Player(socketId, name, x, y);
    this.players.set(socketId, player);
    this._lbDirty = true;
    return player;
  }

  /**
   * Remove a player (disconnect / already dead).
   * Does NOT spawn a death drop — that happens in the game loop on death events.
   * @param {string} socketId
   */
  removePlayer(socketId) {
    this.players.delete(socketId);
    this._lbDirty = true;
  }

  getPlayer(socketId) {
    return this.players.get(socketId) || null;
  }

  get playerCount() {
    return this.players.size;
  }

  get aliveCount() {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.alive) { n++; }
    }
    return n;
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  _safeSpawnPoint() {
    const margin = cfg.SPAWN_MARGIN;
    const maxW   = cfg.WORLD_WIDTH  - margin;
    const maxH   = cfg.WORLD_HEIGHT - margin;
    const safeR2 = cfg.SPAWN_SAFETY_RADIUS * cfg.SPAWN_SAFETY_RADIUS;

    for (let attempt = 0; attempt < 30; attempt++) {
      const x = margin + Math.random() * (maxW - margin);
      const y = margin + Math.random() * (maxH - margin);
      let safe = true;
      for (const player of this.players.values()) {
        if (!player.alive) { continue; }
        const dx = player.x - x;
        const dy = player.y - y;
        if (dx * dx + dy * dy < safeR2) {
          safe = false;
          break;
        }
      }
      if (safe) { return { x, y }; }
    }
    // Fallback: random edge-avoiding position
    return {
      x: margin + Math.random() * (maxW - margin),
      y: margin + Math.random() * (maxH - margin),
    };
  }

  // ── Leaderboard ────────────────────────────────────────────────────────

  /**
   * Rebuild and cache the leaderboard.
   * Called by the game loop every LEADERBOARD_UPDATE_TICKS.
   * @returns {Array} sorted top-N entries
   */
  rebuildLeaderboard() {
    const entries = [];
    for (const player of this.players.values()) {
      if (player.alive) {
        entries.push(player.toLeaderboardEntry());
      }
    }
    entries.sort((a, b) => b.sc - a.sc);
    this._leaderboard = entries.slice(0, cfg.LEADERBOARD_SIZE);
    this._lbDirty     = false;
    return this._leaderboard;
  }

  get leaderboard() {
    return this._leaderboard;
  }

  // ── Snapshot (AOI filtered) ────────────────────────────────────────────

  /**
   * Build a per-client snapshot filtered to the player's Area of Interest.
   * Only entities within AOI_RADIUS of the player's head are included.
   * This is the Stage A bandwidth optimisation built in from day 1.
   *
   * @param {string} socketId
   * @param {number} tickNumber
   * @param {boolean} sendLeaderboard — whether to include lb in this snapshot
   * @returns {object} — compact payload ready for socket.emit
   */
  buildSnapshot(socketId, tickNumber, sendLeaderboard) {
    const self = this.players.get(socketId);
    if (!self) { return null; }

    const cx = self.x;
    const cy = self.y;
    const r2 = cfg.AOI_RADIUS * cfg.AOI_RADIUS;

    // ── Players in AOI ────────────────────────────────────────────────
    const playersInView = [];
    for (const player of this.players.values()) {
      if (!player.alive) { continue; }
      const dx = player.x - cx;
      const dy = player.y - cy;
      if (dx * dx + dy * dy <= r2 || player.id === socketId) {
        playersInView.push(player.toSnapshot());
      }
    }

    // ── Food in AOI ───────────────────────────────────────────────────
    const foodInView = this.foodManager.getFoodInAOI(cx, cy);

    return {
      t:  tickNumber,
      p:  playersInView,
      f:  foodInView.map(food => food.toPacket()),
      y: {
        sc: self.score,
        l:  self.segments.length,
        a:  self.alive,
        b:  self.boosting,
      },
      lb: sendLeaderboard ? this._leaderboard : null,
    };
  }

  // ── World info (sent on join) ──────────────────────────────────────────

  getWorldInfo() {
    return {
      worldWidth:  cfg.WORLD_WIDTH,
      worldHeight: cfg.WORLD_HEIGHT,
      aoiRadius:   cfg.AOI_RADIUS,
      tickRate:    cfg.TICK_RATE,
      broadcastRate: cfg.BROADCAST_RATE,
      segmentSpacing: cfg.SEGMENT_SPACING,
    };
  }
}

module.exports = { World };
