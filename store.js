'use strict';

/**
 * Stockage des comptes et des sessions dans un fichier JSON.
 * - mots de passe hachés avec scrypt (module crypto natif, aucune dépendance)
 * - jetons de session stockés sous forme de hash SHA-256 (une fuite du fichier ne donne pas les jetons)
 * - écriture atomique (fichier temporaire + rename), regroupée par un petit délai
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SESSION_MS = 30 * 24 * 3600 * 1000;
const RESERVED_PSEUDOS = new Set(['ordinateur', 'robot', 'admin', 'administrateur', 'moderateur', 'modérateur']);

const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦄', '🐧', '🐨', '🐵', '🦉', '🐢', '🐬', '🦖', '🚀', '⚡'];

const emptyBucket = () => ({ w: 0, l: 0, d: 0 });
const emptyStats = () => ({
  p4: { human: emptyBucket(), cpu: emptyBucket() },
  rps: { human: emptyBucket(), cpu: emptyBucket() },
});

const normPseudo = (p) => p.normalize('NFKC').toLowerCase();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validateRegistration(body) {
  const b = body && typeof body === 'object' ? body : {};

  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { error: 'Adresse e-mail invalide.', field: 'email' };
  }

  const pseudo = typeof b.pseudo === 'string' ? b.pseudo.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (pseudo.length < 3 || pseudo.length > 16) {
    return { error: 'Le pseudo doit faire entre 3 et 16 caractères.', field: 'pseudo' };
  }
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(pseudo)) {
    return { error: 'Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -.', field: 'pseudo' };
  }
  if (RESERVED_PSEUDOS.has(normPseudo(pseudo))) {
    return { error: 'Ce pseudo est réservé.', field: 'pseudo' };
  }

  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8 || password.length > 128) {
    return { error: 'Le mot de passe doit faire entre 8 et 128 caractères.', field: 'password' };
  }

  const avatar = AVATARS.includes(b.avatar) ? b.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
  return { email, pseudo, password, avatar };
}

class Store {
  constructor(file) {
    this.file = file;
    this.users = {};
    this.sessions = {};
    this.byEmail = new Map();
    this.byPseudo = new Map();
    this.timer = null;
    this.dirty = false;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`Base illisible : sauvegardée dans ${backup}. Démarrage avec une base vide.`);
      return;
    }
    this.users = data.users || {};
    this.sessions = data.sessions || {};
    const now = Date.now();
    for (const [key, s] of Object.entries(this.sessions)) if (!s || s.exp < now) delete this.sessions[key];
    for (const u of Object.values(this.users)) {
      if (!u.stats) u.stats = emptyStats();
      this.byEmail.set(u.email, u.id);
      this.byPseudo.set(normPseudo(u.pseudo), u.id);
    }
  }

  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      try {
        this.flush();
      } catch (e) {
        console.error('Écriture de la base impossible :', e.message);
      }
    }, 250);
    this.timer.unref();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users, sessions: this.sessions }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  getUser(id) {
    return this.users[id] || null;
  }
  findByEmail(email) {
    const id = this.byEmail.get(email);
    return id ? this.users[id] : null;
  }
  emailTaken(email) {
    return this.byEmail.has(email);
  }
  pseudoTaken(pseudo) {
    return this.byPseudo.has(normPseudo(pseudo));
  }

  async createUser({ email, pseudo, password, avatar }) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    // Revérification après l'attente : deux inscriptions simultanées ne doivent pas passer toutes les deux.
    if (this.emailTaken(email)) throw Object.assign(new Error('email'), { code: 'EMAIL_TAKEN' });
    if (this.pseudoTaken(pseudo)) throw Object.assign(new Error('pseudo'), { code: 'PSEUDO_TAKEN' });
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      email,
      pseudo,
      avatar,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      createdAt: Date.now(),
      stats: emptyStats(),
    };
    this.users[user.id] = user;
    this.byEmail.set(email, user.id);
    this.byPseudo.set(normPseudo(pseudo), user.id);
    this.save();
    return user;
  }

  async verifyPassword(user, password) {
    if (!user) {
      // Même durée de calcul que pour un vrai compte, pour ne pas révéler quels e-mails existent.
      await scrypt(password, Buffer.alloc(16), 64);
      return false;
    }
    const hash = await scrypt(password, Buffer.from(user.salt, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[sha256(token)] = { uid: userId, exp: Date.now() + SESSION_MS };
    this.save();
    return token;
  }

  getSession(token) {
    if (typeof token !== 'string') return null;
    const key = sha256(token);
    const s = this.sessions[key];
    if (!s) return null;
    if (s.exp < Date.now()) {
      delete this.sessions[key];
      return null;
    }
    return this.users[s.uid] || null;
  }

  deleteSession(token) {
    if (typeof token !== 'string') return;
    delete this.sessions[sha256(token)];
    this.save();
  }
}

module.exports = { Store, AVATARS, validateRegistration, normPseudo, emptyStats };
