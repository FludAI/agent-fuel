// Smoke test: hits both live endpoints and runs the quote math once.
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = /GRAPH_API_KEY=(\w+)/.exec(env)[1];
const FUEL = "https://api.studio.thegraph.com/query/1758890/agent-fuel/v0.1.1";
const MESSARI = `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS`;

const gql = async (u, q) => {
  const r = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const b = await r.json();
  if (b.errors) throw new Error(JSON.stringify(b.errors));
  return b.data;
};

const d = await gql(
  FUEL,
  "{ pools { lastSpot swapCount } metricsSnapshots(first:3,orderBy:timestamp,orderDirection:desc){ spot credibility maxSellImpactBps } }"
);
console.log("agent-fuel OK:", JSON.stringify(d.pools[0]));

const m = await gql(
  MESSARI,
  '{ liquidityPool(id: "0x2dd7792966535333bae2f063bdf179f1bed220a4"){ totalValueLockedUSD cumulativeSwapCount } }'
);
console.log("messari OK:", JSON.stringify(m.liquidityPool));

const P = parseFloat(d.pools[0].lastSpot);
const phi = 0.15, mu = 1.5, d0 = 0.6, r = 0.12 / 12, T = 6, pg = 0.001 * 200;
const F = phi * 5000;
const stake = Math.max(0, 3000 - d0 * F) / (r * P);
console.log(
  `quote(measured, M=$5000, c=$3000/mo): fee=$${F} stake/mo=${Math.round(stake).toLocaleString()} wNEWS  expected-cost=${Math.round((stake * T) / pg).toLocaleString()} wNEWS  premium=$${mu * 5000}`
);
