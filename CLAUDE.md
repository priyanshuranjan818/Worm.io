# CLAUDE.md — HaxxWorm.io Multiplayer Game

This file is the single source of truth for architecture, game spec, and scaling plan.

---

## 1. Project Summary

A real-time multiplayer browser game in the Wormate.io / Slither.io genre. Players control a
worm that follows the mouse cursor, eats food to grow, and dies if its head hits another worm's
body. All players who click "Join" land in the same shared live arena.

**Not a visual clone** — original assets/theme, same core mechanics.

---

## 2. Game Mechanics Spec (source of truth)

| Mechanic | Rule |
|---|---|
| Movement | Worm head continuously moves toward the mouse cursor position. No keyboard movement. |
| Boost | Holding mouse-down increases speed; worm slowly loses mass while boosting. |
| Growth | Eating food increases length + score. Food has varying value (tiny → mega). |
| Death | Only **head-to-body** collision kills. Passing your head over your *own* tail = safe. |
| Death drop | On death, the worm's full body converts into a field of food pellets others can eat. |
| Leaderboard | Top N players by current length/score, updated live for all clients. |
| World | One shared arena per server instance; all concurrent joiners land in the same instance (until sharding — see §5). |
| Camera | Each client renders only the area around their own worm (viewport), not the whole map. |

Server is authoritative for all of the above — client never decides collisions or growth, only
sends input (cursor angle, boost on/off) and renders what the server tells it.

---

## 3. Architecture

```
Browser Client (Canvas + Vanilla JS)
   │  Native WebSocket (binary, no socket.io)
   │  msgpack binary frames (← NOT JSON)
   ▼
uWebSockets.js Game Server (C++ under the hood, Node.js bindings)
   ├── HTTP: static file serving (public/)
   ├── WS: /  — all game connections
   ├── transport.js — msgpack encode/decode, socket rooms abstraction
   ├── Game loop (60Hz tick, 20Hz broadcast)
   ├── In-memory world state: players, food, positions
   ├── Spatial grid collision detection
   └── Per-client AOI snapshot broadcasts
```

### Why uWebSockets.js (not socket.io)

| Property | socket.io | uWebSockets.js |
|---|---|---|
| Implementation | JavaScript | C++ (libuv + epoll/kqueue) |
| Throughput | ~100k msg/sec | ~10M msg/sec |
| Latency | Higher (JS event loop) | Near-native |
| Protocol overhead | Large (polling fallback, JSON) | Minimal (raw WS frames) |
| Used by | General web apps | slither.io clones, gaming |

uWebSockets.js is a C++ WebSocket server exposed to Node.js via N-API bindings.
We write regular JavaScript — the C++ performance is transparent.

### Wire format: msgpack binary (not JSON)
- All server→client and client→server messages are **msgpack-encoded binary**
- msgpack is ~30-50% smaller than JSON and faster to encode/decode
- Short key names (`t`, `d`) used in all message envelopes
- Segment positions encoded as integer arrays `[x, y]` (not `{x, y}` objects)

---

## 4. Message Protocol

### Client → Server (msgpack binary)
```
{ t: 'pj', d: { name } }         player:join
{ t: 'pi', d: { a, b } }         player:input (angle, boosting)
{ t: 'pr', d: { name } }         player:rejoin
```

### Server → Client (msgpack binary)
```
{ t: 'gj', d: { ... } }          game:joined
{ t: 'gs', d: { t, p, f, y, lb, fe, fs } }   game:snapshot (20Hz)
{ t: 'gd', d: { score, length, killer } }     game:death
{ t: 'gk', d: { victimName, killerId } }      game:killed (kill feed)
{ t: 'ge', d: { message } }                  game:error
```

---

## 5. Why Naive Multiplayer Doesn't Scale (and what breaks first)

Two ceilings hit before anything else:

1. **CPU per tick** — collision detection between every worm and every other worm is O(n²) if
   done naively. At a few hundred concurrent players in one arena, this starts dropping tick rate.
