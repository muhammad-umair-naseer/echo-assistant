/** Backend client. Chat is SSE over fetch: meta → token* → done|error. */

export interface Recalled {
  id: number;
  fact: string;
  score: number;
}
export interface Remembered {
  id: number;
  fact: string;
  category?: string;
  replaced?: string; // old fact this one superseded
}
export interface MemoryItem {
  id: number;
  fact: string;
  source: string;
  category: string;
  created_at: string;
}
export interface Status {
  hasKey: boolean;
  hasTts: boolean;
  model: string;
  memories: number;
}

export interface ChatEvents {
  onMeta?: (m: { recalled: Recalled[]; hasKey: boolean }) => void;
  onToken?: (t: string) => void;
  onTool?: (t: { name: string; args: string }) => void;
  onAction?: (a: { type: "open_url"; url: string }) => void;
  onDone?: (d: { remembered: Remembered[] }) => void;
  onError?: (message: string) => void;
}

export async function getStatus(): Promise<Status> {
  return (await fetch("/api/status")).json();
}

export async function listMemories(): Promise<MemoryItem[]> {
  return (await fetch("/api/memory")).json();
}

export async function importMemories(items: { fact: string; category?: string }[]): Promise<{ imported: number }> {
  const res = await fetch("/api/memory/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(items),
  });
  return res.json();
}

export async function removeMemory(id: number): Promise<boolean> {
  const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
  return ((await res.json()) as { deleted: boolean }).deleted;
}

/** Never throws: every failure (fetch, mid-stream disconnect, bad frame) is
 *  routed to onError so the terminal can always recover its input row. */
export async function chat(sessionId: string, message: string, ev: ChatEvents): Promise<void> {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });
    if (!res.ok || !res.body) {
      ev.onError?.(`backend unreachable (${res.status}) — is \`npm run server\` running?`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (event === "meta") ev.onMeta?.(parsed);
          else if (event === "token") ev.onToken?.(parsed.t);
          else if (event === "tool") ev.onTool?.(parsed);
          else if (event === "action") ev.onAction?.(parsed);
          else if (event === "done") ev.onDone?.(parsed);
          else if (event === "error") ev.onError?.(parsed.message);
        } catch {
          /* one malformed frame must not kill the stream */
        }
      }
    }
  } catch (err) {
    ev.onError?.(`connection lost: ${(err as Error).message}`);
  }
}
