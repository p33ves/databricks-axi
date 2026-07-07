import { describe, expect, it } from "vitest";
import { createSkillMarkdown, extractCommandsBlock } from "../src/skill.js";

describe("skill", () => {
  it("extracts the commands block from TOP_HELP", () => {
    const block = extractCommandsBlock();
    expect(block).toMatch(/^commands\[\d+\]:/);
    expect(block).toContain("(none)=home");
  });

  it("renders SKILL.md with frontmatter and npx guidance", () => {
    const md = createSkillMarkdown();
    expect(md.startsWith("---\nname: databricks-axi\n")).toBe(true);
    expect(md).toContain("npx -y databricks-axi");
    expect(md).toContain(extractCommandsBlock());
  });
});
