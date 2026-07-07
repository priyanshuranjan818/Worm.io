'use strict';

/**
 * config.js — Single source of truth for all game constants.
 *
 * Every tunable value lives here. Nothing in game logic should
 * contain a magic number — import this module instead.
 *
 * Values can be overridden at startup via environment variables
 * (see .env.example) without modifying code. This is what makes
 * AWS / Docker deployments clean and configurable.
 */

require('dotenv').config();

const cfg = {
  // ── Server ─────────────────────────────────────────────────────────
  PORT:       parseInt(process.env.PORT, 10)       || 3000,
  NODE_ENV:   process.env.NODE_ENV                 || 'development',
  LOG_LEVEL:  process.env.LOG_LEVEL                || 'info',

  // ── Game Loop ──────────────────────────────────────────────────────
  // Physics simulation rate — every tick the world advances by TICK_MS ms
  TICK_RATE:      parseInt(process.env.TICK_RATE_HZ, 10)  || 60,
  // How often state snapshots are pushed to clients (must divide TICK_RATE)
  BROADCAST_RATE: parseInt(process.env.BROADCAST_HZ, 10)  || 20,

  // ── World ──────────────────────────────────────────────────────────
  WORLD_WIDTH:  parseInt(process.env.WORLD_WIDTH, 10)  || 14000,
  WORLD_HEIGHT: parseInt(process.env.WORLD_HEIGHT, 10) || 14000,
  MAX_PLAYERS:  parseInt(process.env.MAX_PLAYERS_PER_ARENA, 10) || 50,

  // ── Worm Physics ───────────────────────────────────────────────────
  BASE_SPEED:         3.5,   // pixels per tick at normal speed
  BOOST_SPEED_MULT:   1.85,  // head speed multiplier while boosting
  MAX_TURN_RATE:      0.085, // max radians the worm can turn per tick (feel)
  SEGMENT_SPACING:    12,    // distance (px) between consecutive segments
  INITIAL_LENGTH:     22,    // starting segment count
  MIN_BOOST_LENGTH:   10,    // minimum segments needed to boost
  SAFE_SEGMENTS:      8,     // own segments near head skipped for self-collision
  HEAD_RADIUS:        10,    // collision radius of worm head
  BODY_RADIUS:        8,     // collision radius of body segments
  // Visual radii (drawn larger than collision for aesthetics)
  HEAD_DRAW_RADIUS:   14,
  BODY_DRAW_RADIUS:   10,

  // ── Boost ──────────────────────────────────────────────────────────
  // Segments lost per tick while boosting (fractional accumulator)
  BOOST_MASS_COST: 0.10,

  // ── Food ───────────────────────────────────────────────────────────
  FOOD_TARGET_COUNT: 3000,
  FOOD_SPAWN_BATCH:  80,     // max food spawned per maintain cycle
  DEATH_SEG_PER_FOOD: 3,    // every N segments → 1 food pellet on death
  FOOD_TYPES: {
    tiny:   { value: 1,  radius: 5  },
    small:  { value: 2,  radius: 7  },
    medium: { value: 5,  radius: 10 },
    large:  { value: 12, radius: 15 },
    mega:   { value: 30, radius: 22 },
  },
  // Weighted random spawn distribution
  FOOD_WEIGHTS: [
    { type: 'tiny',   weight: 0.40 },
    { type: 'small',  weight: 0.30 },
    { type: 'medium', weight: 0.18 },
    { type: 'large',  weight: 0.10 },
    { type: 'mega',   weight: 0.02 },
  ],

  // ── Spatial Grid ───────────────────────────────────────────────────
  // Cell size: larger = fewer cells but more entities per cell.
  // Optimal: 2-3x the max collision query radius.
  GRID_CELL_SIZE: 280,

  // ── Area of Interest (AOI) ─────────────────────────────────────────
  // Only entities within this radius of a player's head are sent to that client.
  AOI_RADIUS: 2800,

  // ── Leaderboard ────────────────────────────────────────────────────
  LEADERBOARD_SIZE:            10,
  LEADERBOARD_UPDATE_TICKS:     6, // recalculate every N ticks

  // ── Spawn ──────────────────────────────────────────────────────────
  SPAWN_MARGIN:     600,   // px from world edge where players cannot spawn
  SPAWN_SAFETY_RADIUS: 800, // px — no other worm heads within this radius of spawn point

  // ── Networking ─────────────────────────────────────────────────────
  // How many ticks between input timeouts before player is considered AFK
  INPUT_TIMEOUT_TICKS: 600, // 10s at 60Hz
};

// Derived constants (computed once, not magic numbers in logic)
cfg.TICK_MS        = 1000 / cfg.TICK_RATE;         // ms per physics tick
cfg.BROADCAST_EVERY = Math.round(cfg.TICK_RATE / cfg.BROADCAST_RATE); // ticks between broadcasts

module.exports = cfg;
