import { Request, Response, NextFunction } from "express";

/** Wraps async route handlers so thrown errors reach the error middleware instead of crashing the process. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error("[error]", err.message);

  const status = err.status || 500;
  const message =
    status === 500 ? "Something went wrong on our end. Please try again." : err.message;

  res.status(status).json({ error: message });
}
