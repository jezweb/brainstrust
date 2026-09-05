#!/usr/bin/env -S npx tsx
// brainstrust — consult flagship non-Anthropic models as agentic pair reviewers.
//
//   npx tsx src/consult.ts --methodology review --repo . \
//     --question "Is the auth middleware order correct?" \
//     --paths "src/server/index.ts:middleware registration"
//
// Two transports, picked automatically (override with --transport):
//   - gateway (default, no key needed): calls the bt gateway
//     (bt.jezweb.workers.dev), which runs every seat through Cloudflare's
//     Workers AI binding. No tool-calling loop — repo context is
//     pre-gathered (bundle.ts: the working-tree diff + hinted files) and
//     handed over as one bundle. Output is labelled `grounding: bundle`.
//   - openrouter (opt-in, needs $OPENROUTER_API_KEY): the original agentic
//     loop — each model gets read-only repo tools and explores the code
//     ITSELF via the OpenRouter agent SDK. Richer grounding, costs tokens.
//
// Claude consults should NOT use either — spawn a Task subagent instead
// (free, native tools).

import { OpenRouter, maxCost, stepCountIs } from "@openrouter/agent";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { repoTools } from "./tools.ts";
import { pickModels, withGatewayFloor, GATEWAY_MIN_ANSWERED, type PickedModel } from "./models.ts";
import { METHODOLOGIES, instructionsFor, listMethodologies, type Methodology, type Pattern, type Grounding } from "./methodologies.ts";
import { parsePathHints, gatherBundle, DEFAULT_BUNDLE_MAX_BYTES } from "./bundle.ts";
import { callGatewayPanel, GatewayError } from "./gateway.ts";

type Transport = "gateway" | "openrouter";

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
  transport?: Transport;
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
  const transport = a.transport === "gateway" || a.transport === "openrouter" ? a.transport : undefined;
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
    transport,
  };
}

