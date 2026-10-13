import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import { Types } from "mongoose";

export interface AuthedRequest extends Request {
  userId?: Types.ObjectId;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = verifyToken(token);
    req.userId = new Types.ObjectId(payload.userId);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}
