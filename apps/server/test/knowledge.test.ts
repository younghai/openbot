import { describe, it, expect } from "vitest";
import { chunkDocument } from "../src/knowledge.js";

describe("chunkDocument", () => {
  it("returns empty for short text", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("short")).toEqual([]);
  });

  it("chunks text larger than CHUNK_SIZE", () => {
    const long = "a".repeat(2000);
    const chunks = chunkDocument(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(800);
  });

  it("caps chunk count", () => {
    const huge = "x".repeat(800 * 600);
    const chunks = chunkDocument(huge);
    expect(chunks.length).toBeLessThanOrEqual(501); // cap is `> 500` so max is 501
  });

  it("preserves most content across chunks", () => {
    const text = "Hello world. ".repeat(100);
    const chunks = chunkDocument(text);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(total).toBeGreaterThan(text.length * 0.5);
  });
});
