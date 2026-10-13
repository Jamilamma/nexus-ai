import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { queryRecording } from "../controllers/ragController";

const router = Router();
router.use(requireAuth);

router.post("/query", asyncHandler(queryRecording));

export default router;
