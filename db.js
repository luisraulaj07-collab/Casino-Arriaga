const { createClient } = require("@libsql/client");

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:local.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Inicializar tablas en la nube
async function initDb() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        password_hash TEXT,
        email TEXT,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Migraciones seguras para bases ya creadas en Turso
    try {
      await db.execute(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
    } catch (e) {}
    try {
      await db.execute(`ALTER TABLE users ADD COLUMN email TEXT`);
    } catch (e) {}

    // Evita nombres de usuario duplicados en registros web (ignora nulos)
    try {
      await db.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
        ON users (LOWER(username))
        WHERE username IS NOT NULL
      `);
    } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        game TEXT NOT NULL,
        detail TEXT,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

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
      );
    `);

    // Saldo operativo propio de cada colaborador
    await db.execute(`
      CREATE TABLE IF NOT EXISTS staff_wallets (
        staff_key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await db.execute(`
      INSERT OR IGNORE INTO staff_wallets (staff_key, label, balance)
      VALUES ('staff_1', 'Colaborador 1', 0), ('staff_2', 'Colaborador 2', 0)
    `);

    // Historial de movimientos de colaboradores y recargas del admin
    await db.execute(`
      CREATE TABLE IF NOT EXISTS staff_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_key TEXT NOT NULL,
        staff_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_user_id INTEGER,
        amount INTEGER NOT NULL,
        balance_after INTEGER,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    console.log("Tablas inicializadas correctamente en Turso.");
  } catch (error) {
    console.error("Error al inicializar la base de datos:", error);
  }
}

initDb();

async function getOrCreateUser(telegramId, username, firstName) {
  const res = await db.execute({
    sql: "SELECT * FROM users WHERE telegram_id = ?",
    args: [telegramId],
  });
  let row = res.rows[0];

  if (!row) {
    await db.execute({
      sql: "INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, 0)",
      args: [telegramId, username || null, firstName || null],
    });
    const resNew = await db.execute({
      sql: "SELECT * FROM users WHERE telegram_id = ?",
      args: [telegramId],
    });
    row = resNew.rows[0];
  } else {
    await db.execute({
      sql: "UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?",
      args: [username || row.username, firstName || row.first_name, telegramId],
    });
    const resUpdated = await db.execute({
      sql: "SELECT * FROM users WHERE telegram_id = ?",
      args: [telegramId],
    });
    row = resUpdated.rows[0] || row;
  }
  return row;
}

async function getUser(telegramId) {
  const res = await db.execute({
    sql: "SELECT * FROM users WHERE telegram_id = ?",
    args: [telegramId],
  });
  return res.rows[0];
}

async function getUserByUsername(username) {
  const clean = String(username || "").trim().toLowerCase();
  if (!clean) return null;
  const res = await db.execute({
    sql: "SELECT * FROM users WHERE LOWER(username) = ? LIMIT 1",
    args: [clean],
  });
  return res.rows[0] || null;
}

async function createWebUser({ username, passwordHash, email, firstName }) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  const displayName = (firstName || cleanUsername).trim();

  // ID entero positivo único para mantener compatibilidad total con telegram_id en todo el sistema
  let userId = Date.now() * 100 + Math.floor(Math.random() * 100);
  while (await getUser(userId)) {
    userId = Date.now() * 100 + Math.floor(Math.random() * 100);
  }

  await db.execute({
    sql: `
      INSERT INTO users (telegram_id, username, first_name, password_hash, email, balance)
      VALUES (?, ?, ?, ?, ?, 0)
    `,
    args: [userId, cleanUsername, displayName, passwordHash, cleanEmail],
  });

  return await getUser(userId);
}

async function listUsers() {
  const res = await db.execute(
    "SELECT telegram_id, username, first_name, email, balance, created_at FROM users ORDER BY first_name"
  );
  return res.rows;
}

