import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api, apiErrorMessage } from "../services/api";
import { MeetingReport, MyMeetingReport } from "../types";

export default function MeetingReportPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<MeetingReport | null>(null);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [view, setView] = useState<"full" | "mine">("full");

  useEffect(() => {
    if (!id) return;
    api
      .get(`/meetings/${id}/report`)
      .then((res) => setReport(res.data))
      .catch((err) => setError(apiErrorMessage(err)));
  }, [id]);

  // The meeting can end before its AI report is finished; keep refreshing (up to ~3 minutes) until it appears.
  const reportPending = !!report && !report.summary && (report.recordingStatus === "analyzing" || report.recordingStatus === "transcribing");
  useEffect(() => {
    if (!id || !reportPending) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      api
        .get(`/meetings/${id}/report`)
        .then((res) => setReport(res.data))
        .catch(() => {});
      if (tries >= 45) window.clearInterval(timer);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [id, reportPending]);

  async function handleDelete() {
    if (!id) return;
    if (!confirm("Delete this meeting and all its data (transcript, summary, recording)? This cannot be undone.")) return;
    setDeleteError("");
    try {
      await api.delete(`/meetings/${id}`);
      // Remove it from the UI immediately by navigating back to the list
      // rather than leaving the (now-deleted) report on screen.
      navigate("/meetings");
    } catch (err) {
      setDeleteError(apiErrorMessage(err));
    }
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto text-center card p-8 space-y-3">
        <h2 className="text-lg font-semibold">Can't show this report</h2>
        <p className="text-sm text-slate-400">{error}</p>
        <Link to="/meetings" className="btn-primary inline-block">
          Back to Meetings
        </Link>
      </div>
    );
  }

  if (!report) return <div className="text-slate-500 text-sm">Loading report…</div>;

  const { meeting, summary, transcript, recordingStatus, myReport } = report;
  const stillProcessing = !summary && (recordingStatus === "analyzing" || recordingStatus === "transcribing");

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{meeting.title}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {meeting.startedAt && new Date(meeting.startedAt).toLocaleString()} ·{" "}
            {meeting.participants.map((p) => p.displayName).join(", ")}
          </p>
        </div>
        {meeting.status === "ended" && meeting.isHost && (
          <button onClick={handleDelete} className="btn-secondary text-sm text-red-400 shrink-0">
            Delete
          </button>
        )}
      </div>
      {deleteError && <p className="text-sm text-red-300">{deleteError}</p>}

      {myReport && summary && (
        <div className="flex gap-1.5 text-xs">
          {(["full", "mine"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 rounded-md font-medium ${
                view === v ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-slate-400"
              }`}
            >
              {v === "full" ? "Full report" : "My report"}
            </button>
          ))}
        </div>
      )}

      {view === "mine" && myReport && summary && <MyReportView myReport={myReport} />}

      {view === "full" && stillProcessing && (
        <div className="card p-5 text-sm text-amber-300">
          NEXUS AI is still generating the summary for this meeting. Refresh in a moment.
        </div>
      )}

      {view === "full" && recordingStatus === "failed" && !summary && (
        <div className="card p-5 text-sm text-red-300">
          This meeting ended before enough speech was captured to generate a summary.
        </div>
      )}

      {view === "full" && summary && (
        <>
          <Section title="Summary">
            <p className="text-sm text-slate-300 whitespace-pre-line">{summary.detailedSummary || summary.shortSummary}</p>
          </Section>

          <Section title="Key discussion points">
            <BulletList items={summary.keyPoints} />
          </Section>

          <Section title="Decisions">
            <BulletList items={summary.decisions} empty="No decisions were recorded." />
          </Section>

          <Section title="Action items">
            {summary.actionItems.length === 0 ? (
              <p className="text-sm text-slate-500">No action items were recorded.</p>
            ) : (
              <div className="space-y-2">
                {summary.actionItems.map((a, i) => (
                  <div key={i} className="text-sm bg-white/5 rounded-lg p-3">
                    <div className="text-slate-200">{a.task}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      {a.owner} · {a.deadline} · {a.priority}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Questions">
            <BulletList items={summary.questions} empty="No open questions were recorded." />
          </Section>

          <Section title="Important dates">
            <BulletList items={summary.importantDates} empty="No dates were mentioned." />
          </Section>
        </>
      )}

      {view === "full" && transcript && (
        <Section title="Full transcript">
          <div className="space-y-3 max-h-[32rem] overflow-y-auto pr-1">
            {transcript.segments.map((s, i) => (
              <div key={i} className="text-sm">
                <div className="text-xs text-slate-500 mb-0.5">
                  [{formatTime(s.startTime)}] <span className="text-slate-300 font-medium">{s.speaker}</span>
                </div>
                <p className="text-slate-200">{s.text}</p>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function MyReportView({ myReport }: { myReport: MyMeetingReport }) {
  return (
    <>
      <Section title="What I said">
        {myReport.whatISaid.length === 0 ? (
          <p className="text-sm text-slate-500">No speech from you was captured in this meeting.</p>
        ) : (
          <div className="space-y-3 max-h-[24rem] overflow-y-auto pr-1">
            {myReport.whatISaid.map((s, i) => (
              <div key={i} className="text-sm">
                <div className="text-xs text-slate-500 mb-0.5">[{formatTime(s.startTime)}]</div>
                <p className="text-slate-200">{s.text}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="My action items">
        {myReport.myActionItems.length === 0 ? (
          <p className="text-sm text-slate-500">No action items were assigned to you.</p>
        ) : (
          <div className="space-y-2">
            {myReport.myActionItems.map((a, i) => (
              <div key={i} className="text-sm bg-white/5 rounded-lg p-3">
                <div className="text-slate-200">{a.task}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {a.deadline} · {a.priority}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Decisions from the meeting">
        <BulletList items={myReport.decisions} empty="No decisions were recorded." />
      </Section>

      <Section title="Important points">
        <BulletList items={myReport.importantPoints} empty="No key points were recorded." />
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <h2 className="font-medium mb-3">{title}</h2>
      {children}
    </div>
  );
}

function BulletList({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="text-sm text-slate-500">{empty || "Nothing recorded."}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="text-sm text-slate-300">
          • {it}
        </li>
      ))}
    </ul>
  );
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
