import { Response } from "express";
import { AuthedRequest } from "../middleware/auth";
import { Recording } from "../models/Recording";
import { Interview } from "../models/Interview";
import { Summary } from "../models/Summary";

export async function getDashboardStats(req: AuthedRequest, res: Response) {
  const userId = req.userId;

  const [totalRecordings, recordingsByType, interviews, summaries, recentRecordings] = await Promise.all([
    Recording.countDocuments({ userId }),
    Recording.aggregate([
      { $match: { userId } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
    ]),
    Interview.find({ userId }).select("overallScore status createdAt"),
    Summary.find({ userId }).select("actionItems topics"),
    Recording.find({ userId }).sort({ createdAt: -1 }).limit(5),
  ]);

  const totalActionItems = summaries.reduce((s, doc) => s + (doc.actionItems?.length || 0), 0);
  const completedInterviews = interviews.filter((i) => i.status === "completed");
  const avgInterviewScore =
    completedInterviews.length > 0
      ? completedInterviews.reduce((s, i) => s + (i.overallScore || 0), 0) / completedInterviews.length
      : null;

  const topicCounts: Record<string, number> = {};
  for (const s of summaries) {
    for (const topic of s.topics || []) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
  }
  const topTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([topic, count]) => ({ topic, count }));

  res.json({
    totalRecordings,
    recordingsByType,
    totalInterviews: interviews.length,
    completedInterviews: completedInterviews.length,
    avgInterviewScore,
    totalActionItems,
    topTopics,
    recentRecordings,
  });
}
