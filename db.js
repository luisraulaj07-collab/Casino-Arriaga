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
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

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
    console.log("Tablas inicializadas correctamente en Turso.");
  } catch (error) {
    console.error("Error al inicializar la base de datos:", error);
  }
}

initDb();

async function getOrCreateUser(telegramId, username, firstName) {
  const res = await db.execute({
    sql: 'SELECT * FROM users WHERE telegram_id = ?',
    args: [telegramId]
  });
  let row = res.rows[0];

  if (!row) {
    await db.execute({
      sql: 'INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, 0)',
      args: [telegramId, username || null, firstName || null]
    });
    const resNew = await db.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [telegramId]
    });
    row = resNew.rows[0];
  } else {
    await db.execute({
      sql: 'UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?',
      args: [username || row.username, firstName || row.first_name, telegramId]
    });
  }
  return row;
}

async function getUser(telegramId) {
  const res = await db.execute({
    sql: 'SELECT * FROM users WHERE telegram_id = ?',
    args: [telegramId]
  });
  return res.rows[0];
}

async function listUsers() {
  const res = await db.execute('SELECT telegram_id, username, first_name, balance FROM users ORDER BY first_name');
  return res.rows;
}

async function applyDelta(telegramId, delta, game, detail) {
  const userRes = await db.execute({
    sql: 'SELECT * FROM users WHERE telegram_id = ?',
    args: [telegramId]
  });
  const user = userRes.rows[0];
  if (!user) throw new Error('Usuario no existe');

  const newBalance = user.balance + delta;
  if (newBalance < 0) throw new Error('Saldo insuficiente');

  // Ejecutamos las operaciones de actualización y registro de movimiento
  await db.execute({
    sql: 'UPDATE users SET balance = ? WHERE telegram_id = ?',
    args: [newBalance, telegramId]
  });

  await db.execute({
    sql: 'INSERT INTO movements (telegram_id, game, detail, delta, balance_after) VALUES (?, ?, ?, ?, ?)',
    args: [telegramId, game, detail || '', delta, newBalance]
  });

  return newBalance;
}

module.exports = { getOrCreateUser, getUser, listUsers, applyDelta, db };
