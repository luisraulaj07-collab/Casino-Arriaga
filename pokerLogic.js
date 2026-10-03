// Funciones de evaluación de póker para Texas Hold'em (7 cartas: 2 propias + 5 comunitarias)

const suits = [{ s: '♠', red: false }, { s: '♣', red: false }, { s: '♥', red: true }, { s: '♦', red: true }];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function freshDeck() {
  var d = [];
  suits.forEach(function (su) {
    ranks.forEach(function (r) {
      d.push({ rank: r, suit: su.s, red: su.red, val: rankValue(r) });
    });
  });
  for (var k = d.length - 1; k > 0; k--) {
    var r = Math.floor(Math.random() * (k + 1));
    var t = d[k]; d[k] = d[r]; d[r] = t;
  }
  return d;
}

function rankValue(r) {
  var map = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  return map[r] || 2;
}

// Genera todas las combinaciones posibles de 5 cartas a partir de un arreglo de 7
function getCombinations(arr, k) {
  var i, sub, ret = [];
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  for (i = 0; i < arr.length; i++) {
    sub = getCombinations(arr.slice(i + 1), k - 1);
    for (var j = 0; j < sub.length; j++) {
      ret.push([arr[i]].concat(sub[j]));
    }
  }
  return ret;
}

// Evalúa una mano exacta de 5 cartas y devuelve un puntaje numérico y su nombre
function evaluate5CardHand(hand) {
  hand.sort(function(a, b) { return b.val - a.val; });
  
  var values = hand.map(function(c) { return c.val; });
  var suitsList = hand.map(function(c) { return c.suit; });

  var isFlush = suitsList.every(function(s) { return s === suitsList[0]; });
  
  var isStraight = false;
  var straightHigh = 0;
  
  // Verificar escalera normal
  if (values[0] - values[1] === 1 && values[1] - values[2] === 1 && values[2] - values[3] === 1 && values[3] - values[4] === 1) {
    isStraight = true;
    straightHigh = values[0];
  } 
  // Escalera especial A-5 (A, 5, 4, 3, 2)
  else if (values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2) {
    isStraight = true;
    straightHigh = 5; // El As cuenta como 1 bajo en esta escalera
  }

  // Conteo de frecuencias (pares, tríos, pokers)
  var counts = {};
  values.forEach(function(v) { counts[v] = (counts[v] || 0) + 1; });
  
  var freq = [];
  for (var v in counts) {
    freq.push({ val: parseInt(v, 10), count: counts[v] });
  }
  freq.sort(function(a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return b.val - a.val;
  });

  // Jerarquía de manos
  if (isStraight && isFlush) {
    return { score: 8000000 + straightHigh, name: straightHigh === 14 ? 'Escalera Real' : 'Escalera de Color' };
  }
  if (freq[0].count === 4) {
    return { score: 7000000 + (freq[0].val * 100) + freq[1].val, name: 'Poker' };
  }
  if (freq[0].count === 3 && freq[1].count === 2) {
    return { score: 6000000 + (freq[0].val * 100) + freq[1].val, name: 'Full House' };
  }
  if (isFlush) {
    return { score: 5000000 + values[0], name: 'Color' };
  }
  if (isStraight) {
    return { score: 4000000 + straightHigh, name: 'Escalera' };
  }
  if (freq[0].count === 3) {
    return { score: 3000000 + (freq[0].val * 100) + values[0], name: 'Trío' };
  }
  if (freq[0].count === 2 && freq[1].count === 2) {
    return { score: 2000000 + (freq[0].val * 100) + (freq[1].val * 10) + freq[2].val, name: 'Doble Par' };
  }
  if (freq[0].count === 2) {
    return { score: 1000000 + (freq[0].val * 100) + values[0], name: 'Par' };
  }

  return { score: values[0], name: 'Carta Alta' };
}

// Función principal que evalúa las 7 cartas (2 del jugador + 5 comunitarias) y encuentra la mejor de 5
function evalBestHand(playerCards, communityCards) {
  var totalCards = playerCards.concat(communityCards);
  var possible5CardHands = getCombinations(totalCards, 5);
  
  var bestResult = { score: -1, name: 'Carta Alta' };

  possible5CardHands.forEach(function(hand5) {
    var res = evaluate5CardHand(hand5);
    if (res.score > bestResult.score) {
      bestResult = res;
    }
  });

  return bestResult;
}

module.exports = {
  freshDeck: freshDeck,
  evalBestHand: evalBestHand
};
