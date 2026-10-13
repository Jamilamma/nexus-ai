import React, { useEffect, useRef, useState } from "react";
import { MeetingChatMessage } from "../../types";

export default function ChatPanel({
  messages,
  currentUserId,
  onSend,
}: {
  messages: MeetingChatMessage[];
  currentUserId: string;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && <p className="text-sm text-slate-600">No messages yet. Say hello 👋</p>}
        {messages.map((m) => {
          const mine = m.userId === currentUserId;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <div className="mb-0.5 text-[11px] text-slate-500">
                {mine ? "You" : m.displayName} ·{" "}
                {new Date(m.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-1.5 text-sm ${
                  mine ? "bg-brand-500/25 text-slate-100" : "bg-white/5 text-slate-200"
                }`}
              >
                {m.text}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={submit} className="flex gap-2 border-t border-white/5 p-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          className="input"
          placeholder="Message everyone…"
        />
        <button type="submit" className="btn-primary shrink-0" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
