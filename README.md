# HaxxWorm.io

Real-time multiplayer worm game — production-ready Node.js server + HTML5 Canvas client.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment config
cp .env.example .env

# 3. Run in development (auto-restart on file changes)
npm run dev

# 4. Open in browser
# http://localhost:3000
```

## Production Run (direct)

```bash
NODE_ENV=production npm start
```

## Docker (recommended for production)

```bash
# Build and run
docker compose up --build

# Or just run (uses pre-built image)
docker compose up
```

## AWS Deployment (EC2 — v1)

```bash
# On EC2 instance:
git clone <your-repo>
cd HaxxWorm.io
npm ci --only=production
NODE_ENV=production PORT=3000 node server/index.js

# With PM2 (recommended for EC2)
npm install -g pm2
pm2 start server/index.js --name haxxworm
pm2 save
pm2 startup
```

## Health Check

```
GET /health
→ { status: "ok", uptime: 123, arenas: [...], mem: {...} }
```

AWS ALB and ECS use this endpoint for instance health monitoring.

## File Structure

```
HaxxWorm.io/
  server/
    index.js          # Entry point — Express + Socket.io wiring
    config.js         # All tunable constants (env-overridable)
    gameLoop.js       # Fixed 60Hz tick loop + 20Hz broadcast
    world.js          # Arena state — players, food, leaderboard
    player.js         # Player entity — physics, input, serialisation
    food.js           # Food entity + FoodManager + death drops
    spatialGrid.js    # Spatial hash grid — O(1) collision broadphase
    collision.js      # Pure collision detection (food + body)
    matchmaking.js    # Arena assignment (Stage B: multi-arena)
    assetRegistry.js  # Skin / food-type / map registry
    logger.js         # Pino structured logger (CloudWatch-ready)
  public/
    index.html        # Game shell + HUD
    client.js         # Socket wiring, state machine, render loop
    renderer.js       # Canvas 2D drawing (worms, food, camera, HUD)
    interpolation.js  # Client-side lerp between server snapshots
    input.js          # Mouse input → angle (30Hz throttled)
    style.css         # Cyberpunk dark neon UI
  maps/
    default.json      # Default arena config
  public/assets/
    skins/registry.json   # Custom skin definitions
    food/registry.json    # Custom food type definitions
  Dockerfile
  docker-compose.yml
  .env.example
```

## Custom Assets

### Add a custom skin
1. Create a skin image and put it in `public/assets/skins/`
2. Add an entry to `public/assets/skins/registry.json`
3. Restart the server

### Add a custom food type
1. Add a sprite to `public/assets/food/`
2. Add an entry to `public/assets/food/registry.json`
3. Restart the server

### Add a custom map
1. Create `maps/yourmap.json` following the format in `maps/default.json`
2. Set `ACTIVE_MAP=yourmap` in `.env`
3. Restart the server

## Configuration

All values configurable via `.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `production` enables JSON logs |
| `TICK_RATE_HZ` | `60` | Physics simulation rate |
| `BROADCAST_HZ` | `20` | Network update rate to clients |
| `WORLD_WIDTH` | `14000` | Arena width in pixels |
| `WORLD_HEIGHT` | `14000` | Arena height in pixels |
| `MAX_PLAYERS_PER_ARENA` | `50` | Players per arena before new one opens |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Scaling Stages

| Stage | What | When |
|---|---|---|
| **A** | Spatial grid + AOI (already built in) | Day 1 ✅ |
| **B** | Multi-arena via `matchmaking.js` | When one arena fills |
| **C** | ALB + ECS + sticky sessions | When multiple EC2 needed |
| **D** | Redis leaderboard + RDS accounts | Real scale |

See `CLAUDE.md` for the full architecture and scaling plan.
