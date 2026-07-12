// Hermetic self-check for tools/arena/server.mjs's pure parse helpers.
// No vitest config exists in this repo, so vitest globals are off here;
// import explicitly (implementer note b) — relying on globals would also
// fail lint, since eslint only grants vitest globals to *.test.ts.
//
// Must never spawn `claude`/`databricks` — pure parsing only.
import { describe, it, expect } from "vitest";
import {
  condense,
  condenseEvent,
  parseResultEvent,
  buildResultRow,
  buildComparison,
} from "./server.mjs";

// A few assistant/user events + one final `result` event, same shape as a
// real `claude -p --output-format stream-json --verbose` transcript.
const STREAM_LINES = [
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Let me check the cluster." }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "databricks clusters list -o json" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content: [{ type: "text", text: '[{"cluster_id":"123"}]' }],
        },
      ],
    },
  }),
  "not json, must be skipped without throwing",
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.01234,
    duration_api_ms: 4567,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 50,
    },
  }),
];

describe("condense", () => {
  it("produces ASSISTANT/TOOL/RESULT lines and skips malformed JSON", () => {
    expect(condense(STREAM_LINES)).toEqual([
      "ASSISTANT: Let me check the cluster.",
      "TOOL Bash: databricks clusters list -o json",
      'RESULT: [{"cluster_id":"123"}]',
    ]);
  });

  it("truncates a tool_result longer than 1500 chars", () => {
    const longText = "x".repeat(2000);
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: [{ type: "text", text: longText }] },
        ],
      },
    });
    const [result] = condenseEvent(JSON.parse(line));
    expect(result.startsWith("RESULT: " + "x".repeat(1500))).toBe(true);
    expect(result.endsWith("[...truncated]")).toBe(true);
  });

  it("ignores events with no message content array", () => {
    expect(condenseEvent({ type: "system" })).toEqual([]);
  });
});

describe("parseResultEvent", () => {
  it("yields the expected tokens/turns/cost from the final result event", () => {
    expect(parseResultEvent(STREAM_LINES)).toEqual({
      num_turns: 3,
      tokens_in: 100,
      tokens_cache_create: 10,
      tokens_cache_read: 20,
      tokens_out: 50,
      cost_usd: 0.01234,
      is_error: false,
    });
  });

  it("returns nulls when there is no result event", () => {
    expect(parseResultEvent(["not json"])).toEqual({
      num_turns: null,
      tokens_in: null,
      tokens_cache_create: null,
      tokens_cache_read: null,
      tokens_out: null,
      cost_usd: null,
      is_error: null,
    });
  });
});

describe("buildResultRow", () => {
  it("contains no host/token key and only the numeric metric fields plus task", () => {
    const metrics = {
      exit: 0,
      wall_s: 12,
      ...parseResultEvent(STREAM_LINES),
    };
    const row = buildResultRow("list clusters", {
      "raw-cli": metrics,
      mcp: metrics,
      "databricks-axi": metrics,
    });

    expect(Object.keys(row).sort()).toEqual(["conditions", "task", "ts"]);
    expect(row.task).toBe("list clusters");
    expect(typeof row.ts).toBe("string");
    // Whitelist, matching the exact metric field list in spec §6 — a "host"
    // or credential-shaped key would fail this, but the legitimate
    // "tokens_in"/"tokens_out"/etc. token-COUNT fields must not.
    const allowedKeys = new Set([
      "exit",
      "wall_s",
      "num_turns",
      "tokens_in",
      "tokens_cache_create",
      "tokens_cache_read",
      "tokens_out",
      "cost_usd",
      "is_error",
    ]);
    for (const cond of Object.values(row.conditions)) {
      for (const [key, value] of Object.entries(cond)) {
        expect(allowedKeys.has(key)).toBe(true);
        expect(
          typeof value === "number" ||
            typeof value === "boolean" ||
            value === null,
        ).toBe(true);
      }
    }
    expect(JSON.stringify(row)).not.toMatch(/"host"|access_token|bearer/i);
  });
});

describe("buildComparison", () => {
  it("picks the lowest-tokens and lowest-turns condition, skipping errored ones", () => {
    const metrics = {
      "raw-cli": {
        exit: 0,
        is_error: false,
        num_turns: 8,
        tokens_in: 500,
        tokens_out: 300,
        tokens_cache_read: 0,
      },
      mcp: {
        exit: 1,
        is_error: true,
        num_turns: 1,
        tokens_in: 10,
        tokens_out: 5,
        tokens_cache_read: 0,
      },
      "databricks-axi": {
        exit: 0,
        is_error: false,
        num_turns: 2,
        tokens_in: 50,
        tokens_out: 30,
        tokens_cache_read: 0,
      },
    };
    const comparison = buildComparison(metrics);
    expect(comparison.lowest_tokens).toBe("databricks-axi");
    expect(comparison.lowest_turns).toBe("databricks-axi");
  });
});
