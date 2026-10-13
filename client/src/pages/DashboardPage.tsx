import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, apiErrorMessage } from "../services/api";
import { DashboardStats, MeetingListItem } from "../types";
import StatusBadge from "../components/StatusBadge";

function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card p-5">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [title, setTitle] = useState("");
  const [joinLink, setJoinLink] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.get("/analytics/dashboard"), api.get("/meetings")])
      .then(([statsRes, meetingsRes]) => {
        setStats(statsRes.data);
        setMeetings(meetingsRes.data);
      })
      .finally(() => setLoading(false));
  }, []);

  async function createMeeting() {
    if (!title.trim()) {
      setError("Give the meeting a title.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await api.post("/meetings", { title });
      navigate(res.data.joinUrl);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  function goToJoinLink() {
    const trimmed = joinLink.trim();
    if (!trimmed) return;
    const match = trimmed.match(/meeting\/([a-zA-Z0-9]+)/);
    navigate(`/meeting/${match ? match[1] : trimmed}`);
  }

  if (loading) return <div className="text-slate-500 text-sm">Loading dashboard…</div>;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">Real-time multilingual meeting intelligence, at a glance.</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => { setShowCreate((v) => !v); setShowJoin(false); }} className="btn-primary">
            + New Meeting
          </button>
          <button onClick={() => { setShowJoin((v) => !v); setShowCreate(false); }} className="btn-secondary">
            Join Meeting
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="card p-5 space-y-3 max-w-md">
          {error && <p className="text-sm text-red-300">{error}</p>}
          <div>
            <label className="label">Meeting title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" placeholder="Team standup" />
          </div>
          <button onClick={createMeeting} disabled={creating} className="btn-primary w-full">
            {creating ? "Creating…" : "Create Meeting"}
          </button>
        </div>
      )}

      {showJoin && (
        <div className="card p-5 space-y-3 max-w-md">
          <div>
            <label className="label">Meeting link or ID</label>
            <input value={joinLink} onChange={(e) => setJoinLink(e.target.value)} className="input" placeholder="Paste the meeting link you were sent" />
          </div>
          <button onClick={goToJoinLink} className="btn-primary w-full">
            Continue
          </button>
        </div>
      )}

      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-medium">Recent meetings</h2>
          <Link to="/meetings" className="text-sm text-brand-400 hover:underline">
            View all →
          </Link>
        </div>
        {!meetings || meetings.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-slate-500 mb-3">No meetings yet.</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary inline-block text-sm">
              Start your first meeting
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {meetings.slice(0, 5).map((m) => (
              <div key={m.meetingId} className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{m.title}</div>
                  <div className="text-xs text-slate-500">
                    {new Date(m.createdAt).toLocaleDateString()} · {m.participantCount} participant{m.participantCount === 1 ? "" : "s"}
                    {m.durationSeconds !== undefined && ` · ${Math.round(m.durationSeconds / 60)} min`}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="badge bg-white/5 capitalize">{m.status === "ended" ? m.summaryStatus : m.status}</span>
                  <Link
                    to={m.status === "ended" ? `/meetings/${m.meetingId}/report` : `/meeting/${m.meetingId}`}
                    className="text-sm text-brand-400 hover:underline"
                  >
                    {m.status === "ended" ? "View report" : "Rejoin"}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {stats && meetings && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Meetings held" value={meetings.filter((m) => m.status === "ended").length} />
          <StatCard label="Recordings" value={stats.totalRecordings} />
          <StatCard label="Action items" value={stats.totalActionItems} />
          <StatCard
            label="Avg meeting length"
            value={(() => {
              const durations = meetings.map((m) => m.durationSeconds).filter((d): d is number => d !== undefined);
              if (durations.length === 0) return "—";
              const avgMin = durations.reduce((s, d) => s + d, 0) / durations.length / 60;
              return `${Math.round(avgMin)} min`;
            })()}
          />
        </div>
      )}

      {stats && stats.topTopics.length > 0 && (
        <div className="card p-5">
          <h2 className="font-medium mb-4">Frequent topics</h2>
          <div className="space-y-2">
            {stats.topTopics.map((t) => (
              <div key={t.topic} className="flex items-center justify-between text-sm">
                <span className="text-slate-300">{t.topic}</span>
                <span className="text-slate-500">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
