import fs from "fs";
import path from "path";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { env } from "../../config/env";

/**
 * Local-disk storage implementation. Swappable: implement the same
 * interface (save/getPath/delete) against S3/Supabase/Firebase for
 * production, and only this file changes — recording metadata (fileUrl)
 * stays provider-agnostic.
 */

const uploadDir = path.resolve(process.cwd(), env.uploadDir);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_MIME = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/m4a",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "text/plain",
];

const storageEngine = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${uuid()}${ext}`);
  },
});

export const uploadMiddleware = multer({
  storage: storageEngine,
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

export function getStoredFilePath(fileUrl: string): string {
  return path.join(uploadDir, path.basename(fileUrl));
}

export function deleteStoredFile(fileUrl: string): void {
  const filePath = getStoredFilePath(fileUrl);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
