'use strict';

/**
 * Puissance 4 : règles + ordinateur (3 niveaux).
 *
 * Plateau : 6 lignes x 7 colonnes, board[r][c], r = 0 en haut.
 * 0 = vide, 1 / 2 = pions des joueurs.
 */

const ROWS = 6;
const COLS = 7;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const CENTER_FIRST = [3, 2, 4, 1, 5, 0, 6];
const WIN_SCORE = 1_000_000;

// Les 69 fenêtres de 4 cases alignées, calculées une seule fois.
const WINDOWS = (() => {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of DIRS) {
        const er = r + dr * 3;
        const ec = c + dc * 3;
        if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
        out.push([[r, c], [r + dr, c + dc], [r + dr * 2, c + dc * 2], [er, ec]]);
      }
    }
  }
  return out;
})();

const newBoard = () => Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
const copyBoard = (b) => b.map((row) => row.slice());
const validMoves = (b) => {
  const moves = [];
  for (let c = 0; c < COLS; c++) if (b[0][c] === 0) moves.push(c);
  return moves;
};
const orderedMoves = (b) => CENTER_FIRST.filter((c) => b[0][c] === 0);
const isFull = (b) => b[0].every((v) => v !== 0);

/** Pose un pion dans la colonne ; renvoie la ligne d'arrivée, ou -1 si la colonne est pleine. */
function drop(b, col, player) {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (b[r][col] === 0) {
      b[r][col] = player;
      return r;
    }
  }
  return -1;
}

function countDir(b, r, c, dr, dc, p) {
  let n = 0;
  r += dr;
  c += dc;
  while (r >= 0 && r < ROWS && c >= 0 && c < COLS && b[r][c] === p) {
    n++;
    r += dr;
    c += dc;
  }
  return n;
}

/** Le pion en (r, c) fait-il partie d'un alignement de 4 ou plus ? */
function winAt(b, r, c) {
  const p = b[r][c];
  if (!p) return false;
  for (const [dr, dc] of DIRS) {
    if (1 + countDir(b, r, c, dr, dc, p) + countDir(b, r, c, -dr, -dc, p) >= 4) return true;
  }
  return false;
}

/** Les cases de l'alignement passant par (r, c), ou null. */
function lineAt(b, r, c) {
  const p = b[r][c];
  if (!p) return null;
  for (const [dr, dc] of DIRS) {
    const fwd = countDir(b, r, c, dr, dc, p);
    const back = countDir(b, r, c, -dr, -dc, p);
    if (1 + fwd + back >= 4) {
      const cells = [];
      for (let s = -back; s <= fwd; s++) cells.push([r + dr * s, c + dc * s]);
      return cells;
    }
  }
  return null;
}

/** Joueur (1 ou 2) ayant un alignement sur le plateau, sinon 0. */
function winner(b) {
  for (const w of WINDOWS) {
    const p = b[w[0][0]][w[0][1]];
    if (p && w.every(([r, c]) => b[r][c] === p)) return p;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Ordinateur                                                          */
/* ------------------------------------------------------------------ */

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

function evaluate(b, me) {
  const opp = 3 - me;
  let score = 0;
  for (let r = 0; r < ROWS; r++) {
    if (b[r][3] === me) score += 3;
    else if (b[r][3] === opp) score -= 3;
  }
  for (const w of WINDOWS) {
    let m = 0;
    let o = 0;
    for (const [r, c] of w) {
      const v = b[r][c];
      if (v === me) m++;
      else if (v === opp) o++;
    }
    if (m && o) continue;
    if (m === 3) score += 5;
    else if (m === 2) score += 2;
    else if (o === 3) score -= 6;
    else if (o === 2) score -= 2;
  }
  return score;
}

function search(b, depth, alpha, beta, maximizing, me, lr, lc) {
  if (lr >= 0 && winAt(b, lr, lc)) return (b[lr][lc] === me ? 1 : -1) * (WIN_SCORE + depth);
  const moves = orderedMoves(b);
  if (moves.length === 0) return 0;
  if (depth === 0) return evaluate(b, me);
  const player = maximizing ? me : 3 - me;
  let best = maximizing ? -Infinity : Infinity;
  for (const c of moves) {
    const r = drop(b, c, player);
    const v = search(b, depth - 1, alpha, beta, !maximizing, me, r, c);
    b[r][c] = 0;
    if (maximizing) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }
  return best;
}

/** Niveau 3 : anticipe plusieurs coups (minimax avec élagage alpha-bêta). */
function minimaxMove(b, me, depth, rng) {
  let best = -Infinity;
  let bestMoves = [];
  for (const c of orderedMoves(b)) {
    const r = drop(b, c, me);
    const v = search(b, depth - 1, -Infinity, Infinity, false, me, r, c);
    b[r][c] = 0;
    if (v > best) {
      best = v;
      bestMoves = [c];
    } else if (v === best) {
      bestMoves.push(c);
    }
  }
  return pick(bestMoves, rng);
}

/** Niveau 2 : gagne si possible, bloque la plupart du temps, évite d'offrir une victoire. */
function heuristicMove(b, me, rng) {
  const opp = 3 - me;
  const moves = validMoves(b);
  const wouldWin = (c, p) => {
    const r = drop(b, c, p);
    const w = winAt(b, r, c);
    b[r][c] = 0;
    return w;
  };
  for (const c of moves) if (wouldWin(c, me)) return c;
  if (rng() < 0.8) for (const c of moves) if (wouldWin(c, opp)) return c;

  const safe = moves.filter((c) => {
    const r = drop(b, c, me);
    let ok = true;
    if (r > 0) {
      const r2 = drop(b, c, opp);
      if (winAt(b, r2, c)) ok = false;
      b[r2][c] = 0;
    }
    b[r][c] = 0;
    return ok;
  });
  const pool = safe.length ? safe : moves;
  const weights = pool.map((c) => 4 - Math.abs(3 - c)); // colonnes centrales favorisées
  let roll = rng() * weights.reduce((a, b2) => a + b2, 0);
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * Choisit la colonne jouée par l'ordinateur.
 * level 1 : au hasard · level 2 : tactique de base · level 3 : minimax profondeur 6
 */
function cpuMove(board, level, me, rng = Math.random) {
  const b = copyBoard(board);
  const moves = validMoves(b);
  if (moves.length === 0) return -1;
  if (level <= 1) return pick(moves, rng);
  if (level === 2) return heuristicMove(b, me, rng);
  return minimaxMove(b, me, 6, rng);
}

module.exports = {
  ROWS,
  COLS,
  newBoard,
  copyBoard,
  validMoves,
  isFull,
  drop,
  winAt,
  lineAt,
  winner,
  cpuMove,
};