/** Guard CLI-supplied numbers: fall back to the default on NaN/≤0. */
function validPos(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildInput(args: Args, question: string, grounding: Grounding): string {
  let input = `Question / task:\n${question}\n`;
  const hints = parsePathHints(args.paths);
  if (hints.length) {
    const list = hints.map((h) => (h.why ? `- ${h.path} — ${h.why}` : `- ${h.path}`)).join("\n");
    const suffix = grounding === "tools" ? " — explore wherever the code leads" : "";
    input += `\nStarting points (hints, NOT limits${suffix}):\n${list}\n`;
  }
  input +=
    grounding === "tools"
      ? `\nUse your read-only tools to read the actual code before answering.`
      : `\nRead the BUNDLE below (diff + hinted files, gathered by the calling agent) before answering. If something relevant isn't in it, say so explicitly (mark it NOT-SHOWN) rather than guessing.`;
  return input;
}

function artifactDir(repo: string, methodologyKey: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(repo, ".brainstrust", `${stamp}-${methodologyKey}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// OpenRouter transport — the original agentic tool-loop path (opt-in).
// ---------------------------------------------------------------------------

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
  // Count tool calls AS THEY HAPPEN. getToolCalls() returns only the final turn's
  // calls (the answer turn has none → 0, misleadingly), so consume the stream
  // concurrently with getText(). null = couldn't measure (don't fake a 0).
  const toolCallsP = (async (): Promise<number | null> => {
    let n = 0;
    try {
      for await (const _ of result.getToolCallsStream()) n++;
    } catch {
      return null;
    }
    return n;
  })();
  const text = await result.getText();
  const toolCalls = await toolCallsP;
  let cost: number | null | undefined;
  try {
    cost = (await result.getResponse()).usage?.cost;
  } catch {
    /* cost is best-effort — some providers don't report it */
  }
  return { model, text, cost, toolCalls };
}

// Lazily build a client per call so a key check can run first.
let _client: OpenRouter | null = null;
function openRouterClient(): OpenRouter {
  if (!_client) _client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  return _client;
}

async function runOpenRouterConsult(args: Args, m: Methodology, pattern: Pattern, question: string): Promise<void> {
  const count = pattern === "consensus" ? (args.count ?? m.count) : 1;
  const { models, stale } = await pickModels({ explicit: args.models, count, transport: "openrouter" });
  if (stale) {
    console.error("⚠️  models.flared.au unreachable — using a STALE fallback model set. Prefer --models <id,...>.");
  }

  const instructions = instructionsFor(m, "tools");
  const input = buildInput(args, question, "tools");

  console.error(
    `brainstrust · ${m.title} · ${pattern} · openrouter · ${models.map((x) => x.id).join(", ")} (max $${args.maxCost}/model)`,
  );
  models.forEach((x) => console.error(`  → consulting ${x.id} …`));

  const results = await Promise.all(
    models.map((x) =>
      consultOne(openRouterClient(), x.id, instructions, input, args.repo, args.maxCost, args.maxSteps).catch(
        (err: unknown) => ({
          model: x.id,
          text: `(failed: ${(err as Error).message})`,
          cost: undefined as number | null | undefined,
          toolCalls: null as number | null,
        }),
      ),
    ),
  );

  const dir = artifactDir(args.repo, m.key);
  writeFileSync(join(dir, "prompt.md"), `# ${m.title} (openrouter/tools)\n\n${instructions}\n\n---\n\n${input}\n`);

  let totalCost = 0;
  for (const r of results) {
    writeFileSync(join(dir, `${r.model.replace(/\//g, "_")}.md`), r.text);
    if (r.cost != null) totalCost += r.cost;
  }

  console.log(`\n# brainstrust — ${m.title} (${pattern}) · grounding: tools\n`);
  for (const r of results) {
    const costStr = r.cost && r.cost > 0 ? `$${r.cost.toFixed(4)}` : "cost n/a";
    const reads = r.toolCalls == null ? "reads: unknown" : `${r.toolCalls} repo reads`;
    console.log(`\n## ${r.model}  ·  ${costStr}  ·  ${reads}\n`);
    console.log(r.text);
  }
  const totalStr = totalCost > 0 ? `$${totalCost.toFixed(4)}` : "n/a (providers didn't report usage)";
  console.log(
    `\n---\nTotal: ${totalStr} across ${results.length} model(s). Artifacts: ${dir}\n` +
      `Synthesis is yours: the panel is INPUT, not verdict. Note where they agree/disagree, add your own read, and say if you disagree with all of them.`,
  );
}

// ---------------------------------------------------------------------------
// Gateway transport — the default. One call, pre-gathered bundle, no key.
// ---------------------------------------------------------------------------

async function runGatewayConsult(args: Args, m: Methodology, pattern: Pattern, question: string): Promise<void> {
  const requestedCount = pattern === "consensus" ? (args.count ?? m.count) : 1;
  // The bt gateway refuses the WHOLE call below its panel floor (3 seats
  // answering across 2+ labs — see withGatewayFloor's doc comment), no
  // matter how many of the requested seats succeed. Auto-picked panels are
  // padded up to the floor even for a "single"/2-seat methodology
  // (devils-advocate, or a 2-model consensus); an explicit --models below
  // the floor is respected as the caller's choice, with a warning.
  const count = args.models ? requestedCount : withGatewayFloor(requestedCount);
  const { models, stale } = await pickModels({ explicit: args.models, count, transport: "gateway" });
  if (stale) {
    console.error(
      "⚠️  bt gateway /health unreachable — using a STALE fallback model set. Prefer --models <id,...>.",
    );
  }
  if (!args.models && count > requestedCount) {
    console.error(
      `  (bt gateway requires ≥${GATEWAY_MIN_ANSWERED} seats across 2+ labs to answer, or the whole call errors — requesting ${count} instead of ${requestedCount} for '${pattern}')`,
    );
  }
  if (args.models && models.length < GATEWAY_MIN_ANSWERED) {
    console.error(
      `  ⚠️  only ${models.length} explicit model(s) passed — the bt gateway requires ≥${GATEWAY_MIN_ANSWERED} seats across 2+ labs to answer, or the whole call errors.`,
    );
  }

  const hints = parsePathHints(args.paths);
  const bundle = gatherBundle(args.repo, hints, DEFAULT_BUNDLE_MAX_BYTES);

  const instructions = instructionsFor(m, "bundle");
  const input = buildInput(args, question, "bundle");
  const bundleBlock = bundle.text.trim()
    ? `\n\n=== BUNDLE (gathered by the calling agent — you have no live tool access) ===\n${bundle.text}\n=== END BUNDLE ===`
    : `\n\n=== BUNDLE ===\n(no diff and no readable hinted files were gathered — answer from the question alone, or say what you'd need to see)\n=== END BUNDLE ===`;
  const fullQuestion = `${instructions}\n\n${input}${bundleBlock}`;

  console.error(
    `brainstrust · ${m.title} · ${pattern} · gateway/bundle · ${models.map((x: PickedModel) => x.id).join(", ")}`,
  );
  if (bundle.filesMissing.length) {
    console.error(`  (bundle: could not read or ran out of budget for: ${bundle.filesMissing.join(", ")})`);
  }

  const dir = artifactDir(args.repo, m.key);
  writeFileSync(join(dir, "prompt.md"), `# ${m.title} (gateway/bundle)\n\n${fullQuestion}\n`);

  let result;
  try {
    result = await callGatewayPanel(
      fullQuestion,
      models.map((x) => x.id),
    );
  } catch (err) {
    if (err instanceof GatewayError) {
      console.error(`bt gateway call failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  for (const v of result.verdicts) {
    writeFileSync(join(dir, `${v.model.replace(/[/@]/g, "_")}.md`), v.review || `(no response: ${v.error ?? "unknown"})`);
  }

  console.log(`\n# brainstrust — ${m.title} (${pattern}) · grounding: bundle\n`);
  for (const v of result.verdicts) {
    const tag = v.error ? `ERROR: ${v.error}` : v.from_reasoning ? "from reasoning stream (unstructured)" : "ok";
    console.log(`\n## ${v.model}  ·  lab: ${v.lab}  ·  ${tag}\n`);
    if (v.review) console.log(v.review);
  }

  const bundleSummary = `diff ${bundle.diffIncluded ? "included" : "none"}, ${bundle.filesRead.length} file(s) read${
    bundle.filesMissing.length ? `, ${bundle.filesMissing.length} skipped` : ""
  }, ${bundle.bytes} bytes`;
  console.log(
    `\n---\nGateway: routing=${result.routing} · labs: ${result.labs.join(", ")} · usable ${result.usable_verdicts}/${result.verdicts.length} · ${(
      result.elapsed_ms / 1000
    ).toFixed(0)}s\n` +
      `Grounding: bundle (${bundleSummary}). Artifacts: ${dir}\n` +
      `Synthesis is yours: the panel is INPUT, not verdict. Note where they agree/disagree, add your own read, and say if you disagree with all of them.`,
  );
  for (const n of result.notes) console.error(`note: ${n}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

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

  // Gateway is the default: no OpenRouter key needed, no weekly cap, no
  // OpenRouter spend. OpenRouter is opt-in — either an explicit
  // --transport openrouter, or (for anyone who already has a working key and
  // wants the richer live-exploration path) OPENROUTER_API_KEY being set.
  const transport: Transport = args.transport ?? (process.env.OPENROUTER_API_KEY ? "openrouter" : "gateway");

  if (transport === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error(
        "--transport openrouter needs OPENROUTER_API_KEY set. (Drop --transport, or unset it, to use the bt gateway instead — no key needed.)",
      );
      process.exit(1);
    }
    await runOpenRouterConsult(args, m, pattern, question);
    return;
  }
  await runGatewayConsult(args, m, pattern, question);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
