/**
 * Search-provider seam for the `web:research` BPP (FN-077).
 *
 * The handler talks to a `SearchProvider` interface only. Tests and
 * `WEB_RESEARCH_FAKE=1` use `FakeSearchProvider`, which serves a
 * deterministic in-memory corpus keyed by query substring.
 *
 * `HttpSearchProvider` is a scaffold for the planned Tavily / Brave /
 * SerpAPI plug-ins, selected via `WEB_RESEARCH_PROVIDER` env. It does
 * NOT call any network today — it throws `search_provider_not_configured`
 * until a follow-up task wires the real adapters.
 *
 *   TODO(real-search-provider): implement the per-provider HTTP
 *   request/response mapping for Tavily, Brave Search, and SerpAPI;
 *   plumb `WEB_RESEARCH_API_KEY`. See `README.md`.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly publisher?: string;
  /** Unix seconds — when the source was published, if known. */
  readonly publishedAtSec?: number;
}

export interface SearchOpts {
  readonly maxResults: number;
  readonly recencyDays?: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
}

export interface SearchProvider {
  search(query: string, opts: SearchOpts): Promise<readonly SearchHit[]>;
}

/* -------------------------------------------------------------------------- */
/* Domain matching                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Returns the lowercase host of `url`, or `""` if it cannot be parsed.
 * Pulled out so both the search filter and the fetcher's SSRF guard
 * agree on host extraction.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * `entry` may be a bare hostname (`example.com`), a hostname with port
 * (`example.com:8080`), or a full `http(s):` URL — we normalise both
 * sides to a host before suffix-matching. Suffix-match means
 * `entry="example.com"` matches `news.example.com` as well as
 * `example.com` itself, but never `notexample.com`.
 */
export function domainMatches(entry: string, url: string): boolean {
  const host = hostOf(url);
  if (host === "") return false;
  let needle = entry.toLowerCase();
  if (needle.startsWith("http://") || needle.startsWith("https://")) {
    needle = hostOf(needle);
  }
  // Strip optional port.
  needle = needle.split(":")[0] ?? "";
  if (needle === "") return false;
  if (host === needle) return true;
  return host.endsWith(`.${needle}`);
}

/**
 * Apply allow/block-list filters and the per-call `maxResults` cap.
 * Pulled out so `FakeSearchProvider` and any real adapter share one
 * canonical filtering pass. `recencyDays` is honoured when the hit
 * carries `publishedAtSec`; older hits are dropped.
 */
