// 5x7 dot-matrix font + layout for the big percentage. Shared by the browser (window.CCGlyphs)
// and the unit tests (require). Layout rule: each glyph owns 5 columns, glyphs are separated by
// exactly one blank column, and there is one blank column of margin on each side.
(function (root) {
  'use strict';
  const FONT = {
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  };
  const GLYPH_W = 5, GLYPH_H = 7, GAP = 1, MARGIN = 1;

  // Returns { cols, rows, glyphs: [{ ch, col }], lit: Map("c,r" -> ch) }
  function layout(text) {
    const chars = String(text).split('').filter((c) => FONT[c]);
    const glyphs = chars.map((ch, i) => ({ ch, col: MARGIN + i * (GLYPH_W + GAP) }));
    const cols = chars.length ? MARGIN * 2 + chars.length * GLYPH_W + (chars.length - 1) * GAP : MARGIN * 2;
    const rows = GLYPH_H + MARGIN * 2;
    const lit = new Map();
    for (const g of glyphs) {
      FONT[g.ch].forEach((row, r) => {
        for (let c = 0; c < GLYPH_W; c++) if (row[c] === '1') lit.set(`${g.col + c},${r + MARGIN}`, g.ch);
      });
    }
    return { cols, rows, glyphs, lit };
  }

  const api = { FONT, layout, GLYPH_W, GLYPH_H, GAP, MARGIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCGlyphs = api;
})(typeof window !== 'undefined' ? window : globalThis);
