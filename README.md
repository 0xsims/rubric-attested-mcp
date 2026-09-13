# rubric-attested-mcp

MCP server that exposes [Rubric Protocol](https://rubric-protocol.com)'s live,
attested price feeds as tools for any MCP-wired agent (Claude Code, Cursor,
Windsurf, etc). Handles the [x402](https://x402.org) `402 -> pay -> retry`
flow automatically via Coinbase's official `x402-fetch`.

**Why this instead of any other price feed:** every response is signed with
**ML-DSA-65** (FIPS 204 post-quantum) and anchored to **Hedera Consensus
Service**. The returned `attestationId` can be independently verified forever
at `rubric-protocol.com/v1/verify/:attestationId` — free, public, no further
trust in Rubric required.

Rubric's own agent identity is registered on-chain at
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry
(`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Base mainnet).

## Tools

### `get_attested_price`
Paid ($0.02 USDC via x402 on Base mainnet). Live spot price for a Base-mainnet
asset pair read straight from Chainlink aggregators via `eth_call`.

- `symbol` (string, required) — e.g. `"ETH"`, `"BTC/USD"`
- `proof` (boolean, optional) — include the raw Chainlink round tuple + a
  disclosed commitment opening for independent recomputation ($0.25 instead)
- `at` (string, optional) — ISO-8601 timestamp for a historical price instead
  of latest ($0.50)

### `list_attested_services`
Free. Returns Rubric's live x402 service catalog
(`rubric-protocol.com/.well-known/x402.json`) — every priced route, price,
network, and description.

## Install

```bash
npm install -g rubric-attested-mcp
```

## Configure

Add to your MCP client config (Claude Code, Cursor, Windsurf, etc):

```json
{
  "mcpServers": {
    "rubric-attested": {
      "command": "rubric-attested-mcp",
      "env": {
        "RUBRIC_MCP_PAYER_KEY": "0x<your-base-mainnet-wallet-private-key>"
      }
    }
  }
}
```

`RUBRIC_MCP_PAYER_KEY` is an EOA private key funded with USDC on Base mainnet
— it pays for `get_attested_price` calls directly (EIP-3009 `exact` scheme,
no smart account/bundler needed). `list_attested_services` works with no key
configured.

## Develop

```bash
npm install
npm run build
npm start
```

## License

MIT
