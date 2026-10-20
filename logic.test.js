'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C4 = require('../lib/connect4');
const RPS = require('../lib/rps');
const { Store, validateRegistration } = require('../lib/store');

const seeded = (seed = 1) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

test('P4 : alignements horizontal, vertical, diagonales', () => {
  let b = C4.newBoard();
  for (let c = 0; c < 4; c++) C4.drop(b, c, 1);
  assert.equal(C4.winner(b), 1);
  b = C4.newBoard();
  for (let i = 0; i < 4; i++) C4.drop(b, 2, 2);
  assert.equal(C4.winner(b), 2);
  b = C4.newBoard();
  // diagonale montante
  const cols = [[0, 1], [1, 2], [1, 1], [2, 2], [2, 2], [2, 1], [3, 2], [3, 2], [3, 2], [3, 1]];
  for (const [c, p] of cols) C4.drop(b, c, p);
  assert.equal(C4.winner(b), 1);
  const r = C4.drop(C4.newBoard(), 0, 1);
  assert.equal(r, 5);
});

test('P4 : colonne pleine et plateau plein', () => {
  const b = C4.newBoard();
  for (let i = 0; i < 6; i++) C4.drop(b, 0, 1 + (i % 2));
  assert.equal(C4.drop(b, 0, 1), -1);
  assert.deepEqual(C4.validMoves(b), [1, 2, 3, 4, 5, 6]);
});

test('P4 ordinateur : tous les niveaux jouent un coup légal', () => {
  for (const level of [1, 2, 3]) {
    const b = C4.newBoard();
    const col = C4.cpuMove(b, level, 2, seeded(7));
    assert.ok(col >= 0 && col < 7, `niveau ${level}`);
  }
});

test('P4 ordinateur niv.2 et 3 : gagnent en un coup et bloquent', () => {
  for (const level of [2, 3]) {
    const b = C4.newBoard();
    for (let i = 0; i < 3; i++) C4.drop(b, 0, 2); // l'ordinateur (2) peut gagner en colonne 0
    C4.drop(b, 1, 1); C4.drop(b, 2, 1);
    assert.equal(C4.cpuMove(b, level, 2, () => 0.5), 0, `niveau ${level} gagne`);
  }
  const b = C4.newBoard();
  for (let i = 0; i < 3; i++) C4.drop(b, 5, 1); // menace unique : l'humain gagne en colonne 5
  C4.drop(b, 0, 2);
  assert.equal(C4.cpuMove(b, 3, 2, seeded(3)), 5, 'niveau 3 bloque');
  assert.equal(C4.cpuMove(b, 2, 2, () => 0.1), 5, 'niveau 2 bloque');
});

test('P4 : le niveau 3 bat le niveau 1 sur 10 parties', () => {
  let wins = 0;
  for (let g = 0; g < 10; g++) {
    const b = C4.newBoard();
    const rng = seeded(100 + g);
    let turn = g % 2; // alterne qui commence
    let result = 0;
    for (let n = 0; n < 42 && !result; n++) {
      const p = turn + 1;
      const col = C4.cpuMove(b, p === 2 ? 3 : 1, p, rng);
      if (col < 0) break;
      const r = C4.drop(b, col, p);
      if (C4.winAt(b, r, col)) result = p;
      turn = 1 - turn;
    }
    if (result === 2) wins++;
  }
  assert.ok(wins >= 9, `niveau 3 a gagné ${wins}/10`);
});

test('PFC : règles et égalité', () => {
  assert.equal(RPS.outcome('pierre', 'ciseaux'), 0);
  assert.equal(RPS.outcome('ciseaux', 'pierre'), 1);
  assert.equal(RPS.outcome('feuille', 'pierre'), 0);
  assert.equal(RPS.outcome('feuille', 'feuille'), 'tie');
  assert.equal(RPS.TARGET, 2);
});

test('PFC ordinateur : niveau 3 exploite un joueur prévisible, niveau 1 non', () => {
  const play = (level) => {
    const hist = []; let cpuPoints = 0, humanPoints = 0;
    const rng = seeded(5);
    for (let i = 0; i < 200; i++) {
      const h = 'pierre';
      const c = RPS.cpuChoice(level, hist, rng);
      const r = RPS.outcome(h, c);
      hist.push({ h, c, r: r === 'tie' ? 't' : r === 0 ? 'w' : 'l' });
      if (r === 0) humanPoints++; else if (r === 1) cpuPoints++;
    }
    return cpuPoints - humanPoints;
  };
  assert.ok(play(3) > 80, 'niveau 3 doit dominer un joueur qui répète pierre');
  assert.ok(Math.abs(play(1)) < 40, 'niveau 1 reste au hasard');
});

test('Comptes : validation, doublons, mot de passe, sessions', async () => {
  assert.equal(validateRegistration({ email: 'x', pseudo: 'abc', password: '12345678' }).field, 'email');
  assert.equal(validateRegistration({ email: 'a@b.co', pseudo: 'ab', password: '12345678' }).field, 'pseudo');
  assert.equal(validateRegistration({ email: 'a@b.co', pseudo: 'Ordinateur', password: '12345678' }).field, 'pseudo');
  assert.equal(validateRegistration({ email: 'a@b.co', pseudo: 'abc', password: '123' }).field, 'password');
  const v = validateRegistration({ email: 'A@B.co ', pseudo: 'David', password: '12345678' });
  assert.equal(v.email, 'a@b.co');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arene-')), 'db.json');
  const s = new Store(file);
  const u = await s.createUser(v);
  assert.ok(s.emailTaken('a@b.co') && s.pseudoTaken('DAVID'));
  await assert.rejects(s.createUser({ ...v, email: 'z@z.co' }), { code: 'PSEUDO_TAKEN' });
  assert.equal(await s.verifyPassword(u, '12345678'), true);
  assert.equal(await s.verifyPassword(u, 'mauvais-mdp'), false);
  assert.equal(await s.verifyPassword(null, 'x'), false);
  const t = s.createSession(u.id);
  assert.equal(s.getSession(t).id, u.id);
  s.flush();
  const s2 = new Store(file); // persistance
  assert.equal(s2.getSession(t).pseudo, 'David');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(t), 'le jeton brut ne doit pas être stocké');
  s2.deleteSession(t);
  assert.equal(s2.getSession(t), null);
});
