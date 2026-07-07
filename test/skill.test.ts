import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli.js";
import { createSkillMarkdown, extractCommandsBlock } from "../src/skill.js";

describe("skill", () => {
  it("extracts the commands block from TOP_HELP", () => {
    const block = extractCommandsBlock();
    expect(block).toMatch(/^commands\[\d+\]:/);
    expect(block).toContain("(none)=home");
    expect(block).toContain("jobs list");
    expect(block).toContain("jobs logs <run_id>");
  });

  it("advertises every wired command domain in TOP_HELP", () => {
    const block = extractCommandsBlock();
    for (const domain of Object.keys(COMMANDS)) {
      expect(block).toContain(domain === "home" ? "(none)=home" : domain);
    }
  });

  it("renders SKILL.md with frontmatter and npx guidance", () => {
    const md = createSkillMarkdown();
    expect(md.startsWith("---\nname: databricks-axi\n")).toBe(true);
    expect(md).toContain("npx -y databricks-axi");
    expect(md).toContain(extractCommandsBlock());
  });
});
