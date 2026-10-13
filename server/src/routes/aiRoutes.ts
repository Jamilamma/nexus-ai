import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { rewrite, translate } from "../controllers/aiController";

const router = Router();
router.use(requireAuth);

router.post("/rewrite", asyncHandler(rewrite));
router.post("/translate", asyncHandler(translate));

export default router;
