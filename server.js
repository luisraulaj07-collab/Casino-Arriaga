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
  return
