const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = process.env.PORT || 3000;
const players = new Map();
const bombs = new Map();
const authorizedHits = new Map();
const hitCooldowns = new Map();
let worldState = { mapObjects: {}, mapCurrencyDrops: [] };
let maintenance = { active: false };

app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true, players: players.size }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function publicPlayers() {
  const out = {};
  for (const [id, p] of players) out[id] = {
    id: p.id, name: p.name, playerId: p.playerId,
    tankIndex: p.tankIndex, x: p.x, y: p.y, angle: p.angle,
    lives: p.lives, hasGold: p.gold > 0, updatedAt: p.updatedAt
  };
  return out;
}
function broadcastPlayers() { io.to('game').emit('players:update', publicPlayers()); }
function broadcastSharedCamera() {
  // Camera is client-local: each player follows their own tank to avoid map shake.
  // Kept as a no-op for compatibility with existing event flow.
}

function pruneTransientState() {
  const now = Date.now();
  for (const [id, b] of bombs) if (now > b.expiresAt + 5000) bombs.delete(id);
  for (const [key, v] of authorizedHits) if (now - v.at > 5000) authorizedHits.delete(key);
  for (const [key, at] of hitCooldowns) if (now - at > 5000) hitCooldowns.delete(key);
}

io.on('connection', socket => {
  socket.emit('players:update', publicPlayers());
  socket.emit('world:sync', worldState);
  socket.emit('maintenance:update', maintenance);

  socket.on('player:join', data => {
    const d = data || {};
    players.set(socket.id, {
      id: socket.id,
      name: String(d.name || 'Player').slice(0, 24),
      playerId: String(d.playerId || '').slice(0, 32),
      email: String(d.email || '').slice(0, 120).toLowerCase(),
      tankIndex: Math.max(0, Math.min(100, Number(d.tankIndex) || 0)),
      x: 0, y: 0, angle: 0, lives: 3,
      gold: Math.max(0, clampNumber(d.gold, 0, 100000000, 0)),
      updatedAt: Date.now()
    });
    socket.join('game');
    socket.emit('world:sync', worldState);
    broadcastPlayers();
    broadcastSharedCamera();
  });

  socket.on('player:move', data => {
    if (!players.has(socket.id) || !data || typeof data !== 'object') return;
    const p = players.get(socket.id);
    p.x = clampNumber(data.x, -1000000000, 1000000000, p.x);
    p.y = clampNumber(data.y, -1000000000, 1000000000, p.y);
    p.angle = clampNumber(data.angle, -1000, 1000, p.angle);
    p.lives = Math.max(0, Math.min(999, Number(data.lives) || 0));
    p.tankIndex = Math.max(0, Math.min(100, Number(data.tankIndex) || 0));
    p.name = String(data.name || p.name).slice(0, 24);
    if (data.playerId) p.playerId = String(data.playerId).slice(0, 32);
    if (data.email) p.email = String(data.email).slice(0, 120).toLowerCase();
    p.gold = Math.max(0, clampNumber(data.gold, 0, 100000000, p.gold));
    p.updatedAt = Date.now();
    socket.to('game').emit('players:update', publicPlayers());
    broadcastSharedCamera();
  });

  socket.on('player:bomb', data => {
    const p = players.get(socket.id);
    if (!p || !data) return;
    pruneTransientState();
    const x = clampNumber(data.x, -1000000000, 1000000000, 0);
    const y = clampNumber(data.y, -1000000000, 1000000000, 0);
    const radius = clampNumber(data.radius, 10, 300, 45);
    const bombId = `${socket.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    // The server records who owns each online bomb and whether its owner is eligible for PvP.
    bombs.set(bombId, { bombId, ownerId: socket.id, x, y, radius, pvpEligible: p.gold > 0, placedAt: Date.now(), expiresAt: Date.now() + 2000, hitTargets: new Set() });
    io.to('game').emit('bomb:placed', { bombId, ownerId: socket.id, x, y, radius, pvpEligible: p.gold > 0 });
  });

  socket.on('world:update', data => {
    if (!players.has(socket.id) || !data || typeof data !== 'object') return;
    if (data.mapObjects && typeof data.mapObjects === 'object' && !Array.isArray(data.mapObjects)) {
      worldState.mapObjects = Object.fromEntries(Object.entries(data.mapObjects).slice(-1200));
    }
    if (Array.isArray(data.mapCurrencyDrops)) worldState.mapCurrencyDrops = data.mapCurrencyDrops.slice(0, 200);
    socket.to('game').emit('world:sync', worldState);
  });

  // A hit request is accepted only for a server-recorded bomb, with a valid owner,
  // after its fuse, while both players have a positive wallet balance.
  socket.on('player:hit-request', data => {
    if (!players.has(socket.id) || !data || data.targetId !== socket.id) return;
    pruneTransientState();
    const target = players.get(socket.id);
    const bomb = bombs.get(String(data.bombId || ''));
    if (!bomb || bomb.ownerId !== String(data.killerId || '') || bomb.ownerId === socket.id) return;
    const killer = players.get(bomb.ownerId);
    if (!killer || !bomb.pvpEligible || killer.gold <= 0 || target.gold <= 0) return;
    const now = Date.now();
    if (now < bomb.expiresAt || now > bomb.expiresAt + 4000 || bomb.hitTargets.has(socket.id)) return;
    const distance = Math.hypot(target.x - bomb.x, target.y - bomb.y);
    if (distance > bomb.radius + 65) return;
    bomb.hitTargets.add(socket.id);
    authorizedHits.set(`${socket.id}:${killer.id}`, { at: now, bombId: bomb.bombId, rewarded: false });
    io.to(socket.id).emit('player:hit', { targetId: socket.id, killerId: killer.id, bombId: bomb.bombId });
  });

  // A reward is issued only after the victim client confirms a life-loss event
  // corresponding to a previously validated server-side bomb hit.
  socket.on('player:kill', data => {
    if (!data || data.victimId !== socket.id) return;
    const killerId = String(data.killerId || '');
    const victim = players.get(socket.id);
    const killer = players.get(killerId);
    const key = `${socket.id}:${killerId}`;
    const auth = authorizedHits.get(key);
    if (!victim || !killer || !auth || auth.rewarded || Date.now() - auth.at > 5000) return;
    if (victim.gold <= 0 || killer.gold <= 0) return;
    auth.rewarded = true;
    hitCooldowns.set(key, Date.now());
    io.to(killerId).emit('wallet:reward', { winnerId: killerId, amount: 0.90, victimId: socket.id });
    authorizedHits.delete(key);
  });

  socket.on('admin:maintenance', data => {
    // Compatibility with the existing UI. This is not a secured admin API.
    maintenance = { active: !!(data && data.active) };
    io.emit('maintenance:update', maintenance);
  });

  socket.on('admin:bonus', data => {
    const email = String(data && data.targetEmail || '').trim().toLowerCase();
    const amount = clampNumber(data && data.amount, 0.01, 100000, 0);
    if (!email || amount <= 0) return;
    let sent = false;
    for (const [id, p] of players) {
      if (p.email && p.email === email) {
        p.gold = Number((p.gold + amount).toFixed(2));
        io.to(id).emit('wallet:admin-bonus', { amount });
        sent = true;
      }
    }
    if (sent) broadcastPlayers();
  });

  socket.on('admin:bonus-all', data => {
    const amount = clampNumber(data && data.amount, 0.01, 100000, 0);
    if (amount <= 0) return;
    for (const [id, p] of players) {
      p.gold = Number((p.gold + amount).toFixed(2));
      io.to(id).emit('wallet:admin-bonus', { amount });
    }
    broadcastPlayers();
  });

  socket.on('admin:direct-message', data => {
    const email = String(data && data.targetEmail || '').trim().toLowerCase();
    const message = String(data && data.message || '').trim().slice(0, 500);
    if (!email || !message) return;
    for (const [id, p] of players) {
      if (p.email && p.email === email) io.to(id).emit('player:message', { message, direct: true, sentAt: Date.now() });
    }
  });

  socket.on('admin:broadcast-message', data => {
    const message = String(data && data.message || '').trim().slice(0, 500);
    if (!message) return;
    io.to('game').emit('player:message', { message, sentAt: Date.now() });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    for (const [id, b] of bombs) if (b.ownerId === socket.id) bombs.delete(id);
    io.emit('player:left', socket.id);
    broadcastPlayers();
    broadcastSharedCamera();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Bomber Tanks multiplayer server listening on ${PORT}`));
