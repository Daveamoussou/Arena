'use strict';

(() => {
  const TOKEN_KEY = 'arene.token';
  const GAMES = { p4: 'Puissance 4', rps: 'Pierre-Feuille-Ciseaux' };
  const EMOJI = { pierre: '✊', feuille: '✋', ciseaux: '✌️' };
  const LABEL = { pierre: 'Pierre', feuille: 'Feuille', ciseaux: 'Ciseaux' };
  const LEVEL_NAMES = { 1: 'Débutant', 2: 'Malin', 3: 'Redoutable' };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Crée un élément ; tout le texte passe par textContent (aucune injection HTML possible). */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* stockage indisponible */ } },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
  };

  const state = {
    token: store.get(),
    socket: null,
    me: null,
    lobby: { players: [], online: 0 },
    game: null,
    gameDeadline: null,
    invite: null,
    inviteDeadline: null,
    cpuGame: 'p4',
    search: '',
    registerAvatar: null,
    ignoreDisconnect: false,
  };

  /* ---------------- Utilitaires d'interface ---------------- */

  function toast(msg, kind) {
    const t = h('div', { class: `toast ${kind || ''}`, role: 'status' }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 4000);
  }

  function showScreen(name) {
    for (const s of $$('.screen')) s.hidden = s.id !== `screen-${name}`;
    $('#topbar').hidden = name === 'auth';
  }

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: JSON.stringify(body || {}),
    }).then(async (r) => {
      let data = {};
      try { data = await r.json(); } catch { /* corps vide */ }
      if (!r.ok) throw Object.assign(new Error(data.error || 'Erreur réseau.'), { field: data.field });
      return data;
    });
  }

  function emit(event, payload) {
    return new Promise((resolve) => {
      if (!state.socket) return resolve({ ok: false });
      state.socket.timeout(8000).emit(event, payload || {}, (err, res) => {
        if (err) { toast('Le serveur ne répond pas.', 'error'); return resolve({ ok: false }); }
        if (res && !res.ok && res.error) toast(res.error, 'error');
        resolve(res || { ok: false });
      });
    });
  }

  /* ---------------- Authentification ---------------- */

  function renderAvatarPicker(container, avatars, onPick) {
    container.replaceChildren();
    for (const a of avatars) {
      const b = h('button', { type: 'button', class: 'avatar-opt', 'aria-label': `Avatar ${a}`, on: { click: () => onPick(a) } }, a);
      b.dataset.avatar = a;
      container.append(b);
    }
  }

  function markAvatar(container, selected) {
    for (const b of $$('.avatar-opt', container)) b.classList.toggle('selected', b.dataset.avatar === selected);
  }

  async function initAuthScreen() {
    let avatars = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙'];
    try { avatars = (await (await fetch('/api/config')).json()).avatars || avatars; } catch { /* valeurs par défaut */ }
    state.registerAvatar = avatars[Math.floor(Math.random() * avatars.length)];
    const box = $('#avatar-register');
    renderAvatarPicker(box, avatars, (a) => { state.registerAvatar = a; markAvatar(box, a); });
    markAvatar(box, state.registerAvatar);

    for (const tab of $$('.tab')) {
      tab.addEventListener('click', () => {
        $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        $('#form-register').hidden = tab.dataset.tab !== 'register';
        $('#form-login').hidden = tab.dataset.tab !== 'login';
      });
    }

    $('#form-register').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      $$('.err', f).forEach((x) => (x.textContent = ''));
      const btn = $('button[type=submit]', f);
      btn.disabled = true;
      try {
        const res = await api('/api/register', {
          email: f.email.value, pseudo: f.pseudo.value, password: f.password.value, avatar: state.registerAvatar,
        });
        onAuthenticated(res);
      } catch (err) {
        const target = err.field ? $(`.err[data-for="${err.field}"]`, f) : $('#err-register');
        (target || $('#err-register')).textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });

    $('#form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      $('#err-login').textContent = '';
      const btn = $('button[type=submit]', f);
      btn.disabled = true;
      try {
        onAuthenticated(await api('/api/login', { email: f.email.value, password: f.password.value }));
      } catch (err) {
        $('#err-login').textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function onAuthenticated(res) {
    state.token = res.token;
    store.set(res.token);
    state.me = res.me;
    connect();
  }

  function logoutLocal(message) {
    state.ignoreDisconnect = true;
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    state.token = null;
    state.me = null;
    state.game = null;
    state.invite = null;
    store.clear();
    closeModal();
    showScreen('auth');
    if (message) toast(message);
  }

  /* ---------------- Connexion temps réel ---------------- */

  function connect() {
    if (state.socket) state.socket.disconnect();
    state.ignoreDisconnect = false;
    const socket = io({ auth: { token: state.token }, reconnectionDelayMax: 3000 });
    state.socket = socket;

    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') logoutLocal('Session expirée, reconnecte-toi.');
    });

    socket.on('init', (d) => {
      state.me = d.me;
      state.lobby = d.lobby;
      state.game = d.game;
      state.gameDeadline = d.game && d.game.timeLeft != null ? Date.now() + d.game.timeLeft : null;
      state.invite = null;
      closeModal();
      if (d.invite) onInviteNew(d.invite);
      renderAll();
    });

    socket.on('lobby:update', (l) => { state.lobby = l; if (!state.game) renderPlayers(); });
    socket.on('me:update', (u) => { Object.assign(state.me, u); if (!state.game) renderMe(); $('#who').textContent = state.me.pseudo; });
    socket.on('invite:new', onInviteNew);
    socket.on('invite:ended', onInviteEnded);

    socket.on('game:state', (g) => {
      state.game = g;
      state.gameDeadline = g.timeLeft != null ? Date.now() + g.timeLeft : null;
      closeModal();
      state.invite = null;
      renderAll();
    });

    socket.on('session:replaced', () => logoutLocal('Tu t\'es connecté ailleurs : cette fenêtre est déconnectée.'));

    socket.on('disconnect', () => {
      if (!state.ignoreDisconnect) toast('Connexion perdue, reconnexion…');
    });
  }

  /* ---------------- Invitations ---------------- */

  function closeModal() {
    $('#overlay').hidden = true;
    $('#modal').replaceChildren();
  }

  function onInviteNew(inv) {
    state.invite = inv;
    state.inviteDeadline = Date.now() + inv.timeLeft;
    const incoming = inv.to.id === state.me.id;
    const other = incoming ? inv.from : inv.to;
    const modal = $('#modal');
    modal.replaceChildren(
      h('div', { class: 'big' }, other.avatar),
      incoming
        ? h('div', {},
            h('h2', {}, `${other.pseudo} te défie !`),
            h('p', { class: 'muted' }, `Partie de ${GAMES[inv.game]}`))
        : h('div', {},
            h('h2', {}, `En attente de ${other.pseudo}…`),
            h('p', { class: 'muted' }, `Invitation envoyée pour ${GAMES[inv.game]}`)),
      h('div', { class: 'bar' }, h('i', { id: 'invite-bar' })),
      h('div', { class: 'actions' },
        incoming
          ? [
              h('button', { class: 'btn good', on: { click: () => emit('invite:respond', { id: inv.id, accept: true }) } }, 'Accepter'),
              h('button', { class: 'btn danger', on: { click: () => emit('invite:respond', { id: inv.id, accept: false }) } }, 'Refuser'),
            ]
          : h('button', { class: 'btn', on: { click: () => emit('invite:cancel', { id: inv.id }) } }, 'Annuler'),
      ),
    );
    $('#overlay').hidden = false;
  }

  function onInviteEnded({ id, reason }) {
    const inv = state.invite;
    if (!inv || inv.id !== id) return;
    state.invite = null;
    closeModal();
    if (reason === 'accepted') return; // game:state suit
    const iSent = inv.from.id === state.me.id;
    const other = iSent ? inv.to : inv.from;
    const msgs = {
      declined: `${other.pseudo} a refusé le défi.`,
      expired: iSent ? `${other.pseudo} n'a pas répondu à temps.` : `L'invitation de ${other.pseudo} a expiré.`,
      cancelled: iSent ? null : `${other.pseudo} a annulé son invitation.`,
      unavailable: `${other.pseudo} n'est plus disponible.`,
    };
    if (msgs[reason]) toast(msgs[reason]);
  }

  /* ---------------- Salon ---------------- */

  function statsRows(stats) {
    const rows = [];
    for (const g of ['p4', 'rps']) {
      for (const [kind, label] of [['human', 'contre des joueurs'], ['cpu', "contre l'ordinateur"]]) {
        const b = stats[g][kind];
        rows.push(h('tr', {},
          h('th', {}, `${GAMES[g]} · ${label}`),
          h('td', { class: 'n' }, String(b.w)),
          h('td', { class: 'n' }, String(b.d)),
          h('td', { class: 'n' }, String(b.l)),
        ));
      }
    }
    return rows;
  }

  function renderMe() {
    const me = state.me;
    const card = $('#me-card');
    card.replaceChildren(
      h('div', { class: 'me-head' },
        h('button', { class: 'big-avatar', title: "Changer d'avatar", 'aria-label': "Changer d'avatar", on: { click: openAvatarModal } }, me.avatar),
        h('div', {}, h('div', { class: 'me-name' }, me.pseudo), h('div', { class: 'muted small' }, 'Ton profil')),
      ),
      h('table', { class: 'stats' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Résultats'), h('th', {}, 'V'), h('th', {}, 'N'), h('th', {}, 'D'))),
        h('tbody', {}, statsRows(me.stats)),
      ),
    );
  }

  async function openAvatarModal() {
    let avatars = [];
    try { avatars = (await (await fetch('/api/config')).json()).avatars || []; } catch { return; }
    const box = h('div', { class: 'avatars' });
    renderAvatarPicker(box, avatars, async (a) => {
      closeModal();
      await emit('profile:avatar', { avatar: a });
    });
    markAvatar(box, state.me.avatar);
    $('#modal').replaceChildren(
      h('h2', {}, 'Choisis ton avatar'), box,
      h('div', { class: 'actions' }, h('button', { class: 'btn', on: { click: closeModal } }, 'Fermer')),
    );
    $('#overlay').hidden = false;
  }

  function renderPlayers() {
    const list = $('#players');
    const q = state.search.trim().toLowerCase();
    const players = state.lobby.players.filter((p) => p.id !== state.me.id && p.pseudo.toLowerCase().includes(q));
    $('#online-count').textContent = `${state.lobby.online} en ligne`;
    list.replaceChildren(
      ...players.map((p) =>
        h('li', { class: 'player' },
          h('span', { class: 'av' }, p.avatar),
          h('span', { class: 'nm' }, p.pseudo),
          h('span', { class: 'acts' },
            h('button', { class: 'btn small', on: { click: () => emit('lobby:challenge', { targetId: p.id, game: 'p4' }) } }, 'Puissance 4'),
            h('button', { class: 'btn small', on: { click: () => emit('lobby:challenge', { targetId: p.id, game: 'rps' }) } }, 'Pierre-Feuille-Ciseaux'),
          ),
        ),
      ),
    );
    const none = players.length === 0;
    const empty = $('#players-empty');
    empty.hidden = !none;
    empty.textContent = q
      ? 'Aucun joueur libre ne correspond à ta recherche.'
      : "Personne d'autre n'est libre pour l'instant. Partage le lien du site à tes amis !";
  }

  function initLobbyControls() {
    $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderPlayers(); });
    for (const b of $$('#cpu-game .seg-btn')) {
      b.addEventListener('click', () => {
        state.cpuGame = b.dataset.game;
        $$('#cpu-game .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      });
    }
    for (const b of $$('#cpu-levels .level')) {
      b.addEventListener('click', () => emit('cpu:start', { game: state.cpuGame, level: Number(b.dataset.level) }));
    }
    $('#logout').addEventListener('click', async () => {
      try { await api('/api/logout'); } catch { /* on se déconnecte quand même localement */ }
      logoutLocal();
    });
  }

  /* ---------------- Partie ---------------- */

  function fmt(ms) {
    return `${Math.ceil(ms / 1000)} s`;
  }

  function playerBox(g, idx, right) {
    const p = g.players[idx];
    const active = !g.over && g.type === 'p4' && g.turn === idx;
    let sub = idx === g.you ? 'Toi' : g.vsCpu ? `Niveau ${g.level}` : '';
    if (idx !== g.you && !g.vsCpu) {
      if (g.opponentLeft) sub = 'A quitté';
      else if (!g.opponentConnected) sub = 'Déconnecté…';
    }
    return h('div', { class: `gp ${right ? 'right' : ''} ${active ? 'active' : ''}` },
      h('span', { class: 'av' }, p.avatar),
      h('div', { style: 'min-width:0' }, // eslint-disable-line
        h('div', { class: 'nm' }, g.type === 'p4' ? [h('span', { class: `token t${idx}` }), ' ', p.pseudo] : p.pseudo),
        h('div', { class: 'sub' }, sub),
      ),
    );
  }

  function statusText(g) {
    if (g.over) return '';
    if (g.type === 'p4') {
      if (g.turn === g.you) return 'À toi de jouer !';
      return g.vsCpu ? "L'ordinateur réfléchit…" : `Tour de ${g.players[g.turn].pseudo}`;
    }
    if (g.youChose) return g.vsCpu ? '…' : `En attente de ${g.players[1 - g.you].pseudo}…`;
    return `Manche ${g.round} : fais ton choix !`;
  }

  function renderGame() {
    const g = state.game;
    const root = $('#game');
    const opp = 1 - g.you;
    const mkBox = (i, right) => playerBox(g, i, right);

    const parts = [
      h('div', { class: 'game-head' }, mkBox(0, false), h('div', { class: 'vs' }, 'VS'), mkBox(1, true)),
      h('div', { class: 'status', id: 'status' }, statusText(g), h('span', { class: 'timer', id: 'timer' })),
      g.type === 'p4' ? renderBoard(g) : renderRps(g),
    ];

    if (g.over) {
      const won = g.winner === g.you;
      const draw = g.winner === 'draw';
      let text = draw ? 'Match nul !' : won ? 'Victoire ! 🎉' : `${g.players[opp].pseudo} a gagné`;
      if (g.reason === 'forfeit') text = won ? `${g.players[opp].pseudo} a abandonné. Victoire !` : 'Tu as abandonné la partie.';
      parts.push(h('div', { class: `banner ${draw ? '' : won ? 'win' : 'lose'}` }, text));
      const actions = [];
      if (g.vsCpu) {
        actions.push(h('button', { class: 'btn primary', on: { click: () => emit('game:replay', {}) } }, 'Rejouer'));
        if (g.level < 3) actions.push(h('button', { class: 'btn', on: { click: () => emit('game:replay', { level: g.level + 1 }) } }, `Niveau ${g.level + 1}`));
      } else if (!g.opponentLeft) {
        actions.push(h('button', { class: 'btn primary', disabled: g.rematch.you, on: { click: () => emit('game:rematch', { gameId: g.id }) } }, g.rematch.you ? 'Revanche demandée…' : 'Revanche'));
      }
      actions.push(h('button', { class: 'btn', on: { click: leave } }, 'Retour au salon'));
      parts.push(h('div', { class: 'game-actions' }, actions));
      if (g.rematch.opponent && !g.rematch.you) parts.push(h('div', { class: 'notice' }, `${g.players[opp].pseudo} propose une revanche !`));
    } else {
      parts.push(h('div', { class: 'game-actions' }, h('button', { class: 'btn small danger', on: { click: leave } }, g.vsCpu ? 'Quitter' : 'Abandonner')));
      if (!g.vsCpu && !g.opponentConnected && !g.opponentLeft) parts.push(h('div', { class: 'notice' }, 'Ton adversaire est déconnecté. Il a quelques secondes pour revenir.'));
    }
    root.replaceChildren(...parts);
    tickTimer();
  }

  async function leave() {
    const g = state.game;
    if (g && !g.over && !g.vsCpu && !confirm('Abandonner la partie ? Tu la perdras.')) return;
    state.game = null;
    await emit('game:leave', {});
    renderAll();
  }

  function renderBoard(g) {
    const winCells = new Set((g.winLine || []).map(([r, c]) => `${r},${c}`));
    const myTurn = !g.over && g.turn === g.you;
    const cols = [];
    for (let c = 0; c < 7; c++) {
      const full = g.board[0][c] !== 0;
      const cells = [];
      for (let r = 0; r < 6; r++) {
        const v = g.board[r][c];
        const cls = ['cell'];
        if (v) cls.push(`p${v}`);
        if (g.lastMove && g.lastMove.r === r && g.lastMove.c === c) cls.push('last');
        if (winCells.has(`${r},${c}`)) cls.push('win');
        cells.push(h('div', { class: cls.join(' ') }));
      }
      const can = myTurn && !full;
      cols.push(h('button', {
        class: `colbtn ${can ? 'can' : ''}`,
        disabled: !can,
        'aria-label': `Colonne ${c + 1}`,
        on: { click: () => emit('game:move', { gameId: g.id, col: c }) },
      }, cells));
    }
    return h('div', { class: 'board' }, cols);
  }

  function renderRps(g) {
    const me = g.you;
    const last = g.lastRound;
    const nodes = [
      h('div', { class: 'rps-scores' },
        h('span', {}, String(g.scores[0])), h('small', {}, `premier à ${g.target}`), h('span', {}, String(g.scores[1]))),
    ];
    if (last) {
      const [a, b] = last.choices;
      const res = last.result;
      nodes.push(h('div', { class: 'rps-reveal', 'aria-live': 'polite' },
        h('div', { class: `who2 ${res === 0 ? 'win' : ''}` }, h('span', { class: res === 0 ? 'win' : '' }, EMOJI[a]), g.players[0].pseudo),
        h('div', { class: 'vs' }, res === 'tie' ? 'Égalité' : res === me ? '✓' : '✗'),
        h('div', { class: `who2` }, h('span', { class: res === 1 ? 'win' : '' }, EMOJI[b]), g.players[1].pseudo),
      ));
    } else {
      nodes.push(h('div', { class: 'rps-reveal' }, '❔'));
    }
    if (!g.over) {
      nodes.push(h('div', { class: 'rps-choices' },
        ['pierre', 'feuille', 'ciseaux'].map((m) =>
          h('button', {
            class: `rps-btn ${g.youChose === m ? 'chosen' : ''}`,
            disabled: !!g.youChose,
            on: { click: () => emit('game:move', { gameId: g.id, choice: m }) },
          }, h('span', { class: 'em' }, EMOJI[m]), LABEL[m]),
        ),
      ));
    }
    return h('div', {}, nodes);
  }

  /* ---------------- Boucle d'affichage des compteurs ---------------- */

  function tickTimer() {
    const g = state.game;
    const t = $('#timer');
    if (g && t && !g.over && state.gameDeadline) {
      const left = Math.max(0, state.gameDeadline - Date.now());
      t.textContent = `(${fmt(left)})`;
      t.classList.toggle('low', left <= 5000);
    } else if (t) {
      t.textContent = '';
    }
    const bar = $('#invite-bar');
    if (bar && state.invite) {
      const total = Math.max(1, state.invite.timeLeft);
      bar.style.transform = `scaleX(${Math.max(0, (state.inviteDeadline - Date.now()) / total)})`;
    }
  }

  function renderAll() {
    if (!state.me) return showScreen('auth');
    $('#who').textContent = state.me.pseudo;
    if (state.game) {
      showScreen('game');
      renderGame();
    } else {
      showScreen('lobby');
      renderMe();
      renderPlayers();
    }
  }

  /* ---------------- Démarrage ---------------- */

  async function start() {
    await initAuthScreen();
    initLobbyControls();
    setInterval(tickTimer, 250);
    if (state.token) {
      // Le serveur confirme la session ; sinon connect_error renvoie vers l'écran de connexion.
      state.me = { id: '', pseudo: '', avatar: '', stats: { p4: { human: { w: 0, l: 0, d: 0 }, cpu: { w: 0, l: 0, d: 0 } }, rps: { human: { w: 0, l: 0, d: 0 }, cpu: { w: 0, l: 0, d: 0 } } } };
      connect();
    } else {
      showScreen('auth');
    }
  }

  start();
})();

// Application installable (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
