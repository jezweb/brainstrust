// Pre-gathered repo context for the gateway path (gateway.ts).
//
// The gateway is a single chat-completion call, not a tool-calling loop, so
// it cannot explore the repo the way the OpenRouter agent loop's models do
// (tools.ts). This module bundles the working-tree diff (if any) plus the
// specific hinted files into one capped block instead. Every gateway result
// built from it is labelled `grounding: bundle` in consult.ts's output — the
// difference from live tool exploration is surfaced, never silently implied
// to be the same thing.

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

/** Leaves headroom under the gateway's 400KB/field cap for instructions + lens + the rest of the prompt. */
export const DEFAULT_BUNDLE_MAX_BYTES = 150_000;
const MAX_FILE_BYTES = 60_000;
const MAX_DIFF_BYTES = 60_000;

export interface Hint {
  path: string;
  why: string;
}

/** Parse `--paths "a/b.ts:why; c/d.ts"` into structured hints. Shared by consult.ts's prompt text and gatherBundle's file reads. */
export function parsePathHints(paths?: string): Hint[] {
  if (!paths) return [];
  return paths
    .split(";")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      const idx = h.indexOf(":"); // split on FIRST colon — a "why" can itself contain colons
      const p = (idx === -1 ? h : h.slice(0, idx)).trim();
      const why = idx === -1 ? "" : h.slice(idx + 1).trim();
      return { path: p, why };
    });
}

export interface Bundle {
  text: string;
  filesRead: string[];
  filesMissing: string[];
  diffIncluded: boolean;
  bytes: number;
  truncated: boolean;
}

/** `git diff HEAD` for the repo, capped — empty string if not a git repo or there's nothing to show. */
function gitDiff(repo: string): string {
  try {
    const out = execFileSync("git", ["-C", repo, "diff", "HEAD", "--"], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return out.length > MAX_DIFF_BYTES ? `${out.slice(0, MAX_DIFF_BYTES)}\n...(diff truncated)` : out;
  } catch {
    return "";
  }
}

function readCapped(abs: string): string {
  const size = statSync(abs).size;
  if (size <= MAX_FILE_BYTES) return readFileSync(abs, "utf8");
  // Bounded read for a big file — same reasoning as tools.ts's read_file.
  const content = readFileSync(abs, "utf8").slice(0, MAX_FILE_BYTES);
  return `${content}\n...(truncated)`;
}

/**
 * Build the context block a gateway-path consult sees in place of live tool
 * access: the working-tree diff (if any) plus every hinted file's content,
 * capped in total at `maxBytes`. A path that resolves outside the repo, does
 * not exist, or arrives after the cap is listed in `filesMissing` rather than
 * silently dropped, so both the model and the calling agent can see what it
 * did not get.
 */
export function gatherBundle(repo: string, hints: Hint[], maxBytes = DEFAULT_BUNDLE_MAX_BYTES): Bundle {
  const root = resolve(repo);
  const prefix = root.endsWith(sep) ? root : root + sep;
  const parts: string[] = [];
  const filesRead: string[] = [];
  const filesMissing: string[] = [];
  let bytes = 0;
  let truncated = false;

  const diff = gitDiff(root);
  const diffIncluded = Boolean(diff.trim());
  if (diffIncluded) {
    parts.push(`--- git diff HEAD ---\n${diff}`);
    bytes += diff.length;
  }

  for (const h of hints) {
    if (bytes >= maxBytes) {
      truncated = true;
      filesMissing.push(h.path);
      continue;
    }
    const abs = resolve(root, h.path);
    if (abs !== root && !abs.startsWith(prefix)) {
      filesMissing.push(h.path); // refuse to leave the repo — same clamp as tools.ts's safePath
      continue;
    }
    let content: string;
    try {
      content = readCapped(abs);
    } catch {
      filesMissing.push(h.path);
      continue;
    }
    filesRead.push(h.path);
    bytes += content.length;
    parts.push(`--- ${relative(root, abs)}${h.why ? ` — ${h.why}` : ""} ---\n${content}`);
  }

  return {
    text: parts.join("\n\n"),
    filesRead,
    filesMissing,
    diffIncluded,
    bytes,
    truncated,
  };
}
