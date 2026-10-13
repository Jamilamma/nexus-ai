import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import {
  startInterview,
  submitAnswer,
  finishInterview,
  getInterview,
  listInterviews,
} from "../controllers/interviewController";

const router = Router();
router.use(requireAuth);

router.post("/start", asyncHandler(startInterview));
router.post("/answer", asyncHandler(submitAnswer));
router.post("/finish", asyncHandler(finishInterview));
router.get("/", asyncHandler(listInterviews));
router.get("/:id", asyncHandler(getInterview));

export default router;
