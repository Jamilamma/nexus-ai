import React from "react";
import { LiveInsightState } from "../../types";

export default function LiveInsights({ insights }: { insights: LiveInsightState | null }) {
  if (!insights) {
    return (
      <div className="card p-4 h-full">
        <h3 className="font-medium mb-3 text-sm text-slate-400 uppercase tracking-wide">AI Insights</h3>
        <p className="text-sm text-slate-600">Insights will appear once there's enough conversation to analyze.</p>
      </div>
    );
  }

  return (
    <div className="card p-4 h-full overflow-y-auto space-y-4">
      <h3 className="font-medium text-sm text-slate-400 uppercase tracking-wide">AI Insights</h3>

      {insights.currentTopic && (
        <div>
          <div className="text-xs text-slate-500 mb-1">Current topic</div>
          <div className="text-sm font-medium text-brand-400">{insights.currentTopic}</div>
        </div>
      )}

      <InsightSection title="Key points" items={insights.keyPoints} />
      <InsightSection title="Decisions" items={insights.decisions} />

      {insights.actionItems.length > 0 && (
        <div>
          <div className="text-xs text-slate-500 mb-1.5">Action items</div>
          <div className="space-y-1.5">
            {insights.actionItems.map((a, i) => (
              <div key={i} className="text-sm bg-white/5 rounded-lg p-2">
                <div className="text-slate-200">{a.task}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {a.owner} · {a.deadline}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <InsightSection title="Questions" items={insights.questions} />
      <InsightSection title="Risks" items={insights.risks} />
      <InsightSection title="Important dates" items={insights.importantDates} />
    </div>
  );
}

function InsightSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-xs text-slate-500 mb-1.5">{title}</div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-sm text-slate-300">
            • {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
