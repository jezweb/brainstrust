---
name: brainstrust
description: >
  Consult other leading AI models for a second opinion that is grounded in your actual codebase. Use for
  code review, architecture, debugging, security, devil's advocate, strategy, exploring blind spots, or
  ideation/brainstorming. Routes Claude consults through a free Task subagent; non-Anthropic consults go
  through the bt gateway by default (free, Workers AI, no key) or the OpenRouter agent loop when opted in.
  Trigger with 'brains trust', 'second opinion', 'ask another model', 'peer review', 'consult', 'challenge
  this', 'devil's advocate', 'brainstorm with the panel'.
user-invocable: true
# The OpenRouter path spends real $; the gateway path (default) does not. Deliberate
# /brainstrust only, never auto-fired — the shipwright loop still invokes it (names it + runs
# the harness via Bash) — this just stops Claude auto-deciding to run a panel because code
# "looks ready".
disable-model-invocation: true
argument-hint: "[methodology] [question]"
---

# Brains Trust

> Part of the **shipwright** method — see the `shipwright` skill for the work-loop this move fits into and when to invoke it.

Get a grounded second opinion from leading models. Non-Anthropic seats run through the **bt gateway** by
default — free, no key, and grounded in a **pre-gathered bundle** (the working-tree diff + the files you
point it at). Opt into the older **OpenRouter agent harness** when you want a seat that **explores the
repo itself** via live read-only tools instead of a bundle (costs tokens, needs a key).

## The one routing rule (read this first)

**Who you consult decides the transport — and the cost:**

| Consulting… | Use | Grounding | Cost |
|---|---|---|---|
| **A Claude model** (Opus/Sonnet/Haiku/Fable) | a **Task subagent** with an explore-and-critique prompt | live tools | **free** — rides the Claude Code subscription |
| **A non-Anthropic model**, default | the **bt gateway** (`src/consult.ts`, no flag needed) | pre-gathered bundle (diff + `--paths`) | **free** — Cloudflare Workers AI, fleet-shared |
| **A non-Anthropic model**, opt-in | the **OpenRouter agent harness** (`src/consult.ts --transport openrouter`) | live tools (model explores itself) | paid OpenRouter tokens |

A Claude subagent already has `Read`/`Grep`/`Glob` and an agent loop — it *is* an agentic pair reviewer
out of the box, for free. So never pay the API to ask Claude. The bt gateway path is also free, so reach
for it first for the **diverse voices** — the whole value of a brains trust is *different blind spots*,
and that means non-Claude models. Reach for `--transport openrouter` only when the question genuinely
needs a model to roam the repo on its own rather than work from a bundle you handed it (e.g. "trace every
caller of this function across the repo").

For an important call, a **mixed panel** is ideal: one free Claude subagent that reads the real files,
plus one or two non-Anthropic voices via the harness.

> **Correlated blind spots:** three Claude subagents "agreeing" is not three independent votes — they
> share Claude's blind spots. Same-provider panels too. For genuine diversity, span providers.

## Methodologies (built-in recipes)

Each bundles a pattern + model count + a system-prompt lens. Pick by the *kind of work*:

| Key | For | Pattern |
|---|---|---|
| `review` | correctness/security review of target code | consensus ×2 |
| `architecture` | design trade-offs, simpler approaches | consensus ×2 |
| `debug` | stuck after attempts → ranked root-cause hypotheses | consensus ×2 |
| `security` | threat-model, ranked by exploitability × blast radius | consensus ×2 |
| `devils-advocate` | argue hard AGAINST the current plan | single |
| `strategy` | product/approach decision | consensus ×2 |
| `explore` | open: what are we missing? blind spots? | consensus ×2 |
| `ideate` | DIVERGE — wide range of options, don't converge | consensus ×3 |

(`ideate` is brainstorming: same tools, different question — the model reads enough to ground ideas, then
generates many distinct directions instead of narrowing.)

## Setup — the harness needs its npm deps

`src/consult.ts` imports npm packages and `node_modules` is not committed. So before the first consult
on a machine, **install the deps: run `npm install` in this plugin's directory** (idempotent — harmless
to repeat, and a plugin update may need it again). Run the harness from that same directory so the deps
and `tsx` resolve. If a consult ever errors with a missing module, that's the signal to install.

