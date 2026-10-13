import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { getDashboardStats } from "../controllers/analyticsController";

const router = Router();
router.use(requireAuth);

router.get("/dashboard", asyncHandler(getDashboardStats));

export default router;
