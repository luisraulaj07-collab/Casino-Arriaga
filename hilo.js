// Lógica de Hi-Lo. El mazo vive solo en el servidor: el navegador nunca sabe
// qué carta sigue hasta que la pide.
const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = {};
RANK_ORDER.forEach(function (r, i) { RANK_VAL[r] = i + 2; });
const SUITS = ['♠', '♥', '♦', '♣'];
const TARGET_RTP = 0.90; // 10% de ventaja para la casa

function freshDeck() {
  var d = [];
  SUITS.forEach(function (s) { RANK_ORDER.forEach(function (r) { d.push({ rank: r, suit: s, val: RANK_VAL[r] }); }); });
  for (var k = d.length - 1; k > 0; k--) {
    var j = Math.floor(Math.random() * (k + 1));
    var t = d[k]; d[k] = d[j]; d[j] = t;
  }
  return d;
}

function probGuess(deck, currentVal, guess) {
  var higher = 0, lower = 0;
  deck.forEach(function (c) { if (c.val > currentVal) higher++; else if (c.val < currentVal) lower++; });
  var favorable = guess === 'higher' ? higher : lower;
  return deck.length > 0 ? favorable / deck.length : 0;
}

// Multiplicador si esta ronda es la que se juega ahora mismo, dado lo que ya
// se acumuló (pCum = probabilidad conjunta de toda la racha hasta aquí).
function multIfWin(deck, currentVal, guess, pCum) {
  var pRound = probGuess(deck, currentVal, guess);
  if (pRound <= 0) return 0;
  return TARGET_RTP / (pCum * pRound);
}

module.exports = { freshDeck: freshDeck, probGuess: probGuess, multIfWin: multIfWin, TARGET_RTP: TARGET_RTP };
