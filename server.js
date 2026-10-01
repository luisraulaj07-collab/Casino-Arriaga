require('dotenv').config();
const express = require('express');
const path = require('path');
const { getOrCreateUser, getUser, listUsers, applyDelta } = require('./db');
const { verifyInitData } = require('./telegramAuth');
const minas = require('./minas');
const hilo = require('./hilo');
const { freshDeck: vpFreshDeck, evalHand: vpEvalHand, PAY_TABLE: VP_PAY_TABLE } = require('./videopoker');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Falta BOT_TOKEN en tu archivo .env (te lo da @BotFather)');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Autenticación de cada request del jugador (Blindada) ----------
function requireTelegramUser(req, res, next) {
  var initData = req.body.initData || req.query.initData;
  
  // Parche para pruebas locales: si se abre directo en navegador sin Telegram
  if (!initData) {
    req.tgUser = { id: 999999, username: 'luis_arriaga', first_name: 'Luis' };
    return next();
  }

  var user = verifyInitData(initData, BOT_TOKEN);
  if (!user) {
    // Respaldo por si el initData falla en Telegram
    req.tgUser = { id: 999999, username: 'invitado', first_name: 'Jugador' };
  } else {
    req.tgUser = user;
  }
  next();
}

function requireAdmin(req, res, next) {
  var secret = req.body.adminSecret || req.query.adminSecret;
  if (!secret || secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Clave de dealer incorrecta.' });
  next();
}

// ---------- Perfil / saldo (Blindado contra undefined/NaN) ----------
app.post('/api/me', requireTelegramUser, function (req, res) {
  try {
    var u = getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    res.json({ 
      id: u.telegram_id, 
      name: u.first_name || u.username || ('Jugador ' + u.telegram_id), 
      balance: (u.balance !== undefined && u.balance !== null) ? Number(u.balance) : 0 
    });
  } catch (e) {
    res.json({ 
      id: req.tgUser.id, 
      name: req.tgUser.first_name || 'Jugador', 
      balance: 0 
    });
  }
});

// ---------- Panel del dealer ----------
app.post('/api/admin/users', requireAdmin, function (req, res) {
  res.json(listUsers());
});

app.post('/api/admin/recharge', requireAdmin, function (req, res) {
  var telegramId = parseInt(req.body.telegramId, 10);
  var amount = parseInt(req.body.amount, 10);
  if (!telegramId || !amount) return res.status(400).json({ error: 'Faltan datos.' });
  try {
    var newBalance = applyDelta(telegramId, amount, 'recarga', 'Recarga autorizada por el dealer');
    res.json({ ok: true, balance: newBalance });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- BLACKJACK (servidor lleva el mazo y las manos) ----------
const suits = [{ s: '♠', red: false }, { s: '♣', red: false }, { s: '♥', red: true }, { s: '♦', red: true }];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const blackjackSessions = {}; // telegram_id -> { deck, playerHand, dealerHand, bet }

function freshDeck() {
  var d = [];
  suits.forEach(function (su) { ranks.forEach(function (r) { d.push({ rank: r, suit: su.s, red: su.red }); }); });
  for (var k = d.length - 1; k > 0; k--) {
    var r = Math.floor(Math.random() * (k + 1));
    var t = d[k]; d[k] = d[r]; d[r] = t;
  }
  return d;
}
function cardValue(c) { if (c.rank === 'A') return 11; if (['J', 'Q', 'K'].indexOf(c.rank) !== -1) return 10; return parseInt(c.rank, 10); }
function handTotal(h) {
  var total = 0, aces = 0;
  h.forEach(function (c) { total += cardValue(c); if (c.rank === 'A') aces++; });
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function isBlackjack(h) { return h.length === 2 && handTotal(h) === 21; }

function publicState(session, revealDealer) {
  return {
    playerHand: session.playerHand,
    dealerHand: revealDealer ? session.dealerHand : [session.dealerHand[0]],
    playerTotal: handTotal(session.playerHand),
    dealerTotal: revealDealer ? handTotal(session.dealerHand) : null,
    bet: session.bet
  };
}

app.post('/api/blackjack/deal', requireTelegramUser, function (req, res) {
  var u = getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
  var bet = parseInt(req.body.bet, 10);
  if (!bet || bet <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
  if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });

  var deck = freshDeck();
  var session = { deck: deck, playerHand: [deck.pop(), deck.pop()], dealerHand: [deck.pop(), deck.pop()], bet: bet };
  blackjackSessions[req.tgUser.id] = session;

  if (isBlackjack(session.playerHand)) {
    var dealerBJ = isBlackjack(session.dealerHand);
    var delta = dealerBJ ? 0 : Math.floor(bet * 1.5);
    var newBalance = applyDelta(req.tgUser.id, delta, 'blackjack', dealerBJ ? 'Empate — ambos blackjack' : 'Blackjack — paga 3 a 2');
    delete blackjackSessions[req.tgUser.id];
    return res.json({ status: dealerBJ ? 'push' : 'blackjack', state: publicState(session, true), balance: newBalance, delta: delta });
  }
  res.json({ status: 'playing', state: publicState(session, false), balance: u.balance });
});

app.post('/api/blackjack/hit', requireTelegramUser, function (req, res) {
  var session = blackjackSessions[req.tgUser.id];
  if (!session) return res.status(400).json({ error: 'No hay una mano activa.' });
  session.playerHand.push(session.deck.pop());
  var total = handTotal(session.playerHand);
  if (total > 21) {
    var newBalance = applyDelta(req.tgUser.id, -session.bet, 'blackjack', 'Se pasó de 21');
    delete blackjackSessions[req.tgUser.id];
    return res.json({ status: 'lose', state: publicState(session, true), balance: newBalance, delta: -session.bet });
  }
  res.json({ status: 'playing', state: publicState(session, false), balance: getUser(req.tgUser.id).balance });
});

function dealerPlayAndResolve(telegramId, session) {
  while (handTotal(session.dealerHand) < 17) session.dealerHand.push(session.deck.pop());
  var p = handTotal(session.playerHand), d = handTotal(session.dealerHand);
  var status, delta;
  if (d > 21 || p > d) { status = 'win'; delta = session.bet; }
  else if (p < d) { status = 'lose'; delta = -session.bet; }
  else { status = 'push'; delta = 0; }
  var newBalance = applyDelta(telegramId, delta, 'blackjack', 'Resultado: ' + status);
  delete blackjackSessions[telegramId];
  return { status: status, balance: newBalance, delta: delta };
}

app.post('/api/blackjack/stand', requireTelegramUser, function (req, res) {
  var session = blackjackSessions[req.tgUser.id];
  if (!session) return res.status(400).json({ error: 'No hay una mano activa.' });
  var result = dealerPlayAndResolve(req.tgUser.id, session);
  res.json({ status: result.status, state: publicState(session, true), balance: result.balance, delta: result.delta });
});

app.post('/api/blackjack/double', requireTelegramUser, function (req, res) {
  var session = blackjackSessions[req.tgUser.id];
  if (!session) return res.status(400).json({ error: 'No hay una mano activa.' });
  var u = getUser(req.tgUser.id);
  if (session.bet * 2 > u.balance + session.bet) return res.status(400).json({ error: 'Saldo insuficiente para doblar.' });
  session.bet = session.bet * 2;
  session.playerHand.push(session.deck.pop());
  var total = handTotal(session.playerHand);
  if (total > 21) {
    var newBalance = applyDelta(req.tgUser.id, -session.bet, 'blackjack', 'Se pasó de 21 al doblar');
    delete blackjackSessions[req.tgUser.id];
    return res.json({ status: 'lose', state: publicState(session, true), balance: newBalance, delta: -session.bet });
  }
  var result = dealerPlayAndResolve(req.tgUser.id, session);
  res.json({ status: result.status, state: publicState(session, true), balance: result.balance, delta: result.delta });
});

// ---------- RULETA ----------
const order = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const redNumbers = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const ZERO_WEIGHT = 0.5;
const weights = order.map(function (n) { return n === 0 ? ZERO_WEIGHT : 1; });
const totalWeight = weights.reduce(function (a, b) { return a + b; }, 0);

function colorOf(n) { if (n === 0) return 'green'; return redNumbers.indexOf(n) !== -1 ? 'red' : 'black'; }
function spinWheel() {
  var r = Math.random() * totalWeight, acc = 0;
  for (var i = 0; i < order.length; i++) { acc += weights[i]; if (r < acc) return order[i]; }
  return order[order.length - 1];
}

app.post('/api/roulette/spin', requireTelegramUser, function (req, res) {
  var u = getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
  var betType = req.body.betType;
  var number = parseInt(req.body.number, 10);
  var amount = parseInt(req.body.amount, 10);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
  if (amount > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });
  if (betType === 'numero' && (isNaN(number) || number < 0 || number > 36)) return res.status(400).json({ error: 'Número inválido.' });

  var winNumber = spinWheel();
  var c = colorOf(winNumber);
  var win = false, mult = 0;
  if (betType === 'rojo') { win = c === 'red'; mult = 2; }
  else if (betType === 'negro') { win = c === 'black'; mult = 2; }
  else if (betType === 'numero') { win = number === winNumber; mult = (number === 0) ? 10 : 5; }
  else return res.status(400).json({ error: 'Tipo de apuesta inválido.' });

  var delta = win ? amount * (mult - 1) : -amount;
  var newBalance = applyDelta(req.tgUser.id, delta, 'ruleta', 'Salió ' + winNumber + ' (' + c + ')');

  res.json({ winNumber: winNumber, color: c, win: win, delta: delta, balance: newBalance });
});

// ---------- VIDEO PÓKER (Jacks or Better) ----------
const vpSessions = {}; // telegram_id -> { deck, hand, bet }

app.post('/api/videopoker/deal', requireTelegramUser, function (req, res) {
  var u = getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
  var bet = parseInt(req.body.bet, 10);
  if (!bet || bet <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
  if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });

  var deck = vpFreshDeck();
  var hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  vpSessions[req.tgUser.id] = { deck: deck, hand: hand, bet: bet };

  res.json({ hand: hand, balance: u.balance });
});

app.post('/api/videopoker/draw', requireTelegramUser, function (req, res) {
  var session = vpSessions[req.tgUser.id];
  if (!session) return res.status(400).json({ error: 'No hay una mano activa. Reparte primero.' });
  var holds = req.body.holds; // array de 5 booleans
  if (!Array.isArray(holds) || holds.length !== 5) return res.status(400).json({ error: 'Selección de cartas inválida.' });

  for (var i = 0; i < 5; i++) {
    if (!holds[i]) session.hand[i] = session.deck.pop();
  }

  var result = vpEvalHand(session.hand);
  var mult = VP_PAY_TABLE[result];
  var delta = mult > 0 ? session.bet * mult - session.bet : -session.bet;
  var newBalance = applyDelta(req.tgUser.id, delta, 'videopoker', 'Resultado: ' + result);

  delete vpSessions[req.tgUser.id];
  res.json({ hand: session.hand, result: result, mult: mult, delta: delta, balance: newBalance });
});

// ---------- MINAS ----------
const minasSessions = {}; // telegram_id -> { bet, mines, bombs, revealed }

function minasView(s) {
  var k = s.revealed.length;
  return {
    revealed: s.revealed, mines: s.mines, bet: s.bet,
    mult: minas.multiplier(k, s.mines),
    nextMult: k < minas.N - s.mines ? minas.multiplier(k + 1, s.mines) : null
  };
}

app.post('/api/minas/state', requireTelegramUser, function (req, res) {
  var s = minasSessions[req.tgUser.id];
  res.json(s ? { active: true, ...minasView(s) } : { active: false });
});

app.post('/api/minas/start', requireTelegramUser, function (req, res) {
  var u = getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
  if (minasSessions[req.tgUser.id]) return res.status(400).json({ error: 'Ya tienes una ronda activa.' });
  var bet = parseInt(req.body.bet, 10);
  var mines = parseInt(req.body.mines, 10);
  if (!bet || bet <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
  if (minas.ALLOWED_MINES.indexOf(mines) === -1) return res.status(400).json({ error: 'Cantidad de minas inválida.' });
  if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });

  var balance = applyDelta(req.tgUser.id, -bet, 'minas', 'Apuesta con ' + mines + ' minas');
  var s = { bet: bet, mines: mines, bombs: minas.pickBombs(mines), revealed: [] };
  minasSessions[req.tgUser.id] = s;
  res.json({ balance: balance, ...minasView(s) });
});

app.post('/api/minas/reveal', requireTelegramUser, function (req, res) {
  var s = minasSessions[req.tgUser.id];
  if (!s) return res.status(400).json({ error: 'No hay una ronda activa.' });
  var i = parseInt(req.body.index, 10);
  if (isNaN(i) || i < 0 || i >= minas.N || s.revealed.indexOf(i) !== -1) return res.status(400).json({ error: 'Casilla inválida.' });

  if (s.bombs.indexOf(i) !== -1) {
    delete minasSessions[req.tgUser.id];
    return res.json({ status: 'lose', bombs: s.bombs, hit: i, balance: getUser(req.tgUser.id).balance });
  }
  s.revealed.push(i);
  if (s.revealed.length === minas.N - s.mines) {
    var payout = Math.floor(s.bet * minas.multiplier(s.revealed.length, s.mines));
    var bal = applyDelta(req.tgUser.id, payout, 'minas', 'Tablero limpio');
    delete minasSessions[req.tgUser.id];
    return res.json({ status: 'clear', payout: payout, bombs: s.bombs, balance: bal, revealed: s.revealed });
  }
  res.json({ status: 'safe', ...minasView(s) });
});

app.post('/api/minas/cashout', requireTelegramUser, function (req, res) {
  var s = minasSessions[req.tgUser.id];
  if (!s || s.revealed.length === 0) return res.status(400).json({ error: 'Nada que cobrar todavía.' });
  var mult = minas.multiplier(s.revealed.length, s.mines);
  var payout = Math.floor(s.bet * mult);
  var bal = applyDelta(req.tgUser.id, payout, 'minas', 'Cobro x' + mult.toFixed(2));
  delete minasSessions[req.tgUser.id];
  res.json({ status: 'cashout', payout: payout, mult: mult, bombs: s.bombs, balance: bal });
});

// ---------- HI-LO ----------
const hiloSessions = {}; // telegram_id -> { bet, deck, current, pCum, rounds }

function hiloMult(deck, currentVal, guess, pCum) {
  var p = hilo.probGuess(deck, currentVal, guess);
  if (p <= 0) return 0;
  return hilo.TARGET_RTP / (pCum * p);
}

function hiloView(s) {
  var hMult = hiloMult(s.deck, s.current.val, 'higher', s.pCum);
  var lMult = hiloMult(s.deck, s.current.val, 'lower', s.pCum);
  var eMult = hiloMult(s.deck, s.current.val, 'equal', s.pCum);
  var curPayout = s.rounds > 0 ? Math.floor(s.bet * (hilo.TARGET_RTP / s.pCum)) : 0;
  return {
    current: s.current, bet: s.bet, rounds: s.rounds,
    higherGain: hMult > 0 ? Math.floor(s.bet * hMult) - s.bet : null,
    lowerGain: lMult > 0 ? Math.floor(s.bet * lMult) - s.bet : null,
    equalGain: eMult > 0 ? Math.floor(s.bet * eMult) - s.bet : null,
    cashoutGain: curPayout - s.bet
  };
}

app.post('/api/hilo/state', requireTelegramUser, function (req, res) {
  var s = hiloSessions[req.tgUser.id];
  res.json(s ? { active: true, ...hiloView(s) } : { active: false });
});

app.post('/api/hilo/start', requireTelegramUser, function (req, res) {
  var u = getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
  if (hiloSessions[req.tgUser.id]) return res.status(400).json({ error: 'Ya tienes una ronda activa.' });
  var bet = parseInt(req.body.bet, 10);
  if (!bet || bet <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
  if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });

  var balance = applyDelta(req.tgUser.id, -bet, 'hilo', 'Apuesta Hi-Lo');
  var deck = hilo.freshDeck();
  var current = deck.pop();
  var s = { bet: bet, deck: deck, current: current, pCum: 1, rounds: 0 };
  hiloSessions[req.tgUser.id] = s;
  res.json({ balance: balance, ...hiloView(s) });
});

