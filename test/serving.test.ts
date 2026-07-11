import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const ENDPOINT = {
  name: "databricks-gte-large-en",
  state: { ready: "READY", config_update: "NOT_UPDATING" },
  task: "llm/v1/embeddings",
};

describe("serving list", () => {
  it("passes exact argv and renders default fields from a bare array", async () => {
    t.fake.respond("serving-endpoints list", [
      ENDPOINT,
      {
        name: "custom-model",
        state: { ready: "NOT_READY", config_update: "UPDATING" },
        task: "llm/v1/chat",
      },
    ]);
    const { out, exitCode } = await t.run(["serving", "list"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["serving-endpoints", "list", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("endpoints[2]{name,state,task}:");
    expect(out).toContain("databricks-gte-large-en,READY,llm/v1/embeddings");
    expect(out).toContain("NOT_READY (updating)");
    expect(out).toContain("count: 2");
  });

  it("passes --limit through", async () => {
    t.fake.respond("serving-endpoints list", []);
    await t.run(["serving", "list", "--limit", "5"]);
    expect(t.fake.calls()).toEqual([
      ["serving-endpoints", "list", "--limit", "5", "-o", "json"],
    ]);
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    t.fake.respond("serving-endpoints list", [ENDPOINT]);
    const { out } = await t.run(["serving", "list", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("serving list --limit 2");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("serving-endpoints list", []);
    const { out, exitCode } = await t.run(["serving", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no serving endpoints in this workspace");
  });

  it("selects raw fields with --fields", async () => {
    t.fake.respond("serving-endpoints list", [
      { ...ENDPOINT, creation_timestamp: 5 },
    ]);
    const { out } = await t.run([
      "serving",
      "list",
      "--fields",
      "name,creation_timestamp",
    ]);
    expect(out).toContain("endpoints[1]{name,creation_timestamp}:");
    expect(out).toContain("databricks-gte-large-en,5");
  });
});

describe("serving view", () => {
  it("shows a foundation-model endpoint with no entity_version/workload_size", async () => {
    t.fake.respond("serving-endpoints get", {
      name: "databricks-gte-large-en",
      state: { ready: "READY", config_update: "NOT_UPDATING" },
      task: "llm/v1/embeddings",
      config: {
        served_entities: [
          {
            name: "gte-large-en-0",
            foundation_model: {
              name: "gte-large-en",
              display_name: "GTE Large EN",
              description: "embedding model",
              docs: "https://example.com",
            },
          },
        ],
      },
    });
    const { out, exitCode } = await t.run([
      "serving",
      "view",
      "databricks-gte-large-en",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["serving-endpoints", "get", "databricks-gte-large-en", "-o", "json"],
    ]);
    expect(out).toContain("name: databricks-gte-large-en");
    expect(out).toContain("state: READY");
    expect(out).toContain("task: llm/v1/embeddings");
    expect(out).toContain("GTE Large EN");
    expect(out).not.toContain("entity_version");
    expect(out).not.toContain("workload_size");
    expect(out).toContain(
      "/serving-endpoints/databricks-gte-large-en/invocations",
    );
  });

  it("shows a custom endpoint's entity_version/workload_size/scale_to_zero", async () => {
    t.fake.respond("serving-endpoints get", {
      name: "custom-model",
      state: { ready: "READY", config_update: "NOT_UPDATING" },
      task: "llm/v1/chat",
      config: {
        served_entities: [
          {
            name: "custom-model-1",
            entity_name: "catalog.schema.custom_model",
            entity_version: "3",
            workload_size: "Small",
            scale_to_zero: true,
          },
        ],
      },
    });
    const { out } = await t.run(["serving", "view", "custom-model"]);
    expect(out).toContain(
      "served_entities[1]{name,entity_version,workload_size,scale_to_zero}:",
    );
    expect(out).toContain('catalog.schema.custom_model,"3",Small,true');
  });

  it("shows an updating endpoint's compact state", async () => {
    t.fake.respond("serving-endpoints get", {
      name: "custom-model",
      state: { ready: "NOT_READY", config_update: "UPDATING" },
      task: "llm/v1/chat",
      config: { served_entities: [] },
    });
    const { out } = await t.run(["serving", "view", "custom-model"]);
    expect(out).toContain("NOT_READY (updating)");
  });

  it("maps the live serving-404 shape to NOT_FOUND", async () => {
    t.fake.respondError(
      "serving-endpoints get",
      "Error: Endpoint with name 'bogus-endpoint' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "serving",
      "view",
      "bogus-endpoint",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("serving list");
  });

  it("maps an empty upstream response to a structured error", async () => {
    t.fake.respondError("serving-endpoints get", "", 0);
    const { out, exitCode } = await t.run([
      "serving",
      "view",
      "databricks-gte-large-en",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });
});

describe("serving dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["serving", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare serving invocation", async () => {
    const { exitCode } = await t.run(["serving"]);
    expect(exitCode).toBe(2);
  });

  it("serves serving --help", async () => {
    const { out, exitCode } = await t.run(["serving", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi serving");
  });

  it("rejects extra positionals on id commands", async () => {
    const { exitCode } = await t.run(["serving", "view", "a", "b"]);
    expect(exitCode).toBe(2);
  });

  it("fails loud on an unknown flag", async () => {
    const { out, exitCode } = await t.run(["serving", "list", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--bogus'");
  });
});
