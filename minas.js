// Lógica de Minas. Las minas viven SOLO en el servidor: el navegador nunca sabe dónde están.
const N = 25;                       // casillas (5x5)
const RTP = 0.90;                   // 10% de ventaja para la casa
const ALLOWED_MINES = [1, 3, 5, 10, 15];

// Multiplicador tras k casillas seguras = RTP / probabilidad de llegar vivo hasta ahí.
function multiplier(k, mines) {
  if (k === 0) return 1;
  var p = 1;
  for (var i = 0; i < k; i++) p *= (N - mines - i) / (N - i);
  return RTP / p;
}

function pickBombs(mines) {
  var bombs = [];
  while (bombs.length < mines) {
    var r = Math.floor(Math.random() * N);
    if (bombs.indexOf(r) === -1) bombs.push(r);
  }
  return bombs;
}

module.exports = { N, ALLOWED_MINES, multiplier, pickBombs };
