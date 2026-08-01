import { describe, expect, it } from "vitest";
import {
  totalMode,
  TOTAL_FETCH_CEILING,
  TOTAL_TIMEOUT_MS,
  type Flags,
} from "../src/commands/shared.js";

const flags = (entries: [string, string | boolean][] = []): Flags =>
  new Map(entries);

// The spawn budget and the fetch bound are only observable through a real
// multi-page drain, which the CLI-level rig can't stage — assert them here.
describe("totalMode", () => {
  it("fetches one display page on the default spawn budget without --total", () => {
    const counted = totalMode(flags([["profile", "prod"]]), 30);
    expect(counted.total).toBe(false);
    expect(counted.fetch).toBe(30);
    expect(counted.spawn).toEqual({ profile: "prod" });
  });

  it("widens the spawn timeout for the multi-page --total drain", () => {
    const counted = totalMode(flags([["total", true]]), 30);
    expect(counted.fetch).toBe(TOTAL_FETCH_CEILING);
    expect(counted.spawn.timeoutMs).toBe(TOTAL_TIMEOUT_MS);
    // Well clear of the 30s default a legitimate drain would blow through.
    expect(TOTAL_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("never fetches fewer rows than the caller asked to display", () => {
    const counted = totalMode(flags([["total", true]]), 2000);
    expect(counted.fetch).toBe(2000);
  });
});
