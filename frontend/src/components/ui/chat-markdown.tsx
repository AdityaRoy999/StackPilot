"use client";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Settled messages retain their parsed tree while the active message streams.
export const ChatMarkdown = memo(function ChatMarkdown({ content, components }: {content: string; components?: Components}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>;
});
