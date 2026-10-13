import React, { useState } from "react";
import { LiveChatEntry } from "../../types";

export default function AskNexusLive({
  history,
  onAsk,
  disabled,
}: {
  history: LiveChatEntry[];
  onAsk: (question: string) => void;
  disabled: boolean;
}) {
  const [question, setQuestion] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || disabled) return;
    onAsk(question);
    setQuestion("");
  }

  return (
    <div className="card p-4">
      <h3 className="font-medium mb-3 text-sm text-slate-400 uppercase tracking-wide">Ask NEXUS AI</h3>

      <div className="space-y-3 mb-3 max-h-40 overflow-y-auto">
        {history.length === 0 && (
          <p className="text-sm text-slate-600">
            Ask about what's been discussed so far — e.g. "What are the action items?"
          </p>
        )}
        {history.map((h, i) => (
          <div key={i} className="text-sm space-y-1">
            <div className="text-brand-400 font-medium">You: {h.question}</div>
            <div className="text-slate-300 bg-white/5 rounded-lg p-2">{h.answer}</div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="input"
          placeholder="What did they decide about the deadline?"
          disabled={disabled}
        />
        <button type="submit" disabled={disabled} className="btn-primary shrink-0">
          Ask
        </button>
      </form>
    </div>
  );
}
