import { describe, expect, it } from "vitest";
import { browserBatchSummary, browserResultSummary, toolArgumentSummary } from "./tool-summary";

describe("tool summaries", () => {
  it("renders a browser batch as actions instead of coerced objects", () => {
    expect(browserBatchSummary([{ action: "navigate", url: "https://example.test" }, { action: "click", element_id: 4 }]))
      .toBe("2 actions · navigate · click");
    expect(browserBatchSummary([{ action: "click" }, { action: "click" }])).toBe("2 actions · click");
  });
  it("keeps unknown structured tool arguments readable", () => {
    expect(toolArgumentSummary([{ url: "https://example.test" }, { selector: "button" }])).toBe("2 items");
    expect(toolArgumentSummary({ url: "https://example.test", selector: "button" })).toBe("url · selector");
    expect(toolArgumentSummary(null)).toBe("");
    expect(toolArgumentSummary(0)).toBe("0");
  });
  it("preserves verification results without rendering image payloads as text", () => {
    const preview = JSON.parse(browserResultSummary({status:"unverified", frame:"large-base64-payload",
      screenshot:"another-image", verification:{description:"0/1 explicit expectations passed"},
      assertions:[{status:"unverified",reason:"Page unavailable",expectation:{kind:"visible"}}]}));
    expect(preview).toEqual({status:"unverified",verification:"0/1 explicit expectations passed",
      checks:[{status:"unverified",reason:"Page unavailable",expectation:{kind:"visible"}}]});
  });
});
