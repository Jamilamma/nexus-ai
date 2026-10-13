/**
 * REAL-RECORDING accuracy evaluation for live speech-to-text (and optional translation review).
 * This is the only test here that measures recognition quality; every other verify script uses a fake vendor.
 *
 * It streams each recording through the REAL production client (realtimeTranscribe.ts -> Soniox, using your
 * SONIOX_API_KEY) at real-time pace, then compares what came back with EXACTLY what was spoken.
 *
 * INPUT: a folder with, per recording,
 *    <name>.wav|.mp3|.m4a|.webm|.ogg   the audio (16 kHz mono PCM16 WAV is read directly; anything else needs `ffmpeg` on PATH)
 *    <name>.txt                        the exact words spoken (UTF-8), written in the script you expect back
 *    <name>.meta.json  (optional)      { "lang": "ta", "condition": "noise", "hints": ["ta","en"] }
 *  If there is no meta file, lang = the part of the file name before the first "_" (e.g. ta_clean_01.wav -> "ta"),
 *  and condition = the second part (clean | pauses | noise ...), else "clean".
 *  Suggested set: en, ta, tanglish, hi, ar x { clean, normal pauses, background noise }.
 *
 * RUN (from server/):
 *    npx ts-node --transpile-only scripts/verify/sttAccuracy.eval.ts --dir ./recordings [--out results.json] [--speed 1] [--translate English]
 *    npx ts-node --transpile-only scripts/verify/sttAccuracy.eval.ts --self-test        # checks the metric code itself, no key needed
 *
 * METRICS (reported per file and per language / condition):
 *   WER  word error rate  = (substitutions + deletions + insertions) / reference words, after normalisation
 *   CER  character error rate, same idea on characters (more meaningful for Tamil/Hindi/Arabic, where word
 *        boundaries and spelling variants dominate WER)
 *   language: dominant language the recognizer reported vs the one you said you spoke
 *   dup lines: consecutive lines with identical text;  low-conf: lines flagged low confidence
 * NORMALISATION (applied to BOTH sides, nothing else is "forgiven"): Unicode NFKC, lower-case, punctuation and symbols
 *   removed, Arabic diacritics/tatweel removed, whitespace collapsed. Spelling variants, script differences and number
 *   formats ("5" vs "five") still count as errors, so Tanglish references must be written the way you expect it back.
 *
 * TRANSLATION: with --translate <Language>, each recognised transcript is also sent through the production translation
 *   prompt (needs LLM_API_KEY) and printed beside the original for a HUMAN to grade. No automatic score is claimed.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

// ------------------------------------------------------------------ metrics (exported for the self-test)
export function normalizeForScoring(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // Arabic diacritics + tatweel
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function editDistance<T>(a: T[], b: T[]): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
export function wer(ref: string, hyp: string) {
  const r = normalizeForScoring(ref).split(" ").filter(Boolean), h = normalizeForScoring(hyp).split(" ").filter(Boolean);
  return { errors: editDistance(r, h), total: r.length };
}
export function cer(ref: string, hyp: string) {
  const r = [...normalizeForScoring(ref).replace(/ /g, "")], h = [...normalizeForScoring(hyp).replace(/ /g, "")];
  return { errors: editDistance(r, h), total: r.length };
}
const pct = (e: number, t: number) => (t === 0 ? "n/a" : `${((100 * e) / t).toFixed(1)}%`);

function selfTest() {
  let bad = 0;
  const eq = (label: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) bad++; };
  eq("identical -> 0 errors", wer("the cat sat", "the cat sat"), { errors: 0, total: 3 });
  eq("1 substitution in 3 words", wer("the cat sat", "the cat sit"), { errors: 1, total: 3 });
  eq("1 deletion", wer("the cat sat", "the sat"), { errors: 1, total: 3 });
  eq("2 insertions", wer("the cat", "the big black cat"), { errors: 2, total: 2 });
  eq("case + punctuation are normalised away", wer("Hello, World!", "hello world"), { errors: 0, total: 2 });
  eq("a wrong word still counts after normalisation", wer("Hello, World!", "hello word"), { errors: 1, total: 2 });
  eq("Tamil: exact match", wer("நாளைக்கு மீட்டிங் இருக்கு", "நாளைக்கு மீட்டிங் இருக்கு"), { errors: 0, total: 3 });
  eq("Tamil: one wrong word", wer("நாளைக்கு மீட்டிங் இருக்கு", "நாளைக்கு மீட்டிங் இல்லை"), { errors: 1, total: 3 });
  eq("Hindi: exact match through danda/punctuation", wer("कल की मीटिंग है।", "कल की मीटिंग है"), { errors: 0, total: 4 });
  eq("Arabic: diacritics ignored", wer("مَتَى سنبدأ", "متى سنبدأ"), { errors: 0, total: 2 });
  eq("Arabic: a wrong word counts", wer("متى سنبدأ الاجتماع", "متى سنبدأ الاجتماعات"), { errors: 1, total: 3 });
  eq("CER ignores spaces: one wrong character of 9", cer("ab cd efg", "ab cd efh"), { errors: 1, total: 7 });
  eq("CER on Tamil counts code points", cer("இருக்கு", "இருகு").errors > 0, true);
  eq("empty reference -> total 0 (reported n/a, never divided by zero)", wer("", "anything").total, 0);
  console.log(bad ? `\n${bad} FAILURE(S)` : "\nALL PASSED"); process.exit(bad ? 1 : 0);
}

// ------------------------------------------------------------------ audio loading
function readPcm16k(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (/\.wav$/i.test(file)) {
      const b = fs.readFileSync(file);
      if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") {
        let off = 12, fmt: { fmt: number; ch: number; rate: number; bits: number } | null = null;
        while (off + 8 <= b.length) {
          const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
          if (id === "fmt ") fmt = { fmt: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
          if (id === "data" && fmt && fmt.fmt === 1 && fmt.ch === 1 && fmt.rate === 16000 && fmt.bits === 16) return resolve(b.subarray(off + 8, off + 8 + size));
          off += 8 + size + (size % 2);
        }
      }
    }
    // Anything else (or a WAV in another format): decode + resample with ffmpeg.
    const ff = spawn("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
    const chunks: Buffer[] = []; let err = "";
    ff.stdout.on("data", (d) => chunks.push(d)); ff.stderr.on("data", (d) => (err += d));
    ff.on("error", () => reject(new Error(`${path.basename(file)} is not 16 kHz mono PCM16 WAV and ffmpeg is not available to convert it`)));
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${err.trim()}`))));
  });
}

// ------------------------------------------------------------------ run one recording through the real client
interface Line { text: string; language?: string; languages?: string[]; confidence?: number; lowConfidence: boolean }
async function transcribe(pcm: Buffer, hints: string[] | undefined, speed: number): Promise<{ lines: Line[]; errors: string[]; finalLagMs: number }> {
  const { startRealtimeTranscription } = require("../../src/services/speech/realtimeTranscribe");
  const { env } = require("../../src/config/env");
  const lines: Line[] = []; const errors: string[] = [];
  let lastFinalAt = 0; const started = Date.now();
  const closed = new Promise<void>((r) => {
    const s = startRealtimeTranscription(
      (e: any) => { if (e.type === "final") { lastFinalAt = Date.now(); lines.push({ text: e.text, language: e.detectedLanguage, languages: e.languages, confidence: e.confidence, lowConfidence: e.confidence !== undefined && e.confidence < env.sttMinConfidence }); } },
      (e: Error) => errors.push(e.message), started, () => r(), undefined, hints ? { languageHints: hints } : {}
    );
    (async () => {
      const CH = 3200, t0 = Date.now(); let sent = 0;
      const audio = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 3)]); // + 3 s of silence so the last sentence is endpointed
      for (let o = 0; o < audio.length; o += CH) {
        s.sendAudioChunk(audio.subarray(o, o + CH), Date.now()); sent += 100;
        const wait = t0 + sent / speed - Date.now(); if (wait > 0) await new Promise((x) => setTimeout(x, wait));
      }
      endedAt = Date.now(); s.close();
    })();
  });
  let endedAt = 0;
  await Promise.race([closed, new Promise((r) => setTimeout(r, pcm.length / 32 / 0.5 + 60_000))]);
  return { lines, errors, finalLagMs: lastFinalAt && endedAt ? Math.max(0, lastFinalAt - endedAt) : 0 };
}

// ------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dir = arg("--dir"); if (!dir) { console.error("usage: --dir <folder> [--out file.json] [--speed 1] [--translate English]   |   --self-test"); process.exit(2); }
  const speed = Math.max(0.5, parseFloat(arg("--speed") || "1")); const translateTo = arg("--translate"); const out = arg("--out");
  const { env } = require("../../src/config/env");
  if (!env.sonioxApiKey) { console.error("SONIOX_API_KEY is not set (server/.env). This evaluation talks to the real service."); process.exit(2); }

  const names = fs.readdirSync(dir).filter((f) => /\.(wav|mp3|m4a|webm|ogg)$/i.test(f)).sort();
  if (names.length === 0) { console.error(`no audio files in ${dir}`); process.exit(2); }
  const rows: any[] = [];
  for (const f of names) {
    const base = f.replace(/\.[^.]+$/, ""); const refFile = path.join(dir, base + ".txt");
    if (!fs.existsSync(refFile)) { console.log(`skip ${f}: no ${base}.txt (the exact words spoken)`); continue; }
    const metaFile = path.join(dir, base + ".meta.json"); const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
    const parts = base.split("_"); const lang = meta.lang || parts[0]; const condition = meta.condition || parts[1] || "clean";
    const ref = fs.readFileSync(refFile, "utf8").trim();
    process.stdout.write(`${f} ... `);
    const pcm = await readPcm16k(path.join(dir, f));
    const r = await transcribe(pcm, meta.hints, speed);
    const hyp = r.lines.map((l) => l.text).join(" ");
    const w = wer(ref, hyp), c = cer(ref, hyp);
    const norm = r.lines.map((l) => normalizeForScoring(l.text));
    const langVotes = new Map<string, number>(); for (const l of r.lines) if (l.language) langVotes.set(l.language, (langVotes.get(l.language) ?? 0) + normalizeForScoring(l.text).length);
    const detected = [...langVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
    const row: any = { file: f, lang, condition, refWords: w.total, wer: w, cer: c, detected, lines: r.lines.length, dupLines: norm.filter((n, i) => i > 0 && n && n === norm[i - 1]).length, lowConf: r.lines.filter((l) => l.lowConfidence).length, finalLagMs: r.finalLagMs, errors: r.errors, reference: ref, recognised: hyp };
    if (translateTo && r.lines.length) {
      try {
        const { translateTranscriptSegments } = require("../../src/services/ai/translateSegments");
        const tr = await translateTranscriptSegments(r.lines.map((l) => ({ text: l.text, language: l.language, languages: l.languages })), translateTo);
        row.translation = r.lines.map((l, i) => ({ original: l.text, translated: tr.find((t: any) => t.index === i)?.translatedText ?? null }));
      } catch (e: any) { row.translationError = e.message; }
    }
    rows.push(row);
    console.log(`WER ${pct(w.errors, w.total)}  CER ${pct(c.errors, c.total)}  lang ${detected}  lines ${r.lines.length}${r.errors.length ? "  ERRORS: " + r.errors[0] : ""}`);
  }

  const agg = (key: "lang" | "condition") => {
    const g = new Map<string, any[]>(); for (const r of rows) g.set(r[key], [...(g.get(r[key]) ?? []), r]);
    console.log(`\n--- by ${key} ---`);
    for (const [k, rs] of [...g.entries()].sort()) {
      const we = rs.reduce((a, r) => a + r.wer.errors, 0), wt = rs.reduce((a, r) => a + r.wer.total, 0), ce = rs.reduce((a, r) => a + r.cer.errors, 0), ct = rs.reduce((a, r) => a + r.cer.total, 0);
      console.log(`${k.padEnd(12)} files ${String(rs.length).padStart(2)}  WER ${pct(we, wt).padStart(6)}  CER ${pct(ce, ct).padStart(6)}  dup lines ${rs.reduce((a, r) => a + r.dupLines, 0)}  low-conf ${rs.reduce((a, r) => a + r.lowConf, 0)}`);
    }
  };
  agg("lang"); agg("condition");
  console.log("\n--- worst files (read these: the numbers hide WHAT went wrong) ---");
  for (const r of [...rows].sort((a, b) => b.cer.errors / Math.max(1, b.cer.total) - a.cer.errors / Math.max(1, a.cer.total)).slice(0, 5)) {
    console.log(`\n${r.file}  (spoke ${r.lang}, recognised as ${r.detected})\n  SPOKEN:     ${r.reference}\n  RECOGNISED: ${r.recognised}`);
  }
  if (translateTo) {
    console.log(`\n--- translation into ${translateTo}: grade these by eye ---`);
    for (const r of rows) for (const t of r.translation ?? []) console.log(`[${r.lang}] ${t.original}\n   -> ${t.translated ?? "(no translation returned)"}`);
  }
  if (out) { fs.writeFileSync(out, JSON.stringify(rows, null, 2)); console.log(`\nfull results written to ${out}`); }
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
