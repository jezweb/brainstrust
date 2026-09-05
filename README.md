# brainstrust

A second opinion that's **grounded in your actual codebase**, not a bundle you hand-fed it. You point the
consulted model at a couple of starting files (or let it see your working-tree diff); it grounds every
claim in what it actually saw and cites file:line.

Sibling of [`decisions`](https://github.com/jezweb/decisions) — *decisions* asks a **human** for one clean
call; *brainstrust* asks **other models** for a grounded read.

## The routing rule (this is the whole cost story)

| Consulting… | Transport | Cost |
|---|---|---|
| a **Claude** model | a **Task subagent** (native `Read`/`Grep`/`Glob`) | **free** — rides the Claude Code subscription |
| a **non-Anthropic** model | the **bt gateway** (default) or the **OpenRouter agent loop** (opt-in) | free (Workers AI) or paid OpenRouter tokens |

A Claude subagent is already an agentic pair reviewer, for free — so never pay the API to ask Claude. Pay
only for the **diverse voices** (different providers/labs = different blind spots), which is the actual
point of a brains trust. Best of both: a **mixed panel** — one free Claude subagent reading the real files,
plus a non-Anthropic voice or two.

## Two transports for the non-Anthropic seats

`src/consult.ts` picks automatically — **gateway is the default**, no key needed:

| | **gateway** (default) | **openrouter** (opt-in) |
|---|---|---|
| Needs | nothing — no key | `$OPENROUTER_API_KEY` |
| How the model sees the repo | a **pre-gathered bundle**: the working-tree diff (if any) + the files named in `--paths`, gathered by `consult.ts` itself | **live tool access** — `read_file`/`grep`/`find`/`list_dir`, the model explores the repo itself |
| Cost | free (Cloudflare Workers AI, fleet-shared) | paid OpenRouter tokens, weekly-capped |
| Models | 5 open-weight seats, 5 distinct labs (moonshot, alibaba, zhipu, deepseek, openai) — see `bt.jezweb.workers.dev/health` | flagship non-Anthropic, one per provider, from `models.flared.au` |
| Output tag | `grounding: bundle` | `grounding: tools` |

Force one explicitly with `--transport gateway` or `--transport openrouter`. With no flag: gateway, unless
`$OPENROUTER_API_KEY` is set in the environment (then openrouter, for anyone who already has a working key
and wants the richer live-exploration path).

```bash
# default — no key, the gateway bundles the diff + your --paths hints for you
npx tsx src/consult.ts \
  --methodology review --repo /path/to/repo \
  --question "Can a gated role reach /admin given the middleware order?" \
  --paths "src/server/index.ts:middleware registration; src/server/middleware/auth.ts:the gate"

# opt into the OpenRouter tool-loop (the model explores the repo live)
export OPENROUTER_API_KEY=...
npx tsx src/consult.ts --transport openrouter --methodology review --repo /path/to/repo \
  --question "..." --paths "..."
```

### Why a bundle, not a tool loop, on the gateway path

The bt gateway (`bt.jezweb.workers.dev`, `~/Documents/bt-gateway`) is a single chat-completion call through
Cloudflare's Workers AI binding — not a tool-calling loop. It cannot fetch files itself. `src/bundle.ts`
compensates by gathering `git diff HEAD` plus every `--paths` file (capped, path-clamped to the repo root —
same safety model as `src/tools.ts`) and handing it over as one block. Every gateway result is printed with
`grounding: bundle` so this is never silently implied to be the same as live exploration. **Safety model for
the OpenRouter path stays as before:** there is deliberately no write/edit/bash tool and every path is
clamped to the repo root, so a read-only consult needs no container — the absence of hands *is* the
sandbox.

Flags: `--methodology` (recipe, default `explore`), `--models` (explicit ids for whichever transport is
active), `--pattern` / `--count`, `--transport` (`gateway` | `openrouter`), `--question-file`, `--paths`
(hints — read as bundle content on gateway, exploration starting points on openrouter). `--max-cost`
(default $0.50/model) and `--max-steps` (25) are openrouter-only ceilings.

## Model selection

Neither transport ever guesses a model id from memory:

- **gateway**: `src/models.ts` reads `GET bt.jezweb.workers.dev/health` and takes `default_panel` as-is —
  that field is itself populated on the gateway side from `wrangler ai models list --json`, so this is
  always the gateway's own live answer, not a baked-in list. A small stale fallback exists only for when
  `/health` is unreachable, and warns when used.
- **openrouter**: unchanged — the live curated list at `models.flared.au`, same stale-fallback behaviour.

Anthropic models are excluded from both: a Claude second opinion rides the Claude Code subscription via a
Task subagent (free), not paid tokens or the shared fleet Workers AI budget.

## Methodologies

`review` · `architecture` · `debug` · `security` · `devils-advocate` · `strategy` · `explore` · `ideate`
— each bundles a pattern, model count, and a system-prompt lens. `ideate` is the brainstorming mode: same
grounding, different question (diverge into many options instead of converging).

## What's in here

| Path | What |
|---|---|
| `skills/brainstrust/SKILL.md` | the operating method (routing, methodologies, the discipline) |
| `src/consult.ts` | CLI: picks transport + models + methodology, runs the consult, prints + saves |
| `src/gateway.ts` | the bt gateway HTTP client (`/health`, `/panel`), BT_TOKEN resolution |
| `src/bundle.ts` | gathers the diff + `--paths` files into one capped, repo-clamped bundle (gateway path) |
| `src/tools.ts` | the read-only, repo-clamped filesystem tools handed to the model (openrouter path) |
| `src/models.ts` | model selection for both transports (gateway `/health`, or OpenRouter's live list) |
| `src/methodologies.ts` | the built-in recipes, in both grounding modes (`tools` / `bundle`) |

## Discipline

The panel is **input, not verdict** — you synthesise, and say when you disagree with all of them. The
system prompt forbids claims about code the model hasn't seen and demands file:line citations; hold the
output to that (on the gateway path, "hasn't seen" means "not in the bundle" — the model is told to mark
anything else `NOT-SHOWN` rather than guess). Span providers/labs for genuine diversity (same-lab or
all-Claude panels share blind spots). Mind the spend on the openrouter path — it costs money; the gateway
path and Claude subagents don't.

## Requirements

Node 18+ (for `fetch`/`AbortSignal.timeout`). Gateway path (default): nothing else — reads the fleet's
`BT_TOKEN` from `~/Documents/.jez/secrets/bt-gateway.md`, or `$BT_TOKEN`/`$BT_URL` to override. OpenRouter
path (opt-in): `$OPENROUTER_API_KEY`. `rg` (ripgrep) is used for `grep` if present on the openrouter path,
falling back to system `grep`.
