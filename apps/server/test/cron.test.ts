import { describe, it, expect } from "vitest";
import { parseCron, cronMatches } from "../src/cron.js";

describe("parseCron", () => {
  it("parses * * * * *", () => {
    expect(parseCron("* * * * *")).toHaveLength(5);
  });

  it("rejects invalid field count", () => {
    expect(() => parseCron("* * *")).toThrow();
  });

  it("rejects out-of-range minutes", () => {
    expect(() => parseCron("61 * * * *")).toThrow();
  });

  it("rejects non-numeric input", () => {
    expect(() => parseCron("abc * * * *")).toThrow();
  });
});

describe("cronMatches", () => {
  // 2026-01-05 = Monday, 2026-01-06 = Tue, ..., 2026-01-09 = Fri, 2026-01-04 = Sun
  const jan = (day: number, h = 8, m = 0): Date => new Date(2026, 0, day, h, m, 0, 0);

  it("matches every minute for * * * * *", () => {
    expect(cronMatches("* * * * *", jan(5, 0, 0))).toBe(true);
    expect(cronMatches("* * * * *", jan(5, 23, 59))).toBe(true);
  });

  it("matches specific hour:minute", () => {
    expect(cronMatches("30 8 * * *", jan(5, 8, 30))).toBe(true);
    expect(cronMatches("30 8 * * *", jan(5, 8, 31))).toBe(false);
  });

  it("matches weekday range 1-5 (Mon-Fri)", () => {
    expect(cronMatches("0 8 * * 1-5", jan(5))).toBe(true);  // Mon
    expect(cronMatches("0 8 * * 1-5", jan(9))).toBe(true);  // Fri
    expect(cronMatches("0 8 * * 1-5", jan(4))).toBe(false); // Sun
  });

  it("matches step values", () => {
    expect(cronMatches("*/15 * * * *", jan(5, 0, 0))).toBe(true);
    expect(cronMatches("*/15 * * * *", jan(5, 0, 15))).toBe(true);
    expect(cronMatches("*/15 * * * *", jan(5, 0, 7))).toBe(false);
  });

  it("handles invalid cron gracefully", () => {
    expect(() => cronMatches("bad", jan(5))).toThrow();
  });
});
