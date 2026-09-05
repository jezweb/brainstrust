import { test } from "node:test";
import assert from "node:assert/strict";
import { pickModels } from "../models.ts";

const REAL_FETCH = globalThis.fetch;

function mockFetch(handler: (url: string) => Response) {
  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (input: string | URL) => handler(String(input));
}

function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

test("pickModels: explicit ids win as-is on the gateway transport, provider read from @cf/<provider>/<model>", async () => {
  const { models, stale } = await pickModels({
    explicit: "@cf/moonshotai/kimi-k2.6,@cf/openai/gpt-oss-120b",
    count: 5,
    transport: "gateway",
  });
  assert.equal(stale, false);
  assert.deepEqual(models, [
    { id: "@cf/moonshotai/kimi-k2.6", provider: "moonshotai" },
    { id: "@cf/openai/gpt-oss-120b", provider: "openai" },
  ]);
});

test("pickModels: explicit ids win as-is on the openrouter transport, provider read from <provider>/<model>", async () => {
  const { models, stale } = await pickModels({
    explicit: "openai/gpt-5.4, google/gemini-3.1-pro-preview",
    count: 5,
    transport: "openrouter",
  });
  assert.equal(stale, false);
  assert.deepEqual(models, [
    { id: "openai/gpt-5.4", provider: "openai" },
    { id: "google/gemini-3.1-pro-preview", provider: "google" },
  ]);
});

test("pickModels(gateway): sources ids from the bt gateway's /health.default_panel, drops anthropic, dedupes by lab, respects count", async () => {
  mockFetch((url) => {
    assert.match(url, /\/health$/);
    return new Response(
      JSON.stringify({
        ok: true,
        routing: "ai-binding",
        default_panel: [
          "@cf/moonshotai/kimi-k2.6",
          "@cf/qwen/qwen3.8-27b",
          "@cf/anthropic/claude-x", // must be excluded — Claude rides a Task subagent, not this
          "@cf/zai-org/glm-5.3",
          "@cf/deepseek-ai/deepseek-v4-pro-0813",
          "@cf/openai/gpt-oss-120b",
        ],
        synthesis_model: "@cf/moonshotai/kimi-k2.6",
      }),
      { status: 200 },
    );
  });
  try {
    const { models, stale } = await pickModels({ count: 3, transport: "gateway" });
    assert.equal(stale, false);
    assert.equal(models.length, 3);
    assert.deepEqual(
      models.map((m) => m.id),
      ["@cf/moonshotai/kimi-k2.6", "@cf/qwen/qwen3.8-27b", "@cf/zai-org/glm-5.3"],
    );
    assert.ok(!models.some((m) => m.provider === "anthropic"));
  } finally {
    restoreFetch();
  }
});

test("pickModels(gateway): falls back to a stale set when /health is unreachable, and says so", async () => {
  mockFetch(() => new Response("boom", { status: 500 }));
  try {
    const { models, stale } = await pickModels({ count: 5, transport: "gateway" });
    assert.equal(stale, true);
    assert.ok(models.length > 0);
    assert.ok(models.every((m) => m.id.startsWith("@cf/")));
  } finally {
    restoreFetch();
  }
});

test("pickModels(openrouter): falls back to a stale set when models.flared.au is unreachable, and says so", async () => {
  mockFetch(() => new Response("boom", { status: 500 }));
  try {
    const { models, stale } = await pickModels({ count: 5, transport: "openrouter" });
    assert.equal(stale, true);
    assert.ok(models.length > 0);
    assert.ok(!models.some((m) => m.provider === "anthropic"));
  } finally {
    restoreFetch();
  }
});

test("withGatewayFloor: pads a below-floor request up to the gateway's panel floor", async () => {
  const { withGatewayFloor, GATEWAY_MIN_ANSWERED } = await import("../models.ts");
  assert.equal(withGatewayFloor(1), GATEWAY_MIN_ANSWERED);
  assert.equal(withGatewayFloor(2), GATEWAY_MIN_ANSWERED);
  assert.equal(withGatewayFloor(3), 3);
  assert.equal(withGatewayFloor(5), 5);
});
