'use strict';

/**
 * assetRegistry.js — Pluggable registry for custom skins, food types, and maps.
 *
 * v1: Loads from local JSON files in public/assets/.
 * Stage B: Can be extended to load from S3 / a database without changing the API.
 *
 * This is the seam described in the architecture plan:
 *   "When you're ready to add custom assets, you won't be touching game logic
 *    — just dropping files and updating JSON registries."
 */

const fs   = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');

// ── Loader helper ──────────────────────────────────────────────────────────

function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

// ── Skin registry ──────────────────────────────────────────────────────────

class SkinRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.skins = new Map();
    this._load();
  }

  _load() {
    const data = loadJSON(path.join(ASSETS_DIR, 'skins', 'registry.json'));
    if (data && Array.isArray(data.skins)) {
      for (const skin of data.skins) {
        this.skins.set(skin.id, skin);
      }
    }
    // Always ensure the built-in default exists
    if (!this.skins.has('default')) {
      this.skins.set('default', {
        id:         'default',
        name:       'Default',
        headColor:  null, // use player.color
        bodyGradient: null,
        eyeStyle:   'default',
        deathEffect:'pixel_burst',
      });
    }
  }

  get(id) {
    return this.skins.get(id) || this.skins.get('default');
  }

  list() {
    return [...this.skins.values()];
  }

  /**
   * Register a new skin at runtime (Stage B: called after upload to S3).
   * @param {object} skinData
   */
  register(skinData) {
    this.skins.set(skinData.id, skinData);
  }
}

// ── Food type registry ─────────────────────────────────────────────────────

class FoodTypeRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.types = new Map();
    this._load();
  }

  _load() {
    const data = loadJSON(path.join(ASSETS_DIR, 'food', 'registry.json'));
    if (data && Array.isArray(data.foodTypes)) {
      for (const ft of data.foodTypes) {
        this.types.set(ft.id, ft);
      }
    }
  }

  get(id) {
    return this.types.get(id) || null;
  }

  list() {
    return [...this.types.values()];
  }

  register(foodType) {
    this.types.set(foodType.id, foodType);
  }
}

// ── Map registry ───────────────────────────────────────────────────────────

class MapRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.maps = new Map();
    this._load();
  }

  _load() {
    const mapsDir = path.join(__dirname, '..', 'maps');
    if (!fs.existsSync(mapsDir)) { return; }
    const files = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = loadJSON(path.join(mapsDir, file));
      if (data && data.id) {
        this.maps.set(data.id, data);
      }
    }
  }

  get(id) {
    return this.maps.get(id) || this.maps.get('default') || null;
  }

  list() {
    return [...this.maps.values()];
  }
}

// ── Singleton exports ──────────────────────────────────────────────────────

const skinRegistry    = new SkinRegistry();
const foodTypeRegistry = new FoodTypeRegistry();
const mapRegistry     = new MapRegistry();

module.exports = { skinRegistry, foodTypeRegistry, mapRegistry };
