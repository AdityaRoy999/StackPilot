export function chatMessageId(): string {
  // These are UI identity keys, not authentication credentials. LAN HTTP
  // previews do not expose crypto.randomUUID even when crypto is available.
  return globalThis.crypto?.randomUUID?.() || `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function permissionRequestId(event: {id?: string; token?: string}): string {
  // A signed token's signature suffix identifies the same review after recovery;
  // it does not contain the private arguments or the complete approval token.
  return event.id || (event.token ? `permission-${event.token.slice(-32)}` : chatMessageId());
}

export function upsertChatMessage<T extends {id: string}>(messages: T[], message: T): T[] {
  const index=messages.findIndex(item=>item.id === message.id);
  if (index < 0) return [...messages,message];
  return messages.map((item,i)=>i === index ? message : item);
}

export function joinContinuation(previous: string, next: string): string {
  return previous.trim() && next.trim() ? `${previous.trimEnd()}\n\n${next}` : previous || next;
}
