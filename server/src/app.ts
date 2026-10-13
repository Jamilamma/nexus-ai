import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";

import authRoutes from "./routes/authRoutes";
import recordingRoutes from "./routes/recordingRoutes";
import aiRoutes from "./routes/aiRoutes";
import ragRoutes from "./routes/ragRoutes";
import learningRoutes from "./routes/learningRoutes";
import interviewRoutes from "./routes/interviewRoutes";
import analyticsRoutes from "./routes/analyticsRoutes";
import meetingRoutes from "./routes/meetingRoutes";

const app = express();

app.use(helmet());
app.use(cors({ origin: env.clientUrl, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use("/api", apiLimiter);

app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/recordings", recordingRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/rag", ragRoutes);
app.use("/api/learning", learningRoutes);
app.use("/api/interview", interviewRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/meetings", meetingRoutes);

app.use((_req, res) => res.status(404).json({ error: "Route not found." }));

app.use(errorHandler);

export default app;