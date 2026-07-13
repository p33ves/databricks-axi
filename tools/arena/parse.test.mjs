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
  buildMetrics,
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

  it("renders a ToolSearch tool_reference result as tool names, not blank", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [
              {
                type: "tool_reference",
                tool_name: "mcp__databricks__list_jobs",
              },
              { type: "tool_reference", tool_name: "mcp__databricks__get_job" },
            ],
          },
        ],
      },
    });
    const [result] = condenseEvent(JSON.parse(line));
    expect(result).toBe(
      "RESULT: matched tools: mcp__databricks__list_jobs, mcp__databricks__get_job",
    );
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

describe("buildMetrics", () => {
  it("strips the host from error_line when the condition exits non-zero", () => {
    const metrics = buildMetrics(
      {
        code: 1,
        lastErrLine:
          "Error: cannot authenticate. Host: https://dbc-abc123.cloud.databricks.com",
      },
      12,
      ["not json, no result event"],
    );

    expect(metrics.exit).toBe(1);
    expect(metrics.is_error).toBe(true);
    expect(metrics.error_line).toBe(
      "Error: cannot authenticate. Host: <workspace>",
    );
    expect(metrics.error_line).not.toMatch(/https:|ReferenceError/);
  });

  it("leaves error_line null on a clean exit", () => {
    const metrics = buildMetrics({ code: 0, lastErrLine: "" }, 5, STREAM_LINES);
    expect(metrics.error_line).toBe(null);
    expect(metrics.is_error).toBe(false);
  });
});

describe("buildResultRow", () => {
  it("contains no host/token key and only the numeric metric fields plus task", () => {
    // Realistic runCondition shape, including the free-text fields that the
    // live paths attach (error_line can be the upstream CLI's stderr trailer
    // ending in "Host: https://..."): buildResultRow must strip every one of
    // them, so this fixture deliberately carries the worst case.
    const metrics = {
      exit: 1,
      wall_s: 12,
      ...parseResultEvent(STREAM_LINES),
      is_error: true,
      error_line: "Host: https://dbc-abc123.cloud.databricks.com",
      error: "spawn failed",
      disabled: true,
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
    expect(JSON.stringify(row)).not.toMatch(
      /"host|error_line|"error"|disabled|access_token|bearer|https:/i,
    );
  });
});

describe("buildComparison", () => {
  it("badges lowest cost (not token count) and fewest turns, skipping errored", () => {
    const metrics = {
      // fewest total tokens but the MOST expensive (cost must win, not tokens)
      mcp: { exit: 0, is_error: false, num_turns: 3, cost_usd: 0.53 },
      "raw-cli": { exit: 1, is_error: true, num_turns: 1, cost_usd: 0.01 },
      "databricks-axi": {
        exit: 0,
        is_error: false,
        num_turns: 2,
        cost_usd: 0.46,
      },
    };
    const c = buildComparison(metrics);
    expect(c.lowest_cost).toEqual(["databricks-axi"]);
    expect(c.lowest_turns).toEqual(["databricks-axi"]);
  });

  it("badges every condition tied at the minimum", () => {
    const metrics = {
      "raw-cli": { exit: 0, is_error: false, num_turns: 2, cost_usd: 0.11 },
      "databricks-axi": {
        exit: 0,
        is_error: false,
        num_turns: 2,
        cost_usd: 0.12,
      },
      mcp: { exit: 0, is_error: false, num_turns: 5, cost_usd: 0.2 },
    };
    const c = buildComparison(metrics);
    expect(c.lowest_cost).toEqual(["raw-cli"]); // distinct cost winner
    expect(c.lowest_turns.sort()).toEqual(["databricks-axi", "raw-cli"]); // 2-way tie
  });

  it("badges nobody when all candidates tie (a wash)", () => {
    const metrics = {
      "raw-cli": { exit: 0, is_error: false, num_turns: 2, cost_usd: 0.1 },
      "databricks-axi": {
        exit: 0,
        is_error: false,
        num_turns: 2,
        cost_usd: 0.1,
      },
      mcp: { exit: 0, is_error: false, num_turns: 2, cost_usd: 0.1 },
    };
    const c = buildComparison(metrics);
    expect(c.lowest_cost).toEqual([]);
    expect(c.lowest_turns).toEqual([]);
  });

  it("badges nobody when only one condition survives", () => {
    const metrics = {
      "raw-cli": { exit: 1, is_error: true, num_turns: 1, cost_usd: 0.01 },
      mcp: { exit: null, is_error: true, disabled: true },
      "databricks-axi": {
        exit: 0,
        is_error: false,
        num_turns: 2,
        cost_usd: null,
      },
    };
    const c = buildComparison(metrics);
    expect(c.lowest_cost).toEqual([]);
    expect(c.lowest_turns).toEqual([]);
  });
});
