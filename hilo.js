const TARGET_RTP = 0.97; // 97% RTP para el jugador (3% de ventaja para la casa)

const suits = [
  { s: '♠', red: false },
  { s: '♣', red: false },
  { s: '♥', red: true },
  { s: '♦', red: true }
];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function freshDeck() {
  var d = [];
  suits.forEach(function (su) {
    ranks.forEach(function (r, idx) {
      d.push({ rank: r, suit: su.s, red: su.red, val: idx + 2 });
    });
  });
  for (var k = d.length - 1; k > 0; k--) {
    var r = Math.floor(Math.random() * (k + 1));
    var t = d[k]; d[k] = d[r]; d[r] = t;
  }
  return d;
}

// Calcula la probabilidad para 'higher', 'lower' o 'equal'
function probGuess(deck, currentVal, guess) {
  var total = deck.length;
  if (total === 0) return 0;
  var favorable = 0;
  deck.forEach(function (c) {
    if (guess === 'higher' && c.val > currentVal) favorable++;
    if (guess === 'lower' && c.val < currentVal) favorable++;
    if (guess === 'equal' && c.val === currentVal) favorable++;
  });
  return favorable / total;
}

module.exports = {
  TARGET_RTP: TARGET_RTP,
  freshDeck: freshDeck,
  probGuess: probGuess
};
