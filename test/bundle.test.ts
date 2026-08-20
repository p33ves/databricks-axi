import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const JOB_ID = "331085809900271";
const PIPELINE_UUID = "905299c1-874d-44b6-995b-e6a5d2eb1a84";

const VALIDATE_CONFIG_CLEAN = {
  bundle: { name: "axi_probe", target: "dev", mode: "development" },
  workspace: {
    root_path: "/Workspace/Users/u@x.com/.bundle/axi_probe/dev",
    current_user: {
      userName: "u@x.com",
      groups: [{ value: "1" }],
      entitlements: [{ value: "allow-cluster-create" }],
    },
  },
  resources: {
    jobs: { probe_job: { name: "x" } },
    pipelines: { probe_pipeline: { name: "y" } },
  },
};

const FOUR_DIAG_STDERR = `Warning: unknown field: nmae
  at resources.jobs.j1
  in databricks.yml:6:7

Warning: unknown field: taskss
  at resources.jobs.j1
  in databricks.yml:7:7

Warning: cannot parse "not-a-number" as an integer
  at resources.jobs.j2.max_concurrent_runs
  in databricks.yml:10:28

Error: job requires at least one task
  at resources.jobs.j1
  in databricks.yml:5:3
`;

describe("bundle validate", () => {
  it("passes exact argv and renders a clean digest", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr: "",
      exitCode: 0,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["bundle", "validate", "-o", "json"]]);
    expect(out).toContain("bundle: axi_probe");
    expect(out).toContain("target: dev");
    expect(out).toContain("mode: development");
    expect(out).toContain("user: u@x.com");
    expect(out).toContain(
      "root_path: /Workspace/Users/u@x.com/.bundle/axi_probe/dev",
    );
    expect(out).toContain("valid: true");
    expect(out).toContain("errors: 0");
    expect(out).toContain("warnings: 0");
    expect(out).toContain("resources[2]{type,count,keys}:");
    expect(out).toContain("jobs,1,probe_job");
    expect(out).toContain("pipelines,1,probe_pipeline");
    // The SCIM current_user blob is never rendered.
    expect(out).not.toContain("allow-cluster-create");
  });

  it("threads --target/--profile onto argv", async () => {
    t.fake.respondWith("-p AWS bundle validate -t dev", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      exitCode: 0,
    });
    await t.run(["bundle", "validate", "--target", "dev", "--profile", "AWS"]);
    expect(t.fake.calls()).toEqual([
      ["-p", "AWS", "bundle", "validate", "-t", "dev", "-o", "json"],
    ]);
  });

  it("D3/§0b.1: reports the real Error, not the first Warning, at exit 0", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr: FOUR_DIAG_STDERR,
      exitCode: 1,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("valid: false");
    expect(out).toContain("errors: 1");
    expect(out).toContain("warnings: 3");
    expect(out).toContain("job requires at least one task");
    // The real Error sorts ahead of the Warning entries.
    expect(out.indexOf("job requires at least one task")).toBeLessThan(
      out.indexOf("unknown field: nmae"),
    );
  });

  it("warnings-only stays valid: true without --strict", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr:
        "Warning: unknown field: nmae\n  at resources.jobs.j1\n  in databricks.yml:6:7\n",
      exitCode: 0,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("valid: true");
    expect(out).toContain("warnings: 1");
  });

  it("C4: --strict flips valid to false client-side and never reaches upstream argv", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr:
        "Warning: unknown field: nmae\n  at resources.jobs.j1\n  in databricks.yml:6:7\n",
      exitCode: 0,
    });
    const { out, exitCode } = await t.run(["bundle", "validate", "--strict"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("valid: false");
    expect(t.fake.calls()).toEqual([["bundle", "validate", "-o", "json"]]);
  });

  it("unknown-target: throws UPSTREAM_ERROR carrying 'Available targets:'", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify({ bundle: { name: "axi_probe" } }),
      stderr:
        "Error: nosuchtarget: no such target. Available targets: dev, prod\n",
      exitCode: 1,
    });
    const { out, exitCode } = await t.run([
      "bundle",
      "validate",
      "--target",
      "nosuchtarget",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("Available targets:");
  });

  it("auth-shaped first Error classifies as AUTH_ERROR, exit 1", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: "{}",
      stderr: "Error: token expired, please re-authenticate\n",
      exitCode: 1,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: AUTH_ERROR");
  });

  it("{} stdout + a parse-error Error: renders a structured digest, no crash", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: "{}",
      stderr:
        "Error: failed to parse databricks.yml: yaml: line 3: bad mapping\n",
      exitCode: 1,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("valid: false");
    expect(out).toContain("errors: 1");
  });

  it("unparseable stderr degrades to parse_failed: true, no manufactured severity", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr:
        "a completely unrecognized failure shape with no diagnostic prefix\n",
      exitCode: 1,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("parse_failed: true");
    expect(out).toContain("diagnostics: []");
    expect(out).toContain("unrecognized failure shape");
    expect(out).toContain("valid: false");
  });

  it("logger-only stderr on a clean exit 0 keeps the full digest, no parse_failed", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr: "Warn: [hostmetadata] cloud metadata lookup timed out\n",
      exitCode: 0,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("parse_failed");
    expect(out).toContain("bundle: axi_probe");
    expect(out).toContain("valid: true");
    expect(out).toContain("warnings: 0");
  });

  it("drops the logger's Warn: [hostmetadata] line instead of miscounting it", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr:
        "Warn: [hostmetadata] cloud metadata lookup timed out\nWarning: unknown field: nmae\n  at resources.jobs.j1\n  in databricks.yml:6:7\n",
      exitCode: 0,
    });
    const { out } = await t.run(["bundle", "validate"]);
    expect(out).toContain("warnings: 1");
    expect(out).not.toContain("hostmetadata");
  });

  it("missing workspace object renders no user/root_path keys, no crash", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify({
        bundle: { name: "x", target: "dev" },
        resources: {},
      }),
      stderr: "",
      exitCode: 0,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("user:");
    expect(out).not.toContain("root_path:");
  });

  it("--full adds the raw config and every diagnostic beyond the 10-cap", async () => {
    const manyWarnings = Array.from(
      { length: 12 },
      (_, i) => `Warning: warning number ${i}\n  at resources.jobs.j${i}\n`,
    ).join("\n");
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      stderr: manyWarnings,
      exitCode: 0,
    });
    const { out: defaultOut } = await t.run(["bundle", "validate"]);
    expect(defaultOut).toContain("diagnostics[10]");
    expect(defaultOut).toContain("showing 10 of 12 diagnostics");

    const { out: fullOut } = await t.run(["bundle", "validate", "--full"]);
    expect(fullOut).toContain("diagnostics[12]");
    expect(fullOut).toContain("allow-cluster-create"); // only visible via raw config
  });

  it("not-in-a-bundle: VALIDATION_ERROR, exit 2", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: "",
      stderr: "Error: unable to locate bundle root: databricks.yml not found\n",
      exitCode: 1,
    });
    const { out, exitCode } = await t.run(["bundle", "validate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("code: VALIDATION_ERROR");
  });

  it("C5: a comma in --var's value is rejected before spawning, message names only the key", async () => {
    const { out, exitCode } = await t.run([
      "bundle",
      "validate",
      "--var",
      "msg=a,other=b",
    ]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
    expect(out).toContain("comma");
    expect(out).toContain("msg");
    expect(out).not.toContain("msg=a,other=b");
  });

  it.each([
    ["no equals sign", "secret,value"],
    ["empty key", "=v"],
    ["non-identifier key", "bad key=v"],
    ["digit-leading key", "1abc=v"],
  ])(
    "a malformed --var pair (%s) is rejected before spawning without echoing it",
    async (_label, pair) => {
      const { out, exitCode } = await t.run([
        "bundle",
        "validate",
        "--var",
        pair,
      ]);
      expect(exitCode).toBe(2);
      expect(t.fake.calls()).toEqual([]);
      expect(out).toContain("code: VALIDATION_ERROR");
      expect(out).not.toContain(pair);
      expect(out).not.toContain("secret,valu");
    },
  );

  it("C6: a repeated --var is rejected before spawning", async () => {
    const { exitCode } = await t.run([
      "bundle",
      "validate",
      "--var",
      "a=1",
      "--var",
      "b=2",
    ]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("C6: a mixed --var/--var= repeat is also rejected", async () => {
    const { exitCode } = await t.run([
      "bundle",
      "validate",
      "--var",
      "a=1",
      "--var=b=2",
    ]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("F1: --var never lands on argv — delivered via BUNDLE_VAR_<name> env instead", async () => {
    t.fake.respondWith("bundle validate", {
      stdoutRaw: JSON.stringify(VALIDATE_CONFIG_CLEAN),
      exitCode: 0,
    });
    await t.run(["bundle", "validate", "--var", "a=1"]);
    expect(t.fake.calls()).toEqual([["bundle", "validate", "-o", "json"]]);
    for (const call of t.fake.calls()) {
      expect(call).not.toContain("--var");
      expect(call.some((a) => a.startsWith("--var"))).toBe(false);
    }
    expect(t.fake.envs()).toEqual([{ BUNDLE_VAR_a: "1" }]);
  });
});

describe("bundle plan", () => {
  const PLAN_MIXED = {
    plan_version: 2,
    cli_version: "1.6.0",
    plan: {
      "resources.jobs.probe_job": {
        action: "update",
        changes: {
          max_concurrent_runs: { action: "update", old: 4, new: 2, remote: 4 },
          name: {
            action: "update",
            old: "old-name",
            new: "new-name",
            remote: "old-name",
          },
          email_notifications: { action: "skip", reason: "empty", remote: {} },
          "tasks[task_key='hello'].run_if": {
            action: "skip",
            reason: "backend_default",
            remote: "ALL_SUCCESS",
          },
          f1: { action: "skip", reason: "backend_default" },
          f2: { action: "skip", reason: "backend_default" },
          f3: { action: "skip", reason: "backend_default" },
          f4: { action: "skip", reason: "backend_default" },
          f5: { action: "skip", reason: "backend_default" },
          f6: { action: "skip", reason: "backend_default" },
          f7: { action: "skip", reason: "backend_default" },
        },
      },
      "resources.jobs.probe_job.permissions": { action: "skip" },
    },
  };

  it("passes exact argv, tallies actions, and emits jobs.probe_job (not resources.jobs.probe_job)", async () => {
    t.fake.respond("bundle plan", PLAN_MIXED);
    const { out, exitCode } = await t.run([
      "bundle",
      "plan",
      "--target",
      "dev",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["bundle", "plan", "-t", "dev", "-o", "json"],
    ]);
    expect(out).toContain("plan_version: 2");
    expect(out).toContain("jobs.probe_job,update");
    expect(out).not.toContain("resources.jobs.probe_job,update");
    expect(out).toContain("max_concurrent_runs,name");
    expect(out).not.toContain('"id"');
  });

  it("C3: excludes child entries from resources/actions, counts them in nested", async () => {
    t.fake.respond("bundle plan", PLAN_MIXED);
    const { out } = await t.run(["bundle", "plan"]);
    expect(out).toContain("nested: 1");
    expect(out).toContain("count: 1");
  });

  it("changed_fields lists only the non-skip changes from an 11-entry map", async () => {
    t.fake.respond("bundle plan", PLAN_MIXED);
    const { out } = await t.run(["bundle", "plan"]);
    expect(out).toContain('jobs.probe_job,update,"max_concurrent_runs,name"');
  });

  it("skip rows are excluded by default, included under --full with new_state/remote_state absent by default", async () => {
    const skipOnly = {
      plan_version: 2,
      plan: {
        "resources.jobs.probe_job": { action: "skip", new_state: { x: 1 } },
      },
    };
    t.fake.respond("bundle plan", skipOnly);
    const { out: defOut } = await t.run(["bundle", "plan"]);
    expect(defOut).not.toContain("new_state");
    expect(defOut).toContain("status: no changes for target default");

    const { out: fullOut } = await t.run(["bundle", "plan", "--full"]);
    expect(fullOut).toContain("new_state");
  });

  it("recreate/delete actions emit a data-loss warning line", async () => {
    const destructive = {
      plan: {
        "resources.jobs.a": { action: "recreate" },
        "resources.jobs.b": { action: "delete" },
      },
    };
    t.fake.respond("bundle plan", destructive);
    const { out } = await t.run(["bundle", "plan"]);
    expect(out).toContain("warning:");
    expect(out).toMatch(/data-losing/);
  });

  it("empty plan renders a definitive no-changes verdict, exit 0", async () => {
    t.fake.respond("bundle plan", { plan_version: 2, plan: {} });
    const { out, exitCode } = await t.run(["bundle", "plan"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no changes for target default");
  });

  it("C2: an all-create plan (never deployed) is a normal plan, not an error", async () => {
    t.fake.respond("bundle plan", {
      plan_version: 2,
      plan: { "resources.jobs.probe_job": { action: "create" } },
    });
    const { out, exitCode } = await t.run(["bundle", "plan"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("jobs.probe_job,create");
    expect(out).not.toContain("no changes");
  });

  it("C9: a terraform-engine plan (no plan_version) omits the field instead of defaulting it", async () => {
    t.fake.respond("bundle plan", {
      plan: { "resources.jobs.probe_job": { action: "skip" } },
    });
    const { out } = await t.run(["bundle", "plan"]);
    expect(out).not.toContain("plan_version");
  });

  it("C9: --select rejection on a terraform-engine bundle passes through as UPSTREAM_ERROR", async () => {
    t.fake.respondError(
      "bundle plan",
      "Error: --select is only supported with the direct engine\n",
    );
    const { out, exitCode } = await t.run([
      "bundle",
      "plan",
      "--select",
      "jobs.x",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("direct engine");
  });

  it("C1: forwards --select as-is (already the accepted <type>.<name> form)", async () => {
    t.fake.respond("bundle plan --select jobs.probe_job", PLAN_MIXED);
    await t.run(["bundle", "plan", "--select", "jobs.probe_job"]);
    expect(t.fake.calls()).toEqual([
      ["bundle", "plan", "--select", "jobs.probe_job", "-o", "json"],
    ]);
  });

  it("F3: --fields subsets a plan row instead of being silently ignored", async () => {
    t.fake.respond("bundle plan", PLAN_MIXED);
    const { out } = await t.run(["bundle", "plan", "--fields", "key"]);
    expect(out).toContain("resources[1]{key}:");
    expect(out).not.toContain("changed_fields");
  });

  it("plan_bytes is present in the default digest", async () => {
    t.fake.respond("bundle plan", { plan_version: 2, plan: {} });
    const { out } = await t.run(["bundle", "plan"]);
    expect(out).toContain("plan_bytes:");
  });

  it("not-in-a-bundle: VALIDATION_ERROR, exit 2", async () => {
    t.fake.respondError(
      "bundle plan",
      "Error: unable to locate bundle root: databricks.yml not found\n",
    );
    const { exitCode } = await t.run(["bundle", "plan"]);
    expect(exitCode).toBe(2);
  });
});

describe("bundle summary", () => {
  const DEPLOYED = {
    resources: {
      jobs: {
        probe_job: {
          name: "[dev u] axi_probe_job",
          id: JOB_ID,
          url: `https://x/jobs/${JOB_ID}?o=1`,
          modified_status: "created",
        },
      },
    },
  };
  const NOT_DEPLOYED = {
    resources: { jobs: { probe_job: { name: "axi_probe_job" } } },
  };

  it("renders deployed resources with real id/url", async () => {
    t.fake.respond("bundle summary", DEPLOYED);
    const { out, exitCode } = await t.run(["bundle", "summary"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["bundle", "summary", "-o", "json"]]);
    expect(out).toContain("resources[1]{type,key,name,id,url}:");
    expect(out).toContain(JOB_ID);
    expect(out).toContain("count: 1");
  });

  it("--fields subsets the row", async () => {
    t.fake.respond("bundle summary", DEPLOYED);
    const { out } = await t.run(["bundle", "summary", "--fields", "key,id"]);
    expect(out).toContain("resources[1]{key,id}:");
  });

  it("C2: no resource carries an id -> definitive no-deployment verdict, exit 0", async () => {
    t.fake.respond("bundle summary", NOT_DEPLOYED);
    const { out, exitCode } = await t.run([
      "bundle",
      "summary",
      "--target",
      "dev",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no deployment for target dev");
  });

  it("--force-pull only appears on argv when passed", async () => {
    t.fake.respond("bundle summary --force-pull", DEPLOYED);
    await t.run(["bundle", "summary", "--force-pull"]);
    expect(t.fake.calls()).toEqual([
      ["bundle", "summary", "--force-pull", "-o", "json"],
    ]);
  });

  it("--full adds modified_status", async () => {
    t.fake.respond("bundle summary", DEPLOYED);
    const { out } = await t.run(["bundle", "summary", "--full"]);
    expect(out).toContain("modified_status");
  });

  it("not-in-a-bundle: VALIDATION_ERROR, exit 2", async () => {
    t.fake.respondError(
      "bundle summary",
      "Error: unable to locate bundle root: databricks.yml not found\n",
    );
    const { exitCode } = await t.run(["bundle", "summary"]);
    expect(exitCode).toBe(2);
  });
});

describe("bundle deploy", () => {
  it("0-byte stdout + progress on stderr + exit 0 -> status: deployed", async () => {
    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      stderr: "Uploading bundle files...\nDeployment complete!\n",
      exitCode: 0,
    });
    const { out, exitCode } = await t.run(["bundle", "deploy", "--yes"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["bundle", "deploy", "--auto-approve"]]);
    expect(out).toContain("status: deployed");
  });

  it("F1: --var never lands on deploy argv — delivered via BUNDLE_VAR_<name> env instead", async () => {
    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      exitCode: 0,
    });
    await t.run(["bundle", "deploy", "--yes", "--var", "env=prod"]);
    expect(t.fake.calls()).toEqual([["bundle", "deploy", "--auto-approve"]]);
    expect(t.fake.envs()).toEqual([{ BUNDLE_VAR_env: "prod" }]);
  });

  it("never forwards --force even when --yes is passed", async () => {
    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      exitCode: 0,
    });
    await t.run(["bundle", "deploy", "--yes"]);
    const argv = t.fake.calls()[0];
    expect(argv).not.toContain("--force");
  });

  it("a nonzero exit renders a 50-line redacted tail, unbounded by --full", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      stderr: lines,
      exitCode: 1,
    });
    const { out, exitCode } = await t.run(["bundle", "deploy", "--yes"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).not.toContain("line 0\n");
    expect(out).toContain("line 79");
    expect(out).toContain("--full");

    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      stderr: lines,
      exitCode: 1,
    });
    const { out: fullOut } = await t.run([
      "bundle",
      "deploy",
      "--yes",
      "--full",
    ]);
    expect(fullOut).toContain("line 0");
    expect(fullOut).toContain("line 79");
  });

  it("the approval-required refusal suggests --yes and bundle plan", async () => {
    t.fake.respondWith("bundle deploy", {
      stdoutRaw: "",
      stderr:
        "Error: the deployment requires destructive actions, but the current console does not support prompting.\nTo proceed, use --auto-approve after reviewing the plan above.\n",
      exitCode: 1,
    });
    const { out, exitCode } = await t.run(["bundle", "deploy"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("bundle deploy --yes");
    expect(out).toContain("bundle plan");
  });

  it("redacts a token-shaped string in the failure tail", async () => {
    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      stderr: "Error: auth failed for dapi1234567890abcdef1234\n",
      exitCode: 1,
    });
    const { out } = await t.run(["bundle", "deploy", "--yes"]);
    expect(out).not.toContain("dapi1234567890abcdef1234");
    expect(out).toContain("[redacted]");
  });

  it(">64KB stderr sets a truncated capture note", async () => {
    const huge = "e".repeat(80 * 1024);
    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      stderr: huge,
      exitCode: 1,
    });
    const { out } = await t.run(["bundle", "deploy", "--yes"]);
    expect(out).toContain("64KB capture cap");
  });

  it("not-in-a-bundle: VALIDATION_ERROR, exit 2", async () => {
    t.fake.respondWith("bundle deploy --auto-approve", {
      stdoutRaw: "",
      stderr: "Error: unable to locate bundle root: databricks.yml not found\n",
      exitCode: 1,
    });
    const { exitCode } = await t.run(["bundle", "deploy", "--yes"]);
    expect(exitCode).toBe(2);
  });

  it("C5/C6: --var guards apply before spawning", async () => {
    const { exitCode: c5 } = await t.run([
      "bundle",
      "deploy",
      "--var",
      "a=1,b=2",
    ]);
    expect(c5).toBe(2);
    const { exitCode: c6 } = await t.run([
      "bundle",
      "deploy",
      "--var",
      "a=1",
      "--var",
      "b=2",
    ]);
    expect(c6).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("bundle run", () => {
  const JOB_SUMMARY = {
    resources: {
      jobs: {
        probe_job: { name: "x", id: JOB_ID, url: "https://x/jobs/1" },
      },
    },
  };
  const PIPELINE_SUMMARY = {
    resources: {
      pipelines: {
        probe_pipeline: {
          name: "y",
          id: PIPELINE_UUID,
          url: "https://x/pipelines/1",
        },
      },
    },
  };
  const APP_SUMMARY = {
    resources: { apps: { my_app: { name: "z", id: "app-1" } } },
  };
  const UNDEPLOYED_SUMMARY = {
    resources: { jobs: { probe_job: { name: "x" } } },
  };

  it("resolves a job key via summary and dispatches to jobs run-now --no-wait", async () => {
    t.fake.respond("bundle summary", JOB_SUMMARY);
    t.fake.respond("jobs run-now", {
      run_id: "999",
      state: { life_cycle_state: "PENDING" },
    });
    const { out, exitCode } = await t.run(["bundle", "run", "probe_job"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["bundle", "summary", "-o", "json"],
      ["jobs", "run-now", JOB_ID, "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain('run_id: "999"');
    expect(out).toContain(`id: "${JOB_ID}"`);
  });

  it("--wait drops --no-wait", async () => {
    t.fake.respond("bundle summary", JOB_SUMMARY);
    t.fake.respond("jobs run-now", {
      run_id: "999",
      state: { result_state: "SUCCESS" },
    });
    await t.run(["bundle", "run", "probe_job", "--wait"]);
    expect(t.fake.calls()[1]).toEqual([
      "jobs",
      "run-now",
      JOB_ID,
      "-o",
      "json",
    ]);
  });

  it("resolves a pipeline key via summary and dispatches to pipelines start-update", async () => {
    t.fake.respond("bundle summary", PIPELINE_SUMMARY);
    t.fake.respond("pipelines start-update", { update_id: "u1" });
    const { out, exitCode } = await t.run(["bundle", "run", "probe_pipeline"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["bundle", "summary", "-o", "json"],
      ["pipelines", "start-update", PIPELINE_UUID, "-o", "json"],
    ]);
    expect(out).toContain("update_id: u1");
  });

  it("--wait on a pipeline is a documented no-op: returns immediately with a note", async () => {
    t.fake.respond("bundle summary", PIPELINE_SUMMARY);
    t.fake.respond("pipelines start-update", { update_id: "u1" });
    const { out, exitCode } = await t.run([
      "bundle",
      "run",
      "probe_pipeline",
      "--wait",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("update_id: u1");
    expect(out).toContain("jobs-only");
  });

  it("C7: key present but no id steers to bundle deploy without calling run-now/start-update", async () => {
    t.fake.respond("bundle summary", UNDEPLOYED_SUMMARY);
    const { out, exitCode } = await t.run(["bundle", "run", "probe_job"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([["bundle", "summary", "-o", "json"]]);
    expect(out).toContain("bundle deploy");
  });

  it("a non-jobs/pipelines resource type exits 2, naming the raw CLI", async () => {
    t.fake.respond("bundle summary", APP_SUMMARY);
    const { out, exitCode } = await t.run(["bundle", "run", "my_app"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("databricks bundle run");
  });

  it("an unknown key -> NOT_FOUND listing valid keys, one upstream call total", async () => {
    t.fake.respond("bundle summary", JOB_SUMMARY);
    const { out, exitCode } = await t.run(["bundle", "run", "nosuchkey"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("probe_job");
    expect(t.fake.calls()).toEqual([["bundle", "summary", "-o", "json"]]);
  });

  it("never spawns `databricks bundle run` for any input", async () => {
    t.fake.respond("bundle summary", JOB_SUMMARY);
    t.fake.respond("jobs run-now", { run_id: "1" });
    await t.run(["bundle", "run", "probe_job"]);
    for (const call of t.fake.calls()) {
      expect(call.slice(0, 2)).not.toEqual(["bundle", "run"]);
    }
  });

  it.each([
    ["probe_job", "--"],
    ["probe_job", "--", "echo", "hi"],
    ["--"],
    ["probe_job", "extra"],
  ])("rejects %s with exit 2 and no spawn", async (...runArgs) => {
    const { exitCode } = await t.run(["bundle", "run", ...runArgs]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("not-in-a-bundle (via the summary resolve step): VALIDATION_ERROR, exit 2", async () => {
    t.fake.respondError(
      "bundle summary",
      "Error: unable to locate bundle root: databricks.yml not found\n",
    );
    const { exitCode } = await t.run(["bundle", "run", "probe_job"]);
    expect(exitCode).toBe(2);
  });
});

describe("bundle destroy", () => {
  it("without --yes: exit 2, no spawn, message carries the do-not-auto-retry warning", async () => {
    const { out, exitCode } = await t.run(["bundle", "destroy"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
    expect(out.toLowerCase()).toContain("not undoable");
    expect(out.toLowerCase()).toContain("explicitly approved");
  });

  it("with --yes: forwards --auto-approve", async () => {
    t.fake.respondWith("bundle destroy --auto-approve", {
      stdoutRaw: "",
      exitCode: 0,
    });
    const { out, exitCode } = await t.run(["bundle", "destroy", "--yes"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["bundle", "destroy", "--auto-approve"]]);
    expect(out).toContain("status: destroyed");
  });

  it("--force-lock forwards only when explicitly passed", async () => {
    t.fake.respondWith("bundle destroy --auto-approve -t prod --force-lock", {
      stdoutRaw: "",
      exitCode: 0,
    });
    await t.run([
      "bundle",
      "destroy",
      "--yes",
      "--target",
      "prod",
      "--force-lock",
    ]);
    expect(t.fake.calls()).toEqual([
      ["bundle", "destroy", "--auto-approve", "-t", "prod", "--force-lock"],
    ]);
  });

  it("not-in-a-bundle: VALIDATION_ERROR, exit 2", async () => {
    t.fake.respondWith("bundle destroy --auto-approve", {
      stdoutRaw: "",
      stderr: "Error: unable to locate bundle root: databricks.yml not found\n",
      exitCode: 1,
    });
    const { exitCode } = await t.run(["bundle", "destroy", "--yes"]);
    expect(exitCode).toBe(2);
  });
});

describe("bundle dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["bundle", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare bundle invocation", async () => {
    const { exitCode } = await t.run(["bundle"]);
    expect(exitCode).toBe(2);
  });

  it("serves bundle --help", async () => {
    const { out, exitCode } = await t.run(["bundle", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi bundle");
    expect(out).toContain("databricks bundle");
    expect(out).toContain("databricks-axi api");
  });

  it("fails loud on an unknown flag", async () => {
    const { out, exitCode } = await t.run(["bundle", "validate", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--bogus'");
  });
});