## Running a non-Anthropic consult

Run from the plugin's directory. No key needed — this goes through the bt gateway by default:

```bash
npx tsx src/consult.ts \
  --methodology review \
  --repo /path/to/repo \
  --question "Is the auth middleware order correct, and can a gated role reach /admin?" \
  --paths "src/server/index.ts:middleware registration; src/server/middleware/auth.ts:the gate"
```
`--repo` is the target repo to consult on (paths are read relative to it, so where you run from doesn't
change which code the model sees). On the gateway path, `consult.ts` gathers `git diff HEAD` for that repo
plus every `--paths` file itself and hands it over as a bundle (`src/bundle.ts`) — there is no live
exploration, so point `--paths` at what actually matters; output is tagged `grounding: bundle`.

- `--methodology` (default `explore`) picks the recipe. `--pattern` / `--count` / `--models` override it.
- `--models` is auto-chosen as **flagship non-Anthropic, one per lab** — from the bt gateway's own
  `GET /health.default_panel` on the gateway transport, or `models.flared.au` on the openrouter transport
  — with a stale fallback (and a warning) if the live source is unreachable. Or pass explicit ids.
- `--paths` are *hints* (path:why, `;`-separated). On the gateway path these are exactly what gets bundled
  (not limits on a live crawl — there is no crawl); on `--transport openrouter` they're starting points and
  the model roams from there.
- Output: each model's view to stdout (+ `.brainstrust/<ts>-<methodology>/`).

### Opting into the OpenRouter tool-loop instead

When a question genuinely needs a model to explore the repo on its own — not just read what you handed
it — add `--transport openrouter` (or just have `OPENROUTER_API_KEY` set):

```bash
export OPENROUTER_API_KEY=...
npx tsx src/consult.ts --transport openrouter --methodology review --repo /path/to/repo \
  --question "..." --paths "src/server/index.ts:starting point"
```

Costs paid OpenRouter tokens; `--max-cost` (default $0.50/model) and `--max-steps` (25) are hard ceilings
via the agent loop's `stopWhen`, and each consult prints its own token cost. Output is tagged
`grounding: tools`.

## Running a Claude consult (free)

Don't use the harness. Spawn a **Task subagent**: give it the question, the methodology lens (copy the
relevant row's framing), and the starting file paths, and tell it to explore the repo and return a
prioritised, file:line-cited critique. It reads the code natively. For consensus, spawn 2-3 with
different stances (skeptic / pragmatist / security-hawk) in parallel.

## The discipline (what keeps it honest)

- **The panel is INPUT, not verdict.** You synthesise: note where they agree/disagree, add your own read,
  and say plainly when you disagree with all of them. Don't defer to "the models said X" — they are
  often confidently wrong in chorus.
- **Grounded only.** The system prompt forbids claims about code the model hasn't seen and demands
  file:line citations. On the gateway path "seen" means "in the bundle" — the model is told to mark
  anything else `NOT-SHOWN` rather than guess. Hold consulted output to that either way — discount
  ungrounded assertions.
- **Span providers/labs for real diversity.** Redundant labs give correlated errors.
- **Mind the spend.** The gateway path and Claude subagents are free; `--transport openrouter` costs
  money. Reach for the paid path only when the question needs live exploration, not every edit.

## When to use / not

**Use:** before a major architectural change; stuck debugging after 2+ attempts; security-sensitive code;
challenging your own plan; ideation when you want breadth; any genuine "what are we missing?".
**Skip:** simple syntax, well-known answers, every small edit (slow + costs money).
