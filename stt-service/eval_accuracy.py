"""
Measure REAL accuracy on YOUR recordings (the only honest way to know how well this works for your voices).

Folder layout (default ./eval_samples):
    001.ta.wav   + 001.txt   -> recording, language code in the file name, EXACT words spoken (UTF-8)
    002.en.mp3   + 002.txt
    003.ta+en.wav + 003.txt  -> Tamil/English mix ("ta+en" = auto between the two, code-switch prompt)

Usage:   python eval_accuracy.py [folder] [http://127.0.0.1:9000]
Prints per-file WER (word error rate) and CER (character error rate; the fairer metric for Tamil/Hindi/Arabic,
where word boundaries and spelling variants inflate WER), whether the language was identified, and a summary.
Lower is better. Compare numbers across settings (model size, WHISPER_LANGUAGES, prompts) on the SAME files.
"""
import os, re, sys, unicodedata
import httpx

folder = sys.argv[1] if len(sys.argv) > 1 else "eval_samples"
base = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:9000").rstrip("/")
token = os.environ.get("WHISPER_API_TOKEN", "")


def norm(t):
    t = unicodedata.normalize("NFC", t.lower())
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", t)).strip()


def edit(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


rows = []
for f in sorted(os.listdir(folder)):
    m = re.match(r"(.+)\.([a-z]{2}(?:\+[a-z]{2})?)\.(wav|mp3|m4a|ogg|flac|webm|mp4)$", f)
    ref_file = os.path.join(folder, m.group(1) + ".txt") if m else None
    if not m or not os.path.exists(ref_file):
        continue
    lang_spec = m.group(2)
    ref = norm(open(ref_file, encoding="utf-8").read())
    langs = lang_spec.split("+")
    data = {"language": langs[0]} if len(langs) == 1 else {"candidates": ",".join(langs)}
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with open(os.path.join(folder, f), "rb") as fh:
        r = httpx.post(f"{base}/transcribe-file", files={"file": (f, fh)}, data=data, headers=headers, timeout=3600)
    r.raise_for_status()
    j = r.json()
    hyp = norm(" ".join(s["text"] for s in j["segments"]))
    wer = edit(ref.split(), hyp.split()) / max(1, len(ref.split()))
    cer = edit(ref.replace(" ", ""), hyp.replace(" ", "")) / max(1, len(ref.replace(" ", "")))
    lang_ok = j["language"] == langs[0] if len(langs) == 1 else j["language"] in langs
    rows.append((f, wer, cer, lang_ok, j["processing_ms"]))
    print(f"{f:32s} WER {wer:6.1%}  CER {cer:6.1%}  lang={j['language']}{'' if lang_ok else ' (WRONG)'}  {j['processing_ms']} ms")
    print(f"   ref: {ref[:110]}\n   hyp: {hyp[:110]}")

if rows:
    n = len(rows)
    print(f"\n{n} file(s): mean WER {sum(r[1] for r in rows)/n:.1%}, mean CER {sum(r[2] for r in rows)/n:.1%}, language correct {sum(r[3] for r in rows)}/{n}")
else:
    print("No samples found. See the layout at the top of this file.")
