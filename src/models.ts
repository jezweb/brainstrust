// Flagship non-Anthropic model selection.
//
// Anthropic models are deliberately EXCLUDED here: a Claude second opinion should
// ride the Claude Code subscription via a Task subagent (free), not paid OpenRouter
// tokens. brainstrust's API path is for the *diverse* voices — other providers.
//
// Primary source is the live curated list at models.flared.au (so flagship IDs stay
// current). If it's unreachable we fall back to a small baked-in set that is almost
// certainly STALE — it exists only so the tool degrades instead of dying, and the
// caller should prefer `--models <id,...>` or restore the live list.

const LIVE_URL = "https://models.flared.au/json";

export interface PickedModel {
  id: string; // OpenRouter id, e.g. "openai/gpt-5.4"
  provider: string; // e.g. "openai"
}

// Best-effort fallback ONLY. Refresh from the live list; do not treat as canonical.
const FLAGSHIP_FALLBACK: PickedModel[] = [
  { id: "openai/gpt-5.4", provider: "openai" },
  { id: "google/gemini-3.1-pro-preview", provider: "google" },
  { id: "qwen/qwen3.5-max", provider: "qwen" },
  { id: "deepseek/deepseek-v4", provider: "deepseek" },
];

function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(0, slash);
}

/**
 * Fetch the curated list, drop Anthropic, and return one flagship per provider in
 * the list's own order (it is pre-ranked by "leading models"). Falls back on any
 * error. `stale` flags that the fallback was used so the caller can warn.
 */
export async function fetchFlagship(): Promise<{ models: PickedModel[]; stale: boolean }> {
  try {
    const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw: unknown = await res.json();
    const list = Array.isArray(raw) ? raw : (raw as { data?: unknown[] }).data;
    if (!Array.isArray(list)) throw new Error("unexpected list shape");

    const seen = new Set<string>();
    const models: PickedModel[] = [];
    for (const entry of list) {
      const id = typeof entry === "string" ? entry : (entry as { id?: string }).id;
      if (!id || typeof id !== "string") continue;
      const provider = providerOf(id);
      if (provider === "anthropic") continue; // Claude goes via subagent, not here
      if (seen.has(provider)) continue; // one flagship per provider
      seen.add(provider);
      models.push({ id, provider });
    }
    if (models.length === 0) throw new Error("no non-Anthropic models in list");
    return { models, stale: false };
  } catch {
    return { models: FLAGSHIP_FALLBACK, stale: true };
  }
}

/**
 * Choose the models for a consultation.
 * - explicit ids win (comma-separated), as-is.
 * - otherwise pick `count` flagship models from DIFFERENT providers for diversity.
 */
export async function pickModels(opts: {
  explicit?: string;
  count: number;
}): Promise<{ models: PickedModel[]; stale: boolean }> {
  if (opts.explicit && opts.explicit.trim()) {
    const models = opts.explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => ({ id, provider: providerOf(id) }));
    return { models, stale: false };
  }
  const { models, stale } = await fetchFlagship();
  return { models: models.slice(0, Math.max(1, opts.count)), stale };
}
