import React from "react";
import { RecordingStatus } from "../types";

const STATUS_STYLES: Record<RecordingStatus, string> = {
  uploaded: "bg-slate-500/20 text-slate-300",
  transcribing: "bg-amber-500/20 text-amber-300",
  transcribed: "bg-amber-500/20 text-amber-300",
  analyzing: "bg-amber-500/20 text-amber-300",
  ready: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-red-500/20 text-red-300",
};

const STATUS_LABELS: Record<RecordingStatus, string> = {
  uploaded: "Uploaded",
  transcribing: "Transcribing…",
  transcribed: "Transcribed",
  analyzing: "Analyzing…",
  ready: "Ready",
  failed: "Failed",
};

export default function StatusBadge({ status }: { status: RecordingStatus }) {
  return <span className={`badge ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>;
}
