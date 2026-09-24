require('dotenv').config();
const express = require('express');
const path = require('path');
const { getOrCreateUser, getUser, listUsers, applyDelta } = require('./db');
const { verifyInitData } = require('./telegramAuth');

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

// Servir la página principal del casino
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Autenticación de cada request del jugador ----------
function requireTelegramUser(req, res, next) {
  var user = verifyInitData(req.body.initData || req.query.initData, BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'No se pudo verificar tu sesión de Telegram.' });
  req.tgUser = user;
  next();
}

function requireAdmin(req, res, next) {
  var secret = req.body.adminSecret || req.query.adminSecret;
  if (!secret || secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Clave de dealer incorrecta.' });
  next();
}

// ---------- Perfil / saldo ----------
app.post('/api/me', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    res.json({ id: u.telegram_id, name: u.first_name || u.username || ('Jugador ' + u.telegram_id), balance: u.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Panel del dealer ----------
app.post('/api/admin/users', requireAdmin, async function (req, res) {
  try {
    var users = await listUsers();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/recharge', requireAdmin, async function (req, res) {
  var telegramId = parseInt(req.body.telegramId, 10);
  var amount = parseInt(req.body.amount, 10);
  if (!telegramId || !amount) return res.status(400).json({ error: 'Faltan datos.' });
  try {
    var newBalance = await applyDelta(telegramId, amount, 'recarga', 'Recarga autorizada por el dealer');
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

app.post('/api/blackjack/deal', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    var bet = parseInt(req.body.bet, 10);
    if (!bet || bet <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
    if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });

    // Descuenta el saldo de inmediato al repartir para evitar exploits de salida al menú
    var currentBalance = await applyDelta(req.tgUser.id, -bet, 'blackjack', 'Apuesta inicial de Blackjack');

    var deck = freshDeck();
    var session = { deck: deck, playerHand: [deck.pop(), deck.pop()], dealerHand: [deck.pop(), deck.pop()], bet: bet };
    blackjackSessions[req.tgUser.id] = session;

    if (isBlackjack(session.playerHand)) {
      var dealerBJ = isBlackjack(session.dealerHand);
      var delta = dealerBJ ? bet : Math.floor(bet * 2.5);
      var newBalance = await applyDelta(req.tgUser.id, delta, 'blackjack', dealerBJ ? 'Empate — ambos blackjack' : 'Blackjack — paga 3 a 2');
      delete blackjackSessions[req.tgUser.id];
      return res.json({ status: dealerBJ ? 'push' : 'blackjack', state: publicState(session, true), balance: newBalance, delta: dealerBJ ? 0 : Math.floor(bet * 1.5) });
    }
    res.json({ status: 'playing', state: publicState(session, false), balance: currentBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/blackjack/hit', requireTelegramUser, async function (req, res) {
  try {
    var session = blackjackSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una mano activa.' });
    session.playerHand.push(session.deck.pop());
    var total = handTotal(session.playerHand);
    if (total > 21) {
      var newBalance = await applyDelta(req.tgUser.id, -session.bet, 'blackjack', 'Se pasó de 21');
      delete blackjackSessions[req.tgUser.id];
      return res.json({ status: 'lose', state: publicState(session, true), balance: newBalance, delta: -session.bet });
    }
    var currentUser = await getUser(req.tgUser.id);
    res.json({ status: 'playing', state: publicState(session, false), balance: currentUser.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function dealerPlayAndResolve(telegramId, session) {
  var p = handTotal(session.playerHand);

  // VALIDACIÓN DE SEGURIDAD ABSOLUTA: Si el jugador se pasó de 21, pierde de inmediato
  if (p > 21) {
    var newBalance = await applyDelta(telegramId, 0, 'blackjack', 'Derrota: Se pasó de 21');
    delete blackjackSessions[telegramId];
    return { status: 'lose', balance: newBalance, delta: -session.bet };
  }

  while (handTotal(session.dealerHand) < 17) session.dealerHand.push(session.deck.pop());
  var d = handTotal(session.dealerHand);
  var status, delta;

  if (d > 21 || p > d) { status = 'win'; delta = session.bet; }
  else if (p < d) { status = 'lose'; delta = -session.bet; }
  else { status = 'push'; delta = 0; }

  // Al ganar se devuelve la apuesta original + ganancia neta (delta + session.bet)
  var totalReturn = delta > 0 ? session.bet + delta : (delta === 0 ? session.bet : 0);
  var newBalance = await applyDelta(telegramId, totalReturn, 'blackjack', 'Resultado: ' + status);
  delete blackjackSessions[telegramId];
  return { status: status, balance: newBalance, delta: delta };
}

app.post('/api/blackjack/stand', requireTelegramUser, async function (req, res) {
  try {
    var session = blackjackSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una mano activa.' });
    var result = await dealerPlayAndResolve(req.tgUser.id, session);
    res.json({ status: result.status, state: publicState(session, true), balance: result.balance, delta: result.delta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/blackjack/double', requireTelegramUser, async function (req, res) {
  try {
    var session = blackjackSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una mano activa.' });
    var u = await getUser(req.tgUser.id);
    if (session.bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente para doblar.' });
    
    // Descontar la apuesta adicional por doblar
    await applyDelta(req.tgUser.id, -session.bet, 'blackjack', 'Doblar apuesta');
    session.bet = session.bet * 2;
    session.playerHand.push(session.deck.pop());
    
    var total = handTotal(session.playerHand);
    if (total > 21) {
      delete blackjackSessions[req.tgUser.id];
      var currentUser = await getUser(req.tgUser.id);
      return res.json({ status: 'lose', state: publicState(session, true), balance: currentUser.balance, delta: -session.bet });
    }
    var result = await dealerPlayAndResolve(req.tgUser.id, session);
    res.json({ status: result.status, state: publicState(session, true), balance: result.balance, delta: result.delta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

app.post('/api/roulette/spin', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
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

    // En la ruleta se descuenta la apuesta y se devuelve el premio si gana
    var delta = win ? amount * mult : 0;
    var newBalance = await applyDelta(req.tgUser.id, delta - amount, 'ruleta', 'Salió ' + winNumber + ' (' + c + ')');

    res.json({ winNumber: winNumber, color: c, win: win, delta: win ? delta - amount : -amount, balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, function () {
  console.log('Casino corriendo en el puerto ' + PORT);
});
