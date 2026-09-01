import { referenceMeasure } from "./observability.ts";
import { sanitizeLine } from "./prompt.ts";

export type ReferenceSource = {
  title: string;
  url: string;
};

export type ReferenceDecision = {
  research: boolean;
  fresh: boolean;
  reason: string;
  cacheHit: boolean;
};

export type ReferenceContext = {
  observedAt: string;
  marketFacts: string[];
  facts: string[];
  entities: string[];
  visualNotes: string[];
  sources: ReferenceSource[];
  searched: boolean;
  decision: ReferenceDecision;
};

export type ResolveReferenceOptions = {
  knownTerms?: string[];
  forceResearch?: boolean;
  bypassCache?: boolean;
};

type ExaSearchResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  highlights?: string[];
};

type ExaOutput = {
  content?: unknown;
  grounding?: Array<{
    field?: string;
    citations?: Array<{ title?: string; url?: string }>;
  }>;
};

type ExaResponse = {
  results?: ExaSearchResult[];
  output?: ExaOutput;
  requestId?: string;
};

type CachedReference = {
  expiresAtMs: number;
  value: ReferenceContext;
};

const PRICE_SIGNAL =
  /\b(price|worth|trading at|spot|market price|costs?|usd|dollars?|today|now|current)\b/i;
const FRESH_SIGNAL =
  /\b(today|tonight|right now|now|current|currently|latest|live|price|weather|score|result|president|ceo|newest|this week|this month)\b/i;
const EXTERNAL_REFERENCE_SIGNAL =
  /\b(meme|character|celebrity|actor|singer|rapper|politician|president|ceo|brand|product|game|movie|film|anime|cartoon|show|series|team|player|company|coin|token|stock|ticker|website|tiktok|youtube|instagram|x\.com|twitter|reddit|news|headline|weather|score|result|election)\b/i;
const URL_OR_HANDLE_SIGNAL = /(?:https?:\/\/|www\.|@[a-z0-9_]{2,})/i;
const COMMON_CAPITALIZED = new Set([
  "The",
  "A",
  "An",
  "This",
  "That",
  "He",
  "She",
  "They",
  "It",
  "Raccoon",
  "Store",
]);

const MARKET_ASSETS: Array<{ symbol: string; names: RegExp }> = [
  { symbol: "BTC", names: /\b(bitcoin|btc)\b/i },
  { symbol: "ETH", names: /\b(ethereum|ether|eth)\b/i },
  { symbol: "SOL", names: /\b(solana|sol)\b/i },
  { symbol: "DOGE", names: /\b(dogecoin|doge)\b/i },
];

const CACHE = new Map<string, CachedReference>();
const FRESH_CACHE_MS = Math.max(
  0,
  Number(process.env.PUMPTV_REFERENCE_FRESH_CACHE_MS || 15_000),
);
const NORMAL_CACHE_MS = Math.max(
  0,
  Number(process.env.PUMPTV_REFERENCE_CACHE_MS || 5 * 60_000),
);

function compact(value: unknown, max = 500) {
  return sanitizeLine(String(value ?? ""), max);
}

