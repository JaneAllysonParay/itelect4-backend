import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import type { UserRole } from "../types/index.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: UserRole;
    }
  }
}

export interface TokenPayload {
  userId: string;
}

function isTokenPayload(payload: unknown): payload is TokenPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "userId" in payload &&
    typeof payload.userId === "string" &&
    payload.userId.length > 0
  );
}

export const requireAuth: RequestHandler<any, any, any, any> = async (
  req,
  res,
  next,
): Promise<void> => {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      message: "No token. Send Authorization: Bearer <token>",
    });
    return;
  }

  const token = authorization.slice("Bearer ".length);

  let payload: unknown;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!);
  } catch {
    res.status(401).json({
      message: "Token is invalid or has expired",
    });
    return;
  }

  if (!isTokenPayload(payload)) {
    res.status(401).json({
      message: "Token is invalid or has expired",
    });
    return;
  }

  try {
    const user = await User.findById(payload.userId).select("_id role isActive");
    if (!user) {
      res.status(401).json({ message: "Account is unavailable" });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({ message: "This account is inactive" });
      return;
    }

    req.userId = String(user._id);
    req.userRole = user.role;
    next();
  } catch (err) {
    next(err);
  }
};

export function requireRole(
  ...allowedRoles: UserRole[]
): RequestHandler<any, any, any, any> {
  return (req, res, next): void => {
    if (!req.userRole || !allowedRoles.includes(req.userRole)) {
      res.status(403).json({ message: "You are not allowed to perform this action" });
      return;
    }

    next();
  };
}
