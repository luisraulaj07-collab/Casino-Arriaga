// Lógica de Video Póker (Jacks or Better)
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VAL = {};
RANKS.forEach(function (r, i) { RANK_VAL[r] = i + 2; });
const SUITS = ['♠', '♥', '♦', '♣'];

const PAY_TABLE = {
  royal_flush: 250,
  straight_flush: 50,
  four_kind: 25,
  full_house: 6,
  flush: 5,
  straight: 4,
  three_kind: 3,
  two_pair: 2,
  jacks_or_better: 1,
  low_pair: 0,
  nothing: 0
};

function freshDeck() {
  var d = [];
  SUITS.forEach(function (s) {
    RANKS.forEach(function (r) {
      d.push({ rank: r, suit: s, val: RANK_VAL[r], red: (s === '♥' || s === '♦') });
    });
  });
  for (var k = d.length - 1; k > 0; k--) {
    var j = Math.floor(Math.random() * (k + 1));
    var t = d[k]; d[k] = d[j]; d[j] = t;
  }
  return d;
}

function evalHand(cards) {
  var counts = {};
  cards.forEach(function (c) {
    counts[c.rank] = (counts[c.rank] || 0) + 1;
  });
  var countVals = Object.keys(counts).map(function (r) {
    return { rank: r, n: counts[r], val: RANK_VAL[r] };
  });
  countVals.sort(function (a, b) { return b.n - a.n || b.val - a.val; });

  var isFlush = SUITS.some(function (s) {
    return cards.filter(function (c) { return c.suit === s; }).length === 5;
  });

  var vals = cards.map(function (c) { return c.val; }).sort(function (a, b) { return a - b; });
  var uniqueVals = vals.filter(function (v, i) { return vals.indexOf(v) === i; });
  var isStraight = false;
  if (uniqueVals.length === 5) {
    if (uniqueVals[4] - uniqueVals[0] === 4) isStraight = true;
    if (uniqueVals.join(',') === '2,3,4,5,14') isStraight = true; // Escalera baja A-2-3-4-5
  }

  var pattern = countVals.map(function (c) { return c.n; }).join('');

  if (isStraight && isFlush && uniqueVals[uniqueVals.length - 1] === 14 && uniqueVals[0] === 10) return 'royal_flush';
  if (isStraight && isFlush) return 'straight_flush';
  if (pattern === '4111') return 'four_kind';
  if (pattern === '32') return 'full_house';
  if (isFlush) return 'flush';
  if (isStraight) return 'straight';
  if (pattern === '311') return 'three_kind';
  if (pattern === '221') return 'two_pair';
  if (pattern === '2111') {
    var pairRank = countVals[0].rank;
    if (['J', 'Q', 'K', 'A'].indexOf(pairRank) !== -1) return 'jacks_or_better';
    return 'low_pair';
  }
  return 'nothing';
}

module.exports = { freshDeck: freshDeck, evalHand: evalHand, PAY_TABLE: PAY_TABLE };
