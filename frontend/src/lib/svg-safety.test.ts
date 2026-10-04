import { describe, expect, it } from "vitest";
import { sanitizeIconSvg } from "./svg-safety";

describe("custom vector safety", () => {
  it("keeps paths, outlined rectangles and internal gradients", () => {
    const result = sanitizeIconSvg('<svg viewBox="0 0 24 24"><defs><linearGradient id="tone"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="20" height="20" fill="none"/><path d="M1 1L2 2" fill="url(#tone)"/></svg>');
    expect(result).toContain('<rect');
    expect(result).toContain('fill="none"');
    expect(result).toContain('url(#tone)');
  });
  it("removes executable HTML, handlers and external references", () => {
    const result = sanitizeIconSvg('<svg onload="alert(1)"><script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><use href="https://example.test/icon.svg#x"/><path onclick="alert(1)" style="background:url(https://example.test)" fill="url(https://example.test)" d="M1 1"/></svg>');
    expect(result).not.toMatch(/script|foreignObject|onclick|onload|https:\/\/example/);
    expect(result).toContain('d="M1 1"');
  });
  it("rejects malformed and oversized files", () => {
    expect(sanitizeIconSvg('<svg><path></svg>')).toBe("");
    expect(sanitizeIconSvg('<svg>' + 'x'.repeat(131072) + '</svg>')).toBe("");
    expect(sanitizeIconSvg('<html>not a vector</html>')).toBe("");
  });
});
