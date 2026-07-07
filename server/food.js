'use strict';

/**
 * food.js — Food entity and FoodManager.
 *
 * Responsibilities:
 *   - Create food pellets (random spawn + death-drop)
 *   - Maintain target food density using weighted random type distribution
 *   - Track food in the persistent spatial grid (add/remove only on change)
 *   - Pluggable food-type registry (Stage B: load from public/assets/food/registry.json)
 *
 * The FoodManager keeps its own persistent SpatialGrid that only updates
 * when food is added or consumed — far cheaper than rebuilding every tick.
 */

const { v4: uuidv4 } = require('uuid');
const { SpatialGrid } = require('./spatialGrid');
const cfg = require('./config');

// ── Food colour palettes (per type) ───────────────────────────────────────
// These are resolved from the registry in Stage B; hardcoded for v1.
const FOOD_COLORS = {
  tiny:   ['#00ff41', '#41ff00', '#a8ff3e'],
  small:  ['#39ff14', '#76ff03', '#b2ff59'],
  medium: ['#ffaa00', '#ff8c00', '#ffd700'],
  large:  ['#ff3860', '#ff1744', '#ff4081'],
  mega:   ['#ff00ff', '#e040fb', '#ce93d8'],
};

// ── Weighted random helper ─────────────────────────────────────────────────
const WEIGHT_TOTAL = cfg.FOOD_WEIGHTS.reduce((acc, w) => acc + w.weight, 0);

function randomFoodType() {
  let r = Math.random() * WEIGHT_TOTAL;
  for (const entry of cfg.FOOD_WEIGHTS) {
    r -= entry.weight;
    if (r <= 0) { return entry.type; }
  }
  return 'tiny'; // fallback
}

function randomColor(type) {
  const palette = FOOD_COLORS[type] || FOOD_COLORS.tiny;
  return palette[Math.floor(Math.random() * palette.length)];
}

// ── Food entity ────────────────────────────────────────────────────────────

class Food {
  /**
   * @param {number} x
   * @param {number} y
   * @param {string} type — key in cfg.FOOD_TYPES
   * @param {string} [overrideColor] — optional, for custom asset support
   */
  constructor(x, y, type = 'tiny', overrideColor = null) {
    this.id     = uuidv4().replace(/-/g, '').slice(0, 10); // compact ID
    this.x      = x;
    this.y      = y;
    this.type   = type;
    this._gridKey = null; // managed by SpatialGrid

    const typeCfg  = cfg.FOOD_TYPES[type] || cfg.FOOD_TYPES.tiny;
    this.value  = typeCfg.value;
    this.radius = typeCfg.radius;
    this.color  = overrideColor || randomColor(type);
  }

  /** Compact array format for network: [id, x, y, value, color, radius] */
  toPacket() {
    return [
      this.id,
      Math.round(this.x),
      Math.round(this.y),
      this.value,
      this.color,
      this.radius,
    ];
  }
}

// ── FoodManager ────────────────────────────────────────────────────────────

class FoodManager {
  constructor() {
    /** @type {Map<string, Food>} */
    this.foods = new Map();
    // Persistent grid — updated only on add/remove, not every tick
    this.grid  = new SpatialGrid(cfg.GRID_CELL_SIZE);
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  /**
   * Initial world fill — called once at arena startup.
   */
  initialFill() {
    this._spawnBatch(cfg.FOOD_TARGET_COUNT);
  }

  /**
   * Maintain food density — call once per tick (or every few ticks).
   * Spawns at most FOOD_SPAWN_BATCH per call to spread CPU load.
   */
  maintain() {
    const deficit = cfg.FOOD_TARGET_COUNT - this.foods.size;
    if (deficit > 0) {
      this._spawnBatch(Math.min(deficit, cfg.FOOD_SPAWN_BATCH));
    }
  }

  _spawnBatch(count) {
    const margin = cfg.SPAWN_MARGIN;
    for (let i = 0; i < count; i++) {
      const x    = margin + Math.random() * (cfg.WORLD_WIDTH  - margin * 2);
      const y    = margin + Math.random() * (cfg.WORLD_HEIGHT - margin * 2);
      const type = randomFoodType();
      this._addFood(new Food(x, y, type));
    }
  }

  // ── Death drop ─────────────────────────────────────────────────────────

  /**
   * Convert a dead worm's body into food pellets.
   * Returns an array of new Food instances (for the delta broadcast).
   * @param {Array<{x:number, y:number}>} segments
   * @returns {Food[]}
   */
  spawnDeathDrop(segments) {
    const newFoods = [];
    for (let i = 0; i < segments.length; i += cfg.DEATH_SEG_PER_FOOD) {
      const seg   = segments[i];
      const type  = (i % (cfg.DEATH_SEG_PER_FOOD * 3) === 0) ? 'medium' : 'small';
      const food  = new Food(seg.x, seg.y, type);
      this._addFood(food);
      newFoods.push(food);
    }
    return newFoods;
  }

  // ── Add / remove ───────────────────────────────────────────────────────

  _addFood(food) {
    this.foods.set(food.id, food);
    this.grid.insert(food);
  }

  /**
   * Remove food (after it was eaten).
   * @param {string} foodId
   * @returns {boolean} whether food existed
   */
  consume(foodId) {
    const food = this.foods.get(foodId);
    if (!food) { return false; }
    this.grid.remove(food);
    this.foods.delete(foodId);
    return true;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /**
   * Find food items near a point within a given radius.
   * Returns raw Set from grid (broadphase); caller should do exact distance check.
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @returns {Set<Food>}
   */
  queryNear(x, y, radius) {
    return this.grid.query(x, y, radius);
  }

  /**
   * Get all food items within the AOI for a client snapshot.
   * @param {number} cx — centre x
   * @param {number} cy — centre y
   * @returns {Food[]}
   */
  getFoodInAOI(cx, cy) {
    const candidates = this.grid.query(cx, cy, cfg.AOI_RADIUS);
    const r2 = cfg.AOI_RADIUS * cfg.AOI_RADIUS;
    const result = [];
    for (const food of candidates) {
      const dx = food.x - cx;
      const dy = food.y - cy;
      if (dx * dx + dy * dy <= r2) {
        result.push(food);
      }
    }
    return result;
  }
}

module.exports = { Food, FoodManager };
