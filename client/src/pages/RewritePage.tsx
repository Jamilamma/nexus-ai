import React, { useState } from "react";
import { api, apiErrorMessage } from "../services/api";

const MODES = [
  { value: "correct_grammar", label: "Correct grammar" },
  { value: "make_natural", label: "Make natural" },
  { value: "make_professional", label: "Make professional" },
  { value: "make_concise", label: "Make concise" },
  { value: "simplify", label: "Simplify" },
  { value: "explain", label: "Explain" },
  { value: "summarize", label: "Summarize" },
];

const LANGUAGES = ["English", "Tamil", "Hindi", "Arabic"];

export default function RewritePage() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("make_professional");
  const [result, setResult] = useState("");
  const [translateMode, setTranslateMode] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState("Tamil");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleRun() {
    if (!text.trim()) return;
    setLoading(true);
    setError("");
    setResult("");
    try {
      if (translateMode) {
        const res = await api.post("/ai/translate", { text, targetLanguage });
        setResult(res.data.result);
      } else {
        const res = await api.post("/ai/rewrite", { text, mode });
        setResult(res.data.result);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">AI Rewrite</h1>
        <p className="text-sm text-slate-500 mt-1">
          Fix grammar, change tone, translate, or simplify any piece of text.
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        <button
          onClick={() => setTranslateMode(false)}
          className={`px-3 py-1.5 rounded-lg ${!translateMode ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-slate-400"}`}
        >
          Rewrite
        </button>
        <button
          onClick={() => setTranslateMode(true)}
          className={`px-3 py-1.5 rounded-lg ${translateMode ? "bg-brand-500/20 text-brand-400" : "bg-white/5 text-slate-400"}`}
        >
          Translate
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-5 space-y-4">
          <div>
            <label className="label">Original text</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="input h-56 resize-none"
              placeholder="Actually I am working on one project and basically it is like healthcare related project."
            />
          </div>

          {translateMode ? (
            <div>
              <label className="label">Target language</label>
              <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} className="input">
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="label">Mode</label>
              <select value={mode} onChange={(e) => setMode(e.target.value)} className="input">
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-sm text-red-300">{error}</p>}

          <button onClick={handleRun} disabled={loading} className="btn-primary w-full">
            {loading ? "Working…" : translateMode ? "Translate" : "Rewrite"}
          </button>
        </div>

        <div className="card p-5">
          <label className="label">Result</label>
          {result ? (
            <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">{result}</p>
          ) : (
            <p className="text-sm text-slate-600">Output will appear here.</p>
          )}
        </div>
      </div>
    </div>
  );
}
