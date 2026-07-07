'use strict';

/**
 * transport.js — WebSocket transport abstraction layer.
 *
 * Wraps uWebSockets.js raw WebSocket objects with:
 *   - msgpack binary encoding/decoding for all messages
 *   - Socket registry (socketId → ws object)
 *   - Arena rooms (arenaId → Set<socketId>) — replaces socket.io rooms
 *   - Backpressure guard (skip send if client buffer is full)
 *
 * gameLoop.js and index.js use ONLY this module for all I/O.
 * Swapping the underlying WebSocket library in the future only requires
 * changing this file — game logic is completely unaffected.
 */

const { encode, decode } = require('@msgpack/msgpack');

// How many bytes of queued outbound data before we skip non-critical sends.
// Prevents memory bloat when a client is too slow to drain its socket.
const BACKPRESSURE_LIMIT = 512 * 1024; // 512 KB

class Transport {
  constructor() {
    /** @type {Map<string, object>} socketId → uWS ws object */
    this.sockets = new Map();
    /** @type {Map<string, Set<string>>} arenaId → Set<socketId> */
    this.rooms   = new Map();
  }

  // ── Socket lifecycle ───────────────────────────────────────────────────

  /**
   * Register a new WebSocket connection.
   * Called from uWS `open` handler.
   * @param {string} socketId
   * @param {object} ws — uWS WebSocket object
   */
  register(socketId, ws) {
    this.sockets.set(socketId, ws);
  }

  /**
   * Unregister a disconnected socket and remove from its room.
   * Called from uWS `close` handler.
   * @param {string} socketId
   * @param {string|null} arenaId
   */
  unregister(socketId, arenaId) {
    this.sockets.delete(socketId);
    if (arenaId) {
      const room = this.rooms.get(arenaId);
      if (room) {
        room.delete(socketId);
        if (room.size === 0) {
          this.rooms.delete(arenaId);
        }
      }
    }
  }

  // ── Rooms (arena grouping) ─────────────────────────────────────────────

  /**
   * Add a socket to an arena room (equivalent to socket.io's socket.join).
   * @param {string} socketId
   * @param {string} arenaId
   */
  joinRoom(socketId, arenaId) {
    if (!this.rooms.has(arenaId)) {
      this.rooms.set(arenaId, new Set());
    }
    this.rooms.get(arenaId).add(socketId);
  }

  // ── Encoding ───────────────────────────────────────────────────────────

  /**
   * Encode a typed message to a msgpack Buffer.
   * Message envelope: { t: eventType, d: data }
   * Short keys save bandwidth on every message.
   * @param {string} type — event name
   * @param {*} data
   * @returns {Buffer}
   */
  _encode(type, data) {
    return Buffer.from(encode({ t: type, d: data }));
  }

  /**
   * Decode an incoming msgpack ArrayBuffer from the client.
   * @param {ArrayBuffer} rawMessage
   * @returns {{ t: string, d: * } | null}
   */
  decodeIncoming(rawMessage) {
    try {
      return decode(Buffer.from(rawMessage));
    } catch (_err) {
      return null;
    }
  }

  // ── Sending ────────────────────────────────────────────────────────────

  /**
   * Send a binary message to one socket.
   * Silently skips if socket is gone or backpressure limit exceeded.
   * @param {string} socketId
   * @param {string} type
   * @param {*} data
   */
  send(socketId, type, data) {
    const ws = this.sockets.get(socketId);
    if (!ws) { return; }
    if (ws.getBufferedAmount() > BACKPRESSURE_LIMIT) { return; }
    try {
      ws.send(this._encode(type, data), /* isBinary */ true);
    } catch (_err) {
      // Socket may have just closed — ignore
    }
  }

  /**
   * Send a pre-encoded Buffer to one socket (avoids re-encoding per-client snapshots).
   * @param {string} socketId
   * @param {Buffer} buf
   */
  sendRaw(socketId, buf) {
    const ws = this.sockets.get(socketId);
    if (!ws) { return; }
    if (ws.getBufferedAmount() > BACKPRESSURE_LIMIT) { return; }
    try {
      ws.send(buf, true);
    } catch (_err) {}
  }

  /**
   * Broadcast a message to all sockets in an arena room.
   * Encodes once, sends to all — O(n) socket writes.
   * @param {string} arenaId
   * @param {string} type
   * @param {*} data
   */
  broadcast(arenaId, type, data) {
    const room = this.rooms.get(arenaId);
    if (!room || room.size === 0) { return; }
    const buf = this._encode(type, data);
    for (const socketId of room) {
      const ws = this.sockets.get(socketId);
      if (!ws) { continue; }
      if (ws.getBufferedAmount() > BACKPRESSURE_LIMIT) { continue; }
      try {
        ws.send(buf, true);
      } catch (_err) {}
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  get connectionCount() { return this.sockets.size; }

  getRoomSize(arenaId) {
    return this.rooms.get(arenaId)?.size ?? 0;
  }
}

module.exports = { Transport };