export function filterAndCap(
  hits: readonly SearchHit[],
  opts: SearchOpts & { now?: () => number },
): SearchHit[] {
  const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  const allow = opts.allowedDomains ?? [];
  const block = opts.blockedDomains ?? [];
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (block.some((d) => domainMatches(d, h.url))) continue;
    if (allow.length > 0 && !allow.some((d) => domainMatches(d, h.url))) continue;
    if (
      opts.recencyDays !== undefined &&
      opts.recencyDays > 0 &&
      h.publishedAtSec !== undefined
    ) {
      const ageSec = now - h.publishedAtSec;
      if (ageSec > opts.recencyDays * 86400) continue;
    }
    out.push(h);
    if (out.length >= opts.maxResults) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* FakeSearchProvider                                                         */
/* -------------------------------------------------------------------------- */

/** Tagged corpus entry used by `FakeSearchProvider`. */
export interface FakeCorpusEntry {
  /** Substring(s) of the query that should hit this entry, lowercased. */
  readonly matches: readonly string[];
  readonly hit: SearchHit;
}

export interface FakeSearchProviderOpts {
  readonly corpus: readonly FakeCorpusEntry[];
  readonly now?: () => number;
}

/**
 * Deterministic search provider for tests and the worked example.
 * Matching: case-insensitive substring against `entry.matches`. A
 * single corpus entry can match many queries (and vice-versa). Hits
 * are returned in corpus order, then `filterAndCap` is applied.
 */
export class FakeSearchProvider implements SearchProvider {
  private readonly corpus: readonly FakeCorpusEntry[];
  private readonly now: () => number;

  public constructor(opts: FakeSearchProviderOpts) {
    this.corpus = opts.corpus;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  public async search(
    query: string,
    opts: SearchOpts,
  ): Promise<readonly SearchHit[]> {
    const q = query.toLowerCase();
    const matched: SearchHit[] = [];
    for (const e of this.corpus) {
      if (e.matches.some((m) => q.includes(m.toLowerCase()))) {
        matched.push(e.hit);
      }
    }
    return filterAndCap(matched, { ...opts, now: this.now });
  }
}

/**
 * Fixed corpus covering the two example queries used by `main.ts` and
 * the test harness ("solana", "ed25519 vs secp256k1") plus a handful
 * of generic entries so allow/block-list tests have something to chew
 * on.
 */
export const defaultFakeCorpus: readonly FakeCorpusEntry[] = [
  {
    matches: ["solana", "what is solana"],
    hit: {
      url: "https://docs.example.com/solana/overview",
      title: "Solana Overview",
      snippet:
        "Solana is a high-throughput proof-of-stake blockchain whose runtime executes parallel transactions via Sealevel.",
      publisher: "docs.example.com",
      publishedAtSec: 1700000000,
    },
  },
  {
    matches: ["solana", "consensus"],
    hit: {
      url: "https://wiki.example.org/Solana_consensus",
      title: "Solana consensus mechanism",
      snippet:
        "Tower BFT layered atop Proof of History gives Solana its fast finality.",
      publisher: "wiki.example.org",
      publishedAtSec: 1690000000,
    },
  },
  {
    matches: ["ed25519", "signature"],
    hit: {
      url: "https://crypto.example.net/ed25519",
      title: "Ed25519 signatures",
      snippet:
        "Ed25519 is a deterministic EdDSA scheme over Curve25519 with 128-bit security.",
      publisher: "crypto.example.net",
      publishedAtSec: 1685000000,
    },
  },
  {
    matches: ["secp256k1", "ecdsa"],
    hit: {
      url: "https://crypto.example.net/secp256k1",
      title: "secp256k1 in Bitcoin and Ethereum",
      snippet:
        "secp256k1 is a Koblitz curve used by Bitcoin and Ethereum for ECDSA signatures.",
      publisher: "crypto.example.net",
      publishedAtSec: 1680000000,
    },
  },
  {
    matches: ["ed25519 vs secp256k1", "vs"],
    hit: {
      url: "https://blog.example.com/ed25519-vs-secp256k1",
      title: "Ed25519 vs secp256k1",
      snippet:
        "Comparison of EdDSA-Ed25519 and ECDSA-secp256k1: determinism, speed, and audit history.",
      publisher: "blog.example.com",
      publishedAtSec: 1695000000,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* HttpSearchProvider scaffold                                                */
/* -------------------------------------------------------------------------- */

/** Structural subset of `globalThis.fetch` we depend on. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type HttpSearchProviderName = "tavily" | "brave" | "serpapi";

export interface HttpSearchProviderOpts {
  readonly fetch: FetchLike;
  readonly providerName?: string;
  readonly apiKey?: string;
}

/**
 * Scaffold for a real HTTP-backed search provider. Selects between
 * Tavily / Brave / SerpAPI by env (`WEB_RESEARCH_PROVIDER`) but throws
 * `search_provider_not_configured` until the per-provider request /
 * response mapping is wired in a follow-up task.
 *
 *   TODO(real-search-provider): implement Tavily / Brave / SerpAPI
 *   adapters. See `README.md` for the planned env wiring.
 */
export class HttpSearchProvider implements SearchProvider {
  private readonly providerName: string;
  private readonly apiKey: string | undefined;
  /** Reserved for future per-provider call-out. */
  private readonly _fetch: FetchLike;

  public constructor(opts: HttpSearchProviderOpts) {
    this._fetch = opts.fetch;
    this.providerName =
      opts.providerName ?? process.env.WEB_RESEARCH_PROVIDER ?? "";
    this.apiKey = opts.apiKey ?? process.env.WEB_RESEARCH_API_KEY;
  }

  public async search(
    _query: string,
    _opts: SearchOpts,
  ): Promise<readonly SearchHit[]> {
    void this._fetch;
    throw new Error(
      `search_provider_not_configured: name=${this.providerName || "<unset>"}, apiKey=${this.apiKey ? "set" : "missing"}`,
    );
  }
}
