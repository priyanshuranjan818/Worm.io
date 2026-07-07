/**
 * client.js — Game client entry point.
 *
 * Uses native WebSocket (no socket.io) + msgpack binary protocol.
 * Reconnects automatically with exponential backoff.
 *
 * Message format (all binary msgpack):
 *   Send:    { t: 'pj'|'pi'|'pr', d: {...} }
 *   Receive: { t: 'gj'|'gs'|'gd'|'gk'|'ge', d: {...} }
 */

'use strict';

(function () {

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const canvas       = document.getElementById('gameCanvas');
  const mmCanvas     = document.getElementById('minimap-canvas');
  const connectingEl = document.getElementById('connecting-screen');
  const joinEl       = document.getElementById('join-screen');
  const deathEl      = document.getElementById('death-screen');
  const joinBtn      = document.getElementById('join-btn');
  const rejoinBtn    = document.getElementById('rejoin-btn');
  const nameInput    = document.getElementById('player-name');
  const lbContainer  = document.getElementById('leaderboard');
  const scoreBar     = document.getElementById('score-bar');
  const boostBar     = document.getElementById('boost-bar-wrap');
  const minimapEl    = document.getElementById('minimap');
  const killFeed     = document.getElementById('kill-feed');

  // ── State ─────────────────────────────────────────────────────────────────
  let state           = 'connecting';
  let localId         = null;
  let lastYourData    = null;
  let deathScore      = 0;
  let deathLength     = 0;
  let lastDeathKiller = null;

  // ── Init modules ──────────────────────────────────────────────────────────
  Renderer.init(canvas, mmCanvas);
  InputManager.init(canvas);

  // ── WebSocket (native — no socket.io) ────────────────────────────────────
  let _ws             = null;
  let _reconnectDelay = 1000;
  const MAX_RECONNECT = 8000;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    _ws = new WebSocket(`${proto}//${location.host}`);
    _ws.binaryType = 'arraybuffer';

    _ws.onopen = () => {
      console.log('[HaxxWorm] Connected');
      _reconnectDelay = 1000; // reset backoff
      if (state === 'connecting') { _setState('lobby'); }
    };

    _ws.onmessage = (event) => {
      try {
        // Decode msgpack binary frame
        const msg = MessagePack.decode(new Uint8Array(event.data));
        _handleMessage(msg.t, msg.d);
      } catch (err) {
        console.warn('[HaxxWorm] Failed to decode message:', err);
      }
    };

    _ws.onclose = () => {
      console.log('[HaxxWorm] Disconnected — reconnecting in', _reconnectDelay, 'ms');
      InputManager.disable();
      if (state === 'game') { _setState('connecting'); }
      setTimeout(connect, _reconnectDelay);
      _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT);
    };

    _ws.onerror = () => {
      _ws.close(); // triggers onclose → reconnect
    };
  }

  function _send(type, data) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(MessagePack.encode({ t: type, d: data }));
    }
  }

  // ── Server message handlers ───────────────────────────────────────────────

  function _handleMessage(type, data) {
    switch (type) {
      case 'gj': _onJoined(data);   break; // game:joined
      case 'gs': _onSnapshot(data); break; // game:snapshot
      case 'gd': _onDeath(data);    break; // game:death
      case 'gk': _onKilled(data);   break; // game:killed (kill feed)
      case 'ge': _onError(data);    break; // game:error
    }
  }

  function _onJoined(data) {
    localId = data.playerId;
    InterpolationBuffer.setLocalPlayerId(localId);
    InterpolationBuffer.clear();
    Renderer.setLocalPlayer(localId);
    Renderer.setWorldSize(data.worldInfo.worldWidth, data.worldInfo.worldHeight);
    InputManager.enable();
    InputManager.setCallback((input) => _send('pi', input));
    _setState('game');
  }

  function _onSnapshot(data) {
    const now = performance.now();
    InterpolationBuffer.ingest(data, now);
    lastYourData = data.y || lastYourData;
    if (data.lb) { Renderer.updateLeaderboard(data.lb); }
  }

  function _onDeath(data) {
    deathScore      = Math.floor(data.score  || 0);
    deathLength     = data.length || 0;
    lastDeathKiller = data.killer || null;
    InputManager.disable();

    // Particle burst at last known position
    const local = InterpolationBuffer.getLocalPlayer();
    if (local && local.s && local.s[0]) {
      Renderer.spawnDeathParticles(local.s[0][0], local.s[0][1], '#ff3860', 32);
    }

    _setState('dead');
  }

  function _onKilled(data) {
    _addKillFeedEntry(data);
  }

  function _onError(data) {
    console.error('[HaxxWorm] Server error:', data.message);
    alert(data.message);
  }

  // ── UI events ──────────────────────────────────────────────────────────────

  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Anonymous';
    joinBtn.disabled    = true;
    joinBtn.textContent = 'ENTERING…';
    _send('pj', { name });
  });

  rejoinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Anonymous';
    rejoinBtn.disabled    = true;
    rejoinBtn.textContent = 'ENTERING…';
    InterpolationBuffer.clear();
    _send('pr', { name });
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state === 'lobby') { joinBtn.click(); }
  });

  // ── State machine ─────────────────────────────────────────────────────────

  function _setState(newState) {
    state = newState;

    connectingEl.classList.add('hidden');
    joinEl.classList.add('hidden');
    deathEl.classList.add('hidden');
    lbContainer.style.display = 'none';
    scoreBar.style.display    = 'none';
    boostBar.style.display    = 'none';
    minimapEl.style.display   = 'none';

    switch (newState) {
      case 'connecting':
        connectingEl.classList.remove('hidden');
        break;

      case 'lobby':
        joinEl.classList.remove('hidden');
        joinBtn.disabled    = false;
        joinBtn.textContent = 'ENTER THE ARENA';
        nameInput.focus();
        break;

      case 'game':
        lbContainer.style.display = 'flex';
        scoreBar.style.display    = 'flex';
        boostBar.style.display    = 'flex';
        minimapEl.style.display   = 'block';
        break;

      case 'dead': {
        const scoreEl  = document.getElementById('death-score');
        const lenEl    = document.getElementById('death-length');
        const killerEl = document.getElementById('death-killer-text');
        if (scoreEl)  { scoreEl.textContent  = deathScore; }
        if (lenEl)    { lenEl.textContent    = deathLength; }
        if (killerEl) {
          killerEl.innerHTML = lastDeathKiller
            ? `Killed by <span>${_escape(lastDeathKiller)}</span>`
            : 'You ran into a worm';
        }
        rejoinBtn.disabled    = false;
        rejoinBtn.textContent = 'RESPAWN';
        deathEl.classList.remove('hidden');
        break;
      }
    }
  }

  // ── Kill feed ──────────────────────────────────────────────────────────────

  function _addKillFeedEntry(data) {
    const entry = document.createElement('div');
    entry.className = 'kill-entry';
    entry.innerHTML = data.killerId
      ? `<span class="killer">${_escape(data.victimName || '?')}</span> was eaten`
      : `<span class="victim">${_escape(data.victimName || '?')}</span> <span class="self">ran into a worm</span>`;
    killFeed.prepend(entry);
    setTimeout(() => entry.remove(), 3600);
    while (killFeed.children.length > 5) {
      killFeed.removeChild(killFeed.lastChild);
    }
  }

  function _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Render loop (60fps rAF) ───────────────────────────────────────────────

  let _lastRafTime = performance.now();

  function _gameLoop(now) {
    requestAnimationFrame(_gameLoop);

    const dt = Math.min((now - _lastRafTime) / 1000, 0.1);
    _lastRafTime = now;

    InputManager.flush(now);

    const { players, food } = InterpolationBuffer.getRenderState(now);
    Renderer.frame(players, food, lastYourData, dt);
  }

  requestAnimationFrame(_gameLoop);

  // ── Boot ──────────────────────────────────────────────────────────────────
  _setState('connecting');
  connect();

})();
