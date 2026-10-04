"use client";

import { useCallback, useRef, useState } from "react";
import api from "@/lib/api";
import { AiSession } from "@/lib/ai-session";

export function useAiSession() {
  const session = useRef(new AiSession());
  const [activeSessionId, setId] = useState("");
  const setActiveSessionId = useCallback((id: string) => {
    session.current.select(id);
    setId(id);
  }, []);
  const ensureSession = useCallback(async () => {
    const id = await session.current.ensure(async () => {
      const response = await api.post("/ai/sessions", {});
      return response.data?.session?.id || "";
    });
    if (session.current.id === id) setId(id);
    return id;
  }, []);
  return { activeSessionId, setActiveSessionId, ensureSession };
}
