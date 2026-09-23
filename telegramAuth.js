const crypto = require('crypto');

// Verifica que el initData realmente viene de Telegram y no fue falsificado.
// Documentación: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, botToken) {
  if (!initData) return null;
  var params = new URLSearchParams(initData);
  var hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  var pairs = [];
  params.forEach(function (value, key) { pairs.push(key + '=' + value); });
  pairs.sort();
  var dataCheckString = pairs.join('\n');

  var secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  var computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  var authDate = parseInt(params.get('auth_date'), 10);
  var now = Math.floor(Date.now() / 1000);
  // Rechaza sesiones con más de 24 horas de antigüedad
  if (now - authDate > 86400) return null;

  var userRaw = params.get('user');
  if (!userRaw) return null;
  var user = JSON.parse(userRaw);
  return user; // { id, first_name, username, ... }
}

module.exports = { verifyInitData };
