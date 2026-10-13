import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, apiErrorMessage } from "../services/api";
import { Recording } from "../types";
import StatusBadge from "../components/StatusBadge";

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  function load() {
    api.get("/recordings").then((res) => setRecordings(res.data.recordings));
  }

  useEffect(() => {
    load();
    setLoading(false);
    const interval = setInterval(load, 5000); // poll for pipeline status updates
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Recordings</h1>
          <p className="text-sm text-slate-500 mt-1">Meetings, lectures, and interviews you've uploaded.</p>
        </div>
        <button onClick={() => setShowUpload(true)} className="btn-primary">
          + New recording
        </button>
      </div>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onCreated={() => {
            setShowUpload(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : recordings.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-slate-400 mb-4">No recordings yet. Upload audio/video or paste a transcript to get started.</p>
          <button onClick={() => setShowUpload(true)} className="btn-primary">
            Upload a recording
          </button>
        </div>
      ) : (
        <div className="card divide-y divide-white/5">
          {recordings.map((r) => (
            <Link
              key={r._id}
              to={`/recordings/${r._id}`}
              className="flex items-center justify-between px-5 py-4 hover:bg-white/5 transition-colors"
            >
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">{r.title}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  <span className="capitalize">{r.type}</span> · {new Date(r.createdAt).toLocaleString()}
                </div>
              </div>
              <StatusBadge status={r.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("meeting");
  const [file, setFile] = useState<File | null>(null);
  const [pastedTranscript, setPastedTranscript] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (mode === "file" && !file) {
      setError("Choose an audio/video file, or switch to 'Paste transcript'.");
      return;
    }
    if (mode === "paste" && !pastedTranscript.trim()) {
      setError("Paste a transcript, or switch to 'Upload file'.");
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("title", title || (file ? file.name : "Untitled recording"));
      formData.append("type", type);
      if (mode === "file" && file) formData.append("file", file);
      if (mode === "paste") formData.append("pastedTranscript", pastedTranscript);

      await api.post("/recordings", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="card w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">New recording</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label className="label">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" placeholder="Weekly sync — Aug 16" />
          </div>

          <div>
            <label className="label">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className="input">
              <option value="meeting">Meeting</option>
              <option value="lecture">Lecture</option>
              <option value="interview">Interview</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setMode("file")}
              className={`px-3 py-1.5 rounded-lg ${mode === "file" ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-slate-400"}`}
            >
              Upload file
            </button>
            <button
              type="button"
              onClick={() => setMode("paste")}
              className={`px-3 py-1.5 rounded-lg ${mode === "paste" ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-slate-400"}`}
            >
              Paste transcript
            </button>
          </div>

          {mode === "file" ? (
            <div>
              <label className="label">Audio / video file</label>
              <input
                type="file"
                accept="audio/*,video/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="input"
              />
              <p className="text-xs text-slate-500 mt-1">
                Requires a speech-to-text provider configured on the server (see README). If none is
                configured, use "Paste transcript" instead.
              </p>
            </div>
          ) : (
            <div>
              <label className="label">Transcript text</label>
              <textarea
                value={pastedTranscript}
                onChange={(e) => setPastedTranscript(e.target.value)}
                className="input h-40 resize-none"
                placeholder="Paste your meeting or lecture transcript here…"
              />
            </div>
          )}

          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? "Uploading…" : "Create recording"}
          </button>
        </form>
      </div>
    </div>
  );
}