async function applyDelta(telegramId, delta, game, detail) {
  const userRes = await db.execute({
    sql: "SELECT * FROM users WHERE telegram_id = ?",
    args: [telegramId],
  });
  const user = userRes.rows[0];
  if (!user) throw new Error("Usuario no existe");

  const currentBalance = Number(user.balance) || 0;
  const numericDelta = Number(delta) || 0;
  const newBalance = currentBalance + numericDelta;

  if (newBalance < 0) throw new Error("Saldo insuficiente");

  await db.execute({
    sql: "UPDATE users SET balance = ? WHERE telegram_id = ?",
    args: [newBalance, telegramId],
  });

  await db.execute({
    sql: "INSERT INTO movements (telegram_id, game, detail, delta, balance_after) VALUES (?, ?, ?, ?, ?)",
    args: [telegramId, game, detail || "", numericDelta, newBalance],
  });

  return newBalance;
}

async function getStaffWallets() {
  await db.execute(`
    INSERT OR IGNORE INTO staff_wallets (staff_key, label, balance)
    VALUES ('staff_1', 'Colaborador 1', 0), ('staff_2', 'Colaborador 2', 0)
  `);
  const res = await db.execute("SELECT staff_key, label, balance, updated_at FROM staff_wallets");
  const wallets = {};
  res.rows.forEach((row) => {
    wallets[row.staff_key] = {
      staff_key: row.staff_key,
      label: row.label,
      balance: Number(row.balance) || 0,
      updated_at: row.updated_at,
    };
  });
  return wallets;
}

async function adjustStaffWallet({ staffKey, staffName, actionType, targetUserId, amount, detail }) {
  const wallets = await getStaffWallets();
  const wallet = wallets[staffKey];
  if (!wallet) throw new Error("Colaborador no encontrado");

  const currentBalance = Number(wallet.balance) || 0;
  const numericAmount = Number(amount) || 0;
  const nextBalance = currentBalance + numericAmount;

  if (nextBalance < 0) {
    throw new Error("Saldo operativo insuficiente en el colaborador");
  }

  await db.execute({
    sql: "UPDATE staff_wallets SET balance = ?, updated_at = datetime('now') WHERE staff_key = ?",
    args: [nextBalance, staffKey],
  });

  await db.execute({
    sql: `
      INSERT INTO staff_movements (staff_key, staff_name, action_type, target_user_id, amount, balance_after, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      staffKey,
      staffName || wallet.label,
      actionType || "ajuste",
      targetUserId || null,
      numericAmount,
      nextBalance,
      detail || "",
    ],
  });

  return { balance: nextBalance };
}

async function logAdminMovement({ staffKey, staffName, actionType, targetUserId, amount, detail }) {
  await db.execute({
    sql: `
      INSERT INTO staff_movements (staff_key, staff_name, action_type, target_user_id, amount, balance_after, detail)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `,
    args: [
      staffKey || "admin",
      staffName || "Admin",
      actionType || "ajuste",
      targetUserId || null,
      Number(amount) || 0,
      detail || "",
    ],
  });
}

async function listStaffMovements(staffKey, limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  if (staffKey) {
    const res = await db.execute({
      sql: `
        SELECT id, staff_key, staff_name, action_type, target_user_id, amount, balance_after, detail, created_at
        FROM staff_movements
        WHERE staff_key = ?
        ORDER BY id DESC
        LIMIT ?
      `,
      args: [staffKey, safeLimit],
    });
    return res.rows;
  }

  const res = await db.execute({
    sql: `
      SELECT id, staff_key, staff_name, action_type, target_user_id, amount, balance_after, detail, created_at
      FROM staff_movements
      ORDER BY id DESC
      LIMIT ?
    `,
    args: [safeLimit],
  });
  return res.rows;
}

module.exports = {
  getOrCreateUser,
  getUser,
  getUserByUsername,
  createWebUser,
  listUsers,
  applyDelta,
  getStaffWallets,
  adjustStaffWallet,
  logAdminMovement,
  listStaffMovements,
  db,
};
