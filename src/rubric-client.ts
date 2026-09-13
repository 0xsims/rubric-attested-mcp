/**
 * Thin client for Rubric Protocol's x402-paid attested-price routes.
 *
 * Rubric's server-side verifier is hand-rolled (see x402-services-endpoint.ts
 * gate(), "no SDK"), not the reference x402 facilitator wire format: it wants
 * the buyer's payment payload as `{x402Version, accepted: {...CAIP-2 network,
 * amount, payTo...}, payload: {signature, authorization}}`, whereas the
 * official `x402-fetch`/`x402/client` helpers build and validate the
 * standard `{x402Version, scheme, network: "base", payload}` shape (short
 * chain names, no `accepted` wrapper). Neither `wrapFetchWithPayment` nor
 * `createPaymentHeader` can produce what Rubric expects, so this parses the
 * 402 itself and calls the two lower-level `x402/client` primitives that
 * *do* still fit — `preparePaymentHeader` (builds the unsigned EIP-3009
 * authorization) and `signPaymentHeader` (the actual signTypedData call) —
 * then wraps the result in Rubric's envelope by hand. The cryptographic
 * signing is still the audited x402 SDK code; only the envelope shape is
 * custom.
 */
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { preparePaymentHeader, signPaymentHeader } from "x402/client";
import type { PaymentRequirements } from "x402/types";

const RUBRIC_BASE_URL = "https://rubric-protocol.com";
const CALL_TIMEOUT_MS = 30_000;

// Rubric only prices in USDC on Base mainnet today; mapping is kept explicit
// (rather than a generic CAIP-2 parser) so an unrecognized chain fails loudly
// instead of silently signing against the wrong network.
const CAIP2_TO_X402_NETWORK: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
};

// Safety ceiling against a misbehaving server, not an expected spend — every
// route here prices $0.02-$0.50.
const MAX_ATOMIC_UNITS = 1_000_000n; // 1 USDC

export interface RubricCallResult {
  ok: boolean;
  status: number;
  paid: boolean;
  body: unknown;
  error?: string;
}

function payerAccount() {
  const privateKey = process.env.RUBRIC_MCP_PAYER_KEY;
  if (!privateKey || !privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error(
      "RUBRIC_MCP_PAYER_KEY is not set to a valid 0x-prefixed 32-byte private key. " +
        "This wallet pays Rubric's x402 price in USDC on Base mainnet for every call " +
        "(see tool descriptions for cost). Configure it in your MCP client's env block.",
    );
  }
  return privateKeyToAccount(privateKey as `0x${string}`);
}

/** Picks the "exact" EVM accept-entry Rubric offers. */
function pickAcceptEntry(body: any): any {
  const accepts: any[] = body?.accepts ?? [];
  const entry = accepts.find(
    (a) => a.scheme === "exact" && CAIP2_TO_X402_NETWORK[a.network] !== undefined,
  );
  if (!entry) {
    throw new Error(
      `No supported "exact"-scheme EVM accept entry in 402 response. Networks offered: ${accepts.map((a) => a.network).join(", ")}`,
    );
  }
  return entry;
}

/** x402/client's signing helpers key off the short chain name, not Rubric's CAIP-2 one. */
function signingRequirements(entry: any): PaymentRequirements {
  return {
    scheme: "exact",
    network: CAIP2_TO_X402_NETWORK[entry.network] as PaymentRequirements["network"],
    maxAmountRequired: entry.amount,
    resource: RUBRIC_BASE_URL,
    description: "",
    mimeType: "application/json",
    payTo: entry.payTo,
    maxTimeoutSeconds: entry.maxTimeoutSeconds,
    asset: entry.asset,
    extra: entry.extra,
  };
}

async function callPaid(path: string): Promise<RubricCallResult> {
  const url = RUBRIC_BASE_URL + path;

  let account;
  try {
    account = payerAccount();
  } catch (e) {
    return { ok: false, status: 0, paid: false, body: null, error: (e as Error).message };
  }
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  let firstRes: Response;
  try {
    firstRes = await fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, paid: false, body: null, error: `Request to ${url} failed: ${msg}` };
  }

  if (firstRes.status !== 402) {
    return await toResult(firstRes);
  }

  const challenge = await firstRes.json();
  let entry: any;
  try {
    entry = pickAcceptEntry(challenge);
  } catch (e) {
    return { ok: false, status: 402, paid: false, body: challenge, error: (e as Error).message };
  }

  if (BigInt(entry.amount) > MAX_ATOMIC_UNITS) {
    return {
      ok: false,
      status: 402,
      paid: false,
      body: challenge,
      error: `Price ${entry.amount} atomic units exceeds this client's safety ceiling (${MAX_ATOMIC_UNITS}).`,
    };
  }

  const requirements = signingRequirements(entry);
  let paymentB64: string;
  try {
    const unsigned = preparePaymentHeader(account.address, challenge.x402Version, requirements);
    // The public signPaymentHeader signs AND base64-encodes into the standard
    // x402 envelope; decode it back to get at the signed {signature, authorization}
    // payload, which is the part Rubric's own envelope also needs verbatim.
    const standardEnvelopeB64 = await signPaymentHeader(walletClient as any, requirements, unsigned);
    const standardEnvelope = JSON.parse(Buffer.from(standardEnvelopeB64, "base64").toString("utf8"));

    // Rubric's hand-rolled verifier (gate() in x402-services-endpoint.ts) reads
    // pp.accepted.{scheme,network} and pp.payload.{signature,authorization} —
    // its own envelope, not the standard x402 PaymentPayload shape.
    const rubricPayload = {
      x402Version: challenge.x402Version,
      accepted: {
        scheme: entry.scheme,
        network: entry.network, // CAIP-2, e.g. "eip155:8453" — as Rubric sent it
        asset: entry.asset,
        payTo: entry.payTo,
        amount: entry.amount,
        maxTimeoutSeconds: entry.maxTimeoutSeconds,
        extra: entry.extra,
      },
      payload: standardEnvelope.payload,
    };
    paymentB64 = Buffer.from(JSON.stringify(rubricPayload)).toString("base64");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 402,
      paid: false,
      body: challenge,
      error: `Failed to sign payment authorization: ${msg}. Common cause: insufficient USDC on Base mainnet in wallet ${account.address}.`,
    };
  }

  let secondRes: Response;
  try {
    secondRes = await fetch(url, {
      headers: { "X-PAYMENT": paymentB64 },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, paid: false, body: null, error: `Paid retry to ${url} failed: ${msg}` };
  }

  return await toResult(secondRes);
}

async function toResult(res: Response): Promise<RubricCallResult> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON, keep raw text */
  }

  // Rubric's own header, not the standard x402 X-PAYMENT-RESPONSE: base64 JSON
  // {success, transaction, network, payer} (see x402-services-endpoint.ts __settle).
  const paymentResponseHeader = res.headers.get("payment-response");
  let paid = false;
  if (paymentResponseHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf8"));
      paid = decoded?.success === true;
    } catch {
      paid = false;
    }
  }

  return { ok: res.ok, status: res.status, paid, body };
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
