const Database = require('better-sqlite3');
const db = new Database('casino.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

function getOrCreateUser(telegramId, username, firstName) {
  var row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!row) {
    db.prepare('INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, 0)')
      .run(telegramId, username || null, firstName || null);
    row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  } else {
    // mantener username/nombre actualizados por si cambian en Telegram
    db.prepare('UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?')
      .run(username || row.username, firstName || row.first_name, telegramId);
  }
  return row;
}

function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

function listUsers() {
  return db.prepare('SELECT telegram_id, username, first_name, balance FROM users ORDER BY first_name').all();
}

function applyDelta(telegramId, delta, game, detail) {
  var tx = db.transaction(function () {
    var user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (!user) throw new Error('Usuario no existe');
    var newBalance = user.balance + delta;
    if (newBalance < 0) throw new Error('Saldo insuficiente');
    db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(newBalance, telegramId);
    db.prepare('INSERT INTO movements (telegram_id, game, detail, delta, balance_after) VALUES (?, ?, ?, ?, ?)')
      .run(telegramId, game, detail || '', delta, newBalance);
    return newBalance;
  });
  return tx();
}

module.exports = { getOrCreateUser, getUser, listUsers, applyDelta, db };
