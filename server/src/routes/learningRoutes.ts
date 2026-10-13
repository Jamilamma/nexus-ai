import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { generateLearningContent, getLearningContent } from "../controllers/learningController";

const router = Router();
router.use(requireAuth);

router.post("/generate", asyncHandler(generateLearningContent));
router.get("/:recordingId", asyncHandler(getLearningContent));

export default router;
