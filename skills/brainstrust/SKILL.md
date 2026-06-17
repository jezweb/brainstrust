---
name: brainstrust
description: >
  Consult other leading AI models for a second opinion that is grounded in your actual codebase — the
  consulted model reads the repo itself (read/grep/find) instead of being hand-fed files. Use for code
  review, architecture, debugging, security, devil's advocate, strategy, exploring blind spots, or
  ideation/brainstorming. Routes Claude consults through a free Task subagent and non-Anthropic consults
  through the OpenRouter agent loop. Trigger with 'brains trust', 'second opinion', 'ask another model',
  'peer review', 'consult', 'challenge this', 'devil's advocate', 'brainstorm with the panel'.
triggers:
  - brains trust
  - brainstrust
  - second opinion
  - peer review
  - consult the panel
  - challenge this
  - devil's advocate
  - what would another model think
  - brainstorm with the panel
user-invocable: true
argument-hint: "[methodology] [question]"
---

# Brains Trust

> Part of the **shipwright** method — see the `shipwright` skill for the work-loop this move fits into and when to reach for it.

Get a grounded second opinion from leading models. The defining move versus the old version: the
consulted model is an **agentic pair reviewer** — it has read-only repo tools and **explores the code
itself**, rather than reasoning over a bundle you hand-fed it. You point it at a few starting files; it
follows the trail.

## The one routing rule (read this first)

**Who you consult decides the transport — and the cost:**

| Consulting… | Use | Cost |
|---|---|---|
| **A Claude model** (Opus/Sonnet/Haiku/Fable) | a **Task subagent** with an explore-and-critique prompt | **free** — rides the Claude Code subscription |
| **A non-Anthropic model** (Gemini / GPT / Qwen / DeepSeek …) | the **OpenRouter agent harness** (`src/consult.ts`) | paid OpenRouter tokens |

A Claude subagent already has `Read`/`Grep`/`Glob` and an agent loop — it *is* an agentic pair reviewer
out of the box, for free. So never pay the API to ask Claude. Pay only for the **diverse voices** — the
whole value of a brains trust is *different blind spots*, and that means non-Claude models.

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

Run from the plugin's directory:

```bash
export OPENROUTER_API_KEY=...        # Claude consults need no key
npx tsx src/consult.ts \
  --methodology review \
  --repo /path/to/repo \
  --question "Is the auth middleware order correct, and can a gated role reach /admin?" \
  --paths "src/server/index.ts:middleware registration; src/server/middleware/auth.ts:the gate"
```
`--repo` is the target repo to consult on (the harness reads files relative to it, so where you run
from doesn't change which code the model sees).

- `--methodology` (default `explore`) picks the recipe. `--pattern` / `--count` / `--models` override it.
- `--models` is auto-chosen as **flagship non-Anthropic, one per provider** from the live list
  (`models.flared.au`), with a stale fallback if it's unreachable — or pass explicit ids
  (`--models openai/gpt-5.4,google/gemini-3.1-pro-preview`).
- `--paths` are *hints* (path:why, `;`-separated), NOT limits — the model roams from there.
- `--max-cost` (default $0.50/model) and `--max-steps` (25) are hard ceilings via the agent loop's
  `stopWhen`. Each consult prints its own token cost.
- Output: each model's view to stdout (+ `.brainstrust/<ts>-<methodology>/`), with a total cost line.

## Running a Claude consult (free)

Don't use the harness. Spawn a **Task subagent**: give it the question, the methodology lens (copy the
relevant row's framing), and the starting file paths, and tell it to explore the repo and return a
prioritised, file:line-cited critique. It reads the code natively. For consensus, spawn 2-3 with
different stances (skeptic / pragmatist / security-hawk) in parallel.

## The discipline (what keeps it honest)

- **The panel is INPUT, not verdict.** You synthesise: note where they agree/disagree, add your own read,
  and say plainly when you disagree with all of them. Don't defer to "the models said X" — they are
  often confidently wrong in chorus.
- **Grounded only.** The harness's system prompt forbids claims about code the model hasn't read and
  demands file:line citations. Hold consulted output to that — discount ungrounded assertions.
- **Span providers for real diversity.** Redundant providers give correlated errors.
- **Mind the spend.** Non-Claude consults cost money; Claude subagents don't. Reach for the panel on
  decisions that matter, not every edit.

## When to use / not

**Use:** before a major architectural change; stuck debugging after 2+ attempts; security-sensitive code;
challenging your own plan; ideation when you want breadth; any genuine "what are we missing?".
**Skip:** simple syntax, well-known answers, every small edit (slow + costs money).
