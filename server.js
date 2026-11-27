require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  getOrCreateUser,
  getUser,
  getUserByUsername,
  createWebUser,
  listUsers,
  applyDelta,
  getStaffWallets,
  adjustStaffWallet,
  logAdminMovement,
  listStaffMovements
} = require('./db');
const { verifyInitData } = require('./telegramAuth');
const pokerLogic = require('./pokerLogic');
const minasLogic = require('./minas');
const hiloLogic = require('./hilo');
const carreras = require('./carreras');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const STAFF_SECRET_1 = process.env.STAFF_SECRET_1 || '';
const STAFF_SECRET_2 = process.env.STAFF_SECRET_2 || '';
const JWT_SECRET = process.env.JWT_SECRET || 'clave_temporal_cambiar_en_render';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function signSessionToken(user) {
  return jwt.sign(
    {
      id: Number(user.telegram_id),
      username: user.username || user.first_name || 'jugador'
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ---------- Registro y Login Web ----------
app.post('/api/auth/register', async function (req, res) {
  try {
    var rawUsername = String(req.body.username || '').trim().toLowerCase();
    var password = String(req.body.password || '');
    var email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
    var firstName = req.body.firstName ? String(req.body.firstName).trim() : rawUsername;

    if (!/^[a-z0-9_]{3,20}$/.test(rawUsername)) {
      return res.status(400).json({
        error: 'El usuario debe tener entre 3 y 20 caracteres (letras, números o guion bajo).'
      });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
    }

    var existing = await getUserByUsername(rawUsername);
    if (existing) {
      return res.status(400).json({ error: 'Ese nombre de usuario ya está registrado.' });
    }

    var passwordHash = await bcrypt.hash(password, 10);
    var created = await createWebUser({
      username: rawUsername,
      passwordHash: passwordHash,
      email: email,
      firstName: firstName
    });

    var token = signSessionToken(created);
    return res.json({
      token: token,
      user: {
        id: Number(created.telegram_id),
        username: created.username,
        name: created.first_name || created.username,
        balance: Number(created.balance) || 0
      }
    });
  } catch (e) {
    console.error('Error en /api/auth/register:', e);
    return res.status(500).json({ error: 'No se pudo completar el registro.' });
  }
});

app.post('/api/auth/login', async function (req, res) {
  try {
    var rawUsername = String(req.body.username || '').trim().toLowerCase();
    var password = String(req.body.password || '');

    if (!rawUsername || !password) {
      return res.status(400).json({ error: 'Ingresa tu usuario y contraseña.' });
    }

    var user = await getUserByUsername(rawUsername);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    var valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    var token = signSessionToken(user);
    return res.json({
      token: token,
      user: {
        id: Number(user.telegram_id),
        username: user.username,
        name: user.first_name || user.username,
        balance: Number(user.balance) || 0
      }
    });
  } catch (e) {
    console.error('Error en /api/auth/login:', e);
    return res.status(500).json({ error: 'Error al iniciar sesión.' });
  }
});

// ---------- Autenticación híbrida (Token Web + Telegram) ----------
function requireTelegramUser(req, res, next) {
  var authHeader = req.headers.authorization || '';
  var bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  var token = (req.body && req.body.token) || (req.query && req.query.token) || bearerToken;

  if (token) {
    try {
      var decoded = jwt.verify(token, JWT_SECRET);
      req.tgUser = {
        id: Number(decoded.id),
        username: decoded.username,
        first_name: decoded.username,
        authType: 'web'
      };
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Tu sesión expiró. Vuelve a iniciar sesión.' });
    }
  }

  var initData = (req.body && req.body.initData) || (req.query && req.query.initData);
  if (initData && BOT_TOKEN) {
    var user = verifyInitData(initData, BOT_TOKEN);
    if (user) {
      req.tgUser = user;
      return next();
    }
  }

  return res.status(401).json({ error: 'Debes iniciar sesión para continuar.' });
}

function resolveStaffIdentity(secret, providedName) {
  if (!secret) return null;
  if (ADMIN_SECRET && secret === ADMIN_SECRET) {
    return {
      staffKey: 'admin',
      role: 'Dealer / Admin',
      defaultName: 'Admin',
      isAdmin: true
    };
  }
  if (STAFF_SECRET_1 && secret === STAFF_SECRET_1) {
    return {
      staffKey: 'staff_1',
      role: 'Colaborador 1',
      defaultName: providedName || 'Colaborador 1',
      isAdmin: false
    };
  }
  if (STAFF_SECRET_2 && secret === STAFF_SECRET_2) {
    return {
      staffKey: 'staff_2',
      role: 'Colaborador 2',
      defaultName: providedName || 'Colaborador 2',
      isAdmin: false
    };
  }
  return null;
}

function requireStaffOrAdmin(req, res, next) {
  var secret = (req.body && req.body.adminSecret) || req.query.adminSecret;
  var providedName = (req.body && req.body.staffName) ? String(req.body.staffName).trim() : '';
  var identity = resolveStaffIdentity(secret, providedName);
  if (!identity) {
    return res.status(401).json({ error: 'Clave de acceso incorrecta.' });
  }
  identity.staffName = providedName || identity.defaultName;
  req.staff = identity;
  next();
}

function requireOnlyAdmin(req, res, next) {
  if (!req.staff || !req.staff.isAdmin) {
    return res.status(403).json({ error: 'Solo el administrador principal puede realizar esta acción.' });
  }
  next();
}

// ---------- Perfil / saldo ----------
app.post('/api/me', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    res.json({
      id: u.telegram_id,
      username: u.username,
      name: u.first_name || u.username || ('Jugador ' + u.telegram_id),
      balance: u.balance
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Panel del dealer y colaboradores ----------
app.post('/api/admin/users', requireStaffOrAdmin, async function (req, res) {
  try {
    var users = await listUsers();
    var wallets = await getStaffWallets();
    var movements = await listStaffMovements(req.staff.isAdmin ? null : req.staff.staffKey, 50);

    var myWalletBalance = req.staff.isAdmin
      ? null
      : ((wallets[req.staff.staffKey] && wallets[req.staff.staffKey].balance) || 0);

    res.json({
      role: req.staff.role,
      isAdmin: req.staff.isAdmin,
      staffKey: req.staff.staffKey,
      staffBalance: myWalletBalance,
      wallets: req.staff.isAdmin ? wallets : null,
      users: users,
      movements: movements
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/staff-fund', requireStaffOrAdmin, requireOnlyAdmin, async function (req, res) {
  try {
    var staffKey = req.body.staffKey;
    var amount = parseInt(req.body.amount, 10);
    if (staffKey !== 'staff_1' && staffKey !== 'staff_2') {
      return res.status(400).json({ error: 'Colaborador inválido.' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Ingresa un monto mayor a 0 para recargar al colaborador.' });
    }

    var result = await adjustStaffWallet({
      staffKey: staffKey,
      staffName: staffKey === 'staff_1' ? 'Colaborador 1' : 'Colaborador 2',
      actionType: 'admin_fund',
      targetUserId: null,
      amount: amount,
      detail: 'Recarga de saldo operativo por ' + req.staff.staffName
    });

    res.json({ ok: true, balance: result.balance });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/recharge', requireStaffOrAdmin, async function (req, res) {
  var telegramId = parseInt(req.body.telegramId, 10);
  var amount = parseInt(req.body.amount, 10);
  if (!telegramId || !amount || amount === 0) {
    return res.status(400).json({ error: 'Faltan datos o monto inválido.' });
  }

  try {
    var isRecharge = amount > 0;
    var absAmount = Math.abs(amount);

    if (!req.staff.isAdmin && isRecharge) {
      var wallets = await getStaffWallets();
      var currentStaffBal = (wallets[req.staff.staffKey] && wallets[req.staff.staffKey].balance) || 0;
      if (currentStaffBal < absAmount) {
        return res.status(400).json({
          error: 'Saldo operativo insuficiente (' + currentStaffBal + '). Pide recarga al administrador.'
        });
      }
    }

    var detail = (isRecharge ? 'Recarga' : 'Pago/descuento') + ' por ' + req.staff.staffName;
    var newBalance = await applyDelta(telegramId, amount, isRecharge ? 'recarga' : 'retiro_pago', detail);

    if (!req.staff.isAdmin) {
      var staffDelta = isRecharge ? -absAmount : 0;
      await adjustStaffWallet({
        staffKey: req.staff.staffKey,
        staffName: req.staff.staffName,
        actionType: isRecharge ? 'recharge' : 'payout',
        targetUserId: telegramId,
        amount: staffDelta,
        detail: (isRecharge ? 'Recargó $' + absAmount : 'Pagó/descontó $' + absAmount) + ' a jugador #' + telegramId
      });
    } else {
      await logAdminMovement({
        staffKey: 'admin',
        staffName: req.staff.staffName,
        actionType: isRecharge ? 'recharge' : 'payout',
        targetUserId: telegramId,
        amount: amount,
        detail: detail + ' a jugador #' + telegramId
      });
    }

    res.json({ ok: true, balance: newBalance, by: req.staff.staffName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- BLACKJACK ----------
const suits = [{ s: '♠', red: false }, { s: '♣', red: false }, { s: '♥', red: true }, { s: '♦', red: true }];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const blackjackSessions = {};

function freshDeck() {
  var d = [];
  suits.forEach(function (su) {
    ranks.forEach(function (r) {
      d.push({ rank: r, suit: su.s, red: su.red });
    });
  });
  for (var k = d.length - 1; k > 0; k--) {
    var r = Math.floor(Math.random() * (k + 1));
    var t = d[k];
    d[k] = d[r];
    d[r] = t;
  }
  return d;
}
function cardValue(c) {
  if (c.rank === 'A') return 11;
  if (['J', 'Q', 'K'].indexOf(c.rank) !== -1) return 10;
  return parseInt(c.rank, 10);
}
function handTotal(h) {
  var total = 0, aces = 0;
  h.forEach(function (c) {
    total += cardValue(c);
    if (c.rank === 'A') aces++;
  });
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}
function isBlackjack(h) {
  return h.length === 2 && handTotal(h) === 21;
}

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

    var deck = freshDeck();
    var session = {
      deck: deck,
      playerHand: [deck.pop(), deck.pop()],
      dealerHand: [deck.pop(), deck.pop()],
      bet: bet
    };
    blackjackSessions[req.tgUser.id] = session;

    if (isBlackjack(session.playerHand)) {
      var dealerBJ = isBlackjack(session.dealerHand);
      var delta = dealerBJ ? 0 : Math.floor(bet * 1.5);
      var newBalance = u.balance;
      if (!dealerBJ) {
        newBalance = await applyDelta(req.tgUser.id, delta, 'blackjack', 'Blackjack — paga 3 a 2');
      }
      delete blackjackSessions[req.tgUser.id];
      return res.json({
        status: dealerBJ ? 'push' : 'blackjack',
        state: publicState(session, true),
        balance: newBalance,
        delta: delta
      });
    }

    res.json({ status: 'playing', state: publicState(session, false), balance: u.balance });
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
      return res.json({
        status: 'lose',
        state: publicState(session, true),
        balance: newBalance,
        delta: -session.bet
      });
    }

    var currentUser = await getUser(req.tgUser.id);
    res.json({ status: 'playing', state: publicState(session, false), balance: currentUser.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function dealerPlayAndResolve(telegramId, session) {
  var p = handTotal(session.playerHand);

  if (p > 21) {
    var newBalance = await applyDelta(telegramId, -session.bet, 'blackjack', 'Se pasó de 21');
    delete blackjackSessions[telegramId];
    return { status: 'lose', balance: newBalance, delta: -session.bet };
  }

  while (handTotal(session.dealerHand) < 17) session.dealerHand.push(session.deck.pop());
  var d = handTotal(session.dealerHand);
  var status, delta = 0;

  if (d > 21 || p > d) {
    status = 'win';
    delta = session.bet;
  } else if (p < d) {
    status = 'lose';
    delta = -session.bet;
  } else {
    status = 'push';
    delta = 0;
  }

  var newBalance = await applyDelta(telegramId, delta, 'blackjack', 'Resultado: ' + status);
  delete blackjackSessions[telegramId];
  return { status: status, balance: newBalance, delta: delta };
}

app.post('/api/blackjack/stand', requireTelegramUser, async function (req, res) {
  try {
    var session = blackjackSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una mano activa.' });
    var result = await dealerPlayAndResolve(req.tgUser.id, session);
    res.json({
      status: result.status,
      state: publicState(session, true),
      balance: result.balance,
      delta: result.delta
    });
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

    session.bet = session.bet * 2;
    session.playerHand.push(session.deck.pop());

    var total = handTotal(session.playerHand);
    if (total > 21) {
      var newBalance = await applyDelta(req.tgUser.id, -session.bet, 'blackjack', 'Doblar y se pasó de 21');
      delete blackjackSessions[req.tgUser.id];
      return res.json({
        status: 'lose',
        state: publicState(session, true),
        balance: newBalance,
        delta: -session.bet
      });
    }

    var result = await dealerPlayAndResolve(req.tgUser.id, session);
    res.json({
      status: result.status,
      state: publicState(session, true),
      balance: result.balance,
      delta: result.delta
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/blackjack/abandon', requireTelegramUser, async function (req, res) {
  try {
    var session = blackjackSessions[req.tgUser.id];
    if (!session) return res.json({ ok: true, active: false });

    var newBalance = await applyDelta(req.tgUser.id, -session.bet, 'blackjack', 'Abandonó la partida con mano activa');
    delete blackjackSessions[req.tgUser.id];

    res.json({ ok: true, active: true, balance: newBalance });
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

function colorOf(n) {
  if (n === 0) return 'green';
  return redNumbers.indexOf(n) !== -1 ? 'red' : 'black';
}
function spinWheel() {
  var r = Math.random() * totalWeight, acc = 0;
  for (var i = 0; i < order.length; i++) {
    acc += weights[i];
    if (r < acc) return order[i];
  }
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
    if (betType === 'numero' && (isNaN(number) || number < 0 || number > 36)) {
      return res.status(400).json({ error: 'Número inválido.' });
    }

    var winNumber = spinWheel();
    var c = colorOf(winNumber);
    var win = false, mult = 0;
    if (betType === 'rojo') { win = c === 'red'; mult = 2; }
    else if (betType === 'negro') { win = c === 'black'; mult = 2; }
    else if (betType === 'numero') { win = number === winNumber; mult = (number === 0) ? 10 : 5; }
    else return res.status(400).json({ error: 'Tipo de apuesta inválido.' });

    var delta = win ? amount * (mult - 1) : -amount;
    var newBalance = await applyDelta(req.tgUser.id, delta, 'ruleta', 'Salió ' + winNumber + ' (' + c + ')');

    res.json({ winNumber: winNumber, color: c, win: win, delta: delta, balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- VIDEO PÓKER (Jacks or Better) ----------
const activePokerGames = {};

app.post('/api/videopoker/deal', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    var betAmount = parseInt(req.body.bet, 10);

    if (!betAmount || betAmount <= 0) {
      return res.status(400).json({ error: 'Apuesta inválida.' });
    }
    if (betAmount > u.balance) {
      return res.status(400).json({ error: 'Saldo insuficiente.' });
    }

    var newBalance = await applyDelta(req.tgUser.id, -betAmount, 'videopoker', 'Apuesta Video Póker');

    var deck = pokerLogic.freshDeck();
    var hand = deck.splice(0, 5);

    activePokerGames[req.tgUser.id] = {
      deck: deck,
      hand: hand,
      bet: betAmount
    };

    res.json({
      hand: hand,
      balance: newBalance
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/videopoker/draw', requireTelegramUser, async function (req, res) {
  try {
    var session = activePokerGames[req.tgUser.id];
    if (!session) {
      return res.status(400).json({ error: 'No hay una partida de póker activa.' });
    }

    var hand = session.hand;
    var deck = session.deck;
    var holds = req.body.holds || [false, false, false, false, false];

    for (let i = 0; i < 5; i++) {
      if (!holds[i]) {
        if (deck.length > 0) {
          hand[i] = deck.pop();
        }
      }
    }

    var resultType = pokerLogic.evalHand(hand);
    var multiplier = pokerLogic.PAY_TABLE[resultType] || 0;
    var winnings = session.bet * multiplier;
    var delta = winnings - session.bet;

    var finalBalance;
    if (delta !== 0) {
      finalBalance = await applyDelta(req.tgUser.id, delta, 'videopoker', 'Premio Video Póker (' + resultType + ')');
    } else {
      finalBalance = (await getUser(req.tgUser.id)).balance;
    }

    delete activePokerGames[req.tgUser.id];

    res.json({
      hand: hand,
      result: resultType,
      mult: multiplier,
      delta: delta,
      balance: finalBalance
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- MINAS ----------
const minasSessions = {};

app.post('/api/minas/state', requireTelegramUser, async function (req, res) {
  try {
    var session = minasSessions[req.tgUser.id];
    if (!session) return res.json({ active: false });
    res.json(Object.assign({ active: true }, session.publicState()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/minas/start', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    var bet = parseInt(req.body.bet, 10);
    var minesCount = parseInt(req.body.mines, 10);

    if (!bet || bet <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
    if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });
    if (minasLogic.ALLOWED_MINES.indexOf(minesCount) === -1) {
      return res.status(400).json({ error: 'Cantidad de minas inválida.' });
    }

    var newBalance = await applyDelta(req.tgUser.id, -bet, 'minas', 'Apuesta inicial de Minas');

    var bombs = minasLogic.pickBombs(minesCount);
    var session = {
      bet: bet,
      minesCount: minesCount,
      bombs: bombs,
      revealed: [],
      mult: 1,
      publicState: function () {
        return { revealed: this.revealed, mult: this.mult, bet: this.bet, minesCount: this.minesCount };
      }
    };
    minasSessions[req.tgUser.id] = session;

    res.json(Object.assign(session.publicState(), { balance: newBalance }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/minas/reveal', requireTelegramUser, async function (req, res) {
  try {
    var session = minasSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una partida activa.' });
    var index = parseInt(req.body.index, 10);
    if (isNaN(index) || index < 0 || index >= minasLogic.N) return res.status(400).json({ error: 'Casilla inválida.' });
    if (session.revealed.indexOf(index) !== -1) return res.status(400).json({ error: 'Casilla ya destapada.' });

    if (session.bombs.indexOf(index) !== -1) {
      var bombs = session.bombs;
      delete minasSessions[req.tgUser.id];
      var u = await getUser(req.tgUser.id);
      return res.json({ status: 'lose', bombs: bombs, balance: u.balance });
    }

    session.revealed.push(index);
    var k = session.revealed.length;
    session.mult = minasLogic.multiplier(k, session.minesCount);

    if (k === minasLogic.N - session.minesCount) {
      var payout = Math.floor(session.bet * session.mult);
      var newBalance = await applyDelta(req.tgUser.id, payout, 'minas', 'Tablero limpiado en Minas');
      var bombs = session.bombs;
      delete minasSessions[req.tgUser.id];
      return res.json({ status: 'clear', mult: session.mult, payout: payout, bombs: bombs, balance: newBalance });
    }

    var u = await getUser(req.tgUser.id);
    res.json({ status: 'playing', mult: session.mult, balance: u.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/minas/cashout', requireTelegramUser, async function (req, res) {
  try {
    var session = minasSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una partida activa.' });
    if (session.revealed.length === 0) return res.status(400).json({ error: 'Debes destapar al menos una casilla.' });

    var payout = Math.floor(session.bet * session.mult);
    var newBalance = await applyDelta(req.tgUser.id, payout, 'minas', 'Cobro exitoso en Minas (x' + session.mult.toFixed(2) + ')');
    var bombs = session.bombs;
    delete minasSessions[req.tgUser.id];

    res.json({ mult: session.mult, payout: payout, bombs: bombs, balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- HI-LO ----------
const hiloSessions = {};

app.post('/api/hilo/state', requireTelegramUser, async function (req, res) {
  try {
    var session = hiloSessions[req.tgUser.id];
    if (!session) return res.json({ active: false });
    res.json(Object.assign({ active: true }, session.publicState()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/hilo/start', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    var bet = parseInt(req.body.bet, 10);
    if (!bet || bet <= 0) return res.status(400).json({ error: 'Apuesta inválida.' });
    if (bet > u.balance) return res.status(400).json({ error: 'Saldo insuficiente.' });

    // Se descuenta la apuesta al instante de iniciar la ronda para evitar escapes al salir
    var newBalance = await applyDelta(req.tgUser.id, -bet, 'hilo', 'Apuesta inicial Hi-Lo');
    var deck = hiloLogic.freshDeck();
    var current = deck.pop();

    var session = {
      bet: bet,
      betDeducted: true,
      deck: deck,
      current: current,
      rounds: 0,
      pCum: 1,
      publicState: function () {
        var pHigh = hiloLogic.probGuess(this.deck, this.current.val, 'higher');
        var pLow = hiloLogic.probGuess(this.deck, this.current.val, 'lower');
        var pEqual = hiloLogic.probGuess(this.deck, this.current.val, 'equal');

        var multH = pHigh > 0 ? hiloLogic.TARGET_RTP / (this.pCum * pHigh) : null;
        var multL = pLow > 0 ? hiloLogic.TARGET_RTP / (this.pCum * pLow) : null;
        var multE = pEqual > 0 ? hiloLogic.TARGET_RTP / (this.pCum * pEqual) : null;

        var cashoutMult = this.rounds > 0 ? (this.pCum > 0 ? hiloLogic.TARGET_RTP / this.pCum : 1) : 0;
        return {
          current: this.current,
          rounds: this.rounds,
          higherGain: multH ? Math.floor(this.bet * multH) - this.bet : null,
          lowerGain: multL ? Math.floor(this.bet * multL) - this.bet : null,
          equalGain: multE ? Math.floor(this.bet * multE) - this.bet : null,
          cashoutGain: Math.floor(this.bet * cashoutMult)
        };
      }
    };
    hiloSessions[req.tgUser.id] = session;

    res.json(Object.assign({ balance: newBalance }, session.publicState()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/hilo/guess', requireTelegramUser, async function (req, res) {
  try {
    var session = hiloSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una partida de Hi-Lo activa.' });
    var guess = req.body.guess;
    if (guess !== 'higher' && guess !== 'lower' && guess !== 'equal') {
      return res.status(400).json({ error: 'Adivinanza inválida.' });
    }

    if (session.deck.length === 0) {
      delete hiloSessions[req.tgUser.id];
      return res.status(400).json({ error: 'El mazo se ha agotado.' });
    }

    var pRound = hiloLogic.probGuess(session.deck, session.current.val, guess);
    if (pRound <= 0) return res.status(400).json({ error: 'Apuesta imposible con la carta actual.' });

    var nextIndex = Math.floor(Math.random() * session.deck.length);
    var nextCard = session.deck.splice(nextIndex, 1)[0];

    var isWin = false;
    if (guess === 'higher') isWin = nextCard.val > session.current.val;
    else if (guess === 'lower') isWin = nextCard.val < session.current.val;
    else if (guess === 'equal') isWin = nextCard.val === session.current.val;

    if (!isWin) {
      delete hiloSessions[req.tgUser.id];
      var u = await getUser(req.tgUser.id);
      return res.json({ status: 'lose', nextCard: nextCard, balance: u.balance });
    }

    session.rounds++;
    session.pCum *= pRound;
    session.current = nextCard;

    if (session.deck.length === 0) {
      var mult = hiloLogic.TARGET_RTP / session.pCum;
      var payout = Math.floor(session.bet * mult);
      var newBalance = await applyDelta(req.tgUser.id, payout, 'hilo', 'Mazo terminado en Hi-Lo');
      delete hiloSessions[req.tgUser.id];
      return res.json({ status: 'autocash', nextCard: nextCard, balance: newBalance, payout: payout });
    }

    var u = await getUser(req.tgUser.id);
    res.json(Object.assign({ status: 'win', nextCard: nextCard, balance: u.balance }, session.publicState()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/hilo/cashout', requireTelegramUser, async function (req, res) {
  try {
    var session = hiloSessions[req.tgUser.id];
    if (!session) return res.status(400).json({ error: 'No hay una partida de Hi-Lo activa.' });
    if (session.rounds === 0) return res.status(400).json({ error: 'Debes acertar al menos una vez para cobrar.' });

    var mult = hiloLogic.TARGET_RTP / session.pCum;
    var payout = Math.floor(session.bet * mult);
    var newBalance = await applyDelta(req.tgUser.id, payout, 'hilo', 'Cobro exitoso en Hi-Lo');
    delete hiloSessions[req.tgUser.id];

    res.json({ payout: payout, balance: newBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/hilo/abandon', requireTelegramUser, async function (req, res) {
  try {
    var session = hiloSessions[req.tgUser.id];
    if (!session) return res.json({ ok: true, active: false });

    // Si por algún motivo no se había descontado al iniciar, se descuenta aquí; si ya se descontó, solo se cierra
    var u = await getUser(req.tgUser.id);
    var balance = u ? u.balance : 0;
    if (!session.betDeducted && session.bet > 0) {
      balance = await applyDelta(req.tgUser.id, -session.bet, 'hilo', 'Abandonó partida activa de Hi-Lo');
    }
    delete hiloSessions[req.tgUser.id];
    res.json({ ok: true, active: true, balance: balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- CARRERAS DE CABALLOS ----------
app.post('/api/carreras/state', requireTelegramUser, async function (req, res) {
  try {
    await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    var state = await carreras.getState(req.tgUser.id);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/carreras/bet', requireTelegramUser, async function (req, res) {
  try {
    var u = await getOrCreateUser(req.tgUser.id, req.tgUser.username, req.tgUser.first_name);
    var name = u.first_name || u.username || ('Jugador ' + u.telegram_id);
    var r = await carreras.placeBet(
      req.tgUser.id,
      name,
      parseInt(req.body.horse, 10),
      parseInt(req.body.amount, 10)
    );
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

carreras.start();

// ---------- GESTIÓN DE WEBSOCKETS (PÓKER MULTIJUGADOR) ----------
const multiplayerPokerRooms = {};

function broadcastRoomState(roomId) {
  var room = multiplayerPokerRooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room_state', {
    roomId: roomId,
    players: room.players,
    communityCards: room.communityCards,
    pot: room.pot,
    currentTurnIndex: room.currentTurnIndex,
    status: room.status,
    dealerMessage: room.dealerMessage
  });
}

function triggerShowdown(room, activePlayers) {
  var bestScore = -1;
  var winners = [];

  activePlayers.forEach(function (p) {
    var combined = p.cards.concat(room.communityCards);
    var evalRes = pokerLogic.evalHand ? pokerLogic.evalHand(combined) : 'Carta alta';
    var score = pokerLogic.PAY_TABLE && pokerLogic.PAY_TABLE[evalRes] ? pokerLogic.PAY_TABLE[evalRes] : 1;
    p.lastHandEvaluation = evalRes;
    if (score > bestScore) {
      bestScore = score;
      winners = [p];
    } else if (score === bestScore) {
      winners.push(p);
    }
  });

  if (winners.length > 0 && room.pot > 0) {
    var share = Math.floor(room.pot / winners.length);
    winners.forEach(function (w) {
      w.chips += share;
    });
    room.dealerMessage =
      '🏆 Ganador(es): ' +
      winners.map(function (w) { return w.name + ' (' + (w.lastHandEvaluation || 'Mano') + ')'; }).join(', ') +
      ' — Pozo: $' +
      room.pot;
  } else {
    room.dealerMessage = 'Mano finalizada.';
  }

  room.status = 'finished';
  room.pot = 0;
}

io.on('connection', function (socket) {
  console.log('Cliente conectado por WebSockets:', socket.id);

  socket.on('join_multiplayer_table', async function (data) {
    var roomId = (data && data.roomId) || 'mesa_poker_1';
    socket.join(roomId);

    if (!multiplayerPokerRooms[roomId]) {
      multiplayerPokerRooms[roomId] = {
        players: [],
        deck: [],
        communityCards: [],
        pot: 0,
        currentTurnIndex: 0,
        status: 'waiting',
        dealerMessage: 'Esperando jugadores...'
      };
    }

    var room = multiplayerPokerRooms[roomId];
    var existingPlayer = room.players.find(function (p) { return p.id === socket.id; });

    if (!existingPlayer) {
      var tgId = data && data.telegramId ? parseInt(data.telegramId, 10) : null;
      var userRecord = null;

      try {
        if (tgId) {
          userRecord = await getUser(tgId);
        }
      } catch (err) {
        console.error('Error buscando usuario para póker:', err);
      }

      var initialChips = userRecord ? userRecord.balance : ((data && data.chips) || 1000);
      var realTelegramId = userRecord ? userRecord.telegram_id : tgId;

      room.players.push({
        id: socket.id,
        telegramId: realTelegramId,
        name: (data && data.name) || (userRecord ? userRecord.first_name : 'Jugador'),
        chips: initialChips,
        initialHandChips: initialChips,
        currentBet: 0,
        hasActed: false,
        cards: [],
        folded: false
      });
    }

    broadcastRoomState(roomId);
  });

  socket.on('leave_multiplayer_table', async function (data) {
    var roomId = (data && data.roomId) || 'mesa_poker_1';
    var room = multiplayerPokerRooms[roomId];
    if (!room) return;

    var leavingPlayerIndex = room.players.findIndex(function (p) { return p.id === socket.id; });
    if (leavingPlayerIndex !== -1) {
      var leavingPlayer = room.players[leavingPlayerIndex];

      if (typeof leavingPlayer.telegramId === 'number') {
        var diff = leavingPlayer.chips - leavingPlayer.initialHandChips;
        if (diff !== 0) {
          try {
            await applyDelta(leavingPlayer.telegramId, diff, 'poker', 'Retiro definitivo de mesa de póker');
          } catch (e) {
            console.error('Error al guardar saldo al salir de la mesa:', e);
          }
        }
      }

      room.players.splice(leavingPlayerIndex, 1);
      if (room.players.length < 2) room.status = 'waiting';

      broadcastRoomState(roomId);
    }
    socket.leave(roomId);
  });

  socket.on('start_hand', function (data) {
    var roomId = (data && data.roomId) || 'mesa_poker_1';
    var room = multiplayerPokerRooms[roomId];
    if (!room || room.players.length < 2) return;

    if (room.status === 'betting') {
      socket.emit('error_message', 'No se puede iniciar una nueva mano mientras la partida actual está en curso.');
      return;
    }

    room.deck = pokerLogic.freshDeck();
    room.pot = 0;
    room.communityCards = room.deck.splice(0, 5);
    room.status = 'betting';
    room.currentTurnIndex = 0;

    room.players.forEach(function (p) {
      p.cards = [room.deck.pop(), room.deck.pop()];
      p.currentBet = 0;
      p.hasActed = false;
      p.folded = false;
      p.lastHandEvaluation = null;
    });

    room.dealerMessage = '¡Mano iniciada! Turno de ' + room.players[0].name;
    broadcastRoomState(roomId);
  });

  socket.on('player_action', function (data) {
    var roomId = (data && data.roomId) || 'mesa_poker_1';
    var room = multiplayerPokerRooms[roomId];
    if (!room || room.status !== 'betting') return;

    var currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;

    var action = data.action;
    var amount = parseInt(data.amount, 10) || 0;

    if (action === 'bet') {
      var maxCurrentBet = 0;
      room.players.forEach(function (p) {
        if (p.currentBet > maxCurrentBet) maxCurrentBet = p.currentBet;
      });

      var neededToCall = maxCurrentBet - currentPlayer.currentBet;
      var raiseAmount = amount > 0 ? amount : 0;

      var totalInvestment = neededToCall;
      if (neededToCall === 0) {
        totalInvestment = raiseAmount > 0 ? raiseAmount : 50;
      } else if (raiseAmount > 0 && raiseAmount !== neededToCall) {
        totalInvestment = neededToCall + raiseAmount;
      }

      if (totalInvestment > currentPlayer.chips) {
        totalInvestment = currentPlayer.chips;
      }

      currentPlayer.chips -= totalInvestment;
      currentPlayer.currentBet += totalInvestment;
      room.pot += totalInvestment;
      currentPlayer.hasActed = true;

      if (currentPlayer.currentBet > maxCurrentBet) {
        room.players.forEach(function (p) {
          if (p.id !== currentPlayer.id && !p.folded) {
            p.hasActed = false;
          }
        });
        room.dealerMessage = currentPlayer.name + ' subió la apuesta a $' + currentPlayer.currentBet;
      } else {
        room.dealerMessage = currentPlayer.name + ' igualó la apuesta ($' + totalInvestment + ')';
      }
    } else if (action === 'check') {
      var maxCurrentBet = 0;
      room.players.forEach(function (p) {
        if (p.currentBet > maxCurrentBet) maxCurrentBet = p.currentBet;
      });

      if (maxCurrentBet > currentPlayer.currentBet) {
        var neededToCall = maxCurrentBet - currentPlayer.currentBet;
        if (neededToCall > currentPlayer.chips) neededToCall = currentPlayer.chips;

        currentPlayer.chips -= neededToCall;
        currentPlayer.currentBet += neededToCall;
        room.pot += neededToCall;
        room.dealerMessage = currentPlayer.name + ' igualó por valor de $' + neededToCall;
      } else {
        room.dealerMessage = currentPlayer.name + ' pasó (Check).';
      }
      currentPlayer.hasActed = true;
    } else if (action === 'fold') {
      currentPlayer.folded = true;
      currentPlayer.hasActed = true;
      room.dealerMessage = currentPlayer.name + ' se retiró.';
    }

    var activePlayers = room.players.filter(function (p) { return !p.folded; });

    if (activePlayers.length === 1) {
      activePlayers[0].chips += room.pot;
      room.dealerMessage = '🏆 ¡' + activePlayers[0].name + ' gana el pozo de $' + room.pot + ' por retirada!';
      room.status = 'finished';
      room.pot = 0;

      sincronizarSaldosBD(room);
      broadcastRoomState(roomId);
      return;
    }

    var currentMaxBet = 0;
    activePlayers.forEach(function (p) {
      if (p.currentBet > currentMaxBet) currentMaxBet = p.currentBet;
    });

    var allActed = activePlayers.every(function (p) { return p.hasActed; });
    var allBetsEqual = activePlayers.every(function (p) { return p.currentBet === currentMaxBet; });

    if (allActed && allBetsEqual) {
      triggerShowdown(room, activePlayers);
      sincronizarSaldosBD(room);
      broadcastRoomState(roomId);
      return;
    }

    var turnsChecked = 0;
    do {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      turnsChecked++;
    } while (room.players[room.currentTurnIndex].folded && turnsChecked < room.players.length);

    broadcastRoomState(roomId);
  });

  socket.on('disconnect', async function () {
    console.log('Cliente desconectado de WebSockets:', socket.id);
    for (var roomId in multiplayerPokerRooms) {
      var room = multiplayerPokerRooms[roomId];
      var initialLength = room.players.length;

      var leavingPlayer = room.players.find(function (p) { return p.id === socket.id; });
      if (leavingPlayer && typeof leavingPlayer.telegramId === 'number') {
        var diff = leavingPlayer.chips - leavingPlayer.initialHandChips;
        if (diff !== 0) {
          try {
            await applyDelta(leavingPlayer.telegramId, diff, 'poker', 'Retiro de mesa multijugador');
          } catch (e) {
            console.error('Error al guardar saldo al desconectar:', e);
          }
        }
      }

      room.players = room.players.filter(function (p) { return p.id !== socket.id; });

      if (room.players.length !== initialLength) {
        if (room.players.length < 2) room.status = 'waiting';
        broadcastRoomState(roomId);
      }
    }
  });
});

async function sincronizarSaldosBD(room) {
  for (var i = 0; i < room.players.length; i++) {
    var p = room.players[i];
    if (typeof p.telegramId === 'number') {
      var diferencia = p.chips - p.initialHandChips;
      if (diferencia !== 0) {
        try {
          await applyDelta(p.telegramId, diferencia, 'poker', 'Resultado de mano de póker multijugador');
        } catch (err) {
          console.error('Error aplicando delta en póker para usuario ' + p.telegramId + ':', err);
        }
      }
      p.initialHandChips = p.chips;
    }
  }
}

server.listen(PORT, function () {
  console.log('Casino por pinche gusto corriendo en el puerto ' + PORT);
});
