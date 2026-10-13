import React, { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api, apiErrorMessage } from "../services/api";
import { MeetingListItem, SUPPORTED_MEETING_LANGUAGES } from "../types";

const MODES = [
  { value: "business_meeting", label: "Business Meeting" },
  { value: "general_meeting", label: "General Meeting" },
  { value: "live_class", label: "Live Class" },
];

export default function MeetingsPage() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState("business_meeting");
  const [defaultLanguage, setDefaultLanguage] = useState("English");
  const [joinLink, setJoinLink] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  function refresh() {
    api.get("/meetings").then((res) => setMeetings(res.data));
  }
  useEffect(refresh, []);

  async function deleteMeeting(meetingId: string) {
    if (!confirm("Delete this meeting and all its data (transcript, summary, recording)? This cannot be undone.")) return;
    try {
      await api.delete(`/meetings/${meetingId}`);
      // Remove it from the UI immediately rather than waiting on a refetch.
      setMeetings((prev) => (prev ? prev.filter((m) => m.meetingId !== meetingId) : prev));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  async function createMeeting() {
    if (!title.trim()) {
      setError("Give the meeting a title.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await api.post("/meetings", { title, mode, defaultLanguage });
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
    const meetingId = match ? match[1] : trimmed;
    navigate(`/meeting/${meetingId}`);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Meetings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Real-time multilingual meetings with a shared AI transcript, insights, and Ask NEXUS.
        </p>
      </div>

      <div className="flex gap-3 flex-wrap">
        <button onClick={() => setShowCreate((v) => !v)} className="btn-primary">
          + New Meeting
        </button>
        <button onClick={() => setShowJoin((v) => !v)} className="btn-secondary">
          Join Meeting
        </button>
      </div>

      {showCreate && (
        <div className="card p-5 space-y-4 max-w-md">
          {error && <p className="text-sm text-red-300">{error}</p>}
          <div>
            <label className="label">Meeting title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" placeholder="Team standup" />
          </div>
          <div>
            <label className="label">Meeting type</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="input">
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Default language</label>
            <select value={defaultLanguage} onChange={(e) => setDefaultLanguage(e.target.value)} className="input">
              {SUPPORTED_MEETING_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <button onClick={createMeeting} disabled={creating} className="btn-primary w-full">
            {creating ? "Creating…" : "Create Meeting"}
          </button>
        </div>
      )}

      {showJoin && (
        <div className="card p-5 space-y-4 max-w-md">
          <div>
            <label className="label">Meeting link or ID</label>
            <input
              value={joinLink}
              onChange={(e) => setJoinLink(e.target.value)}
              className="input"
              placeholder="Paste the meeting link you were sent"
            />
          </div>
          <button onClick={goToJoinLink} className="btn-primary w-full">
            Continue
          </button>
        </div>
      )}

      <div className="card p-5">
        <h2 className="font-medium mb-4">Recent meetings</h2>
        {error && !showCreate && <p className="text-sm text-red-300 mb-3">{error}</p>}
        {meetings === null && <p className="text-sm text-slate-500">Loading…</p>}
        {meetings?.length === 0 && <p className="text-sm text-slate-500">No meetings yet — start your first one above.</p>}
        <div className="space-y-2">
          {meetings?.map((m) => (
            <div key={m.meetingId} className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{m.title}</div>
                <div className="text-xs text-slate-500">
                  {new Date(m.createdAt).toLocaleString()} · {m.participantCount} participant{m.participantCount === 1 ? "" : "s"}
                  {m.durationSeconds !== undefined && ` · ${Math.round(m.durationSeconds / 60)} min`}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="badge bg-white/5 capitalize">{m.status === "ended" ? m.summaryStatus : m.status}</span>
                {m.status === "ended" ? (
                  <Link to={`/meetings/${m.meetingId}/report`} className="text-sm text-brand-400 hover:underline">
                    View report
                  </Link>
                ) : (
                  <Link to={`/meeting/${m.meetingId}`} className="text-sm text-brand-400 hover:underline">
                    Rejoin
                  </Link>
                )}
                {m.status === "ended" && m.isHost && (
                  <button onClick={() => deleteMeeting(m.meetingId)} className="text-sm text-red-400 hover:underline">
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
