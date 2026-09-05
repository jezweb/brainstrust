// bt gateway client — the Workers AI-backed transport for non-Anthropic seats.
//
// This is the DEFAULT transport for consult.ts as of 2026-09-05 (issue #2).
// The gateway (~/Documents/bt-gateway, https://bt.jezweb.workers.dev) runs
// every seat through Cloudflare's Workers AI binding: no OpenRouter key, no
// per-agent OpenRouter setup, five open-weight labs live today (see
// GET /health). It replaces the weekly-capped OpenRouter key that used to
// gate every repo-grounded consult (bt-gateway#5).
//
// Trade-off versus the OpenRouter agent loop (still available, see
// consult.ts --transport openrouter): the gateway is a single chat-completion
// call, not a tool-calling loop — it cannot explore the repo itself. See
// bundle.ts for how consult.ts compensates.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_BT_URL = "https://bt.jezweb.workers.dev";

const gatewayVerdictSchema = z.object({
  model: z.string(),
  lab: z.string(),
  review: z.string().default(""),
  /** True when the model returned empty content and this is its raw reasoning stream instead. */
  from_reasoning: z.boolean().optional(),
  error: z.string().optional(),
});

const gatewayPanelResultSchema = z.object({
  panel: z.array(z.string()).default([]),
  labs: z.array(z.string()).default([]),
  routing: z.string().default("unknown"),
  verdicts: z.array(gatewayVerdictSchema),
  usable_verdicts: z.number().default(0),
  notes: z.array(z.string()).default([]),
  elapsed_ms: z.number().default(0),
});

const gatewayHealthSchema = z.object({
  ok: z.boolean().default(false),
  routing: z.string().default("unknown"),
  default_panel: z.array(z.string()).min(1),
  synthesis_model: z.string().default(""),
});

export type GatewayVerdict = z.infer<typeof gatewayVerdictSchema>;
export type GatewayPanelResult = z.infer<typeof gatewayPanelResultSchema>;
export type GatewayHealth = z.infer<typeof gatewayHealthSchema>;

export class GatewayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
  }
}

function btUrl(): string {
  // $BT_URL is an operator-controlled override for local dev/testing, the
  // same convention the `bt` CLI itself documents (~/.local/bin/bt) — it is
  // read from this process's own environment, not from any network input,
  // so it is not an attacker-reachable value in this tool's threat model.
  const override = process.env.BT_URL;
  return override && override.trim() ? override.trim() : DEFAULT_BT_URL;
}

/**
 * Same length-filter extraction as the `bt` CLI (`~/.local/bin/bt`): a plain
 * "first hex-looking match" would as happily grab a shorter fragment from
 * this file's own prose as the real 48-char token, so match on length.
 */
function readTokenFromSecrets(): string | undefined {
  const path = join(homedir(), "Documents", ".jez", "secrets", "bt-gateway.md");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const match = text.match(/\b[a-f0-9]{48}\b/);
  return match?.[0];
}

/** $BT_TOKEN wins (mirrors the CLI); otherwise read the fleet secrets file. Never logged. */
export function resolveBtToken(): string | undefined {
  const envToken = process.env.BT_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  return readTokenFromSecrets();
}

/**
 * Runs a fetch and normalises EVERY failure mode — network error, DNS
 * failure, an aborted/timed-out request — into a `GatewayError` carrying
 * only a short, generic message. Deliberately does NOT attach the raw
 * fetch/undici error as `cause`: a brains-trust review of this file
 * (2026-09-05) flagged that a caller doing deep/structured logging of an
 * error's cause chain could otherwise surface more of the request —
 * including, in principle, the Authorization header — than the sanitised
 * message implies. The label + timed-out/network-error distinction is
 * enough to debug from; the original error isn't worth that risk.
 */
async function safeFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new GatewayError(`${label} failed: ${aborted ? "timed out" : "network error"}`);
  }
}

/** GET /health — no auth required. Used by models.ts to source live seat ids. */
export async function fetchGatewayHealth(timeoutMs = 8000): Promise<GatewayHealth> {
  const res = await safeFetch(`${btUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) }, "GET /health");
  if (!res.ok) throw new GatewayError(`GET /health → HTTP ${res.status}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new GatewayError("GET /health returned unparseable JSON");
  }
  const parsed = gatewayHealthSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GatewayError(`GET /health returned an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * POST /panel — open question, no review framing, no gateway-side synthesis.
 * consult.ts's own contract is "the panel is input, not verdict" (the calling
 * agent synthesises), so an extra gateway synthesis would just be more text
 * to discount — /review's synthesis feature is deliberately not used here.
 */
export async function callGatewayPanel(
  question: string,
  panel: string[],
  opts: { timeoutMs?: number } = {},
): Promise<GatewayPanelResult> {
  const token = resolveBtToken();
  if (!token) {
    throw new GatewayError(
      "no BT_TOKEN found: set $BT_TOKEN or make ~/Documents/.jez/secrets/bt-gateway.md readable",
    );
  }
  const res = await safeFetch(
    `${btUrl()}/panel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ question, panel }),
      // The gateway holds the connection open with a whitespace drip while a
      // full panel round runs (README: measured 1-4 min); match the bt CLI's
      // own generous ceiling rather than the fetch default.
      signal: AbortSignal.timeout(opts.timeoutMs ?? 900_000),
    },
    "POST /panel",
  );
  const text = await res.text();
  if (!res.ok) {
    throw new GatewayError(`POST /panel → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GatewayError(`POST /panel returned unparseable JSON: ${text.slice(0, 300)}`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.error === "string") {
    throw new GatewayError(`POST /panel → ${r.error}`);
  }
  const parsed = gatewayPanelResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GatewayError(`POST /panel returned an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}
