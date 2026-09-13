/**
 * Thin client for Rubric Protocol's x402-paid attested-price routes.
 * Handles the 402 -> sign EIP-3009 USDC authorization -> retry flow via
 * Coinbase's official x402-fetch, so callers just get back JSON.
 */
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const RUBRIC_BASE_URL = "https://rubric-protocol.com";
const CALL_TIMEOUT_MS = 30_000;

export interface RubricCallResult {
  ok: boolean;
  status: number;
  paid: boolean;
  body: unknown;
  error?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let cachedFetcher: FetchLike | null = null;

/** Lazily builds the payment-wrapped fetch. Fails loudly if no payer key is configured. */
function paymentFetcher(): FetchLike {
  if (cachedFetcher) return cachedFetcher;

  const privateKey = process.env.RUBRIC_MCP_PAYER_KEY;
  if (!privateKey || !privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error(
      "RUBRIC_MCP_PAYER_KEY is not set to a valid 0x-prefixed 32-byte private key. " +
        "This wallet pays Rubric's x402 price in USDC on Base mainnet for every call " +
        "(see tool descriptions for cost). Configure it in your MCP client's env block.",
    );
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  // 1 USDC (6 decimals) is far above any route's price ($0.02-$0.50); this is a safety
  // ceiling against a misbehaving server, not an expected spend.
  const maxAtomicUnits = 1_000_000n;
  cachedFetcher = wrapFetchWithPayment(fetch, walletClient as any, maxAtomicUnits) as FetchLike;
  return cachedFetcher;
}

async function callPaid(path: string): Promise<RubricCallResult> {
  const url = RUBRIC_BASE_URL + path;
  let fetcher: FetchLike;
  try {
    fetcher = paymentFetcher();
  } catch (e) {
    return { ok: false, status: 0, paid: false, body: null, error: (e as Error).message };
  }

  let res: Response;
  try {
    res = await fetcher(url, { method: "GET", signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      paid: false,
      body: null,
      error: `Request to ${url} failed: ${msg}. Common causes: insufficient USDC on Base mainnet in the payer wallet, or the symbol is unsupported.`,
    };
  }

  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON, keep raw text */
  }

  return {
    ok: res.ok,
    status: res.status,
    paid: Boolean(res.headers.get("x-payment-response")),
    body,
  };
}

/** GET /v1/x402/attested-price/:symbol[/proof|/at/:timestamp] */
export async function getAttestedPrice(
  symbol: string,
  opts: { proof?: boolean; at?: string } = {},
): Promise<RubricCallResult> {
  const encodedSymbol = encodeURIComponent(symbol);
  let path = `/v1/x402/attested-price/${encodedSymbol}`;
  if (opts.at) path += `/at/${encodeURIComponent(opts.at)}`;
  else if (opts.proof) path += `/proof`;
  return callPaid(path);
}

/** GET /.well-known/x402.json — free, unpaid, public. Rubric's live x402 service catalog. */
export async function listAttestedServices(): Promise<RubricCallResult> {
  try {
    const res = await fetch(RUBRIC_BASE_URL + "/.well-known/x402.json", {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const body = await res.json();
    return { ok: res.ok, status: res.status, paid: false, body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, paid: false, body: null, error: msg };
  }
}
