/**
 * renderer.js — Canvas 2D game renderer.
 *
 * Responsibilities:
 *   - Camera: follows local player with lerp lag, zooms with worm length
 *   - World: background grid, border wall
 *   - Food: glow circles with color-coded types
 *   - Worms: smooth bezier-path bodies, eyes on head, name tags
 *   - HUD: score, length, leaderboard, boost bar, minimap
 *   - Effects: particle burst placeholder (wired to client.js events)
 *
 * All draw calls are batched per frame. Canvas state is saved/restored
 * only at the camera transform level (expensive ops minimised).
 */

'use strict';

const Renderer = (() => {

  // ── Canvas setup ──────────────────────────────────────────────────────

  let _canvas   = null;
  let _ctx      = null;
  let _mmCanvas = null;
  let _mmCtx    = null;
  let _W        = 0;
  let _H        = 0;

  // ── World info (received on join) ─────────────────────────────────────
  let _worldW = 14000;
  let _worldH = 14000;

  // ── Camera state ─────────────────────────────────────────────────────
  let _camX  = 0;
  let _camY  = 0;
  let _zoom  = 1;

  // ── Map Texture ───────────────────────────────────────────────────────
  const _mapTexture = new Image();
  _mapTexture.src = 'assets/map_background.png?v=2';
  let _mapPattern = null;

  // ── Leaderboard cache ─────────────────────────────────────────────────
  let _leaderboard    = [];
  let _localPlayerId  = null;

  // ── Particle effects ─────────────────────────────────────────────────
  const _particles = [];

  // ── Const ─────────────────────────────────────────────────────────────
  const BG_COLOR     = '#080b14';
  const GRID_COLOR   = 'rgba(0, 255, 65, 0.04)';
  const BORDER_COLOR = 'rgba(0, 255, 65, 0.25)';
  const GRID_SIZE    = 200;
  const FONT_MONO    = "'JetBrains Mono', monospace";
  const FONT_SANS    = "'Inter', system-ui, sans-serif";

  const lerp = (a, b, t) => a + (b - a) * t;

  // ── Init ──────────────────────────────────────────────────────────────

  function init(canvas, minimapCanvas) {
    _canvas   = canvas;
    _ctx      = canvas.getContext('2d', { alpha: false });
    _mmCanvas = minimapCanvas;
    _mmCtx    = minimapCanvas ? minimapCanvas.getContext('2d') : null;
    resize();
    window.addEventListener('resize', resize, { passive: true });
  }

  function resize() {
    _W = _canvas.width  = window.innerWidth;
    _H = _canvas.height = window.innerHeight;
  }

  function setWorldSize(w, h) { _worldW = w; _worldH = h; }
  function setLocalPlayer(id) { _localPlayerId = id; }
  function setLeaderboard(lb) { _leaderboard = lb || []; }

  // ── Camera ────────────────────────────────────────────────────────────

  function _updateCamera(localPlayer) {
    if (!localPlayer) { return; }
    const head = localPlayer.segments[0];
    if (!head) { return; }
    // Target camera position = head
    _camX = lerp(_camX, head[0], 0.12);
    _camY = lerp(_camY, head[1], 0.12);
    // Target zoom: scales with the square root of the ratio of starting radius to current radius, matching Wormate.io
    const targetZoom = Math.sqrt(8 / localPlayer.br);
    const clampedZoom = Math.max(0.4, Math.min(1.2, targetZoom));
    _zoom = lerp(_zoom, clampedZoom, 0.05);
  }

  // ── Background grid ───────────────────────────────────────────────────

  function _drawGrid(ctx) {
    ctx.save();

    // Create pattern once image loaded
    if (!_mapPattern && _mapTexture.complete) {
      _mapPattern = ctx.createPattern(_mapTexture, 'repeat');
    }

    if (_mapPattern) {
      ctx.fillStyle = _mapPattern;
      ctx.fillRect(0, 0, _worldW, _worldH);
    } else {
      // Fallback to neon grid lines
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth   = 1;

      const vLeft  = _camX - (_W / 2) / _zoom;
      const vTop   = _camY - (_H / 2) / _zoom;
      const vRight  = _camX + (_W / 2) / _zoom;
      const vBottom = _camY + (_H / 2) / _zoom;

      const startX = Math.floor(vLeft  / GRID_SIZE) * GRID_SIZE;
      const startY = Math.floor(vTop   / GRID_SIZE) * GRID_SIZE;

      ctx.beginPath();
      for (let x = startX; x <= vRight; x += GRID_SIZE) {
        ctx.moveTo(x, Math.max(0, vTop));
        ctx.lineTo(x, Math.min(_worldH, vBottom));
      }
      for (let y = startY; y <= vBottom; y += GRID_SIZE) {
        ctx.moveTo(Math.max(0, vLeft), y);
        ctx.lineTo(Math.min(_worldW, vRight), y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── World border ──────────────────────────────────────────────────────

  function _drawBorder(ctx) {
    ctx.save();
    ctx.strokeStyle  = BORDER_COLOR;
    ctx.lineWidth    = 6;
    ctx.strokeRect(0, 0, _worldW, _worldH);
    ctx.restore();
  }

  // ── Food ──────────────────────────────────────────────────────────────

  function _drawFood(ctx, food) {
    if (food.length === 0) { return; }

    // Group by color — 2 batched paths per color group (glow ring + solid)
    const byColor = new Map();
    for (const f of food) {
      if (!byColor.has(f.color)) { byColor.set(f.color, []); }
      byColor.get(f.color).push(f);
    }
    for (const [color, items] of byColor.entries()) {
      // Cheap glow: slightly larger semi-transparent outer circle
      ctx.fillStyle = color + '2a'; // ~16% opacity
      ctx.beginPath();
      for (const f of items) {
        ctx.moveTo(f.x + f.radius * 2, f.y);
        ctx.arc(f.x, f.y, f.radius * 2, 0, Math.PI * 2);
      }
      ctx.fill();

      // Solid inner circle
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const f of items) {
        ctx.moveTo(f.x + f.radius, f.y);
        ctx.arc(f.x, f.y, f.radius, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  // ── Worm body ─────────────────────────────────────────────────────────

  function _drawWorms(ctx, players) {
    // Draw enemies first, local player on top
    const sorted = [...players].sort((a, b) => (b.isLocal ? -1 : 1) - (a.isLocal ? -1 : 1));

    for (const player of sorted) {
      _drawWorm(ctx, player);
    }
  }

  function _drawWorm(ctx, player) {
    const { segments, color, name, isLocal, boosting, hr, br, angle } = player;
    if (!segments || segments.length < 2) { return; }

    const bodyR = Math.max(br || 8, 6);
    const headR = Math.max(hr || 10, 8);

    // ── Body: ONE batched path for all segments (critical perf fix) ────────
    // Previously: one ctx.fill() per segment = O(n) GPU state changes
    // Now: one ctx.fill() for entire worm = O(1)
    ctx.globalAlpha = isLocal ? 1 : 0.88;
    ctx.fillStyle   = color;
    ctx.beginPath();
    for (let i = segments.length - 1; i >= 1; i--) {
      const seg    = segments[i];
      const ratio  = 1 - (i / segments.length) * 0.28;
      const radius = Math.max(bodyR * ratio, 3);
      ctx.moveTo(seg[0] + radius, seg[1]);
      ctx.arc(seg[0], seg[1], radius, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    // Boost glow: cheap outer ring stroke (no shadowBlur)
    if (boosting) {
      ctx.strokeStyle = color + '88';
      ctx.lineWidth   = 4;
      ctx.beginPath();
      ctx.arc(segments[0][0], segments[0][1], headR + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── Head ─────────────────────────────────────────────────────────────
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(segments[0][0], segments[0][1], headR, 0, Math.PI * 2);
    ctx.fill();

    // ── Eyes ─────────────────────────────────────────────────────────────
    const eyeOffset = headR * 0.4;
    const eyeR      = headR * 0.28;
    const pupilR    = eyeR * 0.55;
    const eyeAngles = [angle - 0.55, angle + 0.55];
    const [hx, hy]  = [segments[0][0], segments[0][1]];

    // White sclera — batched
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (const ea of eyeAngles) {
      const ex = hx + Math.cos(ea) * eyeOffset;
      const ey = hy + Math.sin(ea) * eyeOffset;
      ctx.moveTo(ex + eyeR, ey);
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
    }
    ctx.fill();

    // Pupils — batched
    ctx.fillStyle = '#111';
    ctx.beginPath();
    for (const ea of eyeAngles) {
      const ex = hx + Math.cos(ea) * eyeOffset;
      const ey = hy + Math.sin(ea) * eyeOffset;
      const px = ex + Math.cos(angle) * pupilR * 0.4;
      const py = ey + Math.sin(angle) * pupilR * 0.4;
      ctx.moveTo(px + pupilR, py);
      ctx.arc(px, py, pupilR, 0, Math.PI * 2);
    }
    ctx.fill();

    // ── Name tag ─────────────────────────────────────────────────────────
    if (name) {
      const fontSize  = Math.max(10, headR * 1.4);
      const tagY      = segments[0][1] - headR - 5;
      ctx.font        = `${Math.round(fontSize)}px ${FONT_MONO}`;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle   = 'rgba(0,0,0,0.65)';
      ctx.fillText(name, segments[0][0] + 1, tagY + 1);
      ctx.fillStyle   = isLocal ? '#00ff88' : '#e0ffe8';
      ctx.fillText(name, segments[0][0], tagY);
    }
  }

  // ── Particles (death burst) ───────────────────────────────────────────

  function spawnDeathParticles(x, y, color, count = 24) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 2 + Math.random() * 4;
      _particles.push({
        x, y,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed,
        r:     3 + Math.random() * 5,
        color,
        alpha: 1,
        life:  0.8 + Math.random() * 0.4,
        age:   0,
      });
    }
  }

  function _updateAndDrawParticles(ctx, dt) {
    for (let i = _particles.length - 1; i >= 0; i--) {
      const p = _particles[i];
      p.age  += dt;
      p.x    += p.vx;
      p.y    += p.vy;
      p.vx   *= 0.94;
      p.vy   *= 0.94;
      p.alpha = 1 - (p.age / p.life);
      if (p.alpha <= 0) { _particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle   = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ── HUD ───────────────────────────────────────────────────────────────

  function _updateHUD(localPlayer, yourData) {
    if (!yourData) { return; }
    const scoreEl  = document.getElementById('hud-score');
    const lengthEl = document.getElementById('hud-length');
    if (scoreEl)  { scoreEl.textContent  = Math.floor(yourData.sc || 0); }
    if (lengthEl) { lengthEl.textContent = yourData.l || 0; }

    // Boost bar
    const boostFill = document.getElementById('boost-bar-fill');
    if (boostFill && localPlayer) {
      const pct = Math.min(100, (localPlayer.length / 200) * 100);
      boostFill.style.width = pct + '%';
      boostFill.classList.toggle('depleting', localPlayer.boosting);
    }
  }

  function updateLeaderboard(lb) {
    if (!lb) { return; }
    _leaderboard = lb;
    const list = document.getElementById('leaderboard-list');
    if (!list) { return; }
    list.innerHTML = '';
    lb.forEach((entry, i) => {
      const li      = document.createElement('li');
      const isYou   = entry.i === _localPlayerId;
      if (isYou) { li.classList.add('is-you'); }

      const rank    = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = `#${i + 1}`;

      const dot     = document.createElement('span');
      dot.className = 'lb-dot';
      dot.style.background = entry.c || entry.color || '#00ff88';

      const name    = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = (isYou ? '▶ ' : '') + (entry.n || '?');

      const score   = document.createElement('span');
      score.className = 'lb-score';
      score.textContent = Math.floor(entry.sc || 0);

      li.append(rank, dot, name, score);
      list.appendChild(li);
    });
  }

  // ── Minimap ───────────────────────────────────────────────────────────

  function _drawMinimap(players, food, localPlayer) {
    if (!_mmCtx || !_mmCanvas) { return; }
    const mm  = _mmCtx;
    const mW  = _mmCanvas.width;
    const mH  = _mmCanvas.height;
    const scX = mW / _worldW;
    const scY = mH / _worldH;

    mm.clearRect(0, 0, mW, mH);
    mm.fillStyle = 'rgba(8,11,20,0.9)';
    mm.fillRect(0, 0, mW, mH);

    // Food dots
    mm.fillStyle = 'rgba(0,255,65,0.3)';
    for (const f of food) {
      mm.fillRect(f.x * scX - 0.5, f.y * scY - 0.5, 1, 1);
    }

    // Player dots
    for (const p of players) {
      if (!p.segments || p.segments.length === 0) { continue; }
      mm.fillStyle = p.isLocal ? '#00ff88' : p.color;
      const mx = p.segments[0][0] * scX;
      const my = p.segments[0][1] * scY;
      mm.beginPath();
      mm.arc(mx, my, p.isLocal ? 3 : 2, 0, Math.PI * 2);
      mm.fill();
    }

    // Viewport rectangle
    if (localPlayer && localPlayer.segments[0]) {
      const vW = (_W / _zoom) * scX;
      const vH = (_H / _zoom) * scY;
      const vx = (localPlayer.segments[0][0] - (_W / _zoom) / 2) * scX;
      const vy = (localPlayer.segments[0][1] - (_H / _zoom) / 2) * scY;
      mm.strokeStyle = 'rgba(0,255,65,0.4)';
      mm.lineWidth   = 1;
      mm.strokeRect(vx, vy, vW, vH);
    }
  }

  // ── Main render frame ─────────────────────────────────────────────────

  /**
   * Render one frame. Called by client.js at 60fps.
   * @param {object[]} players   — interpolated player states
   * @param {object[]} food      — current food state
   * @param {object}   yourData  — { sc, l, a, b } from last snapshot
   * @param {number}   dt        — delta time in seconds
   */
  function frame(players, food, yourData, dt) {
    const ctx = _ctx;
    const localPlayer = players.find(p => p.isLocal) || null;

    // ── Update camera ───────────────────────────────────────────────
    _updateCamera(localPlayer);

    // ── Clear ───────────────────────────────────────────────────────
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, _W, _H);

    // ── World-space transform ───────────────────────────────────────
    ctx.save();
    ctx.translate(_W / 2, _H / 2);
    ctx.scale(_zoom, _zoom);
    ctx.translate(-_camX, -_camY);

    // Draw world
    _drawGrid(ctx);
    _drawBorder(ctx);
    _drawFood(ctx, food);
    _drawWorms(ctx, players);
    _updateAndDrawParticles(ctx, dt);

    ctx.restore();
    // ── World-space transform end ───────────────────────────────────

    // ── HUD ─────────────────────────────────────────────────────────
    _updateHUD(localPlayer, yourData);
    _drawMinimap(players, food, localPlayer);
  }

  function getLocalHeadScreenPos() {
    const localPlayer = InterpolationBuffer.getLocalPlayer();
    if (!localPlayer || !localPlayer.s || !localPlayer.s[0]) {
      return { x: _W / 2, y: _H / 2 };
    }
    const head = localPlayer.s[0];
    return {
      x: _W / 2 + (head[0] - _camX) * _zoom,
      y: _H / 2 + (head[1] - _camY) * _zoom,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  return {
    init,
    resize,
    setWorldSize,
    setLocalPlayer,
    setLeaderboard,
    updateLeaderboard,
    spawnDeathParticles,
    getLocalHeadScreenPos,
    frame,
  };
})();
