import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, apiErrorMessage } from "../services/api";
import { Recording, Transcript, Summary, LearningContent } from "../types";
import StatusBadge from "../components/StatusBadge";

const TABS = ["Summary", "Transcript", "Action Items", "Ask AI", "Learning"] as const;
type TabName = (typeof TABS)[number];

export default function RecordingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [learningContent, setLearningContent] = useState<LearningContent | null>(null);
  const [tab, setTab] = useState<TabName>("Summary");
  const [loading, setLoading] = useState(true);

  function load() {
    api.get(`/recordings/${id}`).then((res) => {
      setRecording(res.data.recording);
      setTranscript(res.data.transcript);
      setSummary(res.data.summary);
      setLearningContent(res.data.learningContent);
    });
  }

  useEffect(() => {
    load();
    setLoading(false);
    const interval = setInterval(() => {
      if (recording && !["ready", "failed"].includes(recording.status)) load();
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, recording?.status]);

  async function handleDelete() {
    if (!confirm("Delete this recording and all generated data? This cannot be undone.")) return;
    await api.delete(`/recordings/${id}`);
    navigate("/recordings");
  }

  if (loading || !recording) return <div className="text-sm text-slate-500">Loading…</div>;

  const isProcessing = !["ready", "failed"].includes(recording.status);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{recording.title}</h1>
          <div className="flex items-center gap-2 mt-1.5 text-sm text-slate-500">
            <span className="capitalize">{recording.type}</span>
            <span>·</span>
            <span>{new Date(recording.createdAt).toLocaleString()}</span>
            <span>·</span>
            <StatusBadge status={recording.status} />
          </div>
        </div>
        <button onClick={handleDelete} className="btn-secondary text-sm text-red-400">
          Delete
        </button>
      </div>

      {recording.status === "failed" && (
        <div className="card p-4 border-red-500/30 bg-red-500/5 text-sm text-red-300">
          Processing failed: {recording.errorMessage || "Unknown error."}
        </div>
      )}

      {isProcessing && recording.status !== "failed" && (
        <div className="card p-4 text-sm text-amber-300 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          NEXUS AI is processing this recording ({recording.status})… this page will update automatically.
        </div>
      )}

      {recording.status === "ready" && (
        <>
          <div className="flex gap-1 border-b border-white/5">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === t ? "border-brand-500 text-brand-400" : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "Summary" && summary && <SummaryTab summary={summary} />}
          {tab === "Transcript" && transcript && <TranscriptTab transcript={transcript} />}
          {tab === "Action Items" && summary && <ActionItemsTab summary={summary} />}
          {tab === "Ask AI" && <AskAITab recordingId={recording._id} />}
          {tab === "Learning" && (
            <LearningTab
              recordingId={recording._id}
              learningContent={learningContent}
              onGenerated={(lc) => setLearningContent(lc)}
            />
          )}
        </>
      )}
    </div>
  );
}

