'use strict';

/**
 * spatialGrid.js — Spatial hash grid for O(1) broadphase lookups.
 *
 * Divides the world into a grid of fixed-size cells. Each entity is
 * bucketed into a cell based on its (x, y) position. Queries return
 * all entities in cells that overlap the query rectangle.
 *
 * Complexity:
 *   insert / remove: O(1) amortised
 *   query(x, y, radius): O(k) where k = entities in overlapping cells
 *
 * This is the Stage A optimisation from CLAUDE.md — built in from day 1.
 * Used for both food consumption checks and worm body collision detection.
 */

class SpatialGrid {
  /**
   * @param {number} cellSize — pixel width/height of each cell
   */
  constructor(cellSize) {
    this.cellSize = cellSize;
    /** @type {Map<string, Set<object>>} */
    this.cells = new Map();
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /** Returns the integer cell coordinates for a world position. */
  _cellCoords(x, y) {
    return [Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)];
  }

  /** Returns the Map key string for a pair of cell coordinates. */
  _key(cx, cy) {
    return `${cx},${cy}`;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Insert an entity into the grid.
   * The entity MUST have numeric `.x` and `.y` properties.
   * After insertion, `entity._gridKey` is set (used by `remove`).
   * @param {object} entity
   */
  insert(entity) {
    const [cx, cy] = this._cellCoords(entity.x, entity.y);
    const key = this._key(cx, cy);
    if (!this.cells.has(key)) {
      this.cells.set(key, new Set());
    }
    this.cells.get(key).add(entity);
    entity._gridKey = key;
  }

  /**
   * Remove an entity from the grid (uses cached `_gridKey`).
   * No-op if the entity was never inserted or already removed.
   * @param {object} entity
   */
  remove(entity) {
    const key = entity._gridKey;
    if (!key) { return; }
    const cell = this.cells.get(key);
    if (cell) {
      cell.delete(entity);
      if (cell.size === 0) {
        this.cells.delete(key);
      }
    }
    entity._gridKey = null;
  }

  /**
   * Update an entity's position in the grid.
   * Only re-buckets if the entity crossed a cell boundary (cheap in most ticks).
   * @param {object} entity — must already be inserted
   * @param {number} newX
   * @param {number} newY
   */
  update(entity, newX, newY) {
    const [newCx, newCy] = this._cellCoords(newX, newY);
    const newKey = this._key(newCx, newCy);
    if (entity._gridKey !== newKey) {
      this.remove(entity);
      entity.x = newX;
      entity.y = newY;
      this.insert(entity);
    } else {
      entity.x = newX;
      entity.y = newY;
    }
  }

  /**
   * Query all entities whose cell overlaps a circle (x, y, radius).
   * Returns a Set — caller is responsible for doing precise distance checks
   * if needed (this is the broadphase; caller does the narrowphase).
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @returns {Set<object>}
   */
  query(x, y, radius) {
    const results = new Set();
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const cell = this.cells.get(this._key(cx, cy));
        if (cell) {
          for (const entity of cell) {
            results.add(entity);
          }
        }
      }
    }
    return results;
  }

  /**
   * Remove all entities from the grid (full clear).
   * Used when rebuilding the segment grid each tick.
   */
  clear() {
    this.cells.clear();
  }

  /** Returns the total number of tracked entities (for metrics). */
  get size() {
    let count = 0;
    for (const cell of this.cells.values()) {
      count += cell.size;
    }
    return count;
  }
}

module.exports = { SpatialGrid };
