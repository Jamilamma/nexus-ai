import React, { useEffect, useRef } from "react";
import { MeetingTranscriptSegment2, MeetingTranscriptPartial } from "../../types";

/** Languages the transcript can be translated into (also the language of NEXUS Summary / Ask answers). */
export const TARGET_LANGUAGES = ["English", "Tamil", "Hindi", "Arabic"] as const;

/** ISO code (as reported by the recognizer) -> display name. Unknown codes are shown as-is, never guessed. */
const LANGUAGE_NAMES: Record<string, string> = { en: "English", ta: "Tamil", hi: "Hindi", ar: "Arabic" };
const CODE_OF: Record<string, string> = { English: "en", Tamil: "ta", Hindi: "hi", Arabic: "ar" };
const nameOf = (code: string) => LANGUAGE_NAMES[code.toLowerCase()] ?? code.toUpperCase();
const spokenLabel = (s: MeetingTranscriptSegment2) => {
  const codes = s.languages && s.languages.length > 0 ? s.languages : s.language ? [s.language] : [];
  return codes.map(nameOf).join(" + ");
};
const isOnly = (s: MeetingTranscriptSegment2, language: string) => {
  const codes = s.languages && s.languages.length > 0 ? s.languages : s.language ? [s.language] : [];
  return codes.length > 0 && codes.every((c) => c.toLowerCase() === CODE_OF[language]);
};

/** "I speak" choices -> ISO codes. ONE language = forced (most accurate when you know it); TWO = auto-detect between them with a code-switching prompt (e.g. Tanglish). "auto" = server default languages. */
export const SPOKEN_CHOICES: Record<string, { label: string; codes: string[] }> = {
  auto: { label: "Auto-detect", codes: [] },
  en: { label: "English", codes: ["en"] },
  ta: { label: "Tamil", codes: ["ta"] },
  "ta+en": { label: "Tamil + English (mixed)", codes: ["ta", "en"] },
  hi: { label: "Hindi", codes: ["hi"] },
  "hi+en": { label: "Hindi + English (mixed)", codes: ["hi", "en"] },
  ar: { label: "Arabic", codes: ["ar"] },
  "ar+en": { label: "Arabic + English (mixed)", codes: ["ar", "en"] },
};

interface Props {
  segments: MeetingTranscriptSegment2[];
  partials: MeetingTranscriptPartial[];
  currentUserId: string;
  viewMode: "original" | "translated";
  targetLanguage: string;
  spokenChoice: string;
  onViewModeChange: (mode: "original" | "translated") => void;
  onTargetLanguageChange: (language: string) => void;
  onSpokenChoiceChange: (choice: string) => void;
}

function clock(iso?: string, fallbackSeconds?: number) {
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const s = Math.max(0, Math.floor(fallbackSeconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Live, participant-aware transcript. Speaker names come from the server (LiveKit identity), never inferred here.
 * "Original" shows exactly what the recognizer heard. "Translated" shows a machine translation of each finalized
 * line for reading; the original is kept and is what Summary / Ask NEXUS use.
 */
export default function TranscriptPanel({
  segments, partials, currentUserId, viewMode, targetLanguage, spokenChoice,
  onViewModeChange, onTargetLanguageChange, onSpokenChoiceChange,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const translated = viewMode === "translated";
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segments.length, partials.map((p) => p.text).join("|"), viewMode]);

  const select = "rounded bg-white/5 px-1.5 py-1 text-xs text-slate-200 outline-none focus:ring-1 focus:ring-brand-400";

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-white/5 px-3 py-2 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-white/10" role="tablist" aria-label="Transcript view">
            {(["original", "translated"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={viewMode === m}
                onClick={() => onViewModeChange(m)}
                className={`px-2.5 py-1 ${viewMode === m ? "bg-brand-500/25 text-brand-400" : "text-slate-400 hover:bg-white/5"}`}
              >
                {m === "original" ? "Original" : "Translated"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5">
            <span>to</span>
            <select className={select} value={targetLanguage} onChange={(e) => onTargetLanguageChange(e.target.value)} aria-label="Translate to">
              {TARGET_LANGUAGES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-1.5">
          <span>I speak</span>
          <select className={select} value={spokenChoice} onChange={(e) => onSpokenChoiceChange(e.target.value)} aria-label="Language I speak">
            {Object.entries(SPOKEN_CHOICES).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <span className="text-slate-600" title="One language = forced (best accuracy if you only speak that language). Two = automatic choice between them. Auto-detect = English, Tamil, Hindi or Arabic.">{spokenChoice === "auto" ? "auto" : SPOKEN_CHOICES[spokenChoice]?.codes.length === 1 ? "forced" : "auto between"}</span>
        </label>
        <p className="text-[11px] leading-snug text-slate-600">
          {translated
            ? `Machine translation into ${targetLanguage} for reading. The original is kept and is what NEXUS AI uses.`
            : `${targetLanguage} is also the language of NEXUS summaries and answers.`}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {segments.length === 0 && partials.length === 0 && <p className="text-sm text-slate-600">Waiting for speech…</p>}
        {segments.map((s, i) => {
          const t = s.translations?.[targetLanguage];
          const same = translated && isOnly(s, targetLanguage);
          return (
            <div key={s.segmentId || i} className="text-sm">
              <div className="mb-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{clock(s.timestamp, s.startTime)}</span>
                <span className={`font-medium ${s.participantId === currentUserId ? "text-brand-400" : "text-slate-300"}`}>
                  {s.speaker}
                  {s.participantId === currentUserId ? " (You)" : ""}
                </span>
                {spokenLabel(s) && <span className="badge bg-white/5" title="Spoken language as detected by the recognizer">{spokenLabel(s)}</span>}
                {s.lowConfidence && (
                  <span className="badge bg-amber-500/10 text-amber-300" title="The speech recognizer was unsure about this line, so it may contain wrong words.">
                    low confidence
                  </span>
                )}
              </div>
              {!translated || same ? (
                <p lang={s.language} dir="auto" className="text-slate-200">{s.text}</p>
              ) : t ? (
                <p lang={CODE_OF[targetLanguage]} dir="auto" className="text-slate-200">{t}</p>
              ) : (
                <>
                  <p className="text-xs italic text-slate-500">Translating…</p>
                  <p lang={s.language} dir="auto" className="text-slate-400">{s.text}</p>
                </>
              )}
            </div>
          );
        })}
        {partials.map((p) => (
          <div key={`partial-${p.participantId}`} className="text-sm opacity-70">
            <div className="mb-0.5 flex items-center gap-2 text-xs text-slate-500">
              <span>{clock(p.timestamp)}</span>
              <span className="font-medium text-slate-300">{p.participantName}</span>
              <span className="italic">speaking…</span>
            </div>
            <p dir="auto" className="italic text-slate-400">{p.text}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
