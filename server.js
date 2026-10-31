'use strict';
/**
 * Buzz Race server — the single source of truth for rooms, timers,
 * question order and scores. Clients only send intents (answer / double /
 * start) and render whatever state the server broadcasts.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const BANK = require('./questions');

const PORT = Number(process.env.PORT) || 3000;
const ROUNDS = Number(process.env.ROUNDS) || 10;
const QUESTION_MS = Number(process.env.QUESTION_MS) || 15000;
const REVEAL_MS = Number(process.env.REVEAL_MS) || 4000;
const LOBBY_GRACE_MS = Number(process.env.LOBBY_GRACE_MS) || 8000; // refresh tolerance in lobby
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 5000; // before host role is handed over
const EMPTY_ROOM_MS = Number(process.env.EMPTY_ROOM_MS) || 120000; // delete rooms nobody is in
const MAX_PLAYERS = 24;
const MAX_ROOMS = 1000;
const MAX_POINTS = 1000;
const DEDUCT_PER_SEC = 50; // correct answer = 1000 - 50 * seconds taken (min 250 at 15s)
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXYZ'; // consonants only: no accidental words, easy to read aloud

const rooms = new Map();

/* ---------- helpers ---------- */
const rnd = (n) => crypto.randomInt(n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeCode() {
  for (let n = 0; n < 200; n++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[rnd(CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function cleanNick(n) {
  return String(n == null ? '' : n)
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
}
const cleanToken = (t) => (typeof t === 'string' && /^[A-Za-z0-9]{8,64}$/.test(t) ? t : null);
function pickQuestions(n) {
  const pool = shuffle(BANK.slice()).slice(0, n);
  return pool.map((x) => {
    const opts = shuffle(x.o.map((t, i) => ({ t, c: i === 0 })));
    return { q: x.q, options: opts.map((o) => o.t), correct: opts.findIndex((o) => o.c) };
  });
}
const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const err = (ws, code, msg, extra) => send(ws, Object.assign({ t: 'error', code, msg }, extra));

/* ---------- rooms & players ---------- */
function newPlayer(nick, token) {
  return {
    id: crypto.randomBytes(4).toString('hex'), // public id
    token: token || crypto.randomBytes(12).toString('hex'), // private rejoin secret (never broadcast)
    nick,
    ws: null,
    connected: false,
    grace: null,
    score: 0,
    doubleUsed: false,
    doubleActive: false,
    answered: false,
    choice: null,
    answerMs: 0,
    delta: 0,
    correct: null,
  };
}

function view(room, me) {
  const list = [...room.players.values()];
  const sorted = list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.score - a.p.score || a.i - b.i)
    .map((x) => x.p);
  const ranks = new Map();
  let r = 0;
  let prev = null;
  sorted.forEach((p, i) => {
    if (p.score !== prev) {
      r = i + 1;
      prev = p.score;
    }
    ranks.set(p.id, r);
  });
  const reveal = room.phase === 'reveal';
  const v = {
    t: 'state',
    now: Date.now(),
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: me.id,
    round: room.round,
    total: ROUNDS,
    qMs: QUESTION_MS,
    rMs: REVEAL_MS,
    players: sorted.map((p) => ({
      id: p.id,
      nick: p.nick,
      score: p.score,
      rank: ranks.get(p.id),
      connected: p.connected,
      answered: p.answered,
      delta: reveal ? p.delta : 0,
      correct: reveal ? p.correct : null,
    })),
    me: { answered: me.answered, choice: me.choice, doubleUsed: me.doubleUsed, doubleActive: me.doubleActive },
  };
  if (room.phase === 'question' || reveal) {
    const q = room.questions[room.round - 1];
    v.question = { q: q.q, options: q.options }; // the correct index is NEVER sent before reveal
    v.endsAt = room.endsAt;
    if (reveal) {
      v.correct = q.correct;
      v.revealEndsAt = room.revealEndsAt;
    }
  }
  return v;
}

function broadcast(room) {
  for (const p of room.players.values()) if (p.connected) send(p.ws, view(room, p));
}

function destroy(room) {
  clearTimeout(room.timer);
  clearTimeout(room.hostTimer);
  clearTimeout(room.emptyTimer);
  for (const p of room.players.values()) clearTimeout(p.grace);
  rooms.delete(room.code);
}
function touchEmpty(room) {
  clearTimeout(room.emptyTimer);
  if (![...room.players.values()].some((p) => p.connected)) {
    room.emptyTimer = setTimeout(() => destroy(room), EMPTY_ROOM_MS);
  }
}

/* ---------- host handling ---------- */
function electHost(room) {
  const h = room.players.get(room.hostId);
  if (h && h.connected) return;
  const next = [...room.players.values()].find((p) => p.connected);
  if (next) {
    room.hostId = next.id;
    broadcast(room);
  }
}
function scheduleHost(room, delay) {
  clearTimeout(room.hostTimer);
  if (delay <= 0) return electHost(room);
  room.hostTimer = setTimeout(() => electHost(room), delay);
}

function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) {
    p.ws.ctx = null; // old socket (e.g. before a refresh) no longer controls this player
    try {
      p.ws.close(4000, 'replaced');
    } catch (_) {}
  }
  clearTimeout(p.grace);
  p.ws = ws;
  p.connected = true;
  ws.ctx = { room, p };
  clearTimeout(room.emptyTimer);
  const h = room.players.get(room.hostId);
  if (!h) room.hostId = p.id;
  else if (!h.connected) scheduleHost(room, HOST_GRACE_MS);
  broadcast(room);
}

function removePlayer(room, p) {
  clearTimeout(p.grace);
  room.players.delete(p.id);
  if (room.hostId === p.id) scheduleHost(room, 0);
  touchEmpty(room);
  broadcast(room);
}

function detach(ws, explicit) {
  const c = ws.ctx;
  if (!c) return;
  ws.ctx = null;
  const { room, p } = c;
  if (p.ws !== ws) return;
  p.ws = null;
  p.connected = false;
  if (room.phase === 'lobby') {
    clearTimeout(p.grace);
    if (explicit) return removePlayer(room, p);
    p.grace = setTimeout(() => {
      if (!p.connected) removePlayer(room, p);
    }, LOBBY_GRACE_MS);
  }
  if (room.hostId === p.id) scheduleHost(room, explicit ? 0 : HOST_GRACE_MS);
  touchEmpty(room);
  if (room.phase === 'question' && allAnswered(room)) return reveal(room);
  broadcast(room);
}

/* ---------- game flow ---------- */
function allAnswered(room) {
  let any = false;
  for (const p of room.players.values()) {
    if (p.connected) {
      any = true;
      if (!p.answered) return false;
    }
  }
  return any;
}

function resetRoundState(p) {
  p.answered = false;
  p.choice = null;
  p.doubleActive = false;
  p.answerMs = 0;
  p.delta = 0;
  p.correct = null;
}

function startGame(room) {
  clearTimeout(room.timer);
  room.questions = pickQuestions(ROUNDS);
  room.round = 0;
  for (const p of room.players.values()) {
    p.score = 0;
    p.doubleUsed = false;
    resetRoundState(p);
  }
  nextRound(room);
}

function nextRound(room) {
  clearTimeout(room.timer);
  if (room.round >= ROUNDS) return finish(room);
  room.round += 1;
  room.phase = 'question';
  room.startAt = Date.now();
  room.endsAt = room.startAt + QUESTION_MS;
  for (const p of room.players.values()) resetRoundState(p);
  room.timer = setTimeout(() => reveal(room), QUESTION_MS);
  broadcast(room);
}

function reveal(room) {
  if (room.phase !== 'question') return;
  clearTimeout(room.timer);
  const q = room.questions[room.round - 1];
  for (const p of room.players.values()) {
    let delta = 0;
    if (p.answered && p.choice === q.correct) {
      const secs = Math.min(QUESTION_MS, Math.max(0, p.answerMs)) / 1000;
      const base = Math.max(0, Math.round(MAX_POINTS - DEDUCT_PER_SEC * secs));
      delta = base * (p.doubleActive ? 2 : 1);
    }
    p.delta = delta;
    p.correct = p.answered ? p.choice === q.correct : null;
    p.score += delta; // scores only change at reveal, so nothing leaks mid-round
  }
  room.phase = 'reveal';
  room.revealEndsAt = Date.now() + REVEAL_MS;
  room.timer = setTimeout(() => nextRound(room), REVEAL_MS);
  broadcast(room);
}

function finish(room) {
  clearTimeout(room.timer);
  room.phase = 'final';
  broadcast(room);
}

function playAgain(room) {
  clearTimeout(room.timer);
  for (const p of [...room.players.values()]) {
    if (!p.connected) {
      clearTimeout(p.grace);
      room.players.delete(p.id);
    }
  }
  for (const p of room.players.values()) {
    p.score = 0;
    p.doubleUsed = false;
    resetRoundState(p);
  }
  room.phase = 'lobby';
  room.round = 0;
  room.questions = [];
  electHost(room);
  broadcast(room);
}

function doAnswer(room, p, i) {
  if (room.phase !== 'question' || p.answered) return;
  if (!Number.isInteger(i) || i < 0 || i > 3) return;
  const now = Date.now();
  if (now > room.endsAt) return;
  p.answered = true;
  p.choice = i;
  p.answerMs = now - room.startAt;
  if (allAnswered(room)) return reveal(room); // everyone's in: no reason to wait
  broadcast(room);
}

function doDouble(room, p) {
  if (room.phase !== 'question' || p.answered || p.doubleUsed) return;
  p.doubleUsed = true;
  p.doubleActive = true;
  broadcast(room);
}

/* ---------- message handling ---------- */
function doCreate(ws, m) {
  const nick = cleanNick(m.nick);
  if (!nick) return err(ws, 'bad_name', 'Pick a nickname (1-14 characters).');
  if (rooms.size >= MAX_ROOMS) return err(ws, 'busy', 'The server is busy right now. Try again in a minute.');
  const code = makeCode();
  if (!code) return err(ws, 'busy', 'Could not create a room. Try again.');
  detach(ws, true);
  const room = {
    code,
    phase: 'lobby',
    players: new Map(),
    hostId: null,
    round: 0,
    questions: [],
    startAt: 0,
    endsAt: 0,
    revealEndsAt: 0,
    timer: null,
    hostTimer: null,
    emptyTimer: null,
  };
  rooms.set(code, room);
  const p = newPlayer(nick, cleanToken(m.token));
  room.players.set(p.id, p);
  room.hostId = p.id;
  attach(ws, room, p);
}

function doJoin(ws, m) {
  const rejoin = m.rejoin ? { rejoin: true } : undefined;
  const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 4) return err(ws, 'bad_code', 'Enter the 4-letter room code.', rejoin);
  const room = rooms.get(code);
  if (!room) {
    return err(
      ws,
      'no_room',
      rejoin ? 'That game has ended. Start or join a new one!' : `Room "${code}" was not found. Check the code and try again.`,
      rejoin
    );
  }
  const token = cleanToken(m.token);
  const nick = cleanNick(m.nick);
  const players = [...room.players.values()];
  let p = token ? players.find((x) => x.token === token) : null;
  if (!p) {
    if (!nick) return err(ws, 'bad_name', 'Pick a nickname (1-14 characters).', rejoin);
    const same = players.find((x) => x.nick.toLowerCase() === nick.toLowerCase());
    if (same) {
      if (same.connected) return err(ws, 'name_taken', 'That nickname is already taken in this room. Pick another.', rejoin);
      p = same; // same nickname + disconnected = it's them coming back
      if (token) p.token = token;
    } else {
      if (room.phase !== 'lobby') return err(ws, 'started', 'That game has already started. Ask the host for the next one!', rejoin);
      if (room.players.size >= MAX_PLAYERS) return err(ws, 'full', 'That room is full.', rejoin);
      p = newPlayer(nick, token);
    }
  }
  if (ws.ctx && ws.ctx.p !== p) detach(ws, true);
  room.players.set(p.id, p);
  attach(ws, room, p);
}

function handle(ws, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'create') return doCreate(ws, m);
  if (m.t === 'join') return doJoin(ws, m);
  if (m.t === 'leave') return detach(ws, true);
  const c = ws.ctx;
  if (!c) return;
  const { room, p } = c;
  const isHost = room.hostId === p.id;
  switch (m.t) {
    case 'start':
      if (!isHost) return err(ws, 'not_host', 'Only the host can start the game.');
      if (room.phase === 'lobby') startGame(room);
      return;
    case 'again':
      if (!isHost) return err(ws, 'not_host', 'Only the host can start a new game.');
      if (room.phase === 'final') playAgain(room);
      return;
    case 'answer':
      return doAnswer(room, p, m.i);
    case 'double':
      return doDouble(room, p);
    default:
  }
}

/* ---------- HTTP + WebSocket ---------- */
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return fs.readFile(INDEX_PATH, (e, buf) => res.end(e ? 'Missing public/index.html' : buf)); // read per request: edits show up on refresh, no restart needed
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.hits = 0;
  ws.ctx = null;
  ws.on('pong', () => {
    ws.alive = true;
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary || ++ws.hits > 30) return; // basic flood protection
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    try {
      handle(ws, m);
    } catch (e) {
      console.error('handler error', e);
    }
  });
  ws.on('close', () => detach(ws, false));
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000);
setInterval(() => {
  for (const ws of wss.clients) ws.hits = 0;
}, 1000);

server.listen(PORT, () => console.log(`Buzz Race listening on :${PORT}`));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

module.exports = { rooms };
