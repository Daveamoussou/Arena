'use strict';

/**
 * Arène des jeux — serveur
 *
 * - Comptes : inscription / connexion (e-mail + pseudo + mot de passe), sessions par jeton
 * - Temps réel (Socket.IO) : salon des joueurs libres, invitations, parties
 * - Jeux : Puissance 4, Pierre-Feuille-Ciseaux, contre un joueur ou contre l'ordinateur (niveaux 1 à 3)
 *
 * Le serveur est l'arbitre : toutes les règles sont vérifiées ici, le navigateur ne fait qu'afficher.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// Fonctionne avec l'arborescence normale (lib/, public/) ET avec tous les fichiers déposés à plat à la racine.
const local = (name) => (fs.existsSync(path.join(__dirname, 'lib', `${name}.js`)) ? `./lib/${name}` : `./${name}`);
const { Store, AVATARS, validateRegistration } = require(local('store'));
const C4 = require(local('connect4'));
const RPS = require(local('rps'));
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html'));
const FLAT_FILES = new Set(['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']);

const GAME_TYPES = ['p4', 'rps'];
const LEVELS = [1, 2, 3];

const num = (...vals) => {
  for (const v of vals) if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const rid = () => crypto.randomBytes(6).toString('hex');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const randInt = (n) => Math.floor(Math.random() * n);

function createApp(opts = {}) {
  const cfg = {
    dataFile: opts.dataFile || process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'),
    inviteMs: num(opts.inviteMs, process.env.INVITE_MS, 30000), // durée de validité d'une invitation
    p4TurnMs: num(opts.p4TurnMs, process.env.P4_TURN_MS, 30000), // temps par coup (Puissance 4 entre humains)
    rpsRoundMs: num(opts.rpsRoundMs, process.env.RPS_ROUND_MS, 15000), // temps par manche (PFC entre humains)
    graceMs: num(opts.graceMs, process.env.GRACE_MS, 30000), // délai de reconnexion en pleine partie
    cpuDelayMs: num(opts.cpuDelayMs, process.env.CPU_DELAY_MS, 700), // "temps de réflexion" de l'ordinateur
    authLimit: num(opts.authLimit, process.env.AUTH_LIMIT, 30), // tentatives d'inscription/connexion / 10 min / IP
  };

  const store = new Store(cfg.dataFile);
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

  /* ================================================================ */
  /* HTTP : fichiers statiques + API de comptes                        */
  /* ================================================================ */

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: '10kb' }));
  if (HAS_PUBLIC) {
    app.use(express.static(path.join(__dirname, 'public')));
  } else {
    // Mode "à plat" : seuls les fichiers du site sont servis (jamais server.js ni la base de données).
    const sendFlat = (res, file) => res.sendFile(file, { root: __dirname });
    app.get('/', (req, res) => sendFlat(res, 'index.html'));
    app.get(['/:file', '/icons/:file'], (req, res, next) => (FLAT_FILES.has(req.params.file) ? sendFlat(res, req.params.file) : next()));
  }

  const hits = new Map();
  const rateOk = (key, max, windowMs) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) {
      e = { n: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.n++;
    return e.n <= max;
  };
  const hitsTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
  }, 60000);
  hitsTimer.unref();

  const bearer = (req) => {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    return m ? m[1] : null;
  };
  const selfView = (u) => ({ id: u.id, pseudo: u.pseudo, avatar: u.avatar, stats: u.stats });
  const tooMany = (res) => res.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });

  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get('/api/config', (req, res) => res.json({ avatars: AVATARS }));

  app.post('/api/register', async (req, res) => {
    try {
      if (!rateOk(`auth:${req.ip}`, cfg.authLimit, 10 * 60 * 1000)) return tooMany(res);
      const v = validateRegistration(req.body);
      if (v.error) return res.status(400).json({ error: v.error, field: v.field });
      if (store.emailTaken(v.email)) return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée.', field: 'email' });
      if (store.pseudoTaken(v.pseudo)) return res.status(409).json({ error: 'Ce pseudo est déjà pris.', field: 'pseudo' });
      const user = await store.createUser(v);
      res.json({ token: store.createSession(user.id), me: selfView(user) });
    } catch (e) {
      if (e.code === 'EMAIL_TAKEN') return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée.', field: 'email' });
      if (e.code === 'PSEUDO_TAKEN') return res.status(409).json({ error: 'Ce pseudo est déjà pris.', field: 'pseudo' });
      console.error('[register]', e);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    try {
      if (!rateOk(`auth:${req.ip}`, cfg.authLimit, 10 * 60 * 1000)) return tooMany(res);
      const b = isObj(req.body) ? req.body : {};
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
      const user = store.findByEmail(email);
      const ok = await store.verifyPassword(user, password);
      if (!ok) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
      res.json({ token: store.createSession(user.id), me: selfView(user) });
    } catch (e) {
      console.error('[login]', e);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  app.post('/api/logout', (req, res) => {
    const token = bearer(req);
    const user = token && store.getSession(token);
    if (token) store.deleteSession(token);
    if (user) {
      const rec = online.get(user.id);
      if (rec) {
        const sock = io.sockets.sockets.get(rec.socketId);
        if (sock) sock.disconnect(true);
        dropUser(user.id);
      }
    }
    res.json({ ok: true });
  });

  /* ================================================================ */
  /* État en mémoire                                                    */
  /* ================================================================ */

  // uid -> { uid, socketId, status: 'free' | 'reserved' | 'playing', gameId, inviteId, disconnected, graceTimer }
  const online = new Map();
  const invites = new Map(); // id -> { id, from, to, game, expires, timer }
  const games = new Map(); // id -> game
  const cpuMemory = new Map(); // uid -> historique des manches PFC contre l'ordinateur (pour qu'il "apprenne")

  const pub = (uid) => {
    const u = store.getUser(uid);
    return u ? { id: u.id, pseudo: u.pseudo, avatar: u.avatar } : null;
  };

  function emitTo(uid, event, payload) {
    const rec = online.get(uid);
    if (rec && !rec.disconnected) io.to(rec.socketId).emit(event, payload);
  }

  /* ---------------- Salon ---------------- */

  function lobbySnapshot() {
    const players = [];
    let count = 0;
    for (const rec of online.values()) {
      if (rec.disconnected) continue;
      count++;
      if (rec.status === 'free') players.push(pub(rec.uid));
    }
    players.sort((a, b) => a.pseudo.localeCompare(b.pseudo, 'fr', { sensitivity: 'base' }));
    return { players, online: count };
  }

  let lobbyTimer = null;
  function broadcastLobby() {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      io.emit('lobby:update', lobbySnapshot());
    }, 50);
  }

  /* ---------------- Invitations ---------------- */

  const inviteView = (inv) => ({
    id: inv.id,
    game: inv.game,
    from: pub(inv.from),
    to: pub(inv.to),
    timeLeft: Math.max(0, inv.expires - Date.now()),
  });

  function endInvite(id, reason) {
    const inv = invites.get(id);
    if (!inv) return;
    clearTimeout(inv.timer);
    invites.delete(id);
    for (const uid of [inv.from, inv.to]) {
      const rec = online.get(uid);
      if (rec && rec.inviteId === id) {
        rec.inviteId = null;
        if (rec.status === 'reserved') rec.status = 'free';
      }
      emitTo(uid, 'invite:ended', { id, reason });
    }
    broadcastLobby();
  }

  function acceptInvite(inv) {
    clearTimeout(inv.timer);
    invites.delete(inv.id);
    for (const uid of [inv.from, inv.to]) {
      const rec = online.get(uid);
      if (rec) rec.inviteId = null;
      emitTo(uid, 'invite:ended', { id: inv.id, reason: 'accepted' });
    }
    const game = createGame({ type: inv.game, p0: inv.from, p1: inv.to, starter: randInt(2) });
    pushGame(game);
    broadcastLobby();
  }

  /* ---------------- Parties ---------------- */

  function newState(type, starter) {
    if (type === 'p4') return { board: C4.newBoard(), turn: starter, winLine: null, lastMove: null };
    return { scores: [0, 0], round: 1, choices: [null, null], lastRound: null };
  }

  function createGame({ type, p0, p1, level = null, starter = 0 }) {
    const vsCpu = p1 === null;
    const game = {
      id: rid(),
      type,
      vsCpu,
      level: vsCpu ? level : null,
      starter,
      players: [pub(p0), vsCpu ? { id: null, pseudo: 'Ordinateur', avatar: '🤖' } : pub(p1)],
      state: newState(type, starter),
      over: false,
      winner: null, // 0 | 1 | 'draw'
      reason: null, // 'win' | 'full' | 'forfeit'
      deadline: null,
      timer: null,
      cpuTimer: null,
      rematch: [false, false],
      left: [false, false],
    };
    games.set(game.id, game);
    for (const p of game.players) {
      const rec = p.id && online.get(p.id);
      if (rec) {
        rec.gameId = game.id;
        rec.status = 'playing';
      }
    }
    armGame(game);
    return game;
  }

  function clearTimers(game) {
    clearTimeout(game.timer);
    clearTimeout(game.cpuTimer);
    game.timer = game.cpuTimer = null;
    game.deadline = null;
  }

  function destroyGame(game) {
    clearTimers(game);
    games.delete(game.id);
  }

  function setDeadline(game, ms, fn) {
    game.deadline = Date.now() + ms;
    game.timer = setTimeout(() => {
      if (games.has(game.id) && !game.over) fn();
    }, ms);
  }

  /** Met en place ce que le jeu attend ensuite : coup de l'ordinateur ou compte à rebours d'un joueur. */
  function armGame(game) {
    clearTimers(game);
    if (game.over) return;
    if (game.type === 'p4') {
      if (game.vsCpu) {
        if (game.state.turn === 1) {
          game.cpuTimer = setTimeout(() => cpuPlay(game), cfg.cpuDelayMs + Math.random() * 400);
        }
      } else {
        setDeadline(game, cfg.p4TurnMs, () => p4Timeout(game));
      }
    } else if (!game.vsCpu) {
      setDeadline(game, cfg.rpsRoundMs, () => rpsTimeout(game));
    }
  }

  function gameView(game, uid) {
    const idx = game.players.findIndex((p) => p.id === uid);
    const other = game.players[1 - idx];
    const orec = other.id ? online.get(other.id) : null;
    const s = game.state;
    const view = {
      id: game.id,
      type: game.type,
      vsCpu: game.vsCpu,
      level: game.level,
      you: idx,
      players: game.players,
      starter: game.starter,
      over: game.over,
      winner: game.winner,
      reason: game.reason,
      timeLeft: game.deadline ? Math.max(0, game.deadline - Date.now()) : null,
      opponentConnected: game.vsCpu ? true : !!(orec && !orec.disconnected && orec.gameId === game.id),
      opponentLeft: game.left[1 - idx],
      rematch: { you: game.rematch[idx], opponent: game.rematch[1 - idx] },
    };
    if (game.type === 'p4') {
      Object.assign(view, { board: s.board, turn: s.turn, winLine: s.winLine, lastMove: s.lastMove });
    } else {
      Object.assign(view, {
        scores: s.scores,
        round: s.round,
        target: RPS.TARGET,
        youChose: s.choices[idx],
        opponentChose: s.choices[1 - idx] !== null,
        lastRound: s.lastRound,
      });
    }
    return view;
  }

  function pushGame(game) {
    game.players.forEach((p, i) => {
      if (!p.id || game.left[i]) return;
      const rec = online.get(p.id);
      if (!rec || rec.gameId !== game.id) return;
      emitTo(p.id, 'game:state', gameView(game, p.id));
    });
  }

  function recordResult(game) {
    const bucket = game.vsCpu ? 'cpu' : 'human';
    game.players.forEach((p, i) => {
      const u = p.id && store.getUser(p.id);
      if (!u) return;
      const key = game.winner === 'draw' ? 'd' : game.winner === i ? 'w' : 'l';
      u.stats[game.type][bucket][key]++;
    });
    store.save();
    for (const p of game.players) {
      const u = p.id && store.getUser(p.id);
      if (u) emitTo(p.id, 'me:update', { stats: u.stats });
    }
  }

  function finishGame(game, winner, reason) {
    clearTimers(game);
    game.over = true;
    game.winner = winner;
    game.reason = reason;
    recordResult(game);
    pushGame(game);
  }

  /** Un joueur quitte la partie (bouton, déconnexion prolongée, déconnexion du compte). */
  function leaveGame(uid) {
    const rec = online.get(uid);
    if (!rec || !rec.gameId) return;
    const game = games.get(rec.gameId);
    rec.gameId = null;
    if (rec.status === 'playing') rec.status = 'free';
    if (!game) return;
    if (game.vsCpu) return destroyGame(game);
    const idx = game.players.findIndex((p) => p.id === uid);
    game.left[idx] = true;
    if (!game.over) finishGame(game, 1 - idx, 'forfeit'); // abandonner = perdre
    if (game.left[0] && game.left[1]) destroyGame(game);
    else pushGame(game);
  }

  /* ---- Puissance 4 ---- */

  function p4Play(game, idx, col) {
    const s = game.state;
    if (s.turn !== idx) return "Ce n'est pas ton tour.";
    if (!Number.isInteger(col) || col < 0 || col >= C4.COLS) return 'Colonne invalide.';
    if (s.board[0][col] !== 0) return 'Cette colonne est pleine.';
    p4Apply(game, idx, col);
    return null;
  }

  function p4Apply(game, idx, col) {
    const s = game.state;
    const row = C4.drop(s.board, col, idx + 1);
    s.lastMove = { r: row, c: col, p: idx };
    const line = C4.lineAt(s.board, row, col);
    if (line) {
      s.winLine = line;
      return finishGame(game, idx, 'win');
    }
    if (C4.isFull(s.board)) return finishGame(game, 'draw', 'full');
    s.turn = 1 - idx;
    armGame(game);
    pushGame(game);
  }

  function p4Timeout(game) {
    // Temps écoulé : un coup au hasard est joué à la place du joueur.
    const moves = C4.validMoves(game.state.board);
    p4Apply(game, game.state.turn, moves[randInt(moves.length)]);
  }

  function cpuPlay(game) {
    if (!games.has(game.id) || game.over || game.type !== 'p4') return;
    const col = C4.cpuMove(game.state.board, game.level, 2);
    if (col >= 0) p4Apply(game, 1, col);
  }

  /* ---- Pierre-Feuille-Ciseaux ---- */

  function rpsChoose(game, idx, choice) {
    const s = game.state;
    if (!RPS.MOVES.includes(choice)) return 'Choix invalide.';
    if (s.choices[idx] !== null) return 'Tu as déjà choisi pour cette manche.';
    s.choices[idx] = choice;
    if (game.vsCpu) {
      // L'ordinateur décide d'après les manches PREcédentes uniquement.
      s.choices[1] = RPS.cpuChoice(game.level, cpuMemory.get(game.players[0].id) || []);
    }
    if (s.choices[0] !== null && s.choices[1] !== null) rpsResolve(game);
    else pushGame(game);
    return null;
  }

  function rpsResolve(game) {
    const s = game.state;
    const [a, b] = s.choices;
    const result = RPS.outcome(a, b);
    s.lastRound = { n: s.round, choices: [a, b], result };
    s.round++;
    s.choices = [null, null];
    if (result !== 'tie') s.scores[result]++;
    if (game.vsCpu) {
      const uid = game.players[0].id;
      const mem = cpuMemory.get(uid) || [];
      mem.push({ h: a, c: b, r: result === 'tie' ? 't' : result === 0 ? 'w' : 'l' });
      if (mem.length > 300) mem.shift();
      cpuMemory.set(uid, mem);
    }
    if (result !== 'tie' && s.scores[result] >= RPS.TARGET) return finishGame(game, result, 'win');
    armGame(game);
    pushGame(game);
  }

  function rpsTimeout(game) {
    // Temps écoulé : un choix au hasard est fait pour ceux qui n'ont pas joué.
    const s = game.state;
    for (let i = 0; i < 2; i++) if (s.choices[i] === null) s.choices[i] = RPS.MOVES[randInt(3)];
    rpsResolve(game);
  }

  /* ================================================================ */
  /* Connexions temps réel                                              */
  /* ================================================================ */

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const user = store.getSession(token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.uid = user.id;
    next();
  });

  function dropUser(uid) {
    const rec = online.get(uid);
    if (!rec) return;
    clearTimeout(rec.graceTimer);
    if (rec.inviteId) endInvite(rec.inviteId, 'unavailable');
    if (rec.gameId) leaveGame(uid);
    online.delete(uid);
    broadcastLobby();
  }

  function buildInit(uid) {
    const rec = online.get(uid);
    const game = rec.gameId ? games.get(rec.gameId) : null;
    const inv = rec.inviteId ? invites.get(rec.inviteId) : null;
    return {
      me: selfView(store.getUser(uid)),
      game: game ? gameView(game, uid) : null,
      invite: inv ? inviteView(inv) : null,
      lobby: lobbySnapshot(),
    };
  }

  io.on('connection', (socket) => {
    const uid = socket.data.uid;

    // Un seul appareil/onglet par compte : le plus récent remplace l'ancien.
    let rec = online.get(uid);
    if (rec) {
      if (!rec.disconnected && rec.socketId !== socket.id) {
        const old = io.sockets.sockets.get(rec.socketId);
        if (old) {
          old.emit('session:replaced');
          old.disconnect(true);
        }
      }
      clearTimeout(rec.graceTimer);
      rec.graceTimer = null;
      rec.disconnected = false;
      rec.socketId = socket.id;
    } else {
      rec = { uid, socketId: socket.id, status: 'free', gameId: null, inviteId: null, disconnected: false, graceTimer: null };
      online.set(uid, rec);
    }

    socket.emit('init', buildInit(uid));
    const game = rec.gameId && games.get(rec.gameId);
    if (game && !game.vsCpu) pushGame(game); // l'adversaire voit que tu es revenu
    broadcastLobby();

    // Garde-fou : pas plus de ~40 messages par seconde et par connexion.
    let windowStart = Date.now();
    let count = 0;
    socket.use((packet, next) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > 40) return next(new Error('Trop de requêtes.'));
      next();
    });

    const on = (event, handler) =>
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          handler(isObj(payload) ? payload : {}, reply);
        } catch (e) {
          console.error(`[${event}]`, e);
          reply({ ok: false, error: 'Erreur serveur.' });
        }
      });
    const fail = (reply, error) => reply({ ok: false, error });

    on('lobby:challenge', (p, reply) => {
      if (!GAME_TYPES.includes(p.game)) return fail(reply, 'Jeu inconnu.');
      const targetId = String(p.targetId || '');
      const me = online.get(uid);
      const target = online.get(targetId);
      if (!me || me.status !== 'free') return fail(reply, "Tu n'es pas disponible pour un défi.");
      if (targetId === uid) return fail(reply, 'Tu ne peux pas te défier toi-même.');
      if (!target || target.disconnected || target.status !== 'free') return fail(reply, "Ce joueur n'est plus disponible.");

      const inv = { id: rid(), from: uid, to: targetId, game: p.game, expires: Date.now() + cfg.inviteMs, timer: null };
      inv.timer = setTimeout(() => endInvite(inv.id, 'expired'), cfg.inviteMs);
      invites.set(inv.id, inv);
      // Pendant l'invitation, les deux joueurs sont "réservés" : ils disparaissent de la liste des libres.
      me.status = target.status = 'reserved';
      me.inviteId = target.inviteId = inv.id;
      const view = inviteView(inv);
      emitTo(uid, 'invite:new', view);
      emitTo(targetId, 'invite:new', view);
      broadcastLobby();
      reply({ ok: true });
    });

    on('invite:cancel', (p, reply) => {
      const inv = invites.get(String(p.id || ''));
      if (!inv || inv.from !== uid) return fail(reply, "Cette invitation n'est plus valide.");
      endInvite(inv.id, 'cancelled');
      reply({ ok: true });
    });

    on('invite:respond', (p, reply) => {
      const inv = invites.get(String(p.id || ''));
      if (!inv || inv.to !== uid) return fail(reply, "Cette invitation n'est plus valide.");
      if (p.accept === true) acceptInvite(inv);
      else endInvite(inv.id, 'declined');
      reply({ ok: true });
    });

    on('cpu:start', (p, reply) => {
      const me = online.get(uid);
      if (!me || me.status !== 'free') return fail(reply, "Tu n'es pas disponible.");
      if (!GAME_TYPES.includes(p.game) || !LEVELS.includes(p.level)) return fail(reply, 'Paramètres invalides.');
      const g = createGame({ type: p.game, p0: uid, p1: null, level: p.level, starter: 0 });
      pushGame(g);
      broadcastLobby();
      reply({ ok: true });
    });

    on('game:move', (p, reply) => {
      const me = online.get(uid);
      const g = games.get(String(p.gameId || ''));
      if (!me || !g || me.gameId !== g.id) return fail(reply, 'Partie introuvable.');
      if (g.over) return fail(reply, 'La partie est terminée.');
      const idx = g.players.findIndex((x) => x.id === uid);
      const err = g.type === 'p4' ? p4Play(g, idx, p.col) : rpsChoose(g, idx, p.choice);
      if (err) return fail(reply, err);
      reply({ ok: true });
    });

    on('game:leave', (p, reply) => {
      leaveGame(uid);
      broadcastLobby();
      reply({ ok: true });
    });

    on('game:rematch', (p, reply) => {
      const me = online.get(uid);
      const g = games.get(String(p.gameId || ''));
      if (!me || !g || me.gameId !== g.id || !g.over || g.vsCpu) return fail(reply, 'Revanche impossible.');
      if (g.left[0] || g.left[1]) return fail(reply, 'Ton adversaire a quitté la partie.');
      const idx = g.players.findIndex((x) => x.id === uid);
      g.rematch[idx] = true;
      if (g.rematch[0] && g.rematch[1]) {
        destroyGame(g);
        const ng = createGame({ type: g.type, p0: g.players[0].id, p1: g.players[1].id, starter: 1 - g.starter });
        pushGame(ng);
      } else {
        pushGame(g);
      }
      reply({ ok: true });
    });

    on('game:replay', (p, reply) => {
      const me = online.get(uid);
      const g = me && me.gameId && games.get(me.gameId);
      if (!g || !g.vsCpu || !g.over) return fail(reply, 'Impossible de rejouer maintenant.');
      const level = LEVELS.includes(p.level) ? p.level : g.level;
      destroyGame(g);
      const ng = createGame({ type: g.type, p0: uid, p1: null, level, starter: 1 - g.starter });
      pushGame(ng);
      reply({ ok: true });
    });

    on('profile:avatar', (p, reply) => {
      if (!AVATARS.includes(p.avatar)) return fail(reply, 'Avatar invalide.');
      const u = store.getUser(uid);
      u.avatar = p.avatar;
      store.save();
      socket.emit('me:update', { avatar: u.avatar });
      broadcastLobby();
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      const r = online.get(uid);
      if (!r || r.socketId !== socket.id) return; // remplacé par une connexion plus récente
      if (r.status === 'playing') {
        // En pleine partie : on laisse un délai pour revenir (perte de réseau, changement d'appli…).
        r.disconnected = true;
        const g = r.gameId && games.get(r.gameId);
        if (g && !g.vsCpu) pushGame(g);
        r.graceTimer = setTimeout(() => dropUser(uid), cfg.graceMs);
      } else {
        dropUser(uid);
      }
    });
  });

  /* ================================================================ */
  /* Cycle de vie                                                       */
  /* ================================================================ */

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve(server.address().port));
    });
  }

  function close() {
    clearInterval(hitsTimer);
    clearTimeout(lobbyTimer);
    for (const g of games.values()) clearTimers(g);
    for (const inv of invites.values()) clearTimeout(inv.timer);
    for (const r of online.values()) clearTimeout(r.graceTimer);
    try {
      store.flush();
    } catch (e) {
      console.error('Écriture finale impossible :', e.message);
    }
    return new Promise((resolve) => {
      io.close(() => resolve());
    });
  }

  return { app, server, io, store, listen, close };
}

module.exports = { createApp };

if (require.main === module) {
  const instance = createApp();
  const port = Number(process.env.PORT) || 3000;
  instance.listen(port).then((p) => console.log(`Arène des jeux prête sur http://localhost:${p}`));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await instance.close();
      process.exit(0);
    });
  }
}
