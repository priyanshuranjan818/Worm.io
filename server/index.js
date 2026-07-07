'use strict';

/**
 * index.js — Server entry point.
 *
 * Uses uWebSockets.js (C++ WebSocket server) instead of socket.io.
 * 10–100× faster WebSocket throughput with near-native latency.
 *
 * Responsibilities:
 *   - uWS App: WebSocket handler + HTTP static file server
 *   - Health check endpoint (AWS ALB / ECS compatible)
 *   - Incoming message routing → game objects
 *   - Graceful SIGTERM shutdown
 */

require('dotenv').config();

const path               = require('path');
const fs                 = require('fs');
const uWS                = require('uWebSockets.js');
const { v4: uuidv4 }     = require('uuid');
const cfg                = require('./config');
const logger             = require('./logger');
const { Transport }      = require('./transport');
const { MatchmakingService } = require('./matchmaking');
const { GameLoop }       = require('./gameLoop');

// ── Static file serving ───────────────────────────────────────────────────

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

function serveStatic(res, urlPath) {
  // Security: normalise and prevent path traversal
  const rel     = urlPath === '/' ? '/index.html' : urlPath;
  const absPath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!absPath.startsWith(PUBLIC_DIR)) {
    res.writeStatus('403 Forbidden').end('Forbidden');
    return;
  }

  const ext  = path.extname(absPath);
  const mime = MIME[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(absPath);
    res.cork(() => {
      res.writeHeader('Content-Type', mime);
      if (cfg.NODE_ENV === 'production') {
        res.writeHeader('Cache-Control', 'public, max-age=3600');
      }
      res.end(data);
    });
  } catch (_err) {
    res.writeStatus('404 Not Found').end('Not Found');
  }
}

// ── App setup ─────────────────────────────────────────────────────────────

const transport   = new Transport();
const matchmaking = new MatchmakingService();

/** @type {Map<string, GameLoop>} arenaId → GameLoop */
const gameLoops = new Map();

function getOrCreateLoop(arena) {
  if (!gameLoops.has(arena.arenaId)) {
    const loop = new GameLoop(arena, transport);
    loop.start();
    gameLoops.set(arena.arenaId, loop);
    logger.info({ arenaId: arena.arenaId }, 'Arena + game loop created');
  }
  return gameLoops.get(arena.arenaId);
}

// Start loops for all initial arenas
for (const arena of matchmaking.arenas.values()) {
  getOrCreateLoop(arena);
}

// ── uWS application ───────────────────────────────────────────────────────

const app = uWS.App();

// ── Health check endpoint ─────────────────────────────────────────────────

let shuttingDown = false;

app.get('/health', (res) => {
  const body = JSON.stringify({
    status:  shuttingDown ? 'shutting_down' : 'ok',
    uptime:  process.uptime(),
    arenas:  matchmaking.getStatus(),
    loops:   [...gameLoops.values()].map(gl => gl.getMetrics()),
    mem:     process.memoryUsage(),
    connections: transport.connectionCount,
  });
  res.cork(() => {
    res.writeStatus(shuttingDown ? '503 Service Unavailable' : '200 OK');
    res.writeHeader('Content-Type', 'application/json');
    res.end(body);
  });
});

// ── Static file routes ─────────────────────────────────────────────────────

app.get('/*', (res, req) => {
  // uWS requires onAborted to be set before any async operation.
  // serveStatic is synchronous so we don't need it here, but set it anyway.
  res.onAborted(() => {});
  serveStatic(res, req.getUrl());
});

// ── WebSocket handler ──────────────────────────────────────────────────────

app.ws('/*', {
  compression:      uWS.DISABLED, // msgpack is already compact; compression adds CPU cost
  maxPayloadLength: 16 * 1024,    // 16 KB max incoming message
  idleTimeout:      30,           // seconds before uWS disconnects idle socket
  sendPingsAutomatically: true,

  open(ws) {
    // Assign a unique ID to this connection
    ws.socketId = uuidv4();
    ws.arenaId  = null;
    transport.register(ws.socketId, ws);
    logger.debug({ socketId: ws.socketId }, 'WS connected');
  },

  message(ws, rawMessage, isBinary) {
    if (!isBinary) { return; } // only accept binary (msgpack) messages
    const msg = transport.decodeIncoming(rawMessage);
    if (!msg || typeof msg.t !== 'string') { return; }

    switch (msg.t) {
      case 'pj': handleJoin(ws, msg.d);   break;
      case 'pi': handleInput(ws, msg.d);  break;
      case 'pr': handleRejoin(ws, msg.d); break;
    }
  },

  close(ws) {
    logger.debug({ socketId: ws.socketId }, 'WS disconnected');
    if (ws.arenaId) {
      const arena = matchmaking.getArenaById(ws.arenaId);
      if (arena) {
        const player = arena.getPlayer(ws.socketId);
        if (player) {
          logger.info({ name: player.name, arenaId: ws.arenaId }, 'Player left');
        }
        arena.removePlayer(ws.socketId);
      }
    }
    transport.unregister(ws.socketId, ws.arenaId);
  },

  drain(ws) {
    // Called when the socket's send buffer drains.
    // We already guard with getBufferedAmount() in transport.js, so nothing needed here.
    logger.debug({ socketId: ws.socketId, buffered: ws.getBufferedAmount() }, 'WS drain');
  },
});

