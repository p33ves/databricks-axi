import { describe, expect, it } from "vitest";
import { truncate } from "../src/truncate.js";

describe("truncate", () => {
  it("head-truncates and marks the total line count", () => {
    const text = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    const result = truncate(text, { lines: 200, mode: "head" });
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(250);
    expect(result.text).toContain("line-1");
    expect(result.text).not.toContain("line-201");
  });

  it("tail-truncates keeping the last N lines", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    const result = truncate(text, { lines: 50, mode: "tail" });
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(60);
    expect(result.text).toContain("line-60");
    expect(result.text).not.toContain("line-10\n");
  });

  it("does not mark exact-boundary input as truncated", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    const result = truncate(text, { lines: 200, mode: "head" });
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(200);
    expect(result.text).toBe(text);
  });

  it("passes short input through untouched", () => {
    const result = truncate("a\nb", { lines: 200, mode: "head" });
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(2);
    expect(result.text).toBe("a\nb");
  });
});
