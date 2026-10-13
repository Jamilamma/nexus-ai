import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { createMeeting, getMeetingPreview, listMyMeetings, getMeetingReport, deleteMeeting, getMeetingToken, getMeetingTranscript } from "../controllers/meetingController";

const router = Router();
router.use(requireAuth);

router.post("/", asyncHandler(createMeeting));
router.get("/", asyncHandler(listMyMeetings));
router.get("/:id/preview", asyncHandler(getMeetingPreview));
router.post("/:id/token", asyncHandler(getMeetingToken));
router.get("/:id/transcript", asyncHandler(getMeetingTranscript));
router.get("/:id/report", asyncHandler(getMeetingReport));
router.delete("/:id", asyncHandler(deleteMeeting));

export default router;
