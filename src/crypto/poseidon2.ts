/**
 * Poseidon-2 (Poseidon sponge, t=3, BN254 Fr) — pure-TypeScript port of the
 * arkworks `ark-crypto-primitives` v0.5.0 implementation.
 *
 * # Parameter set (FN-212-ratified, §10.3.1)
 *
 * | Parameter       | Value                                      |
 * |-----------------|--------------------------------------------|
 * | Curve           | BN254 (ark_bn254::Fr)                      |
 * | State width t   | 3 (rate = 2, capacity = 1)                 |
 * | Full rounds     | 8                                          |
 * | Partial rounds  | 56                                         |
 * | S-box           | x^5                                        |
 * | ARK generation  | Grain LFSR + rejection sampling            |
 * | MDS generation  | Grain LFSR + mod-p reduction → Cauchy MDS  |
 * | skip_matrices   | 0                                          |
 *
 * Constants are generated lazily at first call by the same Grain LFSR
 * algorithm used by `find_poseidon_ark_and_mds::<Fr>(254, 2, 8, 56, 0)`.
 * The KAT vectors in the unit tests pin the parameter set.
 *
 * # Public API
 *
 * - `poseidon2(inputs)` — 3-element sponge hash (rate-2 sponge, t=3)
 * - `encodeFr(value)`   — encode a JS value as a BN254 Fr element (§10.3.1)
 * - `encodeSalt(bytes)` — encode a 32-byte salt LE → Fr
 * - `bytesToHex32(fr)`  — serialize Fr as 32-byte LE hex (64 chars)
 * - `merkleCompress(L, R)` — Poseidon-2 Merkle compress with domain tag
 *
 * # Encoding contract (§10.3.1)
 *
 * Callers pass already-encoded Fr elements to `poseidon2`.  The `encodeFr`
 * helper implements the type-keyed encoding table from §10.3.1.
 */

// ---------------------------------------------------------------------------
// BN254 Fr field
// ---------------------------------------------------------------------------

/** BN254 Fr prime modulus. */
const P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Modular addition. */
function addMod(a: bigint, b: bigint): bigint {
  const r = a + b;
  return r >= P ? r - P : r;
}

/** Modular multiplication. */
function mulMod(a: bigint, b: bigint): bigint {
  return (a * b) % P;
}

/** Modular exponentiation via binary square-and-multiply. */
function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  let result = 1n;
  base = base % modulus;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % modulus;
    exp >>= 1n;
    base = (base * base) % modulus;
  }
  return result;
}

/** Modular inverse using Fermat's little theorem (P is prime). */
function modInv(a: bigint): bigint {
  if (a === 0n) throw new Error("modInv(0) is undefined");
  return modPow(a, P - 2n, P);
}

/** x^5 mod P (the Poseidon S-box). */
function sbox(x: bigint): bigint {
  const x2 = mulMod(x, x);
  const x4 = mulMod(x2, x2);
  return mulMod(x4, x);
}

/**
 * Interpret a Uint8Array as a little-endian unsigned integer and reduce mod P.
 * Mirrors `Fr::from_le_bytes_mod_order` in arkworks.
 */
function fromLeBytesModOrder(bytes: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < bytes.length; i++) {
    val |= BigInt(bytes[i]) << BigInt(8 * i);
  }
  return val % P;
}

/**
 * Interpret a Uint8Array as a big-endian unsigned integer and reduce mod P.
 * Mirrors `Fr::from_be_bytes_mod_order` in arkworks.
 */
function fromBeBytesModOrder(bytes: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < bytes.length; i++) {
    val = (val << 8n) | BigInt(bytes[i]);
  }
  return val % P;
}

// ---------------------------------------------------------------------------
// Grain LFSR — exact port of PoseidonGrainLFSR from ark-crypto-primitives 0.5.0
// ---------------------------------------------------------------------------

