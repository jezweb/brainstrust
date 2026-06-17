#!/usr/bin/env -S npx tsx
// brainstrust — consult flagship non-Anthropic models as agentic pair reviewers.
//
//   npx tsx src/consult.ts --methodology review --repo . \
//     --question "Is the auth middleware order correct?" \
//     --paths "src/server/index.ts:middleware registration"
//
// Each model gets the read-only repo tools and explores the code ITSELF. Claude
// consults should NOT use this — spawn a Task subagent instead (free, native tools).

import { OpenRouter, maxCost, stepCountIs } from "@openrouter/agent";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { repoTools } from "./tools.ts";
import { pickModels } from "./models.ts";
import { METHODOLOGIES, instructionsFor, listMethodologies, type Methodology, type Pattern } from "./methodologies.ts";

interface Args {
  methodology: string;
  pattern?: Pattern;
  models?: string;
  count?: number;
  question?: string;
  questionFile?: string;
  repo: string;
  paths?: string;
  maxCost: number;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t && t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        a[key] = next;
        i++;
      } else {
        a[key] = "true";
      }
    }
  }
  return {
    methodology: a.methodology ?? "explore",
    pattern: a.pattern as Pattern | undefined,
    models: a.models,
    count: a.count ? parseInt(a.count, 10) : undefined,
    question: a.question,
    questionFile: a["question-file"],
    repo: resolve(a.repo ?? "."),
    paths: a.paths,
    maxCost: validPos(a["max-cost"] ? parseFloat(a["max-cost"]) : NaN, 0.5),
    maxSteps: validPos(a["max-steps"] ? parseInt(a["max-steps"], 10) : NaN, 25),
  };
}

/** Guard CLI-supplied numbers: fall back to the default on NaN/≤0. */
function validPos(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildInput(args: Args, question: string): string {
  let input = `Question / task:\n${question}\n`;
  if (args.paths) {
    const hints = args.paths
      .split(";")
      .map((h) => h.trim())
      .filter(Boolean)
      .map((h) => {
        const idx = h.indexOf(":"); // split on FIRST colon — a "why" can itself contain colons
        const p = (idx === -1 ? h : h.slice(0, idx)).trim();
        const why = idx === -1 ? "" : h.slice(idx + 1).trim();
        return why ? `- ${p} — ${why}` : `- ${p}`;
      })
      .join("\n");
    input += `\nStarting points (hints, NOT limits — explore wherever the code leads):\n${hints}\n`;
  }
  input += `\nUse your read-only tools to read the actual code before answering.`;
  return input;
}

async function consultOne(
  client: OpenRouter,
  model: string,
  instructions: string,
  input: string,
  repo: string,
  maxCostUsd: number,
  maxSteps: number,
) {
  const result = client.callModel({
    model,
    instructions,
    input,
    tools: repoTools(repo),
    stopWhen: [stepCountIs(maxSteps), maxCost(maxCostUsd)],
    allowFinalResponse: true,
  });
  const text = await result.getText();
  let cost: number | null | undefined;
  let steps: number | undefined;
  try {
    const resp = await result.getResponse();
    cost = resp.usage?.cost;
    steps = (await result.getToolCalls()).length;
  } catch {
    /* usage best-effort */
  }
  return { model, text, cost, toolCalls: steps };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.OPENROUTER_API_KEY) {
    console.error("Set OPENROUTER_API_KEY. (Claude consults should use a Task subagent, not this tool.)");
    process.exit(1);
  }
  const m: Methodology | undefined = METHODOLOGIES[args.methodology];
  if (!m) {
    console.error(`Unknown methodology '${args.methodology}'. Available:\n${listMethodologies()}`);
    process.exit(1);
  }
  const question = args.questionFile ? readFileSync(args.questionFile, "utf8") : args.question;
  if (!question) {
    console.error("Provide --question \"...\" or --question-file <path>.");
    process.exit(1);
  }

  const pattern: Pattern = args.pattern ?? m.pattern;
  const count = pattern === "consensus" ? (args.count ?? m.count) : 1;
  const { models, stale } = await pickModels({ explicit: args.models, count });
  if (stale) {
    console.error("⚠️  models.flared.au unreachable — using a STALE fallback model set. Prefer --models <id,...>.");
  }

  const instructions = instructionsFor(m);
  const input = buildInput(args, question);

  console.error(
    `brainstrust · ${m.title} · ${pattern} · ${models.map((x) => x.id).join(", ")} (max $${args.maxCost}/model)`,
  );
  models.forEach((x) => console.error(`  → consulting ${x.id} …`));

  const results = await Promise.all(
    models.map((x) =>
      consultOne(client(), x.id, instructions, input, args.repo, args.maxCost, args.maxSteps).catch((err: unknown) => ({
        model: x.id,
        text: `(failed: ${(err as Error).message})`,
        cost: undefined,
        toolCalls: undefined,
      })),
    ),
  );

  // Write artifacts (gitignored) + print a synthesis-ready block to stdout.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(args.repo, ".brainstrust", `${stamp}-${m.key}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.md"), `# ${m.title}\n\n${instructions}\n\n---\n\n${input}\n`);

  let totalCost = 0;
  for (const r of results) {
    writeFileSync(join(dir, `${r.model.replace(/\//g, "_")}.md`), r.text);
    if (r.cost != null) totalCost += r.cost;
  }

  console.log(`\n# brainstrust — ${m.title} (${pattern})\n`);
  for (const r of results) {
    console.log(`\n## ${r.model}${r.cost != null ? `  ·  $${r.cost.toFixed(4)}` : ""}${r.toolCalls != null ? `  ·  ${r.toolCalls} tool calls` : ""}\n`);
    console.log(r.text);
  }
  console.log(
    `\n---\nTotal: $${totalCost.toFixed(4)} across ${results.length} model(s). Artifacts: ${dir}\n` +
      `Synthesis is yours: the panel is INPUT, not verdict. Note where they agree/disagree, add your own read, and say if you disagree with all of them.`,
  );
}

// Lazily build a client per call so a key check can run first.
let _client: OpenRouter | null = null;
function client(): OpenRouter {
  if (!_client) _client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  return _client;
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
