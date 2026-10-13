import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { uploadMiddleware } from "../services/storage/localStorage";
import {
  createRecording,
  listRecordings,
  getRecording,
  deleteRecording,
} from "../controllers/recordingController";

const router = Router();

router.use(requireAuth);

router.post("/", uploadMiddleware.single("file"), asyncHandler(createRecording));
router.get("/", asyncHandler(listRecordings));
router.get("/:id", asyncHandler(getRecording));
router.delete("/:id", asyncHandler(deleteRecording));

export default router;
