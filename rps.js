'use strict';

/**
 * Pierre-Feuille-Ciseaux : règles + ordinateur (3 niveaux).
 *
 * Règles : on joue en plusieurs manches, le premier à 2 manches gagnées l'emporte.
 * En cas d'égalité, la manche est rejouée et ne compte pas.
 */

const MOVES = ['pierre', 'feuille', 'ciseaux'];
const TARGET = 2;

// BEATS[a] = ce que a bat
const BEATS = { pierre: 'ciseaux', feuille: 'pierre', ciseaux: 'feuille' };
// COUNTER[a] = le coup qui bat a
const COUNTER = { pierre: 'feuille', feuille: 'ciseaux', ciseaux: 'pierre' };

/** 0 si a gagne, 1 si b gagne, 'tie' en cas d'égalité. */
function outcome(a, b) {
  if (a === b) return 'tie';
  return BEATS[a] === b ? 0 : 1;
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

function mostFrequent(moves, rng) {
  const counts = { pierre: 0, feuille: 0, ciseaux: 0 };
  for (const m of moves) counts[m]++;
  const max = Math.max(...Object.values(counts));
  return pick(MOVES.filter((m) => counts[m] === max), rng);
}

/** Parmi les coups qui ont suivi `matches`, renvoie le plus fréquent s'il se détache nettement. */
function dominantNext(history, matches) {
  const counts = { pierre: 0, feuille: 0, ciseaux: 0 };
  let total = 0;
  for (let i = 0; i < history.length - 1; i++) {
    if (matches(history[i])) {
      counts[history[i + 1].h]++;
      total++;
    }
  }
  if (total < 2) return null;
  const sorted = MOVES.slice().sort((x, y) => counts[y] - counts[x]);
  return counts[sorted[0]] > counts[sorted[1]] ? sorted[0] : null;
}

/**
 * history : les manches précédentes de CE joueur contre l'ordinateur,
 * [{ h: coup du joueur, c: coup de l'ordinateur, r: 'w' | 'l' | 't' (du point de vue du joueur) }, ...]
 * L'ordinateur choisit toujours AVANT de connaître le coup en cours : il ne triche pas.
 *
 * level 1 : au hasard
 * level 2 : repère le coup préféré récent du joueur et tente de le contrer (une fois sur deux et demie)
 * level 3 : repère les enchaînements (ce que le joueur joue après tel coup / tel résultat), contre dans ~85 % des cas
 */
function cpuChoice(level, history, rng = Math.random) {
  if (level <= 1 || history.length === 0) return pick(MOVES, rng);

  if (level === 2) {
    const recent = history.slice(-12);
    if (recent.length < 3) return pick(MOVES, rng);
    const predicted = mostFrequent(recent.map((x) => x.h), rng);
    return rng() < 0.6 ? COUNTER[predicted] : pick(MOVES, rng);
  }

  const last = history[history.length - 1];
  let predicted = dominantNext(history, (x) => x.h === last.h && x.r === last.r);
  if (!predicted) predicted = dominantNext(history, (x) => x.h === last.h);
  if (!predicted && history.length >= 4) predicted = mostFrequent(history.slice(-15).map((x) => x.h), rng);
  if (!predicted) return pick(MOVES, rng);
  return rng() < 0.85 ? COUNTER[predicted] : pick(MOVES, rng);
}

module.exports = { MOVES, TARGET, outcome, cpuChoice, COUNTER };
