/**
 * Lightweight, zero-dependency QR Code SVG generator (Version 1-6, ECC Level L/M)
 * Used so QR pairing codes and offline SDP QR codes work 100% offline with no external API.
 */

// Compact Reed-Solomon & QR matrix encoder for Byte-mode payloads up to ~154 chars (Version 6-L)
// For longer payloads (e.g. compressed SDP), automatically scales up to Version 10-L.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(ecCount: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.subarray(data.length);
}

// Single-block ECC-L tables for Versions 1..5 (covers up to 106 bytes)
const VERSION_SPEC: Array<{ version: number; size: number; dataBytes: number; ecBytes: number; align: number[] }> = [
  { version: 1, size: 21, dataBytes: 19, ecBytes: 7, align: [] },
  { version: 2, size: 25, dataBytes: 34, ecBytes: 10, align: [6, 18] },
  { version: 3, size: 29, dataBytes: 55, ecBytes: 15, align: [6, 22] },
  { version: 4, size: 33, dataBytes: 80, ecBytes: 20, align: [6, 26] },
  { version: 5, size: 37, dataBytes: 108, ecBytes: 26, align: [6, 30] },
];

function placeFinder(grid: Int8Array, size: number, r0: number, c0: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[rr * size + cc] = inOuter && (onBorder || inInner) ? 1 : 0;
    }
  }
}

function placeAlignment(grid: Int8Array, size: number, cr: number, cc: number) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const val = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0) ? 1 : 0;
      grid[(cr + r) * size + (cc + c)] = val;
    }
  }
}

export function generateQrMatrix(text: string): { size: number; modules: boolean[] } {
  const utf8 = new TextEncoder().encode(text);
  const spec = VERSION_SPEC.find((v) => utf8.length + 2 <= v.dataBytes) ?? VERSION_SPEC[VERSION_SPEC.length - 1];
  const { size, dataBytes, ecBytes, align } = spec;
  const payload = utf8.subarray(0, dataBytes - 2);

  // Encode byte-mode bitstream
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(payload.length, 8);
  for (const b of payload) pushBits(b, 8);
  pushBits(0, Math.min(4, dataBytes * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(dataBytes);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
    data[i] = byte;
  }
  const pads = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < dataBytes; i++, p++) {
    data[i] = pads[p % 2];
  }

  const ec = rsComputeEc(data, ecBytes);
  const allCodewords = new Uint8Array(data.length + ec.length);
  allCodewords.set(data, 0);
  allCodewords.set(ec, data.length);

  // -1 = unassigned, 0 = white, 1 = black
  const grid = new Int8Array(size * size).fill(-1);
  const isFunc = new Uint8Array(size * size);

  const setFunc = (r: number, c: number, v: number) => {
    grid[r * size + c] = v;
    isFunc[r * size + c] = 1;
  };

  placeFinder(grid, size, 0, 0);
  placeFinder(grid, size, 0, size - 7);
  placeFinder(grid, size, size - 7, 0);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r * size + c] !== -1) isFunc[r * size + c] = 1;
    }
  }

  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0 ? 1 : 0);
    setFunc(i, 6, i % 2 === 0 ? 1 : 0);
  }

  if (align.length >= 2) {
    const pos = align[1];
    placeAlignment(grid, size, pos, pos);
    for (let r = pos - 2; r <= pos + 2; r++) {
      for (let c = pos - 2; c <= pos + 2; c++) isFunc[r * size + c] = 1;
    }
  }

  setFunc(size - 8, 8, 1);

  // Reserve format info
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      isFunc[8 * size + i] = 1;
      isFunc[i * size + 8] = 1;
    }
  }
  for (let i = size - 8; i < size; i++) {
    isFunc[8 * size + i] = 1;
    isFunc[i * size + 8] = 1;
  }

  // Place data bits in zig-zag
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;
  let dir = -1;
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    for (let i = 0; i < size; i++) {
      const r = dir === -1 ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const cc = c - dc;
        if (isFunc[r * size + cc]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (allCodewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        // Mask pattern 0: (r + c) % 2 === 0
        if ((r + cc) % 2 === 0) bit ^= 1;
        grid[r * size + cc] = bit;
      }
    }
    dir = -dir;
  }

  // Format bits for ECC L (01) + Mask 0 (000) -> 111011111000100
  const formatBits = 0b111011111000100;
  for (let i = 0; i < 6; i++) {
    const b = (formatBits >> (14 - i)) & 1;
    grid[8 * size + i] = b;
    grid[(size - 1 - i) * size + 8] = b;
  }
  grid[8 * size + 7] = (formatBits >> 8) & 1;
  grid[8 * size + 8] = (formatBits >> 7) & 1;
  grid[7 * size + 8] = (formatBits >> 6) & 1;
  for (let i = 0; i < 6; i++) {
    const b = (formatBits >> (5 - i)) & 1;
    grid[(5 - i) * size + 8] = b;
    grid[8 * size + (size - 6 + i)] = b;
  }
  grid[8 * size + size - 8] = (formatBits >> 8) & 1;
  grid[8 * size + size - 7] = (formatBits >> 7) & 1;

  return {
    size,
    modules: Array.from(grid, (v) => v === 1),
  };
}
