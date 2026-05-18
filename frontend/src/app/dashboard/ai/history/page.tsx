"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface AiChatSession {
  id: string;
  title: string;
  session_type: string;
  preview?: string;
  message_count?: number;
  last_model?: string;
  memory_summary?: string;
  created_at: string;
  updated_at: string;
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function sessionTypeLabel(type: string) {
  if (type === "project_chat") return "Project";
  return "Agent";
}

export default function AiHistoryPage() {
  const sessionsQuery = useQuery({
    queryKey: ["ai-chat-sessions"],
    queryFn: async () => {
      const res = await api.get("/ai/sessions");
      const data = res.data as { sessions?: AiChatSession[] };
      return data.sessions || [];
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 12000,
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await api.delete(`/ai/sessions/${sessionId}`);
    },
    onSuccess: () => sessionsQuery.refetch(),
  });

  const sessions = sessionsQuery.data || [];
  const totalMessages = sessions.reduce((total, session) => total + (session.message_count || 0), 0);
  const rememberedChats = sessions.filter((session) => (session.memory_summary || "").trim()).length;
  const lastChat = sessions[0]?.updated_at;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/dashboard/ai">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">AI Chat History</h1>
            <p className="text-sm text-muted-foreground">Resume conversations with their saved context and memory.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => sessionsQuery.refetch()} disabled={sessionsQuery.isFetching}>
            {sessionsQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Link href="/dashboard/ai">
            <Button size="sm">
              <Plus className="h-4 w-4" />
              New chat
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" />
            Chats
          </div>
          <p className="mt-2 text-3xl font-semibold">{sessions.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            Messages
          </div>
          <p className="mt-2 text-3xl font-semibold">{totalMessages}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" />
            Memory
          </div>
          <p className="mt-2 text-3xl font-semibold">{rememberedChats}</p>
          <p className="mt-1 text-xs text-muted-foreground">{lastChat ? `Latest ${formatDate(lastChat)}` : "No chats yet"}</p>
        </div>
      </div>

      {sessionsQuery.isLoading || (sessionsQuery.isFetching && !sessionsQuery.isFetchedAfterMount) ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card py-20 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading conversations...
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-14 text-center">
          <MessageSquare className="mx-auto h-9 w-9 text-muted-foreground/60" />
          <p className="mt-4 text-sm text-muted-foreground">No chats yet. Start a conversation with the agent.</p>
          <Link href="/dashboard/ai">
            <Button className="mt-5" variant="outline">
              Open agent
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-3">
          {sessions.map((session) => (
            <div key={session.id} className="rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/30">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <Link href={`/dashboard/ai?session_id=${session.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold">{session.title || "Untitled chat"}</h2>
                    <Badge variant="outline">{sessionTypeLabel(session.session_type)}</Badge>
                    {session.last_model && <Badge variant="secondary" className="max-w-64 truncate">{session.last_model}</Badge>}
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                    {session.preview || "Continue this conversation."}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{session.message_count || 0} messages</span>
                    <span>Updated {formatDate(session.updated_at)}</span>
                    {(session.memory_summary || "").trim() && <span>Memory saved</span>}
                  </div>
                </Link>
                <div className="flex items-center gap-2">
                  <Link href={`/dashboard/ai?session_id=${session.id}`}>
                    <Button variant="outline" size="sm">Continue</Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete chat"
                    disabled={deleteSessionMutation.isPending}
                    onClick={() => deleteSessionMutation.mutate(session.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