function normalizeKey(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeTerms(values: string[] | undefined) {
  return (values || [])
    .map((value) => normalizeKey(value))
    .filter(Boolean)
    .slice(0, 32);
}

function cloneContext(
  context: ReferenceContext,
  cacheHit: boolean,
): ReferenceContext {
  return {
    ...context,
    marketFacts: [...context.marketFacts],
    facts: [...context.facts],
    entities: [...context.entities],
    visualNotes: [...context.visualNotes],
    sources: context.sources.map((source) => ({ ...source })),
    decision: { ...context.decision, cacheHit },
  };
}

export function detectMarketSymbols(text: string): string[] {
  if (!PRICE_SIGNAL.test(text)) return [];
  return MARKET_ASSETS.filter((asset) => asset.names.test(text)).map(
    (asset) => asset.symbol,
  );
}

function unknownCapitalizedTerms(text: string, knownTerms: string[]) {
  const matches = text.match(/\b[A-Z][A-Za-z0-9'_-]{2,}\b/g) || [];
  return matches.filter((term) => {
    if (COMMON_CAPITALIZED.has(term)) return false;
    const normalized = normalizeKey(term);
    return !knownTerms.some(
      (known) => known === normalized || known.includes(normalized),
    );
  });
}

export function decideReferenceResearch(
  directive: string,
  options: ResolveReferenceOptions = {},
): Omit<ReferenceDecision, "cacheHit"> {
  const text = compact(directive, 700);
  const knownTerms = normalizeTerms(options.knownTerms);
  const marketSymbols = detectMarketSymbols(text);
  const fresh = FRESH_SIGNAL.test(text) || marketSymbols.length > 0;

  if (options.forceResearch)
    return { research: true, fresh, reason: "forced by operator" };
  if (URL_OR_HANDLE_SIGNAL.test(text))
    return { research: true, fresh, reason: "URL or social handle reference" };
  if (EXTERNAL_REFERENCE_SIGNAL.test(text))
    return { research: true, fresh, reason: "external-reference signal" };

  const marketSet = new Set(
    marketSymbols.map((symbol) => symbol.toLowerCase()),
  );
  const unknownCaps = unknownCapitalizedTerms(text, knownTerms).filter(
    (term) => !marketSet.has(term.toLowerCase()),
  );
  if (unknownCaps.length)
    return {
      research: true,
      fresh,
      reason: `unknown named reference: ${unknownCaps.slice(0, 2).join(", ")}`,
    };

  // A dedicated market provider is more reliable and faster than a generic
  // search for straightforward current crypto-price prompts.
  if (marketSymbols.length)
    return {
      research: false,
      fresh: true,
      reason: "dedicated market-price lookup is sufficient",
    };

  if (fresh)
    return {
      research: true,
      fresh: true,
      reason: "fresh/current fact requested",
    };

  return {
    research: false,
    fresh: false,
    reason: "self-contained scene intent",
  };
}

function uniqueStrings(values: unknown, maxItems = 8, maxLength = 420) {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = compact(raw, maxLength);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseOutputContent(content: unknown): Record<string, unknown> {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content !== "string" || !content.trim()) return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { summary: content };
  }
}

function collectSources(response: ExaResponse): ReferenceSource[] {
  const candidates: ReferenceSource[] = [];
  for (const result of response.results || []) {
    if (result.url) {
      candidates.push({
        title: compact(result.title || result.url, 160),
        url: result.url,
      });
    }
  }
  for (const grounding of response.output?.grounding || []) {
    for (const citation of grounding.citations || []) {
      if (!citation.url) continue;
      candidates.push({
        title: compact(citation.title || citation.url, 160),
        url: citation.url,
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((item) => {
      if (!item.url || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, 6);
}

async function lookupCoinbaseSpot(symbol: string): Promise<string | null> {
  return referenceMeasure.measure(
    {
      start: () => `Market price · ${symbol}-USD`,
      end: (fact) => ({ symbol, found: Boolean(fact) }),
      catch: () => null,
    },
    async () => {
      const response = await fetch(
        `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(4_000),
        },
      );
      if (!response.ok) throw new Error(`Coinbase ${response.status}`);
      const body = (await response.json()) as {
        data?: { amount?: string; currency?: string };
      };
      const amount = body.data?.amount;
      if (!amount || !Number.isFinite(Number(amount))) return null;
      const pretty = Number(amount).toLocaleString("en-US", {
        maximumFractionDigits: Number(amount) >= 100 ? 2 : 6,
      });
      return `${symbol} spot price: $${pretty} ${body.data?.currency || "USD"} (Coinbase, fetched ${new Date().toISOString()})`;
    },
  );
}

async function searchExaReference(
  directive: string,
  fresh: boolean,
): Promise<{
  facts: string[];
  entities: string[];
  visualNotes: string[];
  sources: ReferenceSource[];
  searched: boolean;
}> {
  const apiKey = (process.env.EXA_API_KEY || "").trim();
  if (!apiKey) {
    referenceMeasure.measureSync("Exa reference search skipped", () => ({
      reason: "EXA_API_KEY missing",
    }));
    return {
      facts: [],
      entities: [],
      visualNotes: [],
      sources: [],
      searched: false,
    };
  }

  return referenceMeasure.measure(
    {
      start: () => `Exa reference search · ${fresh ? "fresh" : "normal"}`,
      end: (result) => ({
        facts: result.facts.length,
        entities: result.entities.length,
        visuals: result.visualNotes.length,
        sources: result.sources.length,
      }),
      catch: () => ({
        facts: [],
        entities: [],
        visualNotes: [],
        sources: [],
        searched: false,
      }),
    },
    async () => {
      const query = [
        "Resolve external references in this viewer proposal for a five-second AI video scene.",
        `Viewer proposal: ${JSON.stringify(compact(directive, 700))}`,
        "Find only information that materially helps interpret named, recent, obscure, fictional, meme, product, place, person, or current-fact references.",
        "For current facts or numbers, prefer a fresh trustworthy source and do not guess an exact value.",
      ].join("\n");

      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          type: "fast",
          numResults: 5,
          moderation: true,
          systemPrompt:
            "Return a tiny production reference brief. Ignore ordinary nouns and actions. Do not add trivia. Prefer primary/official sources when practical. If nothing external is useful, return empty arrays. Current numerical facts must come from retrieved sources, never model memory.",
          outputSchema: {
            type: "object",
            required: ["summary", "facts", "entities", "visualNotes"],
            properties: {
              summary: {
                type: "string",
                description:
                  "At most two sentences of useful interpretation, or empty string.",
              },
              facts: {
                type: "array",
                items: { type: "string" },
                description: "Current or factual details useful to this shot.",
              },
              entities: {
                type: "array",
                items: { type: "string" },
                description:
                  "Short identity descriptions for named or obscure references.",
              },
              visualNotes: {
                type: "array",
                items: { type: "string" },
                description:
                  "Only visually useful identifying traits for referenced entities.",
              },
            },
          },
          contents: {
            highlights: {
              query: compact(directive, 500),
              maxCharacters: 1200,
            },
            maxAgeHours: fresh ? 0 : 168,
            livecrawlTimeout: 5_000,
          },
        }),
        signal: AbortSignal.timeout(fresh ? 9_000 : 7_000),
      });

      if (!response.ok) {
        const text = compact(await response.text(), 500);
        throw new Error(`Exa ${response.status}: ${text}`);
      }

      const body = (await response.json()) as ExaResponse;
      const content = parseOutputContent(body.output?.content);
      const summary = compact(content.summary, 520);
      const facts = uniqueStrings(content.facts, 6);
      if (summary) facts.unshift(summary);

      return {
        facts: uniqueStrings(facts, 7),
        entities: uniqueStrings(content.entities, 5),
        visualNotes: uniqueStrings(content.visualNotes, 5),
        sources: collectSources(body),
        searched: true,
      };
    },
  );
}

export async function resolveExternalReferences(
  directive: string,
  options: ResolveReferenceOptions = {},
): Promise<ReferenceContext> {
  const observedAt = new Date().toISOString();
  const marketSymbols = detectMarketSymbols(directive);
  const decision = decideReferenceResearch(directive, options);
  const cacheKey = normalizeKey(directive);
  const ttlMs = decision.fresh ? FRESH_CACHE_MS : NORMAL_CACHE_MS;

  if (!options.bypassCache && ttlMs > 0) {
    const cached = CACHE.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return referenceMeasure.measureSync("Reference cache hit", () =>
        cloneContext(cached.value, true),
      );
    }
  }

  return referenceMeasure.measure(
    {
      start: () => "Resolve viewer references",
      end: (context) => ({
        marketFacts: context.marketFacts.length,
        facts: context.facts.length,
        entities: context.entities.length,
        visuals: context.visualNotes.length,
        sources: context.sources.length,
        searched: context.searched,
        research: context.decision.research,
        reason: context.decision.reason,
      }),
    },
    async () => {
      const [marketResults, exa] = await Promise.all([
        Promise.all(marketSymbols.map((symbol) => lookupCoinbaseSpot(symbol))),
        decision.research
          ? searchExaReference(directive, decision.fresh)
          : Promise.resolve({
              facts: [],
              entities: [],
              visualNotes: [],
              sources: [],
              searched: false,
            }),
      ]);

      const value: ReferenceContext = {
        observedAt,
        marketFacts: marketResults.filter((value): value is string =>
          Boolean(value),
        ),
        facts: exa.facts,
        entities: exa.entities,
        visualNotes: exa.visualNotes,
        sources: exa.sources,
        searched: exa.searched,
        decision: { ...decision, cacheHit: false },
      };

      if (ttlMs > 0) {
        CACHE.set(cacheKey, {
          expiresAtMs: Date.now() + ttlMs,
          value: cloneContext(value, false),
        });
        if (CACHE.size > 128) {
          const oldest = CACHE.keys().next().value;
          if (oldest) CACHE.delete(oldest);
        }
      }

      return value;
    },
  );
}

export function referenceContextForShowrunner(context: ReferenceContext) {
  const lines: string[] = [];
  lines.push(`Observed: ${context.observedAt}`);
  for (const fact of context.marketFacts) lines.push(`MARKET FACT: ${fact}`);
  for (const fact of context.facts) lines.push(`FACT: ${fact}`);
  for (const entity of context.entities) lines.push(`ENTITY: ${entity}`);
  for (const note of context.visualNotes) lines.push(`VISUAL: ${note}`);
  if (context.sources.length) {
    lines.push(
      `Sources: ${context.sources
        .slice(0, 4)
        .map((source) => `${source.title} — ${source.url}`)
        .join(" | ")}`,
    );
  }
  return lines.join("\n").slice(0, 5_500);
}