/**
 * Grain LFSR used by `find_poseidon_ark_and_mds`.
 *
 * IMPORTANT: this mirrors `PoseidonGrainLFSR` in
 * `ark-crypto-primitives 0.5.0 src/sponge/poseidon/grain_lfsr.rs` exactly,
 * including the non-trivial `get_bits` loop and the bit-reversal before
 * field-element construction.
 *
 * Feedback polynomial: x^80 + x^62 + x^51 + x^38 + x^23 + x^13 + 1.
 *
 * State bit layout after initialization (before warm-up):
 *   [0]     = 0
 *   [1]     = 1   (prime field indicator)
 *   [2..5]  = S-box bits (state[5]=1 iff inverse S-box; else all 0)
 *   [6..17] = n (prime_num_bits) in 12 bits, LSB at index 17
 *   [18..29]= t (state_len) in 12 bits, LSB at index 29
 *   [30..39]= R_F in 10 bits, LSB at index 39
 *   [40..49]= R_P in 10 bits, LSB at index 49
 *   [50..79]= all 1s
 */
class GrainLFSR {
  /** The 80-bit circular shift-register (0 or 1 per slot). */
  private state: Uint8Array;
  /** Index of the oldest slot (next to overwrite). */
  private head: number;
  /** Field prime bit-count (for assertions). */
  private readonly primeNumBits: number;

  constructor(
    isSboxAnInverse: boolean,
    primeNumBits: number,
    stateLen: number,
    numFullRounds: number,
    numPartialRounds: number,
  ) {
    this.primeNumBits = primeNumBits;
    const s = new Uint8Array(80);

    // b0, b1: field type indicator — prime field = (0, 1)
    s[0] = 0;
    s[1] = 1;

    // b2..b5: S-box indicator
    if (isSboxAnInverse) {
      s[5] = 1;
    }
    // else all bits 2-5 remain 0

    // b6..b17: n (prime_num_bits) — LSB stored at index 17
    {
      let cur = primeNumBits;
      for (let i = 17; i >= 6; i--) {
        s[i] = cur & 1;
        cur >>= 1;
      }
    }

    // b18..b29: t (state_len) — LSB at index 29
    {
      let cur = stateLen;
      for (let i = 29; i >= 18; i--) {
        s[i] = cur & 1;
        cur >>= 1;
      }
    }

    // b30..b39: R_F — LSB at index 39
    {
      let cur = numFullRounds;
      for (let i = 39; i >= 30; i--) {
        s[i] = cur & 1;
        cur >>= 1;
      }
    }

    // b40..b49: R_P — LSB at index 49
    {
      let cur = numPartialRounds;
      for (let i = 49; i >= 40; i--) {
        s[i] = cur & 1;
        cur >>= 1;
      }
    }

    // b50..b79: all 1s
    for (let i = 50; i < 80; i++) {
      s[i] = 1;
    }

    this.state = s;
    this.head = 0;

    // Warm-up: run 160 update steps, discarding output
    for (let i = 0; i < 160; i++) {
      this._update();
    }
  }

  /** One LFSR step: compute and store a new bit; return it. */
  private _update(): number {
    const h = this.head;
    const newBit =
      this.state[h] ^
      this.state[(h + 13) % 80] ^
      this.state[(h + 23) % 80] ^
      this.state[(h + 38) % 80] ^
      this.state[(h + 51) % 80] ^
      this.state[(h + 62) % 80];
    this.state[h] = newBit;
    this.head = (h + 1) % 80;
    return newBit;
  }

  /**
   * Produce `numBits` output bits using the Poseidon Grain LFSR protocol:
   *
   * For each output bit:
   *   1. Draw `firstBit` from the LFSR.
   *   2. While `firstBit == 0`: discard one bit, draw a new `firstBit`.
   *   3. Once `firstBit == 1`: draw `secondBit` and append it to output.
   *
   * This matches `PoseidonGrainLFSR::get_bits` in arkworks 0.5.0.
   */
  getBits(numBits: number): boolean[] {
    const res: boolean[] = [];
    while (res.length < numBits) {
      // Draw first bit; keep retrying while it's 0
      let firstBit = this._update();
      while (firstBit === 0) {
        this._update(); // discard
        firstBit = this._update(); // new first
      }
      // firstBit is 1; the actual output bit is the next one
      res.push(this._update() !== 0);
    }
    return res;
  }