function SummaryTab({ summary }: { summary: Summary }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="card p-5">
          <h3 className="font-medium mb-2">Short summary</h3>
          <p className="text-sm text-slate-300 leading-relaxed">{summary.shortSummary}</p>
        </div>
        <div className="card p-5">
          <h3 className="font-medium mb-2">Detailed summary</h3>
          <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">{summary.detailedSummary}</p>
        </div>
        <div className="card p-5">
          <h3 className="font-medium mb-3">Key points</h3>
          <ul className="space-y-2">
            {summary.keyPoints.map((k, i) => (
              <li key={i} className="text-sm text-slate-300 flex gap-2">
                <span className="text-brand-400">•</span> {k}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="space-y-6">
        <ListCard title="Decisions" items={summary.decisions} empty="No decisions were explicitly made." />
        <ListCard title="Questions raised" items={summary.questions} empty="No open questions." />
        <ListCard title="Risks" items={summary.risks} empty="No risks discussed." />
        <ListCard title="Topics" items={summary.topics} empty="—" chip />
      </div>
    </div>
  );
}

function ListCard({ title, items, empty, chip }: { title: string; items: string[]; empty: string; chip?: boolean }) {
  return (
    <div className="card p-5">
      <h3 className="font-medium mb-3">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : chip ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((i, idx) => (
            <span key={idx} className="badge bg-white/5 text-slate-300">
              {i}
            </span>
          ))}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((i, idx) => (
            <li key={idx} className="text-sm text-slate-300">
              {i}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TranscriptTab({ transcript }: { transcript: Transcript }) {
  const [query, setQuery] = useState("");
  const filtered = query
    ? transcript.segments.filter((s) => s.text.toLowerCase().includes(query.toLowerCase()))
    : transcript.segments;

  return (
    <div className="card p-5">
      <input
        className="input mb-4"
        placeholder="Search transcript…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        {filtered.map((s, i) => (
          <div key={i} className="flex gap-3 text-sm">
            <div className="w-24 shrink-0 text-slate-500 text-xs pt-0.5">
              {formatTime(s.startTime)}
              <div className="text-slate-400 font-medium">{s.speaker}</div>
            </div>
            <p className="text-slate-300">{s.text}</p>
          </div>
        ))}
        {filtered.length === 0 && <p className="text-sm text-slate-500">No matches.</p>}
      </div>
    </div>
  );
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-red-500/20 text-red-300",
  medium: "bg-amber-500/20 text-amber-300",
  low: "bg-slate-500/20 text-slate-300",
  "not specified": "bg-white/5 text-slate-400",
};

function ActionItemsTab({ summary }: { summary: Summary }) {
  return (
    <div className="card divide-y divide-white/5">
      {summary.actionItems.length === 0 ? (
        <p className="text-sm text-slate-500 p-5">No action items were extracted from this recording.</p>
      ) : (
        summary.actionItems.map((item, i) => (
          <div key={i} className="p-5 flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium">{item.task}</div>
              <div className="text-xs text-slate-500 mt-1">
                Owner: {item.owner} · Deadline: {item.deadline}
              </div>
            </div>
            <span className={`badge shrink-0 ${PRIORITY_STYLE[item.priority] || PRIORITY_STYLE["not specified"]}`}>
              {item.priority}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function AskAITab({ recordingId }: { recordingId: string }) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<{ q: string; a: string; sources: any[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.post("/rag/query", { recordingId, question });
      setHistory((h) => [...h, { q: question, a: res.data.answer, sources: res.data.sources }]);
      setQuestion("");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card p-5">
      <p className="text-sm text-slate-500 mb-4">
        Ask anything about this recording. NEXUS AI retrieves the most relevant parts of the transcript before
        answering.
      </p>

      <div className="space-y-4 mb-4 max-h-[50vh] overflow-y-auto">
        {history.map((h, i) => (
          <div key={i} className="space-y-2">
            <div className="text-sm font-medium text-brand-400">You: {h.q}</div>
            <div className="text-sm text-slate-300 bg-white/5 rounded-lg p-3">{h.a}</div>
          </div>
        ))}
        {history.length === 0 && <p className="text-sm text-slate-600">No questions asked yet.</p>}
      </div>

      {error && <div className="text-sm text-red-300 mb-2">{error}</div>}

      <form onSubmit={handleAsk} className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="input"
          placeholder="What were the three main decisions?"
        />
        <button type="submit" disabled={loading} className="btn-primary shrink-0">
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}

function LearningTab({
  recordingId,
  learningContent,
  onGenerated,
}: {
  recordingId: string;
  learningContent: LearningContent | null;
  onGenerated: (lc: LearningContent) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    try {
      const res = await api.post("/learning/generate", { recordingId });
      onGenerated(res.data.learningContent);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  if (!learningContent) {
    return (
      <div className="card p-8 text-center">
        <p className="text-sm text-slate-400 mb-4">
          Generate study notes, flashcards, and quiz questions from this recording.
        </p>
        {error && <p className="text-sm text-red-300 mb-3">{error}</p>}
        <button onClick={handleGenerate} disabled={generating} className="btn-primary">
          {generating ? "Generating…" : "Generate learning content"}
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="card p-5">
        <h3 className="font-medium mb-2">Notes</h3>
        <p className="text-sm text-slate-300 whitespace-pre-line">{learningContent.notes}</p>
      </div>

      <div className="card p-5">
        <h3 className="font-medium mb-3">Flashcards</h3>
        <div className="space-y-2">
          {learningContent.flashcards.map((f, i) => (
            <details key={i} className="bg-white/5 rounded-lg p-3">
              <summary className="text-sm cursor-pointer">{f.question}</summary>
              <p className="text-sm text-slate-400 mt-2">{f.answer}</p>
            </details>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="font-medium mb-3">Key definitions</h3>
        <div className="space-y-2">
          {learningContent.definitions.map((d, i) => (
            <div key={i} className="text-sm">
              <span className="font-medium text-slate-200">{d.term}:</span>{" "}
              <span className="text-slate-400">{d.definition}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="font-medium mb-3">Quiz</h3>
        <div className="space-y-4">
          {learningContent.quiz.map((q, i) => (
            <div key={i}>
              <p className="text-sm font-medium mb-1">{q.question}</p>
              <ul className="text-sm text-slate-400 space-y-0.5">
                {q.options.map((opt, oi) => (
                  <li key={oi} className={oi === q.correctIndex ? "text-emerald-400" : ""}>
                    {String.fromCharCode(65 + oi)}. {opt}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