2. **Single process = single point of failure and a hard cap** — one Node process can only use
   one CPU core efficiently; you can't just "add more RAM" to hold more players smoothly.

Bandwidth is usually *not* the first bottleneck if state is sent as deltas (see §7), but it
matters at scale too.

---

## 6. Scaling Plan (do these in order, only when needed)

### Stage A — Optimize the single server (cheapest, do this first) ✅ DONE
- **Spatial partitioning** (grid): only check collisions between worms in adjacent cells — built in.
- **Area of Interest (AOI)**: only send each client the state of players/food near their worm — built in.
- **Delta compression**: send only eaten/spawned food, not full state every tick — built in.
- **uWebSockets.js + msgpack**: fastest WebSocket stack available — built in.

### Stage B — Multiple game rooms/instances on one machine
- Run several independent arena instances (separate game loops).
- When a player clicks "Join", `matchmaking.js` routes them to an arena with room.
- `matchmaking.getArena()` is the only place to change for this.

### Stage C — Horizontal scaling across machines
- Load balancer (ALB) in front of multiple uWS Node instances.
- Sticky sessions: player's WebSocket must stay pinned to the server holding their arena state.
- Matchmaking service: stateless Lambda that returns server address on join.

### Stage D — Cross-server coordination
- **Redis pub/sub**: global leaderboard, arena player counts across instances.
- **Persistent storage** (Postgres/Mongo): accounts, skins, coins, cross-session stats.
- **Regional servers**: US/EU/Asia — matchmaking picks closest region.

### Stage E — Ops/reliability
- Health checks + auto-restart per arena instance.
- Metrics: players per instance, tick duration, dropped packets.

---

## 7. Networking Details

- **Client sends input only** (angle in radians, boost bool) — never position.
- **Broadcast rate decoupled from tick rate**: simulate at 60Hz, broadcast at 20Hz.
- **AOI filtering**: each client snapshot contains only entities within AOI_RADIUS (2000px).
- **Interpolation on the client**: render 40ms in the past, lerp between snapshots → smooth 60fps from 20Hz updates.
- **Binary msgpack frames** for all messages — not JSON strings.

---

## 8. File Structure

```
HaxxWorm.io/
  server/
    index.js          # Entry point: uWS server, static files, WS event routing
    transport.js      # Socket abstraction: msgpack encode/decode, rooms, send/broadcast
    config.js         # All tunable constants
    gameLoop.js       # Fixed 60Hz tick, 20Hz broadcast
    world.js          # Arena state container
    player.js         # Player entity (pure game logic)
    food.js           # Food entity + FoodManager
    spatialGrid.js    # Spatial hash grid (O(1) broadphase)
    collision.js      # Pure collision detection functions
    matchmaking.js    # Arena assignment (Stage B seam)
    assetRegistry.js  # Skins / food types / maps registry
    logger.js         # Pino structured logger (CloudWatch-ready)
  public/
    index.html        # Game shell (no socket.io — native WebSocket)
    client.js         # WS + msgpack client, state machine, render loop
    renderer.js       # Canvas 2D rendering
    interpolation.js  # Client-side lerp between snapshots
    input.js          # Mouse input capture (30Hz throttled)
    style.css         # Cyberpunk dark neon UI
  maps/
    default.json
  public/assets/
    skins/registry.json
    food/registry.json
  Dockerfile
  docker-compose.yml
  .env.example
  CLAUDE.md
  package.json
```

## 9. Custom Assets (future)

- **Skins**: add PNG to `public/assets/skins/`, register in `registry.json`
- **Food types**: add sprite to `public/assets/food/`, register in `registry.json`
- **Maps**: add `maps/yourmap.json`, set `ACTIVE_MAP=yourmap` in `.env`
- Stage B+: upload assets to S3, set `ASSET_BASE_URL` in `.env` → CloudFront CDN

## 10. Non-Goals for v1

- No accounts/login, no skins shop, no monetization.
- No mobile touch controls yet.
- No Stage C/D infrastructure before it's actually needed.
