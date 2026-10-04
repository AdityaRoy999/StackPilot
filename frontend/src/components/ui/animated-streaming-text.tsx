"use client";

import React, { useState } from "react";
import { cn } from "@/lib/utils";

interface AnimatedStreamingTextProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
  animation?: "blurIn" | "fadeIn" | null;
  animationDuration?: string;
}

interface Token { id: number; text: string; isNew: boolean; }

/** Preserve settled token nodes without mutating refs during React render. */
export function AnimatedStreamingText({
  content, isStreaming = false, className, animation = "blurIn", animationDuration = "0.32s",
}: AnimatedStreamingTextProps) {
  const [snapshot, setSnapshot] = useState({ content, isStreaming, animation,
    tokens: [{ id: 0, text: content, isNew: false }] as Token[] });
  let tokens = snapshot.tokens;
  if (snapshot.content !== content || snapshot.isStreaming !== isStreaming || snapshot.animation !== animation) {
    const append = isStreaming && snapshot.isStreaming && animation !== null &&
      snapshot.content.length > 0 && content.startsWith(snapshot.content);
    tokens = append
      ? [...snapshot.tokens, ...content.slice(snapshot.content.length).split(/(\s+)/).filter(Boolean)
        .map((text, index) => ({ id: snapshot.tokens.length + index, text, isNew: true }))]
      : [{ id: 0, text: content, isNew: false }];
    // React retries this component before committing, so a new chunk has no stale frame.
    setSnapshot({ content, isStreaming, animation, tokens });
  }
  if (!content) return null;
  if (!isStreaming || animation === null) return <span className={className}>{content}</span>;
  return <span className={cn("inline", className)}>
    {tokens.map(token => <span key={token.id}
      className={token.isNew ? "animate-flow-blur-in inline-block whitespace-pre-wrap" : "inline whitespace-pre-wrap"}
      style={token.isNew ? { animationDuration } : undefined}>{token.text}</span>)}
  </span>;
}
