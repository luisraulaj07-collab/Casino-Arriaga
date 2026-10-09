// Carreras de caballos compartidas: el servidor lleva el reloj y sortea al ganador.
// Ciclo: apuestas (20 s) -> carrera (20 s) -> resultados (6 s) -> nueva ronda.
const { db, applyDelta, getUser } = require('./db');

const RTP = 0.90; // 10% de ventaja para la casa[cite: 5]
const BET_MS = Number(process.env.RACE_BET_MS) || 20000;
const RACE_MS = Number(process.env.RACE_RACE_MS) || 20000;
const LEAD_MS = Number(process.env.RACE_LEAD_MS) || 2000;   // cuenta regresiva antes de arrancar
const RESULT_MS = Number(process.env.RACE_RESULT_MS) || 6000;

const HORSES = [
  { n: 1, name: 'Relámpago', color: '#c0392b', p: 0.30 },
  { n: 2, name: 'Tornado',   color: '#2471a3', p: 0.22 },
  { n: 3, name: 'El Bandido', color: '#27ae60', p: 0.18 },
  { n: 4, name: 'Mezcal',    color: '#d4ac0d', p: 0.14 },
  { n: 5, name: 'Azteca',    color: '#8e44ad', p: 0.10 },
  { n: 6, name: 'Chamuco',   color: '#e67e22', p: 0.06 }
].map(function (h) { h.odds = RTP / h.p; return h; });

let roundCounter = 1;
// Inicializamos 'round' por defecto para evitar valores nulos al arrancar
let round = { 
  id: 1, 
  phase: 'bet', 
  phaseEnd: Date.now() + BET_MS, 
  order: null, 
  runners: null, 
  raceStart: null 
};
let lastResult = null;
let history = [];
let timer = null;

