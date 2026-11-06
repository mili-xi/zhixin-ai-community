import { describe, expect, it } from "vitest";
import { scoreItems } from "./index";

describe("scoreItems", () => {
  it("contains semantic SEO and GEO checks instead of only keyword rules", () => {
    expect(scoreItems.map((item) => item.key)).toContain("entity_clarity");
    expect(scoreItems.map((item) => item.key)).toContain("citation_value");
    expect(scoreItems.find((item) => item.key === "citation_value")?.dimension).toBe("geo");
  });
});
