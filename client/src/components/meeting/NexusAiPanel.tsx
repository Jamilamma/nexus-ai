import React, { useEffect, useRef, useState } from "react";
import { AskNexusEntry, MeetingLiveSummary } from "../../types";

interface Props {
  /** False when the server has NEXUS AI switched off (needs live transcription). */
  available: boolean;
  /** Number of finalized transcript lines so far (0 = nobody has spoken yet). */
  transcriptLines: number;
  summary: MeetingLiveSummary | null;
  summaryLoading: boolean;
  summaryError: string;
  onGenerateSummary: () => void;
  askEntries: AskNexusEntry[];
  onAsk: (question: string) => void;
  onClose: () => void;
}

type View = "menu" | "summary" | "ask";

const SUGGESTIONS = ["What did I miss?", "What are the action items?", "What was decided so far?", "Summarize the last 5 minutes"];

function mmss(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * NEXUS AI modal for a live meeting. Two primary options:
 *   📋 Meeting Summary   |   💬 Ask NEXUS
 * Both are answered by the server from the real speaker-tagged transcript.
 */
/** Seconds waited so far; after a while it says plainly that the AI service is slow instead of looking frozen. */
function PendingElapsed() {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (seconds < 4) return null;
  return (
    <span className="text-xs text-slate-500">
      {seconds} s{seconds >= 20 ? " (the AI service is slow right now; it will give up and tell you after about a minute)" : ""}
    </span>
  );
}

export default function NexusAiPanel(props: Props) {
  const [view, setView] = useState<View>("menu");

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="NEXUS AI"
        className="card flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden bg-ink-800/95 p-0"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-3">
          {view !== "menu" && (
            <button onClick={() => setView("menu")} className="btn-secondary px-2 py-1 text-xs" aria-label="Back">
              ←
            </button>
          )}
          <h2 className="flex-1 text-base font-semibold">
            ✨ NEXUS AI
            {view === "summary" && <span className="ml-2 text-sm font-normal text-slate-400">Meeting Summary</span>}
            {view === "ask" && <span className="ml-2 text-sm font-normal text-slate-400">Ask NEXUS</span>}
          </h2>
          <button onClick={props.onClose} className="btn-secondary px-2 py-1 text-xs" aria-label="Close NEXUS AI">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {!props.available ? (
            <Unavailable />
          ) : view === "menu" ? (
            <Menu lines={props.transcriptLines} onPick={setView} />
          ) : view === "summary" ? (
            <SummaryView {...props} />
          ) : (
            <AskView entries={props.askEntries} onAsk={props.onAsk} transcriptLines={props.transcriptLines} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Unavailable() {
  return (
    <div className="space-y-2 p-5 text-sm text-slate-300">
      <p className="font-medium text-amber-200">NEXUS AI isn't available for this meeting.</p>
      <p className="text-slate-400">
        It needs live transcription on the server (<code>ENABLE_MEETING_TRANSCRIPTION=true</code>) and must not be switched off
        with <code>ENABLE_NEXUS_AI=false</code>. Restart the server after changing <code>server/.env</code>, then rejoin the meeting.
      </p>
    </div>
  );
}

function Menu({ lines, onPick }: { lines: number; onPick: (v: View) => void }) {
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-slate-400">
        {lines === 0
          ? "Nobody has spoken yet. NEXUS works from what is actually said in this meeting."
          : `NEXUS works only from the ${lines} transcript line${lines === 1 ? "" : "s"} captured so far.`}
      </p>
      <button
        onClick={() => onPick("summary")}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-colors hover:bg-white/10"
      >
        <span className="text-2xl">📋</span>
        <span>
          <span className="block font-medium">Meeting Summary</span>
          <span className="block text-xs text-slate-400">Overview, decisions, action items, deadlines and open questions</span>
        </span>
      </button>
      <button
        onClick={() => onPick("ask")}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-colors hover:bg-white/10"
      >
        <span className="text-2xl">💬</span>
        <span>
          <span className="block font-medium">Ask NEXUS</span>
          <span className="block text-xs text-slate-400">Ask a question about this meeting</span>
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SummaryView({ transcriptLines, summary, summaryLoading, summaryError, onGenerateSummary }: Props) {
  const stale = summary ? transcriptLines > summary.segmentCount : false;

  // Opening the Summary generates it right away (once) when there is something to summarize.
  const autoRequested = useRef(false);
  useEffect(() => {
    if (autoRequested.current) return;
    autoRequested.current = true;
    if (transcriptLines > 0 && !summaryLoading && (!summary || transcriptLines > summary.segmentCount)) onGenerateSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full max-h-[70vh] flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {summaryError && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">{summaryError}</div>}

        {!summary && !summaryLoading && (
          <p className="text-slate-500">
            {transcriptLines === 0
              ? "Nobody has spoken yet, so there is nothing to summarize. Once the conversation starts, come back here."
              : "Press the button below to summarize the meeting so far."}
          </p>
        )}

        {summaryLoading && <p className="animate-pulse text-slate-400">NEXUS is reading the transcript…</p>}

        {summary && (
          <>
            <Block title="Overview">
              <p className="text-slate-200">{summary.shortSummary || "No overview available."}</p>
              {summary.detailedSummary && summary.detailedSummary !== summary.shortSummary && (
                <details className="mt-2 rounded-lg bg-white/5 p-2">
                  <summary className="cursor-pointer text-xs text-slate-400">More detail</summary>
                  <p className="mt-2 whitespace-pre-line text-slate-300">{summary.detailedSummary}</p>
                </details>
              )}
            </Block>

            <Block title="Key topics">
              {summary.topics.length === 0 ? (
                <None />
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {summary.topics.map((t, i) => (
                    <span key={i} className="badge bg-white/5 text-slate-300">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </Block>

            <Block title="Key points">
              <List items={summary.keyPoints} />
            </Block>

            <Block title="Decisions">
              <List items={summary.decisions} />
            </Block>

            <Block title="Action items">
              {summary.actionItems.length === 0 ? (
                <None />
              ) : (
                <div className="space-y-1.5">
                  {summary.actionItems.map((a, i) => (
                    <div key={i} className="rounded-lg bg-white/5 p-2">
                      <div className="text-slate-200">{a.task}</div>
                      <div className="mt-0.5 text-xs text-slate-400">
                        <span className="text-slate-500">Responsible:</span> {a.owner}
                        <span className="mx-1.5 text-slate-600">·</span>
                        <span className="text-slate-500">Deadline:</span> {a.deadline}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Block>

            <Block title="Unresolved questions">
              <List items={summary.questions} />
            </Block>

            <p className="text-xs text-slate-600">
              Based on {summary.segmentCount} transcript lines from {summary.speakers.join(", ") || "no one yet"} ·{" "}
              {new Date(summary.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {stale && " · the meeting has moved on since"}
            </p>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 p-3">
        <button onClick={onGenerateSummary} disabled={summaryLoading || transcriptLines === 0} className="btn-primary w-full text-sm">
          {summaryLoading ? "Summarizing…" : summary ? (stale ? "Update summary" : "Refresh summary") : "Summarize meeting so far"}
        </button>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
      {children}
    </div>
  );
}

function None() {
  return <p className="text-slate-500">None mentioned in this meeting.</p>;
}

function List({ items }: { items: string[] }) {
  if (!items || items.length === 0) return <None />;
  return (
    <ul className="space-y-1">
      {items.map((it, i) => (
        <li key={i} className="text-slate-300">
          • {it}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

function AskView({ entries, onAsk, transcriptLines }: { entries: AskNexusEntry[]; onAsk: (q: string) => void; transcriptLines: number }) {
  const [question, setQuestion] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const waiting = entries.some((e) => e.pending);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  function submit(q: string) {
    const text = q.trim();
    if (!text || waiting) return;
    onAsk(text);
    setQuestion("");
  }

  return (
    <div className="flex h-full max-h-[70vh] min-h-[320px] flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {entries.length === 0 && (
          <div className="space-y-3">
            <p className="text-slate-500">
              {transcriptLines === 0
                ? "Nobody has spoken yet. Answers come only from what is said in this meeting."
                : "Ask anything about this meeting. Answers come only from what was actually said, and name who said it."}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => submit(s)} className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((e) => (
          <div key={e.id} className="space-y-1.5">
            <div className="font-medium text-brand-400">You: {e.question}</div>
            {e.pending && (
              <div className="animate-pulse rounded-lg bg-white/5 p-2 text-slate-400">
                NEXUS is checking the transcript… <PendingElapsed />
              </div>
            )}
            {e.error && <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-200">{e.error}</div>}
            {e.answer && (
              <div className="rounded-lg bg-white/5 p-2 text-slate-200">
                <p className="whitespace-pre-line">{e.answer}</p>
                {e.note && <p className="mt-2 text-xs text-amber-300">{e.note}</p>}
                {e.tookMs !== undefined && <p className="mt-1 text-[11px] text-slate-500">Answered in {(e.tookMs / 1000).toFixed(1)} s</p>}
                {e.sources && e.sources.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-500">Sources ({e.sources.length})</summary>
                    <ul className="mt-1.5 space-y-1.5">
                      {e.sources.map((s, i) => (
                        <li key={i} className="text-xs text-slate-400">
                          <span className="text-slate-300">
                            {s.speaker} · {mmss(s.startTime)}
                          </span>
                          <br />
                          {s.text}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          submit(question);
        }}
        className="flex shrink-0 gap-2 border-t border-white/10 p-3"
      >
        <input
          value={question}
          onChange={(ev) => setQuestion(ev.target.value)}
          className="input"
          placeholder="Ask NEXUS about this meeting…"
          maxLength={500}
          autoFocus
        />
        <button type="submit" disabled={waiting || !question.trim()} className="btn-primary shrink-0">
          Ask
        </button>
      </form>
    </div>
  );
}