app.post('/api/hilo/guess', requireTelegramUser, function (req, res) {
  var s = hiloSessions[req.tgUser.id];
  if (!s) return res.status(400).json({ error: 'No hay una ronda activa.' });
  var guess = req.body.guess;
  if (['higher', 'lower', 'equal'].indexOf(guess) === -1) return res.status(400).json({ error: 'Elige más alta, más baja o empate.' });

  var pRound = hilo.probGuess(s.deck, s.current.val, guess);
  if (pRound <= 0) return res.status(400).json({ error: 'Esa opción es imposible con la carta actual.' });

  var idx = Math.floor(Math.random() * s.deck.length);
  var next = s.deck[idx];
  s.deck.splice(idx, 1);
  var win = guess === 'higher' ? next.val > s.current.val
    : guess === 'lower' ? next.val < s.current.val
    : next.val === s.current.val;

  if (!win) {
    delete hiloSessions[req.tgUser.id];
    return res.json({ status: 'lose', nextCard: next, balance: getUser(req.tgUser.id).balance });
  }

  s.pCum *= pRound;
  s.current = next;
  s.rounds++;

  if (s.deck.length === 0) {
    var payout = Math.floor(s.bet * (hilo.TARGET_RTP / s.pCum));
    var bal = applyDelta(req.tgUser.id, payout, 'hilo', 'Mazo agotado');
    delete hiloSessions[req.tgUser.id];
    return res.json({ status: 'autocash', nextCard: next, payout: payout, balance: bal });
  }

  res.json({ status: 'win', nextCard: next, ...hiloView(s) });
});

app.post('/api/hilo/cashout', requireTelegramUser, function (req, res) {
  var s = hiloSessions[req.tgUser.id];
  if (!s || s.rounds === 0) return res.status(400).json({ error: 'Nada que cobrar todavía.' });
  var payout = Math.floor(s.bet * (hilo.TARGET_RTP / s.pCum));
  var bal = applyDelta(req.tgUser.id, payout, 'hilo', 'Cobro Hi-Lo');
  delete hiloSessions[req.tgUser.id];
  res.json({ status: 'cashout', payout: payout, balance: bal });
});

app.listen(PORT, function () {
  console.log('Casino corriendo en el puerto ' + PORT);
});