// ── Message handlers ───────────────────────────────────────────────────────

function sanitiseName(raw) {
  let name = String(raw || '').trim().replace(/[<>&"'/]/g, '').slice(0, 20);
  return name || 'Anonymous';
}

function handleJoin(ws, data) {
  if (ws.arenaId) { return; } // already in a game

  const name  = sanitiseName(data?.name);
  const arena = matchmaking.getArena();
  getOrCreateLoop(arena);

  ws.arenaId = arena.arenaId;
  transport.joinRoom(ws.socketId, arena.arenaId);

  const player = arena.addPlayer(ws.socketId, name);

  const { skinRegistry, foodTypeRegistry } = require('./assetRegistry');
  transport.send(ws.socketId, 'gj', {
    playerId:  player.id,
    arenaId:   arena.arenaId,
    worldInfo: arena.getWorldInfo(),
    color:     player.color,
    name:      player.name,
    skins:     skinRegistry.list(),
    foodTypes: foodTypeRegistry.list(),
  });

  logger.info({ socketId: ws.socketId, name: player.name, arenaId: arena.arenaId }, 'Player joined');
}

function handleInput(ws, data) {
  if (!ws.arenaId) { return; }
  const arena = matchmaking.getArenaById(ws.arenaId);
  if (!arena) { return; }
  const player = arena.getPlayer(ws.socketId);
  if (!player || !player.alive) { return; }

  const angle    = typeof data?.a === 'number' && isFinite(data.a) ? data.a : null;
  const boosting = Boolean(data?.b);
  if (angle === null) { return; }

  player.applyInput(angle, boosting);
}

function handleRejoin(ws, data) {
  if (!ws.arenaId) { return; }
  const arena = matchmaking.getArenaById(ws.arenaId);
  if (!arena) { return; }

  arena.removePlayer(ws.socketId);
  const name   = sanitiseName(data?.name);
  const player = arena.addPlayer(ws.socketId, name);

  const { skinRegistry, foodTypeRegistry } = require('./assetRegistry');
  transport.send(ws.socketId, 'gj', {
    playerId:  player.id,
    arenaId:   arena.arenaId,
    worldInfo: arena.getWorldInfo(),
    color:     player.color,
    name:      player.name,
    skins:     skinRegistry.list(),
    foodTypes: foodTypeRegistry.list(),
  });

  logger.info({ socketId: ws.socketId, name: player.name }, 'Player rejoined');
}

// ── Start listening ────────────────────────────────────────────────────────

let listenSocket = null;

app.listen(cfg.PORT, (token) => {
  if (token) {
    listenSocket = token;
    logger.info({
      port:          cfg.PORT,
      env:           cfg.NODE_ENV,
      tickRate:      cfg.TICK_RATE,
      broadcastRate: cfg.BROADCAST_RATE,
      worldSize:     `${cfg.WORLD_WIDTH}×${cfg.WORLD_HEIGHT}`,
      maxPlayers:    cfg.MAX_PLAYERS,
      transport:     'uWebSockets.js (C++)',
      protocol:      'msgpack binary',
    }, '🐛 HaxxWorm.io server started');
  } else {
    logger.error({ port: cfg.PORT }, 'Failed to listen — port in use?');
    process.exit(1);
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutdown signal — stopping game loops');
  shuttingDown = true;

  for (const loop of gameLoops.values()) { loop.stop(); }

  if (listenSocket) {
    uWS.us_listen_socket_close(listenSocket);
    listenSocket = null;
  }

  setTimeout(() => {
    logger.info('Clean exit');
    process.exit(0);
  }, 2000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

module.exports = { app, transport };
