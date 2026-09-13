#!/usr/bin/env node
/**
 * rubric-attested-mcp — MCP server exposing Rubric Protocol's live attested
 * price feeds as tools, so any MCP-wired agent (Claude Code, Cursor, Windsurf)
 * can discover and pay for them without leaving its runtime.
 *
 * Every priced call carries a receipt no other price feed can produce: the
 * response is signed with ML-DSA-65 (FIPS 204 post-quantum) and anchored to
 * Hedera Consensus Service — independently verifiable via the free
 * /v1/verify/:attestationId endpoint, forever, without trusting Rubric again.
 *
 * Tools:
 *   - get_attested_price: paid (x402, USDC on Base). Handles 402 -> sign -> retry.
 *   - list_attested_services: free. Live catalog from Rubric's x402 bazaar manifest.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAttestedPrice, listAttestedServices } from "./rubric-client.js";

const server = new McpServer({ name: "rubric-attested-mcp", version: "0.1.0" });

server.registerTool(
  "get_attested_price",
  {
    title: "Get attested price (Rubric Protocol)",
    description:
      "Live spot price for a Base-mainnet asset pair (e.g. 'ETH', 'BTC', 'SOL'), read straight from " +
      "Chainlink aggregators via eth_call — no cached feed, no third-party price API in the trust path. " +
      "Pays Rubric Protocol $0.02 USDC per call via x402 (auto pay-and-retry on the 402; needs " +
      "RUBRIC_MCP_PAYER_KEY funded with USDC on Base mainnet). " +
      "The differentiator: every response is sealed with an ML-DSA-65 (FIPS 204 post-quantum) signature " +
      "and anchored to Hedera Consensus Service — the returned attestationId can be independently " +
      "verified forever at rubric-protocol.com/v1/verify/:attestationId, free, with no further trust in " +
      "Rubric required. Set proof:true ($0.25) for the raw Chainlink round tuple + a disclosed commitment " +
      "opening so a third party can recompute the receipt themselves; set at:<ISO timestamp> ($0.50) for " +
      "a historical price walked from on-chain round history instead of the latest one.",
    inputSchema: {
      symbol: z
        .string()
        .min(1)
        .describe("Asset symbol, e.g. 'ETH' or 'ETH/USD'. See list_attested_services for supported pairs."),
      proof: z
        .boolean()
        .optional()
        .describe("If true, also return the raw Chainlink round tuple + commitment opening ($0.25 instead of $0.02)."),
      at: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp for a historical price instead of latest ($0.50). Mutually exclusive with proof."),
    },
  },
  async ({ symbol, proof, at }) => {
    const result = await getAttestedPrice(symbol, { proof, at });
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "list_attested_services",
  {
    title: "List Rubric's attested x402 services",
    description:
      "Free, unpaid. Returns Rubric Protocol's live x402 service catalog (fetched fresh from " +
      "rubric-protocol.com/.well-known/x402.json) — every paid route Rubric exposes, its price, network, " +
      "and description, including but not limited to the attested-price family. Every listed route returns " +
      "an ML-DSA-65 + Hedera-anchored receipt with its response; use this to discover exact resource paths " +
      "and prices before calling get_attested_price or another route directly.",
    inputSchema: {},
  },
  async () => {
    const result = await listAttestedServices();
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
