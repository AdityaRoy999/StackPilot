import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { AnimatedStreamingText } from "./animated-streaming-text";

describe("streaming text", () => {
  it("preserves settled nodes across chunks and resets a replaced response in Strict Mode", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (content: string, isStreaming = true) => act(() => root.render(
      <StrictMode><AnimatedStreamingText content={content} isStreaming={isStreaming} /></StrictMode>));
    try {
      render("Hello");
      const settled = container.querySelector("span span");
      render("Hello world\n");
      expect(container.textContent).toBe("Hello world\n");
      expect(container.querySelector("span span")).toBe(settled);
      render("Hello world\nagain");
      expect(container.textContent).toBe("Hello world\nagain");
      render("Different response");
      expect(container.textContent).toBe("Different response");
      render("Different response", false);
      expect(container.querySelectorAll(".animate-flow-blur-in")).toHaveLength(0);
      render("");
      expect(container.textContent).toBe("");
    } finally { act(() => root.unmount()); }
  });
});
