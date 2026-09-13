# agent-fuel — FUEL subgraph (canonical wNEWS/USDC pool, Base)

ETHOnline 2026. Indexes the market surface of the canonical wNEWS/USDC
Uniswap v3 pool on Base (`0x2dd7792966535333bae2f063bdf179f1bed220a4`,
0.3%, deployed at block 45,499,342 — verified on-chain) and declares the
FUEL business-side schema the MCP server consumes.

## Entities

- `Pool`, `Wallet`, `Swap` — raw market events. Prices derive from
  `sqrtPriceX96` at swap time (token0 = USDC 6d, token1 = wNEWS 18d,
  verified via `token0()`/`token1()` calls), never from quote APIs.
- `MetricsSnapshot` — hourly rollup: OHLC-ish spot, USDC volume, and a
  denomination-credibility measure (largest single sell this hour that
  printed under 5% impact).
- `Business`, `Grading`, `AssignmentEvent` — FUEL engagement schema,
  declared now for API-shape stability; populated when the FUEL
  contracts land. One `AssignmentEvent` row per decision, funded or
  not, with mechanism and decision-time state recorded.

Wallet note: this is a public subgraph — `ownerClass` is always
`UNCLASSIFIED` here by design.

## Live endpoints

- **MCP (Streamable HTTP):** `https://fuel-mcp-667990366434.us-central1.run.app/mcp`
  — five tools over two live Graph sources; POST JSON-RPC. Production
  calibration is injected server-side (Secret Manager); the repo carries
  demo placeholders only.
- Subgraph: `https://api.studio.thegraph.com/query/1758890/agent-fuel/v0.1.1`
- Bridge status/ops/animations: `https://wnews-bridge-667990366434.us-central1.run.app/status/`

Local run (reproducibility path): `cd mcp && npm install && npm start` (stdio).

## Build & deploy

```
npm install
npx graph codegen && npx graph build
npx graph deploy agent-fuel   # needs Subgraph Studio auth
```

Market data composition: pool-level DEX metrics that a standardized
schema already covers are consumed from the Messari standardized
Uniswap v3 subgraph; this subgraph indexes only what is unique to FUEL.

## Notices

© 2026 FludAI / viability.news. Code licensed MIT (see LICENSE).
Patents pending. No patent rights are granted by this license.
