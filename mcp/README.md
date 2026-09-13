# fuel-mcp — FUEL tools over The Graph (ETHOnline 2026, from scratch)

MCP server exposing five FUEL tools, backed by two live Graph data
sources: the custom `agent-fuel` subgraph (this repo) and the **Messari
standardized Uniswap v3 Base subgraph** on the decentralized network —
the standardized schema serves all generic DEX metrics, so the custom
subgraph indexes only what is unique to FUEL.

| Tool | Data |
|---|---|
| `get_credibility` | live — denomination credibility from hourly rollups |
| `get_threat_report` | live — prints ranked by impact |
| `get_company_status` | live market via Messari + agent-fuel; engagement side labeled FIXTURE until FUEL contracts deploy |
| `get_allocation_quote` | live print × the FUEL pricing spec formula (params.json holds DEMO placeholders; production calibration is private) |
| `get_intervention_response` | labeled FIXTURE (schema-ready) |

## Run

```
cd mcp
npm install
echo GRAPH_API_KEY=<your key from Subgraph Studio> > ../.env
node smoke.mjs        # verifies both live endpoints + quote math
npm start             # MCP server on stdio
```

Claude Desktop / Code config:

```json
{ "mcpServers": { "fuel": { "command": "npx", "args": ["tsx", "<path>/mcp/src/server.ts"] } } }
```
