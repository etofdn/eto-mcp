/**
 * CSV profiler for the `data:analyze` BPP (FN-079).
 *
 * Implements a small RFC 4180 compliant parser (handles quoted fields
 * with embedded commas, escaped `""`, CRLF and LF line endings, and a
 * configurable delimiter), a delimiter auto-detector, per-column type
 * inference (`boolean | integer | number | date | string | mixed`),
 * and lightweight summary statistics + anomaly flags. Pure functions
 * — only an optional `rng` is injected for deterministic sampling.
 *
 * Bounds (kept here so the LLM step has predictable input size):
 *  - distinct enumeration capped at 10 000 per column.
 *  - top-K categorical reporting only when `distinctCount ≤ 50`.
 *  - sample rows: first 20 + up to 20 uniformly-random from the rest.
 *  - cell strings truncated at 256 chars with an ellipsis.
 */

import type {
  ColumnProfile,
  DatasetProfile,
  InferredType,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface ProfileOpts {
  readonly delimiter: "," | ";" | "\t" | "auto";
  readonly hasHeader: boolean;
  readonly maxRows: number;
}

export interface ProfileDeps {
  /** Default `Math.random`. */
  readonly rng?: () => number;
}

export interface DatasetSample {
  readonly columns: readonly string[];
  readonly head: ReadonlyArray<readonly string[]>;
  readonly random: ReadonlyArray<readonly string[]>;
}

export interface ProfileResult {
  readonly profile: DatasetProfile;
  readonly sample: DatasetSample;
  readonly truncated: boolean;
  /** Internal-only anomaly flags per column (parallel to `profile.columns`). */
  readonly columnFlags: readonly ColumnFlags[];
}

export interface ColumnFlags {
  readonly highNullRate: boolean;
  readonly allDistinct: boolean;
  readonly monotonic: boolean;
  readonly constant: boolean;
  readonly outlierHeavy: boolean;
}

const DISTINCT_CAP = 10_000;
const TOPVALUES_THRESHOLD = 50;
const TOPVALUES_K = 5;
const HEAD_SAMPLE_SIZE = 20;
const RANDOM_SAMPLE_SIZE = 20;
const CELL_TRUNCATE = 256;
const SAMPLE_LINE_BUDGET = 4 * 1024;

const NULL_TOKENS = new Set([""]); // configurable; default = empty string only
const TRUE_TOKENS = new Set(["true", "1"]);
const FALSE_TOKENS = new Set(["false", "0"]);
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/* -------------------------------------------------------------------------- */
/* profileCsv                                                                 */
/* -------------------------------------------------------------------------- */

export function profileCsv(
  text: string,
  opts: ProfileOpts,
  deps?: ProfileDeps,
): ProfileResult {
  const delimiter =
    opts.delimiter === "auto" ? detectDelimiter(text) : opts.delimiter;

  const allRows = parseCsv(text, delimiter);
  if (allRows.length === 0) {
    return emptyResult(delimiter);
  }

  const headerRow = opts.hasHeader ? allRows[0]! : null;
  const dataStart = opts.hasHeader ? 1 : 0;
  const totalDataRows = allRows.length - dataStart;
  const truncated = totalDataRows > opts.maxRows;
  const dataEnd = dataStart + Math.min(totalDataRows, opts.maxRows);
  const dataRows = allRows.slice(dataStart, dataEnd);

  const columnCount = computeColumnCount(allRows);
  const columnNames = buildColumnNames(headerRow, columnCount);

  // Pad short rows so column accessors are total.
  const padded: string[][] = dataRows.map((r) => {
    if (r.length === columnCount) return [...r];
    const out = [...r];
    while (out.length < columnCount) out.push("");
    return out.slice(0, columnCount);
  });

  const columns: ColumnProfile[] = [];
  const columnFlags: ColumnFlags[] = [];
  for (let c = 0; c < columnCount; c++) {
    const cells = padded.map((r) => r[c]!);
    const { profile, flags } = profileColumn(columnNames[c]!, cells);
    columns.push(profile);
    columnFlags.push(flags);
  }

  const profile: DatasetProfile = {
    rowCount: padded.length,
    columnCount,
    columns,
    delimiter,
    encoding: "utf-8",
    truncated,
  };

  const sample = buildSample(columnNames, padded, deps?.rng ?? Math.random);
  return { profile, sample, truncated, columnFlags };
}

function emptyResult(delimiter: "," | ";" | "\t"): ProfileResult {
  return {
    profile: {
      rowCount: 0,
      columnCount: 0,
      columns: [],
      delimiter,
      encoding: "utf-8",
      truncated: false,
    },
    sample: { columns: [], head: [], random: [] },
    truncated: false,
    columnFlags: [],
  };
}

function computeColumnCount(rows: readonly (readonly string[])[]): number {
  let n = 0;
  for (const r of rows) if (r.length > n) n = r.length;
  return n;
}

function buildColumnNames(
  header: readonly string[] | null,
  columnCount: number,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < columnCount; i++) {
    if (header && header[i] && header[i]!.trim() !== "") {
      out.push(header[i]!);
    } else {
      out.push(`col_${i + 1}`);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Delimiter auto-detect                                                      */
/* -------------------------------------------------------------------------- */

export function detectDelimiter(text: string): "," | ";" | "\t" {
  const head = text.slice(0, 10 * 1024);
  // Count outside quotes to avoid mis-counting embedded delimiters.
  let inQuotes = false;
  let comma = 0;
  let semi = 0;
  let tab = 0;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '"') {
      // toggle, with awareness of escaped ""
      if (inQuotes && head[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ",") comma++;
    else if (ch === ";") semi++;
    else if (ch === "\t") tab++;
  }
  const max = Math.max(comma, semi, tab);
  if (max === 0) return ",";
  if (tab === max) return "\t";
  if (semi === max) return ";";
  return ",";
}

/* -------------------------------------------------------------------------- */
/* RFC 4180 parser                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal RFC 4180 parser. Supports:
 *   - quoted fields with embedded delimiters and newlines,
 *   - escaped `""` inside quoted fields,
 *   - CRLF and LF line endings,
 *   - configurable single-character delimiter,
 *   - skipping a trailing empty record produced by a final newline.
 */
export function parseCsv(
  text: string,
  delimiter: "," | ";" | "\t",
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    // not in quotes
    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      // swallow CR; treat the following LF as the terminator
      if (text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  // Trailing field (no terminator before EOF).
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop a single trailing empty row produced by a final newline.
  if (
    rows.length > 0 &&
    rows[rows.length - 1]!.length === 1 &&
    rows[rows.length - 1]![0] === ""
  ) {
    rows.pop();
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Per-column profile                                                         */
/* -------------------------------------------------------------------------- */

function profileColumn(
  name: string,
  cells: readonly string[],
): { profile: ColumnProfile; flags: ColumnFlags } {
  let nonNull = 0;
  let nullCount = 0;
  const distinct = new Map<string, number>();
  let distinctOverflow = false;

  // Type inference candidates — set to false as we encounter a non-fitting cell.
  let canBool = true;
  let canInt = true;
  let canNum = true;
  let canDate = true;

  // Welford for numeric stats.
  let n = 0;
  let mean = 0;
  let m2 = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const numericValues: number[] = [];

  let stringMin: string | undefined;
  let stringMax: string | undefined;

  let monotonicInc = true;
  let monotonicDec = true;
  let prev: number | null = null;

  for (const raw of cells) {
    if (NULL_TOKENS.has(raw)) {
      nullCount++;
      continue;
    }
    nonNull++;

    if (!distinctOverflow) {
      distinct.set(raw, (distinct.get(raw) ?? 0) + 1);
      if (distinct.size > DISTINCT_CAP) distinctOverflow = true;
    }

    const lower = raw.toLowerCase();
    if (canBool && !(TRUE_TOKENS.has(lower) || FALSE_TOKENS.has(lower))) {
      canBool = false;
    }
    if (canInt) {
      if (!/^-?\d+$/.test(raw)) canInt = false;
    }
    let asNum: number | null = null;
    if (canNum) {
      // Allow integers + decimals + scientific notation.
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
        asNum = Number(raw);
        if (!Number.isFinite(asNum)) canNum = false;
      } else {
        canNum = false;
      }
    } else {
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
        const v = Number(raw);
        if (Number.isFinite(v)) asNum = v;
      }
    }
    if (canDate && !ISO_DATE_RE.test(raw)) canDate = false;

    if (asNum !== null) {
      n++;
      const delta = asNum - mean;
      mean += delta / n;
      m2 += delta * (asNum - mean);
      if (asNum < min) min = asNum;
      if (asNum > max) max = asNum;
      numericValues.push(asNum);
      if (prev !== null) {
        if (asNum < prev) monotonicInc = false;
        if (asNum > prev) monotonicDec = false;
      }
      prev = asNum;
    } else {
      monotonicInc = false;
      monotonicDec = false;
    }

    if (stringMin === undefined || raw < stringMin) stringMin = raw;
    if (stringMax === undefined || raw > stringMax) stringMax = raw;
  }

  // Derive type, ranking by specificity.
  let inferredType: InferredType;
  if (nonNull === 0) {
    inferredType = "string";
  } else if (canBool) {
    inferredType = "boolean";
  } else if (canInt) {
    inferredType = "integer";
  } else if (canNum) {
    inferredType = "number";
  } else if (canDate) {
    inferredType = "date";
  } else {
    // mixed if there's a partial numeric/date intermixing detected; else string.
    // Heuristic: if some values parsed as numbers but not all, mark mixed.
    inferredType = numericValues.length > 0 && numericValues.length < nonNull
      ? "mixed"
      : "string";
  }

  const distinctCount = distinctOverflow ? DISTINCT_CAP : distinct.size;
  const isNumeric = inferredType === "integer" || inferredType === "number";

  const profile: ColumnProfile = {
    name,
    inferredType,
    nonNullCount: nonNull,
    nullCount,
    distinctCount,
    ...(isNumeric && n > 0
      ? {
          min,
          max,
          mean,
          stddev: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0,
        }
      : stringMin !== undefined && !isNumeric
        ? { min: stringMin, max: stringMax! }
        : {}),
    ...(distinctCount > 0 && distinctCount <= TOPVALUES_THRESHOLD
      ? { topValues: topK(distinct, TOPVALUES_K) }
      : {}),
  };

  // Anomaly flags
  const total = nonNull + nullCount;
  const highNullRate = total > 0 && nullCount / total > 0.3;
  const allDistinct = nonNull >= 2 && distinctCount === nonNull && !distinctOverflow;
  const constant = nonNull >= 2 && distinctCount === 1;
  const monotonic =
    isNumeric && n >= 2 && (monotonicInc || monotonicDec) && !constant;
  const outlierHeavy =
    isNumeric && n >= 8 && iqrOutlierRate(numericValues) > 0.05;

  const flags: ColumnFlags = {
    highNullRate,
    allDistinct,
    monotonic,
    constant,
    outlierHeavy,
  };

  return { profile, flags };
}

function topK(
  counts: ReadonlyMap<string, number>,
  k: number,
): Array<{ value: string; count: number }> {
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return entries.slice(0, k).map(([value, count]) => ({ value, count }));
}

function iqrOutlierRate(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return 0;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  let outliers = 0;
  for (const v of sorted) if (v < lo || v > hi) outliers++;
  return outliers / sorted.length;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = sorted[base]!;
  const hi = sorted[base + 1] ?? lo;
  return lo + (hi - lo) * rest;
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* -------------------------------------------------------------------------- */

function buildSample(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
  rng: () => number,
): DatasetSample {
  const head = rows.slice(0, HEAD_SAMPLE_SIZE).map(truncateRow);
  // Random sample from rows beyond `head`.
  const remainder = rows.length > HEAD_SAMPLE_SIZE ? rows.slice(HEAD_SAMPLE_SIZE) : [];
  const randomRows: string[][] = [];
  if (remainder.length > 0) {
    const pickCount = Math.min(RANDOM_SAMPLE_SIZE, remainder.length);
    const seen = new Set<number>();
    while (randomRows.length < pickCount && seen.size < remainder.length) {
      const idx = Math.floor(rng() * remainder.length);
      if (seen.has(idx)) continue;
      seen.add(idx);
      randomRows.push(truncateRow(remainder[idx]!));
    }
  }
  return { columns, head, random: randomRows };
}

function truncateRow(row: readonly string[]): string[] {
  let used = 0;
  const out: string[] = [];
  for (const cell of row) {
    let trimmed = cell;
    if (trimmed.length > CELL_TRUNCATE) {
      trimmed = trimmed.slice(0, CELL_TRUNCATE - 1) + "…";
    }
    if (used + trimmed.length > SAMPLE_LINE_BUDGET) {
      out.push(trimmed.slice(0, Math.max(0, SAMPLE_LINE_BUDGET - used)) + "…");
      // Fill the remaining columns with empty placeholders.
      while (out.length < row.length) out.push("");
      return out;
    }
    out.push(trimmed);
    used += trimmed.length + 1;
  }
  return out;
}
