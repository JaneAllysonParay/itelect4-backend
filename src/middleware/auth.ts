import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export interface TokenPayload {
  userId: string;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      message: "No token. Send Authorization: Bearer <token>",
    });
    return;
  }

  const token = authorization.slice("Bearer ".length);

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET!
    ) as TokenPayload;
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({
      message: "Token is invalid or has expired",
    });
  }
}
