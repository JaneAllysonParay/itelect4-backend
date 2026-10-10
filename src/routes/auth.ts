import { Router, type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import type { TokenPayload } from "../middleware/auth.js";

export interface RegisterBody {
  name: string;
  email: string;
  password: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export const authRouter = Router();

authRouter.post(
  "/register",
  async (
    req: Request<Record<string, string>, unknown, RegisterBody>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { name, password } = req.body;
      const email = req.body.email.trim().toLowerCase();
      const existingUser = await User.findOne({ email });

      if (existingUser) {
        res.status(409).json({ message: "That email is already registered" });
        return;
      }

      const user = await User.create({ name, email, password });
      res.status(201).json(user.toJSON());
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post(
  "/login",
  async (
    req: Request<Record<string, string>, unknown, LoginBody>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { password } = req.body;
      const email = req.body.email.trim().toLowerCase();
      const user = await User.findOne({ email }).select("+password");

      if (!user || !(await bcrypt.compare(password, user.password))) {
        res.status(401).json({ message: "Email or password is incorrect" });
        return;
      }

      const payload: TokenPayload = {
        userId: String(user._id),
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET!, {
        expiresIn: "2h",
      });

      res.json({
        token,
        user: user.toJSON(),
      });
    } catch (err) {
      next(err);
    }
  }
);
