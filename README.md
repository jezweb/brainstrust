# brainstrust

A second opinion that's **grounded in your actual codebase**. The consulted model doesn't get hand-fed a
bundle of files — it has read-only repo tools (`read_file` / `grep` / `find` / `list_dir`) and **explores
the code itself**, the way a Claude Code subagent or a pair programmer does. You point it at a couple of
starting files; it follows the trail.

Sibling of [`decisions`](https://github.com/jezweb/decisions) — *decisions* asks a **human** for one clean
call; *brainstrust* asks **other models** for a grounded read.

## The routing rule (this is the whole cost story)

| Consulting… | Transport | Cost |
|---|---|---|
| a **Claude** model | a **Task subagent** (native `Read`/`Grep`/`Glob`) | **free** — rides the Claude Code subscription |
| a **non-Anthropic** model | the **OpenRouter agent loop** (`src/consult.ts`) | paid OpenRouter tokens |

A Claude subagent is already an agentic pair reviewer, for free — so never pay the API to ask Claude. Pay
only for the **diverse voices** (different providers = different blind spots), which is the actual point of
a brains trust. Best of both: a **mixed panel** — one free Claude subagent reading the real files, plus a
non-Anthropic voice or two.

## How the non-Anthropic path works

`src/consult.ts` uses the [OpenRouter Agent SDK](https://www.npmjs.com/package/@openrouter/agent)
(`@openrouter/agent`): it hands the model the read-only repo tools and runs the tool-calling loop
automatically — the model requests `read_file("…")` / `grep(…)`, the SDK executes it against the repo,
feeds the result back, and loops until the model answers. **Safety model:** there is deliberately no
write/edit/bash tool and every path is clamped to the repo root, so a read-only consult needs no
container — the absence of hands *is* the sandbox.

```bash
export OPENROUTER_API_KEY=...
npm install
npx tsx src/consult.ts \
  --methodology review \
  --repo /path/to/repo \
  --question "Can a gated role reach /admin given the middleware order?" \
  --paths "src/server/index.ts:middleware registration; src/server/middleware/auth.ts:the gate"
```

Flags: `--methodology` (recipe, default `explore`), `--models` (explicit ids, else flagship non-Anthropic
one-per-provider from `models.flared.au` with a stale fallback), `--pattern` / `--count`, `--max-cost`
(default $0.50/model) and `--max-steps` (25) as hard ceilings, `--question-file`, `--paths` (hints, not
limits). Each consult prints its own token cost.

## Methodologies

`review` · `architecture` · `debug` · `security` · `devils-advocate` · `strategy` · `explore` · `ideate`
— each bundles a pattern, model count, and a system-prompt lens. `ideate` is the brainstorming mode: same
tools, different question (diverge into many options instead of converging).

## What's in here

| Path | What |
|---|---|
| `skills/brainstrust/SKILL.md` | the operating method (routing, methodologies, the discipline) |
| `src/consult.ts` | CLI: picks models + methodology, runs the agent loop per model, prints + saves |
| `src/tools.ts` | the read-only, repo-clamped filesystem tools handed to the model |
| `src/models.ts` | flagship non-Anthropic model selection (live list + stale fallback) |
| `src/methodologies.ts` | the built-in recipes |

## Discipline

The panel is **input, not verdict** — you synthesise, and say when you disagree with all of them. The
system prompt forbids claims about code the model hasn't read and demands file:line citations; hold the
output to that. Span providers for genuine diversity (same-provider or all-Claude panels share blind
spots). Mind the spend — non-Claude consults cost money; Claude subagents don't.

## Requirements

Node 18+ (for `fetch`/`AbortSignal.timeout`), `OPENROUTER_API_KEY` for non-Anthropic consults. `rg`
(ripgrep) is used for `grep` if present, falling back to system `grep`.