  /**
   * Generate `numElems` field elements using **rejection sampling**.
   *
   * For each element:
   *   - Draw `primeNumBits` bits via `getBits`.
   *   - Reverse them (makes MSB the first bit drawn).
   *   - Interpret as a big-endian integer.
   *   - Accept if < P; otherwise retry.
   *
   * Used for **ARK** (round constants).
   * Matches `get_field_elements_rejection_sampling` in arkworks 0.5.0.
   */
  getFieldElementsRejectionSampling(numElems: number): bigint[] {
    const res: bigint[] = [];
    while (res.length < numElems) {
      const bits = this.getBits(this.primeNumBits);
      bits.reverse(); // match arkworks bits.reverse() before from_bits_le
      // from_bits_le semantics: bits[0] is coefficient of 2^0 (LSB)
      let val = 0n;
      for (let i = 0; i < bits.length; i++) {
        if (bits[i]) val |= 1n << BigInt(i);
      }
      if (val < P) {
        res.push(val);
      }
      // If val >= P, discard and retry (rejection sampling)
    }
    return res;
  }

  /**
   * Generate `numElems` field elements using **mod-p reduction**.
   *
   * For each element:
   *   - Draw `primeNumBits` bits via `getBits`.
   *   - Reverse them.
   *   - Pack reversed bits LE-within-byte → LE bytes.
   *   - Apply `from_le_bytes_mod_order`.
   *
   * Used for **MDS** x/y values.
   * Matches `get_field_elements_mod_p` in arkworks 0.5.0.
   */
  getFieldElementsModP(numElems: number): bigint[] {
    const res: bigint[] = [];
    for (let k = 0; k < numElems; k++) {
      const bits = this.getBits(this.primeNumBits);
      bits.reverse(); // MSB-first (matches arkworks)
      // Pack into bytes: bits[i] → byte[i>>3] bit (i&7)
      const bytes = new Uint8Array(Math.ceil(this.primeNumBits / 8));
      for (let i = 0; i < bits.length; i++) {
        if (bits[i]) {
          bytes[i >> 3] |= 1 << (i & 7);
        }
      }
      res.push(fromLeBytesModOrder(bytes));
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Parameter generation (ARK + MDS)
// ---------------------------------------------------------------------------

interface PoseidonParams {
  /** Round constants: ark[round][element_index]. */
  ark: bigint[][];
  /** MDS matrix: mds[row][col]. */
  mds: bigint[][];
}

/**
 * Generate the Poseidon-2 BN254 t=3 parameters using the Grain LFSR.
 * Mirrors `find_poseidon_ark_and_mds::<Fr>(254, 2, 8, 56, 0)`.
 *
 * - ARK: 64 vectors × 3 elements, via rejection sampling.
 * - MDS: 3×3 Cauchy matrix, via mod-p reduction of 6 LFSR field elements.
 * - skip_matrices = 0: use the first candidate MDS (no pre-skip).
 */
function buildParams(): PoseidonParams {
  const FULL_ROUNDS = 8;
  const PARTIAL_ROUNDS = 56;
  const T = 3; // rate + capacity

  const lfsr = new GrainLFSR(
    false, // is_sbox_an_inverse = false for x^5
    254, // prime_num_bits (BN254 Fr)
    T, // state_len
    FULL_ROUNDS,
    PARTIAL_ROUNDS,
  );

  // ARK: (full_rounds + partial_rounds) rounds × t elements per round
  const ark: bigint[][] = [];
  for (let round = 0; round < FULL_ROUNDS + PARTIAL_ROUNDS; round++) {
    ark.push(lfsr.getFieldElementsRejectionSampling(T));
  }

  // MDS: skip_matrices=0 means no pre-skip, use first xs/ys directly
  // (the arkworks code skips `skip_matrices` × 2t elements before the final draw)
  const xs = lfsr.getFieldElementsModP(T);
  const ys = lfsr.getFieldElementsModP(T);

  // Cauchy matrix: mds[i][j] = (xs[i] + ys[j])^{-1}
  const mds: bigint[][] = [];
  for (let i = 0; i < T; i++) {
    const row: bigint[] = [];
    for (let j = 0; j < T; j++) {
      const sum = addMod(xs[i], ys[j]);
      row.push(modInv(sum));
    }
    mds.push(row);
  }

  return { ark, mds };
}

/** Lazy-initialised Poseidon parameters (computed once per process). */
let _params: PoseidonParams | null = null;

function getParams(): PoseidonParams {
  if (_params === null) {
    _params = buildParams();
  }
  return _params;
}

// ---------------------------------------------------------------------------
// Poseidon permutation
// ---------------------------------------------------------------------------

/**
 * Apply one Poseidon permutation step: ARK → S-box → MDS.
 *
 * Round structure (matches `PoseidonSponge::permute` in arkworks 0.5.0):
 *   - 4 full rounds  (all 3 elements get S-box)
 *   - 56 partial rounds (only state[0] gets S-box)
 *   - 4 full rounds
 *
 * The permutation acts on ALL t=3 state elements including the capacity
 * element at state[0].
 */
function poseidonPermute(state: bigint[]): void {
  const { ark, mds } = getParams();
  const FULL_HALF = 4;
  const PARTIAL = 56;
  const T = 3;

  let roundIdx = 0;

  // First half: full rounds
  for (let r = 0; r < FULL_HALF; r++, roundIdx++) {
    // ARK
    for (let j = 0; j < T; j++) state[j] = addMod(state[j], ark[roundIdx][j]);
    // S-box (all elements)
    for (let j = 0; j < T; j++) state[j] = sbox(state[j]);
    // MDS: new_state[i] = sum_j mds[i][j] * state[j]
    const tmp0 = addMod(addMod(mulMod(mds[0][0], state[0]), mulMod(mds[0][1], state[1])), mulMod(mds[0][2], state[2]));
    const tmp1 = addMod(addMod(mulMod(mds[1][0], state[0]), mulMod(mds[1][1], state[1])), mulMod(mds[1][2], state[2]));
    const tmp2 = addMod(addMod(mulMod(mds[2][0], state[0]), mulMod(mds[2][1], state[1])), mulMod(mds[2][2], state[2]));
    state[0] = tmp0; state[1] = tmp1; state[2] = tmp2;
  }

  // Partial rounds
  for (let r = 0; r < PARTIAL; r++, roundIdx++) {
    // ARK
    for (let j = 0; j < T; j++) state[j] = addMod(state[j], ark[roundIdx][j]);
    // S-box (first element only)
    state[0] = sbox(state[0]);
    // MDS
    const tmp0 = addMod(addMod(mulMod(mds[0][0], state[0]), mulMod(mds[0][1], state[1])), mulMod(mds[0][2], state[2]));
    const tmp1 = addMod(addMod(mulMod(mds[1][0], state[0]), mulMod(mds[1][1], state[1])), mulMod(mds[1][2], state[2]));
    const tmp2 = addMod(addMod(mulMod(mds[2][0], state[0]), mulMod(mds[2][1], state[1])), mulMod(mds[2][2], state[2]));
    state[0] = tmp0; state[1] = tmp1; state[2] = tmp2;
  }

  // Second half: full rounds
  for (let r = 0; r < FULL_HALF; r++, roundIdx++) {
    // ARK
    for (let j = 0; j < T; j++) state[j] = addMod(state[j], ark[roundIdx][j]);
    // S-box (all elements)
    for (let j = 0; j < T; j++) state[j] = sbox(state[j]);
    // MDS
    const tmp0 = addMod(addMod(mulMod(mds[0][0], state[0]), mulMod(mds[0][1], state[1])), mulMod(mds[0][2], state[2]));
    const tmp1 = addMod(addMod(mulMod(mds[1][0], state[0]), mulMod(mds[1][1], state[1])), mulMod(mds[1][2], state[2]));
    const tmp2 = addMod(addMod(mulMod(mds[2][0], state[0]), mulMod(mds[2][1], state[1])), mulMod(mds[2][2], state[2]));
    state[0] = tmp0; state[1] = tmp1; state[2] = tmp2;
  }
}

// ---------------------------------------------------------------------------
// Public: poseidon2
// ---------------------------------------------------------------------------

/**
 * Poseidon-2 sponge hash over BN254 Fr, t=3 (rate=2, capacity=1).
 *
 * Absorbs three field elements and returns the first squeezed element.
 * Matches `hash_t3` in `crates/eto-zk/src/poseidon.rs`.
 *
 * State layout: [capacity(state[0]), rate_0(state[1]), rate_1(state[2])]
 *
 * Sponge construction (rate=2, capacity=1):
 *  1. state = [0, 0, 0]
 *  2. state[1] += inputs[0]; state[2] += inputs[1]  (absorb to rate portion)
 *  3. Permute                                         (rate full)
 *  4. state[1] += inputs[2]                          (absorb remainder)
 *  5. Permute                                         (before squeeze)
 *  6. return state[1]                                 (first rate element)
 *
 * @param inputs Three BN254 Fr field elements (bigints in [0, P)).
 * @returns First output field element of the sponge.
 */
export function poseidon2(inputs: [bigint, bigint, bigint]): bigint {
  for (const x of inputs) {
    if (x < 0n || x >= P) throw new RangeError(`poseidon2: input out of range: ${x}`);
  }

  // State layout: [capacity=state[0], rate_0=state[1], rate_1=state[2]]
  const state: bigint[] = [0n, 0n, 0n];

  // Absorb rate elements: state[capacity + i] += inputs[i]
  // capacity=1, so state[1] and state[2] are the rate portion
  state[1] = addMod(state[1], inputs[0]); // state[capacity + 0]
  state[2] = addMod(state[2], inputs[1]); // state[capacity + 1]
  // Rate is now full → permute
  poseidonPermute(state);

  // Absorb remaining input
  state[1] = addMod(state[1], inputs[2]); // state[capacity + 0]

  // Squeeze: permute, then return state[capacity + 0] = state[1]
  poseidonPermute(state);

  return state[1];
}

// ---------------------------------------------------------------------------
// Public: encodeFr
// ---------------------------------------------------------------------------

/**
 * Encode a JavaScript value as a BN254 Fr field element per §10.3.1.
 *
 * | Input type                   | Encoding                                 |
 * |------------------------------|------------------------------------------|
 * | `bigint` / `number` (integer)| Canonical decimal string → UTF-8 bytes   |
 * |                              | → 32-byte big-endian pad →               |
 * |                              | `fromBeBytesModOrder`                    |
 * | `string`                     | NFC-normalise → UTF-8 bytes;             |
 * |                              | ≤ 31 bytes: left-zero-pad to 32;         |
 * |                              | > 31 bytes: first 31 bytes + length byte |
 * |                              | → `fromBeBytesModOrder`                  |
 * | `boolean`                    | `false → 0n`, `true → 1n`               |
 * | `null` / `undefined`         | `0n`                                     |
 *
 * Note: salt encoding is NOT handled by this function. Use `encodeSalt`.
 *
 * @param value Any JSON-compatible value.
 * @returns BN254 Fr element in `[0, P)`.
 */
export function encodeFr(value: unknown): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }

  if (typeof value === "boolean") {
    return value ? 1n : 0n;
  }

  if (typeof value === "bigint" || typeof value === "number") {
    // Canonical decimal string representation
    let decimal: string;
    if (typeof value === "bigint") {
      decimal = value.toString(10);
    } else {
      if (!Number.isFinite(value)) {
        throw new TypeError(`encodeFr: cannot encode non-finite number ${value}`);
      }
      // Canonical decimal: strip trailing zeros after decimal point,
      // but preserve "0" for zero.
      decimal = value.toString(10);
      if (decimal.includes(".")) {
        decimal = decimal.replace(/\.?0+$/, "") || "0";
      }
      // Remove leading zeros (e.g. "007") but keep "0" as-is
      if (decimal !== "0") {
        decimal = decimal.replace(/^(-?)0+(\d)/, "$1$2");
      }
    }
    const utf8 = new TextEncoder().encode(decimal);
    const bytes = new Uint8Array(32);
    if (utf8.length <= 32) {
      bytes.set(utf8, 32 - utf8.length); // right-align (big-endian pad)
    } else {
      bytes.set(utf8.subarray(utf8.length - 32)); // take last 32 bytes
    }
    return fromBeBytesModOrder(bytes);
  }

  if (typeof value === "string") {
    // NFC-normalize
    const normalized = value.normalize("NFC");
    const utf8 = new TextEncoder().encode(normalized);
    const bytes = new Uint8Array(32);
    if (utf8.length <= 31) {
      // Left-zero-pad to 32 bytes (big-endian)
      bytes.set(utf8, 32 - utf8.length);
    } else {
      // First 31 bytes + length byte in position 31
      bytes.set(utf8.subarray(0, 31), 0);
      bytes[31] = utf8.length & 0xff;
    }
    return fromBeBytesModOrder(bytes);
  }

  throw new TypeError(`encodeFr: unsupported value type ${typeof value}`);
}

/**
 * Encode a 32-byte salt as a BN254 Fr element using little-endian byte order.
 *
 * Mirrors `Fr::from_le_bytes_mod_order(&salt_bytes)` per §10.3.1.
 * The salt MUST be 32 cryptographically random bytes, distinct per attribute.
 *
 * @param saltBytes 32 random bytes.
 * @returns BN254 Fr element in `[0, P)`.
 */
export function encodeSalt(saltBytes: Uint8Array): bigint {
  if (saltBytes.length !== 32) {
    throw new RangeError(`encodeSalt: expected 32 bytes, got ${saltBytes.length}`);
  }
  return fromLeBytesModOrder(saltBytes);
}

// ---------------------------------------------------------------------------
// Public: bytesToHex32
// ---------------------------------------------------------------------------

/**
 * Serialize a BN254 Fr field element as a 32-byte little-endian hex string
 * (64 lowercase hex characters).
 *
 * Matches `CanonicalSerialize::serialize_compressed` for BN254 Fr in
 * arkworks, which emits little-endian bytes. The result matches the
 * `commitment` / `saltCommitment` hex fields in the §10.3.1 JSON-LD block.
 *
 * @param fr Field element in `[0, P)`.
 * @returns 64-character lowercase hex string.
 */
export function bytesToHex32(fr: bigint): string {
  if (fr < 0n || fr >= P) throw new RangeError(`bytesToHex32: value out of range: ${fr}`);
  const bytes = new Uint8Array(32);
  let val = fr;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Domain separator (Merkle compress helper)
// ---------------------------------------------------------------------------

/**
 * SHA-256-derived domain separator for Merkle compression.
 * `Fr::from_be_bytes_mod_order(sha256("eto.zk.poseidon2.merkle.v1"))`.
 *
 * Pre-computed from `domain_merkle()` in `crates/eto-zk/src/poseidon.rs`.
 */
const DOMAIN_MERKLE =
  0x1246c3e0c3018567c7f1eb638d561294ffc0332284c4141f7fa0121cfd2c1af1n;

/**
 * Poseidon-2 Merkle compression: `Poseidon2_t3([left, right, DOMAIN_MERKLE])`.
 *
 * The domain separator in the third slot distinguishes Merkle compress calls
 * from value-commitment calls (where the third slot holds a small u64 index).
 */
export function merkleCompress(left: bigint, right: bigint): bigint {
  return poseidon2([left, right, DOMAIN_MERKLE]);
}
