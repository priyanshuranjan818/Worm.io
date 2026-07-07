'use strict';

/**
 * matchmaking.js — Arena assignment service.
 *
 * v1: Single global arena — every player joins the same instance.
 *
 * Stage B upgrade (zero breaking changes):
 *   - Replace getArena() to check arena player counts
 *   - Spin up a new World instance when existing ones are full
 *   - Return the arena's id so index.js can route the socket to the right room
 *
 * The clean interface here is exactly what CLAUDE.md §5 Stage B describes:
 * "When a player clicks Join, route them to whichever arena instance has room."
 */

const { World } = require('./world');
const cfg       = require('./config');

class MatchmakingService {
  constructor() {
    /** @type {Map<string, World>} arenaId → World */
    this.arenas = new Map();

    // Create the initial default arena
    const defaultArena = new World('arena-1');
    this.arenas.set(defaultArena.arenaId, defaultArena);
  }

  /**
   * Get (or create) an arena for an incoming player.
   * Returns the World instance to join.
   *
   * Stage B: change this method to implement round-robin / capacity routing.
   * Nothing else in the codebase needs to change.
   *
   * @returns {World}
   */
  getArena() {
    // v1: always return the first (and only) arena
    for (const arena of this.arenas.values()) {
      if (arena.playerCount < cfg.MAX_PLAYERS) {
        return arena;
      }
    }
    // All arenas full — create a new one (Stage B bootstrap)
    const newId    = `arena-${this.arenas.size + 1}`;
    const newArena = new World(newId);
    this.arenas.set(newId, newArena);
    return newArena;
  }

  /**
   * Get an arena by id (used by socket.io event handlers).
   * @param {string} arenaId
   * @returns {World | null}
   */
  getArenaById(arenaId) {
    return this.arenas.get(arenaId) || null;
  }

  /**
   * Returns a summary of all arenas (for the /health endpoint).
   */
  getStatus() {
    const result = [];
    for (const arena of this.arenas.values()) {
      result.push({
        id:      arena.arenaId,
        players: arena.playerCount,
        alive:   arena.aliveCount,
        food:    arena.foodManager.foods.size,
      });
    }
    return result;
  }
}

module.exports = { MatchmakingService };
