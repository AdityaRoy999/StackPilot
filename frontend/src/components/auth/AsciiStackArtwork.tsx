"use client";

import { useEffect, useId, useRef, useState } from "react";
import { asciiGlyphs, ASCII_SCENES, morphAscii, renderAsciiScene, STACK_REST, type AsciiGlyph } from "./ascii-stack";
import styles from "./AsciiStackArtwork.module.css";

const REST_FRAME = renderAsciiScene(0, STACK_REST.yaw, STACK_REST.pitch);
const FLOATING_SYMBOLS = ["</>", "{ }", "[>_]", "01\n10", "o--o\n   |\n   o", "[+]"];

export function AsciiStackArtwork() {
  const stageRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const [scene, setScene] = useState(0);
  const hintId = useId();

  useEffect(() => {
    const stage = stageRef.current, text = textRef.current;
    if (!stage || !text) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const current = { yaw: STACK_REST.yaw, pitch: STACK_REST.pitch };
    const target = { ...current };
    let selected = 0, frame = 0, lastTime = 0;
    let bounds: DOMRect | null = null;
    let transition: { from: AsciiGlyph[]; to: AsciiGlyph[]; started: number } | null = null;

    const draw = () => { text.textContent = renderAsciiScene(selected, current.yaw, current.pitch); };
    const tick = (time: number) => {
      if (time - lastTime < 1000 / 60 - 1) { frame = requestAnimationFrame(tick); return; }
      const dt = Math.min(time - lastTime || 16, 40);
      lastTime = time;
      let unsettled = false;
      if (transition) {
        const progress = Math.min(1, (time - transition.started) / 780);
        text.textContent = morphAscii(transition.from, transition.to, progress);
        if (progress === 1) transition = null;
        unsettled = true;
      } else {
        const damping = 1 - Math.exp(-dt / 90);
        for (const key of ["yaw", "pitch"] as const) {
          current[key] += (target[key] - current[key]) * damping;
          if (Math.abs(target[key] - current[key]) > .001) unsettled = true;
          else current[key] = target[key];
        }
        draw();
      }
      frame = unsettled ? requestAnimationFrame(tick) : 0;
    };
    const schedule = () => {
      if (document.hidden) return;
      if (reduceMotion.matches) {
        transition = null;
        Object.assign(current, target);
        draw();
      } else if (!frame) {
        lastTime = performance.now() - 16;
        frame = requestAnimationFrame(tick);
      }
    };
    const move = (event: PointerEvent) => {
      if (reduceMotion.matches || event.pointerType === "touch") return;
      bounds ??= stage.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
      const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
      target.yaw = STACK_REST.yaw + x * .52;
      target.pitch = STACK_REST.pitch + y * .22;
      stage.style.setProperty("--pointer-x", `${50 + x * 16}%`);
      schedule();
    };
    const resetRotation = () => {
      bounds = null;
      target.yaw = STACK_REST.yaw;
      target.pitch = STACK_REST.pitch;
      stage.style.setProperty("--pointer-x", "50%");
      schedule();
    };
    const select = (next: number) => {
      if (next === selected) return;
      const from = asciiGlyphs(text.textContent || REST_FRAME);
      selected = next;
      setScene(next);
      transition = { from, to: asciiGlyphs(renderAsciiScene(next, current.yaw, current.pitch)), started: performance.now() };
      schedule();
    };
    const cycle = () => select((selected + 1) % ASCII_SCENES.length);
    const keydown = (event: KeyboardEvent) => {
      if (/^[1-6]$/.test(event.key)) { event.preventDefault(); select(Number(event.key) - 1); return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") { select(0); resetRotation(); }
      else {
        if (event.key === "ArrowLeft") target.yaw -= .14;
        if (event.key === "ArrowRight") target.yaw += .14;
        if (event.key === "ArrowUp") target.pitch -= .1;
        if (event.key === "ArrowDown") target.pitch += .1;
        target.pitch = Math.max(-.95, Math.min(-.15, target.pitch));
        target.yaw = Math.max(-.5, Math.min(1.65, target.yaw));
        schedule();
      }
    };
    const cancel = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
    const visibility = () => { if (document.hidden) cancel(); else schedule(); };
    const motionChanged = () => { if (reduceMotion.matches) { cancel(); transition = null; Object.assign(current, target); draw(); } };
    const resize = new ResizeObserver(() => { bounds = null; });
    resize.observe(stage);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerleave", resetRotation);
    stage.addEventListener("click", cycle);
    stage.addEventListener("keydown", keydown);
    stage.addEventListener("blur", resetRotation);
    document.addEventListener("visibilitychange", visibility);
    reduceMotion.addEventListener("change", motionChanged);
    return () => {
      cancel(); resize.disconnect();
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", resetRotation);
      stage.removeEventListener("click", cycle);
      stage.removeEventListener("keydown", keydown);
      stage.removeEventListener("blur", resetRotation);
      document.removeEventListener("visibilitychange", visibility);
      reduceMotion.removeEventListener("change", motionChanged);
    };
  }, []);

  return (
    <button ref={stageRef} type="button" className={styles.stage} data-scene={ASCII_SCENES[scene]} aria-label="Interactive ASCII artwork" aria-describedby={hintId}>
      <span className={styles.frame} aria-hidden="true">
        <span className={styles.edge}><span>+</span><span>{"=".repeat(220)}</span><span>+</span></span>
        <span className={styles.sides}>{[0, 1].map(side => <span key={side}>{Array.from({ length: 64 }, (_, i) => <span key={i}>||</span>)}</span>)}</span>
        <span className={styles.edge}><span>+</span><span>{"=".repeat(220)}</span><span>+</span></span>
      </span>
      <span className={styles.satellites} aria-hidden="true">{FLOATING_SYMBOLS.map((symbol, i) => <span className={styles.satellite} key={i}><span>{symbol}</span></span>)}</span>
      <pre ref={textRef} className={styles.characters} aria-hidden="true">{REST_FRAME}</pre>
      <span className={styles.legend} aria-hidden="true"><span>[ {String(scene + 1).padStart(2, "0")} / 06 ] {ASCII_SCENES[scene]}</span><span>CLICK TO MORPH -&gt;</span></span>
      <span id={hintId} className="sr-only">Move your mouse or use the arrow keys to rotate. Click or press Enter to morph through six ASCII designs. Keys 1 through 6 choose a design. Escape returns to the stack.</span>
      <span className="sr-only" role="status">{ASCII_SCENES[scene].toLowerCase()} design, {scene + 1} of 6.</span>
    </button>
  );
}
