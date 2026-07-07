'use strict';

/**
 * collision.js — Pure collision detection functions.
 *
 * All functions return event objects — they do NOT mutate world state.
 * The game loop applies the returned events. This separation means:
 *   - Logic is testable in isolation (pure input → output)
 *   - Stage B worker threads can run collision without touching I/O
 *
 * Two-phase collision detection:
 *   1. Broadphase: spatial grid query (cheap, returns candidates)
 *   2. Narrowphase: exact distance/circle check (only on candidates)
 *
 * Event types returned:
 *   { type: 'eat',   playerId, foodId, value, growAmount }
 *   { type: 'death', victimId, killerId | null }
 */

const { SpatialGrid } = require('./spatialGrid');
const cfg = require('./config');

// ── Helper ─────────────────────────────────────────────────────────────────

/** Squared distance between two points (avoids sqrt for cheap comparisons). */
function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// ── Food collision ─────────────────────────────────────────────────────────

/**
 * Check if a player's head is close enough to eat any nearby food.
 * Uses the FoodManager's persistent grid for broadphase.
 *
 * @param {import('./player').Player} player
 * @param {import('./food').FoodManager} foodManager
 * @returns {Array<{type:'eat', playerId:string, foodId:string, value:number, growAmount:number}>}
 */
function checkFoodCollisions(player, foodManager) {
  if (!player.alive) { return []; }

  const events    = [];
  const queryR    = player.headRadius + 22; // slightly generous radius for feel
  const candidates = foodManager.queryNear(player.x, player.y, queryR);

  for (const food of candidates) {
    const threshold = player.headRadius + food.radius;
    if (dist2(player.x, player.y, food.x, food.y) <= threshold * threshold) {
      // Growth: 1 segment per food value point
      events.push({
        type:       'eat',
        playerId:   player.id,
        foodId:     food.id,
        value:      food.value,
        growAmount: food.value,
      });
    }
  }

  return events;
}

// ── Body collision ─────────────────────────────────────────────────────────

/**
 * Build a per-tick spatial grid of all body segments from all alive players.
 * This is rebuilt every tick (cheap: ~50 players × ~100 segs = 5000 inserts).
 * Stored as plain objects { x, y, ownerId, segIdx } — not Player instances.
 *
 * @param {Map<string, import('./player').Player>} players
 * @returns {SpatialGrid}
 */
function buildSegmentGrid(players) {
  const grid = new SpatialGrid(cfg.GRID_CELL_SIZE);
  for (const player of players.values()) {
    if (!player.alive) { continue; }
    for (let i = 0; i < player.segments.length; i++) {
      grid.insert({
        x:       player.segments[i].x,
        y:       player.segments[i].y,
        ownerId: player.id,
        segIdx:  i,
      });
    }
  }
  return grid;
}

/**
 * Check all players' heads against the segment grid.
 * Returns death events. Head-to-head (both in same cell) → both die.
 *
 * Per-spec rules:
 *   - Head hits own body: safe for first SAFE_SEGMENTS segments.
 *   - Head hits any other worm's body: death for the head's owner.
 *   - Head hits another head (both checked): both die.
 *
 * @param {Map<string, import('./player').Player>} players
 * @param {SpatialGrid} segmentGrid — pre-built this tick
 * @returns {Array<{type:'death', victimId:string, killerId:string|null}>}
 */
function checkBodyCollisions(players, segmentGrid) {
  const events = [];
  /** @type {Set<string>} — players already scheduled for death this tick */
  const dying  = new Set();

  for (const player of players.values()) {
    if (!player.alive || dying.has(player.id)) { continue; }

    const headX = player.x;
    const headY = player.y;
    const queryR = player.headRadius + cfg.BODY_RADIUS + 5;
    const candidates = segmentGrid.query(headX, headY, queryR);

    for (const seg of candidates) {
      // Skip own safe zone (first SAFE_SEGMENTS of self)
      if (seg.ownerId === player.id && seg.segIdx < cfg.SAFE_SEGMENTS) { continue; }

      const threshold = player.headRadius + cfg.BODY_RADIUS * 0.9; // slightly lenient
      if (dist2(headX, headY, seg.x, seg.y) <= threshold * threshold) {
        dying.add(player.id);
        events.push({
          type:     'death',
          victimId: player.id,
          killerId: (seg.ownerId !== player.id) ? seg.ownerId : null,
        });
        break; // one death per player per tick
      }
    }
  }

  return events;
}

module.exports = { checkFoodCollisions, checkBodyCollisions, buildSegmentGrid };
