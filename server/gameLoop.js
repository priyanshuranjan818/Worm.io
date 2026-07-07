'use strict';

/**
 * gameLoop.js — Fixed-step physics loop + broadcast scheduler.
 *
 * Uses Transport (not socket.io) for all I/O. Transport-agnostic.
 * Broadcast condition: every BROADCAST_EVERY ticks OR on player death.
 * Food-eat events are bundled into the next scheduled broadcast (not immediate)
 * — this prevents over-broadcasting at 60Hz when a player eats food every tick.
 */

const { checkFoodCollisions, checkBodyCollisions, buildSegmentGrid } = require('./collision');
const cfg    = require('./config');
const logger = require('./logger');

const TICK_NS = BigInt(Math.round(cfg.TICK_MS * 1_000_000));

class GameLoop {
  /**
   * @param {import('./world').World} world
   * @param {import('./transport').Transport} transport
   */
  constructor(world, transport) {
    this.world     = world;
    this.transport = transport;
    this.arenaId   = world.arenaId;
    this.running   = false;
    this.tickCount = 0;
    this._tickTimer = null;

    // Perf tracking
    this._slowTickWarnings = 0;
    this._totalTickTime    = 0n;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start() {
    if (this.running) { return; }
    this.running = true;
    this._lastTickTime = process.hrtime.bigint();
    this._schedule();
    logger.info({ arenaId: this.arenaId }, 'Game loop started');
  }

  stop() {
    this.running = false;
    if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
    logger.info({ arenaId: this.arenaId }, 'Game loop stopped');
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  _schedule() {
    if (!this.running) { return; }

    const now = process.hrtime.bigint();
    if (now >= this._lastTickTime + TICK_NS) {
      this._lastTickTime += TICK_NS;
      this._runTick();
    }

    // Sleep until next tick — gives event loop full breathing room for I/O
    const nextTickNs = this._lastTickTime + TICK_NS;
    const delayMs    = Number(nextTickNs - process.hrtime.bigint()) / 1_000_000;
    const safeDelay  = Math.min(Math.max(0, delayMs - 0.5), cfg.TICK_MS);
    this._tickTimer  = setTimeout(() => this._schedule(), safeDelay);
  }

  // ── Tick ───────────────────────────────────────────────────────────────

  _runTick() {
    const t0 = process.hrtime.bigint();

    try {
      this.tickCount++;
      const world = this.world;

      // 1. Move all players
      for (const player of world.players.values()) {
        if (player.alive) { player.tick(); }
      }

      // 2. Build per-tick segment grid for collision broadphase
      const segGrid = buildSegmentGrid(world.players);

      // 3. Collision detection — pure functions → event arrays
      const foodEvents  = [];
      const deathEvents = [];

      for (const player of world.players.values()) {
        if (!player.alive) { continue; }
        const fe = checkFoodCollisions(player, world.foodManager);
        for (const ev of fe) { foodEvents.push(ev); }
      }
      const de = checkBodyCollisions(world.players, segGrid);
      for (const ev of de) { deathEvents.push(ev); }

      // 4. Apply food events
      const eatenFoodIds    = [];
      const spawnedFoodData = [];

      for (const ev of foodEvents) {
        const player = world.players.get(ev.playerId);
        if (!player || !player.alive) { continue; }
        if (world.foodManager.consume(ev.foodId)) {
          player.feed(ev.growAmount, ev.value);
          eatenFoodIds.push(ev.foodId);
        }
      }

      // 5. Apply death events
      const deathData = [];

      for (const ev of deathEvents) {
        const victim = world.players.get(ev.victimId);
        if (!victim || !victim.alive) { continue; }

        const segmentsCopy = [...victim.segments];
        victim.kill();

        const dropped = world.foodManager.spawnDeathDrop(segmentsCopy);
        for (const food of dropped) { spawnedFoodData.push(food.toPacket()); }

        if (ev.killerId) {
          const killer = world.players.get(ev.killerId);
          if (killer && killer.alive) {
            killer.feed(
              Math.floor(segmentsCopy.length * 0.2),
              Math.floor(victim.score * 0.1)
            );
          }
        }

        deathData.push({
          victimId:   ev.victimId,
          victimName: victim.name,
          killerId:   ev.killerId,
          killerName: ev.killerId ? world.players.get(ev.killerId)?.name : null,
          score:      victim.score,
          length:     segmentsCopy.length,
        });
      }

      // 6. Maintain food density
      world.foodManager.maintain();

      // 7. Leaderboard
      const isLbTick = this.tickCount % cfg.LEADERBOARD_UPDATE_TICKS === 0;
      if (isLbTick) { world.rebuildLeaderboard(); }

      // 8. Broadcast
      // Only broadcast on schedule OR when someone dies (deaths are time-critical).
      // Food-eat events are bundled into the next scheduled broadcast — prevents
      // broadcasting at 60Hz every time a worm eats (was the previous lag cause).
      const isBroadcastTick = this.tickCount % cfg.BROADCAST_EVERY === 0;
      if (isBroadcastTick || deathData.length > 0) {
        this._broadcast(
          deathData,
          eatenFoodIds,
          spawnedFoodData,
          isLbTick && isBroadcastTick
        );
      }

    } catch (err) {
      logger.error({ err, arenaId: this.arenaId }, 'Error in game tick');
    }

    // Perf monitoring
    const elapsed = process.hrtime.bigint() - t0;
    this._totalTickTime += elapsed;
    const elapsedMs = Number(elapsed) / 1_000_000;
    if (elapsedMs > cfg.TICK_MS * 0.8) {
      this._slowTickWarnings++;
      if (this._slowTickWarnings % 60 === 1) {
        logger.warn({
          arenaId: this.arenaId,
          tickMs: elapsedMs.toFixed(2),
          budget: cfg.TICK_MS.toFixed(2),
          players: this.world.playerCount,
        }, 'Tick over 80% of budget');
      }
    }
  }

  // ── Broadcast ──────────────────────────────────────────────────────────

  _broadcast(deathData, eatenFoodIds, spawnedFoodData, sendLeaderboard) {
    const { transport, world, arenaId, tickCount: tick } = this;

    // ── Deaths: send individually to victim + broadcast kill event ─────
    for (const death of deathData) {
      transport.send(death.victimId, 'gd', {
        score:  death.score,
        length: death.length,
        killer: death.killerName || null,
      });
      transport.broadcast(arenaId, 'gk', {
        victimName: death.victimName,
        killerId:   death.killerId,
      });
    }

    // ── State snapshots: per-client AOI-filtered ───────────────────────
    for (const [socketId, player] of world.players.entries()) {
      if (!player.alive) { continue; }

      const snapshot = world.buildSnapshot(socketId, tick, sendLeaderboard);
      if (!snapshot) { continue; }

      // Attach food delta
      snapshot.fe = eatenFoodIds;
      snapshot.fs = spawnedFoodData;

      transport.send(socketId, 'gs', snapshot);
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  getMetrics() {
    const avgTickMs = this.tickCount > 0
      ? Number(this._totalTickTime) / this.tickCount / 1_000_000
      : 0;
    return {
      arenaId:          this.arenaId,
      ticks:            this.tickCount,
      avgTickMs:        avgTickMs.toFixed(3),
      slowTickWarnings: this._slowTickWarnings,
      players:          this.world.playerCount,
      food:             this.world.foodManager.foods.size,
    };
  }
}

module.exports = { GameLoop };
