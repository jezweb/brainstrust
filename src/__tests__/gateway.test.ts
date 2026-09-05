import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchGatewayHealth, callGatewayPanel, resolveBtToken, GatewayError } from "../gateway.ts";

const REAL_FETCH = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  // @ts-expect-error — test double, narrower than the real fetch signature
  globalThis.fetch = async (input: string | URL, init?: RequestInit) => handler(String(input), init);
}

function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

test("resolveBtToken: $BT_TOKEN env wins over the secrets file", () => {
  const prev = process.env.BT_TOKEN;
  process.env.BT_TOKEN = "  abc123  ";
  try {
    assert.equal(resolveBtToken(), "abc123");
  } finally {
    if (prev === undefined) delete process.env.BT_TOKEN;
    else process.env.BT_TOKEN = prev;
  }
});

test("fetchGatewayHealth: parses default_panel from a live-shaped /health response", async () => {
  mockFetch((url) => {
    assert.match(url, /\/health$/);
    return new Response(
      JSON.stringify({
        ok: true,
        routing: "ai-binding",
        default_panel: ["@cf/moonshotai/kimi-k2.6", "@cf/qwen/qwen3.8-27b"],
        synthesis_model: "@cf/moonshotai/kimi-k2.6",
      }),
      { status: 200 },
    );
  });
  try {
    const health = await fetchGatewayHealth();
    assert.equal(health.routing, "ai-binding");
    assert.deepEqual(health.default_panel, ["@cf/moonshotai/kimi-k2.6", "@cf/qwen/qwen3.8-27b"]);
  } finally {
    restoreFetch();
  }
});

test("fetchGatewayHealth: throws GatewayError on a non-2xx status", async () => {
  mockFetch(() => new Response("nope", { status: 503 }));
  try {
    await assert.rejects(() => fetchGatewayHealth(), GatewayError);
  } finally {
    restoreFetch();
  }
});

test("fetchGatewayHealth: throws GatewayError when default_panel is missing/empty", async () => {
  mockFetch(() => new Response(JSON.stringify({ ok: true, default_panel: [] }), { status: 200 }));
  try {
    await assert.rejects(() => fetchGatewayHealth(), GatewayError);
  } finally {
    restoreFetch();
  }
});

test("callGatewayPanel: sends a bearer token and returns the parsed verdicts", async () => {
  const prev = process.env.BT_TOKEN;
  process.env.BT_TOKEN = "test-token-123";
  let seenAuth: string | undefined;
  let seenBody: unknown;
  mockFetch((url, init) => {
    assert.match(url, /\/panel$/);
    seenAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        panel: ["@cf/moonshotai/kimi-k2.6", "@cf/openai/gpt-oss-120b", "@cf/qwen/qwen3.8-27b"],
        labs: ["moonshot", "openai", "alibaba"],
        routing: "ai-binding",
        verdicts: [
          { model: "@cf/moonshotai/kimi-k2.6", lab: "moonshot", review: "looks fine" },
          { model: "@cf/openai/gpt-oss-120b", lab: "openai", review: "" , error: "HTTP 500" },
          { model: "@cf/qwen/qwen3.8-27b", lab: "alibaba", review: "some raw reasoning", from_reasoning: true },
        ],
        usable_verdicts: 2,
        notes: [],
        elapsed_ms: 1234,
      }),
      { status: 200 },
    );
  });
  try {
    const result = await callGatewayPanel("a question", ["@cf/moonshotai/kimi-k2.6"]);
    assert.equal(seenAuth, "Bearer test-token-123");
    assert.deepEqual((seenBody as { panel: string[] }).panel, ["@cf/moonshotai/kimi-k2.6"]);
    assert.equal(result.labs.length, 3);
    assert.equal(result.verdicts.length, 3);
    assert.equal(result.usable_verdicts, 2);
  } finally {
    restoreFetch();
    if (prev === undefined) delete process.env.BT_TOKEN;
    else process.env.BT_TOKEN = prev;
  }
});

test("callGatewayPanel: refuses to call out with no token available", async () => {
  const prev = process.env.BT_TOKEN;
  delete process.env.BT_TOKEN;
  // Point at a path that will never resolve to a real token file in CI/dev sandboxes.
  const prevHome = process.env.HOME;
  process.env.HOME = "/nonexistent-home-for-tests";
  let called = false;
  mockFetch(() => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  try {
    await assert.rejects(() => callGatewayPanel("q", ["m"]), GatewayError);
    assert.equal(called, false, "must not fetch when no token is resolvable");
  } finally {
    restoreFetch();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prev !== undefined) process.env.BT_TOKEN = prev;
  }
});

test("callGatewayPanel: a non-2xx response is surfaced as a GatewayError, not swallowed", async () => {
  process.env.BT_TOKEN = "t";
  mockFetch(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
  try {
    await assert.rejects(() => callGatewayPanel("q", ["m"]), GatewayError);
  } finally {
    restoreFetch();
  }
});

test("callGatewayPanel: a raw fetch/network failure is wrapped as GatewayError, never leaked raw", async () => {
  process.env.BT_TOKEN = "t";
  // test double: fetch throws directly, simulating a DNS/network failure.
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(() => callGatewayPanel("q", ["m"]), GatewayError);
  } finally {
    restoreFetch();
  }
});

test("callGatewayPanel: an aborted/timed-out request is wrapped as GatewayError with a clear reason", async () => {
  process.env.BT_TOKEN = "t";
  // test double: fetch throws an AbortError, simulating the AbortSignal.timeout firing.
  globalThis.fetch = async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  try {
    await assert.rejects(() => callGatewayPanel("q", ["m"]), (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      assert.match((err as Error).message, /timed out/);
      return true;
    });
  } finally {
    restoreFetch();
  }
});

test("callGatewayPanel: a malformed response shape (missing verdicts) is refused, not cast blindly", async () => {
  process.env.BT_TOKEN = "t";
  mockFetch(() => new Response(JSON.stringify({ panel: [], labs: [] }), { status: 200 }));
  try {
    await assert.rejects(() => callGatewayPanel("q", ["m"]), GatewayError);
  } finally {
    restoreFetch();
  }
});

test("GatewayError: sets its own name, so it doesn't report as a generic Error in logs", () => {
  const err = new GatewayError("boom");
  assert.equal(err.name, "GatewayError");
});
