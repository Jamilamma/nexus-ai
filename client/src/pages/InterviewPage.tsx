import React, { useState } from "react";
import { api, apiErrorMessage } from "../services/api";
import { Interview, InterviewTurn } from "../types";

const ROLES = [
  "AI Engineer",
  "Data Analyst",
  "Data Scientist",
  "Data Engineer",
  "Python Developer",
  "Software Developer",
  "ML Engineer",
];

export default function InterviewPage() {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [role, setRole] = useState(ROLES[0]);
  const [difficulty, setDifficulty] = useState("intermediate");
  const [jobDescription, setJobDescription] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startInterview() {
    setLoading(true);
    setError("");
    try {
      const res = await api.post("/interview/start", { role, difficulty, jobDescription });
      setInterview(res.data.interview);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitAnswer() {
    if (!interview || !answer.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.post("/interview/answer", { interviewId: interview._id, answer });
      setInterview(res.data.interview);
      setAnswer("");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function finish() {
    if (!interview) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.post("/interview/finish", { interviewId: interview._id });
      setInterview(res.data.interview);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (!interview) {
    return (
      <div className="max-w-lg space-y-6">
        <div>
          <h1 className="text-xl font-semibold">AI Interview Coach</h1>
          <p className="text-sm text-slate-500 mt-1">
            Practice a mock interview and get AI feedback on content, clarity, and grammar.
          </p>
        </div>

        <div className="card p-5 space-y-4">
          {error && <p className="text-sm text-red-300">{error}</p>}
          <div>
            <label className="label">Target role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="input">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Difficulty</label>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="input">
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </select>
          </div>
          <div>
            <label className="label">Job description (optional)</label>
            <textarea
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              className="input h-24 resize-none"
              placeholder="Paste a job description for more relevant questions…"
            />
          </div>
          <button onClick={startInterview} disabled={loading} className="btn-primary w-full">
            {loading ? "Starting…" : "Start mock interview"}
          </button>
        </div>
      </div>
    );
  }

  const currentTurn = interview.turns[interview.turns.length - 1];
  const completedTurns = interview.turns.filter((t) => t.scores);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{interview.role} — Mock Interview</h1>
          <p className="text-sm text-slate-500 mt-1 capitalize">{interview.difficulty} difficulty</p>
        </div>
        {interview.status === "in_progress" && completedTurns.length > 0 && (
          <button onClick={finish} disabled={loading} className="btn-secondary text-sm">
            Finish & get report
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}

      {interview.status === "completed" ? (
        <FinalReport interview={interview} />
      ) : (
        <>
          <div className="space-y-4">
            {interview.turns.slice(0, -1).map((t, i) => (
              <AnsweredTurn key={i} turn={t} index={i} />
            ))}
          </div>

          <div className="card p-5">
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
              Question {interview.turns.length}
            </div>
            <p className="text-sm font-medium mb-4">{currentTurn.question}</p>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              className="input h-32 resize-none mb-3"
              placeholder="Type your answer…"
            />
            <button onClick={submitAnswer} disabled={loading || !answer.trim()} className="btn-primary">
              {loading ? "Evaluating…" : "Submit answer"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AnsweredTurn({ turn, index }: { turn: InterviewTurn; index: number }) {
  return (
    <div className="card p-5">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Question {index + 1}</div>
      <p className="text-sm font-medium mb-2">{turn.question}</p>
      <p className="text-sm text-slate-400 mb-3">{turn.answer}</p>

      {turn.scores && (
        <div className="flex flex-wrap gap-2 mb-3">
          <ScorePill label="Technical" value={turn.scores.technical} />
          <ScorePill label="Communication" value={turn.scores.communication} />
          <ScorePill label="Grammar" value={turn.scores.grammar} />
          <ScorePill label="Clarity" value={turn.scores.clarity} />
        </div>
      )}

      {turn.feedback && (
        <div className="text-sm text-slate-300 bg-white/5 rounded-lg p-3 mb-2">{turn.feedback}</div>
      )}
      {turn.improvedAnswer && (
        <details className="text-sm">
          <summary className="cursor-pointer text-brand-400">See a stronger sample answer</summary>
          <p className="text-slate-400 mt-2">{turn.improvedAnswer}</p>
        </details>
      )}
    </div>
  );
}

function ScorePill({ label, value }: { label: string; value: number }) {
  return (
    <span className="badge bg-white/5 text-slate-300">
      {label}: {value}/10
    </span>
  );
}

function FinalReport({ interview }: { interview: Interview }) {
  return (
    <div className="space-y-6">
      <div className="card p-6 text-center">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Overall score (AI estimate)</div>
        <div className="text-4xl font-semibold text-brand-400">{interview.overallScore}/10</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card p-5">
          <h3 className="font-medium mb-3">Strong areas</h3>
          <ul className="space-y-1.5 text-sm text-slate-300">
            {(interview.strongAreas || []).map((a, i) => (
              <li key={i}>• {a}</li>
            ))}
          </ul>
        </div>
        <div className="card p-5">
          <h3 className="font-medium mb-3">Areas to improve</h3>
          <ul className="space-y-1.5 text-sm text-slate-300">
            {(interview.weakAreas || []).map((a, i) => (
              <li key={i}>• {a}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="font-medium mb-2">Personalized preparation plan</h3>
        <p className="text-sm text-slate-300 whitespace-pre-line">{interview.preparationPlan}</p>
      </div>

      <div className="space-y-4">
        {interview.turns
          .filter((t) => t.scores)
          .map((t, i) => (
            <AnsweredTurn key={i} turn={t} index={i} />
          ))}
      </div>
    </div>
  );
}
