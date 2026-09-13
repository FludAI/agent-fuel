/**
 * FUEL MCP server — ETHOnline 2026 (The Graph, AI track, from scratch).
 *
 * Five tools over two live Graph data sources:
 *  - agent-fuel subgraph (custom, this repo): swaps, hourly metrics,
 *    denomination credibility on the canonical wNEWS/USDC pool (Base).
 *  - Messari standardized Uniswap v3 Base subgraph (decentralized
 *    network): pool TVL / volume / swap counts — standardized schema,
 *    zero custom DEX indexing.
 *
 * Business-side entities (engagements, interventions) populate when the
 * FUEL contracts land on testnet; until then those fields are served as
 * clearly-labeled fixtures.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// params.local.json (gitignored) overrides the committed demo placeholders —
// real calibration is loaded at runtime and never enters the repo.
const PARAMS = (() => {
  if (process.env.PARAMS_JSON) {
    try { return JSON.parse(process.env.PARAMS_JSON); }
    catch (e) { console.error("PARAMS_JSON parse failed:", e); }
  }
  if (process.env.PARAMS_PATH) {
    try { return JSON.parse(readFileSync(process.env.PARAMS_PATH, "utf8")); }
    catch (e) { console.error("PARAMS_PATH read failed:", e); }
  }
  for (const f of ["params.local.json", "params.json"]) {
    try { return JSON.parse(readFileSync(join(HERE, "..", f), "utf8")); } catch {}
  }
  throw new Error("no params file found");
})();

const FUEL_SUBGRAPH =
  process.env.FUEL_SUBGRAPH_URL ??
  "https://api.studio.thegraph.com/query/1758890/agent-fuel/v0.1.1";
const MESSARI_UNIV3_BASE_ID = "FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS";
const POOL = "0x2dd7792966535333bae2f063bdf179f1bed220a4";

function messariUrl(): string {
  const key = process.env.GRAPH_API_KEY;
  if (!key) throw new Error("GRAPH_API_KEY not set (see .env)");
  return `https://gateway.thegraph.com/api/${key}/subgraphs/id/${MESSARI_UNIV3_BASE_ID}`;
}

// Real cash-leg lifecycle from Stripe (restricted read-only key) —
// initiated/pending/settled with Stripe's own available_on as the
// settlement date. Coarse fields only; absent key => null (fixture mode).
async function stripeCashLegs(): Promise<any | null> {
  const key = process.env.STRIPE_KEY;
  if (!key) return null;
  const api = async (path: string) => {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const j = (await r.json()) as any;
    if (j.error) throw new Error(j.error.message);
    return j;
  };
  const charges = await api("charges?limit=10");
  const now = Math.floor(Date.now() / 1000);
  const legs = [];
  for (const c of charges.data) {
    if (c.status !== "succeeded") continue;
    const bt = c.balance_transaction
      ? await api(`balance_transactions/${c.balance_transaction}`)
      : null;
    // Coarse bands only on a public tool: no charge ids, no per-charge amounts, dates to the day.
    legs.push({
      provider: "stripe",
      amount_usd: c.amount / 100,   // used for the totals below; not returned per leg
      initiated_on: new Date(c.created * 1000).toISOString().slice(0, 10),
      expected_settlement_on: bt ? new Date(bt.available_on * 1000).toISOString().slice(0, 10) : null,
      status: bt && bt.available_on <= now ? "settled" : "pending",
    });
  }
  const unsettled = legs.filter((l) => l.status === "pending").reduce((s, l) => s + l.amount_usd, 0);
  const settled = legs.filter((l) => l.status === "settled").reduce((s, l) => s + l.amount_usd, 0);
  const cap = (PARAMS as any).settlementFloatCapUsd ?? null;
  // the float cap is a reserve-policy parameter: only the verdict leaves the service, never the number
  return {
    source: "stripe-live",
    window: "last 10 charges",
    cash_legs: legs.map(({ amount_usd, ...rest }) => rest),
    counts: { settled: legs.filter((l) => l.status === "settled").length, pending: legs.filter((l) => l.status === "pending").length },
    settled_total_usd: Math.round(settled),
    unsettled_total_usd: Math.round(unsettled),
    within_float_cap: cap == null ? null : unsettled <= cap,
  };
}

async function gql(url: string, query: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as any;
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

// Factory: HTTP mode builds a fresh server+transport per request
// (stateless Streamable HTTP); stdio mode builds one.
function buildServer(): McpServer {
const server = new McpServer({ name: "fuel-mcp", version: "0.1.0" });

server.tool(
  "get_credibility",
  "Denomination credibility of the canonical wNEWS/USDC pool: how much " +
    "sell size the book absorbs while printing under 5% impact, plus spot " +
    "trend. Source: agent-fuel subgraph (live).",
  { hours: z.number().int().min(1).max(720).default(72) },
  async ({ hours }) => {
    const d = await gql(
      FUEL_SUBGRAPH,
      `{ pools { lastSpot swapCount }
         metricsSnapshots(first: ${hours}, orderBy: timestamp, orderDirection: desc) {
           timestamp spot credibility maxSellImpactBps volumeUsdc swapCount } }`
    );
    const snaps = d.metricsSnapshots;
    const best = snaps.reduce(
      (m: number, s: any) => Math.max(m, parseFloat(s.credibility)),
      0
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              spot_usdc_per_wnews: d.pools[0]?.lastSpot ?? null,
              credibility_best_usdc: best,
              interpretation:
                "largest single sell in the window that printed <5% impact",
              window_hours: hours,
              active_hours: snaps.length,
              lifetime_swaps: d.pools[0]?.swapCount ?? "0",
              recent: snaps.slice(0, 10),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_company_status",
  "Market + engagement status. Market side is live (Messari standardized " +
    "Uniswap v3 subgraph + agent-fuel subgraph); engagement side is a " +
    "labeled fixture until the FUEL contracts land.",
  {},
  async () => {
    const [mkt, own] = await Promise.all([
      gql(
        messariUrl(),
        `{ liquidityPool(id: "${POOL}") {
             name totalValueLockedUSD cumulativeSwapCount
             cumulativeVolumeUSD inputTokenBalances
             inputTokens { symbol decimals } } }`
      ),
      gql(FUEL_SUBGRAPH, `{ pools { lastSpot swapCount } }`),
    ]);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              market: {
                source: "messari-standardized + agent-fuel (both live)",
                pool: mkt.liquidityPool,
                spot_usdc_per_wnews: own.pools[0]?.lastSpot ?? null,
              },
              engagements: {
                source: "FIXTURE — FUEL contracts not yet deployed",
                active: 0,
                graded_unfunded_cohort: 0,
              },
              cash: (await stripeCashLegs()) ?? {
                source: "FIXTURE — no STRIPE_KEY in env",
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_threat_report",
  "Recent prints ranked by impact: large sells, drawdowns, and absorption " +
    "on the canonical pool. Source: agent-fuel subgraph (live).",
  { topN: z.number().int().min(1).max(50).default(10) },
  async ({ topN }) => {
    const d = await gql(
      FUEL_SUBGRAPH,
      `{ swaps(first: 200, orderBy: timestamp, orderDirection: desc) {
           timestamp usdcDelta wnewsDelta spotAfter printImpactBps } }`
    );
    const swaps = d.swaps as any[];
    const sells = swaps.filter((s) => parseFloat(s.wnewsDelta) > 0);
    const ranked = [...swaps]
      .sort((a, b) => b.printImpactBps - a.printImpactBps)
      .slice(0, topN);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              window_swaps: swaps.length,
              sells: sells.length,
              highest_impact_prints: ranked,
              note: "printImpactBps is print-vs-previous-print; the candle, not the notional",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_allocation_quote",
  "FUEL engagement quote per the FUEL pricing spec, computed on the LIVE print " +
    "from the canonical pool. Grade-gated: only fundable grades get fuel. " +
    "Parameters are demo placeholders (params.json); production " +
    "calibration is private.",
  {
    grade: z.enum(["measured", "reconciled", "declared", "modeled", "detected"]),
    market_cost_usd: z.number().positive(),
    dev_runrate_usd_month: z.number().positive(),
    funded_months: z.number().int().min(1).max(24).optional(),
  },
  async ({ grade, market_cost_usd, dev_runrate_usd_month, funded_months }) => {
    const d = await gql(FUEL_SUBGRAPH, `{ pools { lastSpot } }`);
    const P = parseFloat(d.pools[0]?.lastSpot ?? "0");
    if (P <= 0) throw new Error("no live print available");

    const p = PARAMS;
    const T = funded_months ?? p.fundedMonthsDefault;
    const pg = p.baselineOdds * p.gradeMultipliers_PLACEHOLDER[grade];
    const fundable = p.fundableGrades.includes(grade);
    const F = p.phi * market_cost_usd;
    const rMonthly = p.stakingRateAnnual / 12;
    const gap = Math.max(0, dev_runrate_usd_month - p.delta0 * F);
    const stakePerMonth = gap / (rMonthly * P);
    const expectedTokenCost = (stakePerMonth * T) / pg;
    const premium = p.mu * market_cost_usd;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              live_print_usdc_per_wnews: P,
              grade,
              implied_odds: pg,
              fundable,
              quote: fundable
                ? {
                    cash_fee_usdc: F,
                    stake_wnews_per_month: stakePerMonth,
                    funded_months: T,
                    expected_token_cost_wnews: expectedTokenCost,
                    success_premium_usdc: premium,
                    premium_waterfall: p.waterfall,
                    all_in_cost_multiple: p.phi + p.mu,
                  }
                : null,
              refusal_reason: fundable
                ? null
                : `grade '${grade}' below fundable gate at current print (expected token cost diverges: ${expectedTokenCost.toExponential(2)} wNEWS)`,
              params_note: p._note,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_intervention_response",
  "Observed market response to a protocol intervention (pre-registered " +
    "prediction vs realized). FIXTURE until Intervention events are " +
    "emitted on-chain; shape matches the subgraph schema.",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            source: "FIXTURE — no Intervention events on-chain yet",
            schema_ready: true,
            example_shape: {
              kind: "mint-bid",
              spotBefore: "0.0287",
              predictedResponseJson: "written BEFORE outcome",
              realized: "populated by subgraph when events land",
            },
          },
          null,
          2
        ),
      },
    ],
  })
);

// ---------------------------------------------------------------------------

// get_intervention_statement — one canonical intervention record, six readings.

// The MCP is the controlled interface, not a beneficiary: the record, the

// calculations and the renderings live in the FUEL consent service; this tool

// forwards the request and returns the reading verbatim (record version + hash

// included, so any two audiences can be shown to come from the same record).

// Requires CONSENT_URL and CONSENT_AGENT_TOKEN; without them the tool says so.

// ---------------------------------------------------------------------------

server.tool(

  "get_intervention_statement",

  "The audience-specific reading of one intervention — business, operator, " +

    "agent, steward (core-customer), supporter (capital), attestor — generated " +

    "deterministically from the canonical intervention record. Returns facts, " +

    "calculations, the statement, missing terms, warnings, and the record hash.",

  {

    interventionId: z.string().regex(/^[\w.-]{1,32}$/),

    audience: z.enum(["business", "operator", "agent", "steward", "supporter", "attestor", "all"]).default("business"),

    asOf: z.string().datetime().optional(),

  },

  async ({ interventionId, audience, asOf }) => {

    const url = process.env.CONSENT_URL;

    const token = process.env.CONSENT_AGENT_TOKEN;

    if (!url || !token) {

      return { content: [{ type: "text", text: JSON.stringify({ error: "statement service not configured on this deployment (CONSENT_URL / CONSENT_AGENT_TOKEN)" }) }] };

    }

    const r = await fetch(`${url.replace(/\/$/, "")}/statement`, {

      method: "POST",

      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },

      body: JSON.stringify({ interventionId, audience, asOf }),

    });

    const j = await r.json();

    return { content: [{ type: "text", text: JSON.stringify(j, null, 2) }], ...(r.ok ? {} : { isError: true }) };

  }

);


return server;
}

if (process.env.MCP_HTTP || process.env.K_SERVICE) {
  // Hosted mode (Cloud Run): stateless Streamable HTTP on $PORT.
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/mcp", async (req, res) => {
    const s = buildServer();
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { t.close(); s.close(); });
    await s.connect(t);
    await t.handleRequest(req, res, req.body);
  });
  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, name: "fuel-mcp", tools: 5, sources: ["agent-fuel subgraph", "messari standardized", "stripe cash-leg"] }));
  app.use((_req, res) => res.status(404).json({ error: "not found — MCP at POST /mcp" }));
  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => console.error(`fuel-mcp: streamable HTTP on :${port}`));
} else {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("fuel-mcp: 5 tools on stdio (2 subgraph sources live)");
}
