// Model selection for both transports.
//
// - gateway transport (default, gateway.ts): sources live ids from the bt
//   gateway's own `GET /health.default_panel`. That field is itself populated
//   on the gateway side from `wrangler ai models list --json` (bt-gateway
//   src/index.ts, verified 2026-09-05), so this never guesses a Workers AI
//   catalog id from memory — it just reads the gateway's own live answer.
// - openrouter transport (legacy, opt-in — see consult.ts --transport /
//   OPENROUTER_API_KEY): unchanged from before issue #2. Sources
//   OpenRouter-format flagship ids from the live curated list at
//   models.flared.au.
//
// Anthropic models are excluded from BOTH: a Claude second opinion rides the
// Claude Code subscription via a Task subagent (free), not paid OpenRouter
// tokens or the shared fleet Workers AI budget.

import { fetchGatewayHealth } from "./gateway.ts";

export interface PickedModel {
  id: string; // transport-native id, e.g. "openai/gpt-5.4" or "@cf/moonshotai/kimi-k2.6"
  provider: string; // e.g. "openai", "moonshotai"
}

const OPENROUTER_LIVE_URL = "https://models.flared.au/json";

// Best-effort fallback ONLY, for when the OpenRouter live list is unreachable.
const OPENROUTER_FALLBACK: PickedModel[] = [
  { id: "openai/gpt-5.4", provider: "openai" },
  { id: "google/gemini-3.1-pro-preview", provider: "google" },
  { id: "qwen/qwen3.5-max", provider: "qwen" },
  { id: "deepseek/deepseek-v4", provider: "deepseek" },
];

// Best-effort fallback ONLY, for when the gateway's /health is unreachable.
// Verified live against bt.jezweb.workers.dev/health 2026-09-05 (5 open-weight
// seats, 5 distinct labs, no OpenRouter key needed) — prefer --models
// <id,...> over trusting this for long; it will drift the day the gateway's
// own default panel changes.
const GATEWAY_FALLBACK: PickedModel[] = [
  { id: "@cf/moonshotai/kimi-k2.6", provider: "moonshotai" },
  { id: "@cf/qwen/qwen3.8-27b", provider: "qwen" },
  { id: "@cf/zai-org/glm-5.3", provider: "zai-org" },
  { id: "@cf/deepseek-ai/deepseek-v4-pro-0813", provider: "deepseek-ai" },
  { id: "@cf/openai/gpt-oss-120b", provider: "openai" },
];

/** OpenRouter-style id, "<provider>/<model>" — the provider is the first segment. */
function openrouterProviderOf(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(0, slash);
}

/**
 * Workers AI-hosted ids are "@cf/<provider>/<model...>" — "@cf" is the host,
 * not the provider, the same convention bt-gateway's own `labOf()` uses.
 * Anything else (an explicit override in the binding's third-party form) is
 * a plain "<provider>/<model>".
 */
function gatewayProviderOf(id: string): string {
  const parts = id.split("/");
  return parts[0] === "@cf" ? (parts[1] ?? parts[0]) : (parts[0] ?? id);
}

async function fetchOpenRouterFlagship(): Promise<{ models: PickedModel[]; stale: boolean }> {
  try {
    const res = await fetch(OPENROUTER_LIVE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw: unknown = await res.json();
    const list = Array.isArray(raw) ? raw : (raw as { data?: unknown[] }).data;
    if (!Array.isArray(list)) throw new Error("unexpected list shape");

    const seen = new Set<string>();
    const models: PickedModel[] = [];
    for (const entry of list) {
      const id = typeof entry === "string" ? entry : (entry as { id?: string }).id;
      if (!id || typeof id !== "string") continue;
      const provider = openrouterProviderOf(id);
      if (provider === "anthropic") continue; // Claude goes via subagent, not here
      if (seen.has(provider)) continue; // one flagship per provider
      seen.add(provider);
      models.push({ id, provider });
    }
    if (models.length === 0) throw new Error("no non-Anthropic models in list");
    return { models, stale: false };
  } catch {
    return { models: OPENROUTER_FALLBACK, stale: true };
  }
}

async function fetchGatewayFlagship(): Promise<{ models: PickedModel[]; stale: boolean }> {
  try {
    const health = await fetchGatewayHealth();
    const seen = new Set<string>();
    const models: PickedModel[] = [];
    for (const id of health.default_panel) {
      const provider = gatewayProviderOf(id);
      if (provider === "anthropic") continue; // Claude goes via subagent, not here
      if (seen.has(provider)) continue; // one seat per lab
      seen.add(provider);
      models.push({ id, provider });
    }
    if (models.length === 0) throw new Error("no non-Anthropic models in /health.default_panel");
    return { models, stale: false };
  } catch {
    return { models: GATEWAY_FALLBACK, stale: true };
  }
}

/**
 * The bt gateway refuses the WHOLE call if fewer than this many seats answer
 * across fewer than this many labs (`checkPanelFloor`, bt-gateway
 * src/index.ts, MIN_ANSWERED=3 / MIN_LABS_ANSWERED=2) — even if every
 * requested seat is healthy, a panel smaller than the floor can never clear
 * it. Auto-picked (non-explicit) gateway panels must always request at
 * least this many, regardless of a methodology's nominal consensus count.
 */
export const GATEWAY_MIN_ANSWERED = 3;

/** `Math.max(count, GATEWAY_MIN_ANSWERED)` — pulled out so consult.ts's padding logic is unit-testable without importing the CLI entrypoint. */
export function withGatewayFloor(count: number, floor: number = GATEWAY_MIN_ANSWERED): number {
  return Math.max(count, floor);
}

/**
 * Choose the models for a consultation, on the given transport.
 * - explicit ids win (comma-separated), as-is, for either transport.
 * - otherwise pick `count` flagship models from different providers/labs.
 */
export async function pickModels(opts: {
  explicit?: string;
  count: number;
  transport: "gateway" | "openrouter";
}): Promise<{ models: PickedModel[]; stale: boolean }> {
  if (opts.explicit && opts.explicit.trim()) {
    const providerOf = opts.transport === "gateway" ? gatewayProviderOf : openrouterProviderOf;
    const models = opts.explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => ({ id, provider: providerOf(id) }));
    return { models, stale: false };
  }
  const { models, stale } =
    opts.transport === "gateway" ? await fetchGatewayFlagship() : await fetchOpenRouterFlagship();
  return { models: models.slice(0, Math.max(1, opts.count)), stale };
}