async function initTableAndCounter() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS race_bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER NOT NULL,
        telegram_id INTEGER NOT NULL,
        name TEXT,
        horse INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0,
        payout INTEGER NOT NULL DEFAULT 0
      )
    `);
    var res = await db.execute('SELECT COALESCE(MAX(round_id),0) AS m FROM race_bets');
    if (res.rows && res.rows[0]) {
      roundCounter = res.rows[0].m || 1;
      round.id = roundCounter;
    }
  } catch (e) {
    console.error('Error inicializando tabla race_bets:', e);
  }
}

// Orden de llegada: sorteos ponderados sucesivos (el primero es el ganador).
function drawOrder() {
  var pool = HORSES.slice(), order = [];
  while (pool.length) {
    var tot = pool.reduce(function (s, h) { return s + h.p; }, 0);
    var r = Math.random() * tot, a = 0, k = 0;
    for (; k < pool.length; k++) { a += pool[k].p; if (r < a) break; }
    k = Math.min(k, pool.length - 1);
    order.push(pool[k]); pool.splice(k, 1);
  }
  return order;
}

// Tiempos de llegada y "semillas" del vaivén: todos los celulares dibujan lo mismo.
function makeRunners(order) {
  return HORSES.map(function (h) {
    var rank = order.indexOf(h);
    return {
      T: RACE_MS * 0.80 + rank * RACE_MS * 0.03 + Math.random() * RACE_MS * 0.01,
      ph: Math.random() * 6,
      k: 2 + Math.random() * 3
    };
  });
}

async function refundInterrupted() {
  try {
    var res = await db.execute('SELECT * FROM race_bets WHERE settled = 0');
    for (var i = 0; i < res.rows.length; i++) {
      var b = res.rows[i];
      try { await applyDelta(b.telegram_id, b.amount, 'carreras', 'Reembolso: carrera interrumpida'); } catch (e) {}
      await db.execute({
        sql: 'UPDATE race_bets SET settled = 1 WHERE id = ?',
        args: [b.id]
      });
    }
  } catch (e) {
    console.error('Error en reembolso:', e);
  }
}

function startBetting() {
  roundCounter++;
  var now = Date.now();
  round = { id: roundCounter, phase: 'bet', phaseEnd: now + BET_MS, order: null, runners: null, raceStart: null };
  timer = setTimeout(closeBets, BET_MS);
}

function closeBets() {
  var now = Date.now();
  round.order = drawOrder();
  round.runners = makeRunners(round.order);
  round.raceStart = now + LEAD_MS;
  round.phase = 'race';
  round.phaseEnd = round.raceStart + RACE_MS;
  timer = setTimeout(settle, LEAD_MS + RACE_MS);
}

async function settle() {
  var winner = round.order[0];
  try {
    var res = await db.execute({
      sql: 'SELECT * FROM race_bets WHERE round_id = ?',
      args: [round.id]
    });
    var bets = res.rows;
    var winners = [], results = [];
    for (var i = 0; i < bets.length; i++) {
      var b = bets[i];
      var payout = 0;
      if (b.horse === winner.n) {
        payout = Math.floor(b.amount * winner.odds);
        try { 
          await applyDelta(b.telegram_id, payout, 'carreras', 'Ganó carrera #' + round.id); 
        } catch (e) { 
          payout = 0; 
        }
        winners.push({ name: b.name, amount: b.amount, payout: payout });
      }
      await db.execute({
        sql: 'UPDATE race_bets SET settled = 1, payout = ? WHERE id = ?',
        args: [payout, b.id]
      });
      results.push({ telegram_id: b.telegram_id, amount: b.amount, payout: payout });
    }
    lastResult = { roundId: round.id, winner: winner.n, winners: winners, bets: results };
    history.unshift(winner.n);
    history = history.slice(0, 8);
  } catch (e) {
    console.error('Error al liquidar apuestas:', e);
  }
  round.phase = 'result';
  round.phaseEnd = Date.now() + RESULT_MS;
  timer = setTimeout(startBetting, RESULT_MS);
}

async function start() {
  await initTableAndCounter();
  await refundInterrupted();
  startBetting();
}

async function getState(userId) {
  var now = Date.now();
  var bets = [];
  if (round) {
    try {
      var res = await db.execute({
        sql: 'SELECT * FROM race_bets WHERE round_id = ?',
        args: [round.id]
      });
      bets = res.rows;
    } catch (e) {}
  }
  var u = await getUser(userId);
  var st = {
    serverNow: now, 
    roundId: round.id, 
    phase: round.phase, 
    phaseEnd: round.phaseEnd,
    horses: HORSES.map(function (h) { return { n: h.n, name: h.name, color: h.color, odds: h.odds }; }),
    bets: bets.slice(-40).map(function (b) { return { name: b.name, horse: b.horse, amount: b.amount }; }),
    myBets: bets.filter(function (b) { return b.telegram_id === userId; }).map(function (b) { return { horse: b.horse, amount: b.amount }; }),
    history: history,
    balance: (u && typeof u.balance === 'number') ? u.balance : 0,
    lastResult: lastResult ? { roundId: lastResult.roundId, winner: lastResult.winner, winners: lastResult.winners.slice(0, 10) } : null,
    myResult: null
  };
  if (lastResult) {
    var mine = lastResult.bets.filter(function (b) { return b.telegram_id === userId; });
    if (mine.length) st.myResult = {
      staked: mine.reduce(function (s, b) { return s + b.amount; }, 0),
      payout: mine.reduce(function (s, b) { return s + b.payout; }, 0)
    };
  }
  if (round.phase !== 'bet') { st.raceStart = round.raceStart; st.runners = round.runners; }
  return st;
}

async function placeBet(userId, name, horse, amount) {
  if (!round || round.phase !== 'bet' || Date.now() > round.phaseEnd - 300) return { error: 'Las apuestas están cerradas. Espera la siguiente carrera.' };
  if (!Number.isInteger(horse) || horse < 1 || horse > HORSES.length) return { error: 'Caballo inválido.' };
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'Monto inválido.' };
  var balance;
  try { 
    balance = await applyDelta(userId, -amount, 'carreras', 'Apuesta carrera #' + round.id + ' al caballo ' + horse); 
  } catch (e) { 
    return { error: e.message === 'Saldo insuficiente' ? 'Saldo insuficiente.' : 'No se pudo apostar.' }; 
  }
  await db.execute({
    sql: 'INSERT INTO race_bets (round_id, telegram_id, name, horse, amount) VALUES (?, ?, ?, ?, ?)',
    args: [round.id, userId, name, horse, amount]
  });
  return { balance: balance };
}

module.exports = { start: start, getState: getState, placeBet: placeBet, HORSES: HORSES, _drawOrder: drawOrder };
