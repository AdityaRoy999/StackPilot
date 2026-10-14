import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";
import { technologyLogoPaths } from "@/lib/technology-logos";

const colors: Record<string, string> = { react: "#61DAFB", nextjs: "#7C8DFF", express: "#68A063", postgres: "#4169E1", redis: "#FF4438", node: "#5FA04E", docker: "#2496ED", kubernetes: "#326CE5", mysql: "#00758F", mongodb: "#47A248", python: "#4584B6", django: "#44B78B", flask: "#5BAE89", fastapi: "#009688", vue: "#42B883", angular: "#DD0031", svelte: "#FF3E00", typescript: "#3178C6", javascript: "#E8C83C", vite: "#A267F5", php: "#8892BF", laravel: "#FF2D20", ruby: "#CC342D", rails: "#D30001", java: "#ED8B00", spring: "#6DB33F", go: "#00ADD8", rust: "#DDA677", sqlite: "#3B9BCC", nginx: "#009639" };

/** Brand silhouettes stay recognizable in every light/dark icon theme. */
export function TechnologyIcon({ id, name, className }: { id: string; name?: string; className?: string }) {
  const path = technologyLogoPaths[id];
  if (!path) return <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center text-xs font-semibold", className)}>{(name || id).slice(0, 2)}</span>;
  return <svg aria-hidden="true" data-technology={id} viewBox="0 0 24 24" fill="currentColor" style={{ "--technology-color": colors[id] || "#6D9FF5" } as CSSProperties} className={cn("technology-logo size-5 shrink-0", className)}><path d={path} /></svg>;
}
