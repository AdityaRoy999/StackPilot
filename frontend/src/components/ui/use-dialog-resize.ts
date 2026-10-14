"use client";

import { useLayoutEffect, useRef } from "react";

/** Animate section changes; let animated disclosures resize their parent naturally. */
export function useDialogResize(node: HTMLElement | null, resizeKey?: string | number) {
  const resizeRef = useRef<((interrupt?: boolean) => void) | null>(null);
  const enabled = resizeKey !== undefined;
  useLayoutEffect(() => {
    if (!node || !enabled) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const inlineHeight = node.style.height;
    let previous = node.offsetHeight;
    let animation: Animation | null = null;
    let frame: number | null = null;
    const resize = (interrupt = false) => {
      if (interrupt) {
        // Base UI mounts the incoming panel in a child layout effect. Measure
        // after that commit, rather than measuring both panels mid-switch.
        previous = animation ? node.offsetHeight : previous;
        animation?.cancel();
        animation = null;
        node.removeAttribute("data-dialog-resizing");
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        if (motion.matches) { node.style.height = inlineHeight; previous = node.offsetHeight; return; }
        // Hold the last rendered size until the new panel is ready. This also
        // prevents a one-frame jump before ResizeObserver's pre-paint callback.
        node.style.height = `${previous}px`;
        frame = requestAnimationFrame(() => {
          frame = null;
          node.style.height = inlineHeight;
          resize();
        });
        return;
      }
      if (animation) return;
      const from = previous;
      const target = node.offsetHeight;
      previous = target;
      if (motion.matches || Math.abs(target - from) < 1) return;
      node.setAttribute("data-dialog-resizing", "");
      animation = node.animate([{ height: `${from}px` }, { height: `${target}px` }], {
        duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
      animation.onfinish = () => {
        animation = null;
        node.removeAttribute("data-dialog-resizing");
        previous = node.offsetHeight;
      };
    };
    resizeRef.current = resize;
    // Disclosures already animate their intrinsic height. Starting another
    // popup animation for each observed frame queues a second resize behind
    // the menu. Keep the baseline current and animate only resizeKey changes.
    const observer = new ResizeObserver(() => {
      if (!animation && frame === null) previous = node.offsetHeight;
    });
    observer.observe(node);
    const onDisclosure = (event: Event) => {
      if (!(event.target instanceof Element) || event.target.closest("summary")?.parentElement?.tagName !== "DETAILS") return;
      // A menu opened during a section transition takes over natural sizing.
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      animation?.cancel();
      animation = null;
      node.style.height = inlineHeight;
      node.removeAttribute("data-dialog-resizing");
      previous = node.offsetHeight;
    };
    node.addEventListener("click", onDisclosure, true);
    return () => {
      observer.disconnect();
      node.removeEventListener("click", onDisclosure, true);
      if (frame !== null) cancelAnimationFrame(frame);
      animation?.cancel();
      node.removeAttribute("data-dialog-resizing");
      node.style.height = inlineHeight;
      resizeRef.current = null;
    };
  }, [node, enabled]);
  useLayoutEffect(() => { resizeRef.current?.(true); }, [resizeKey]);
}
