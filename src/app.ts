import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import mongoose from "mongoose";
import { connectDB } from "./config/db.js";
import { authRouter } from "./routes/auth.js";
import { claimRouter } from "./routes/claims.js";
import { aiRouter } from "./routes/ai.js";
import { itemRouter } from "./routes/items.js";

export const app = express();

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

app.use(async (_req, _res, next) => {
  await connectDB();
  next();
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    db: mongoose.connection.readyState === 1,
  });
});

app.use("/api/auth", authRouter);
app.use("/api/items", itemRouter);
app.use("/api/claims", claimRouter);
app.use("/api/ai", aiRouter);

app.use((req: Request, res: Response) => {
  res.status(404).json({
    message: "No route for " + req.method + " " + req.originalUrl,
  });
});

app.use(
  (
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
  ): void => {
    if (err instanceof mongoose.Error.ValidationError) {
      res.status(400).json({
        message: "Validation failed",
        errors: Object.values(err.errors).map((error) => error.message),
      });
      return;
    }

    if (err instanceof mongoose.Error.CastError) {
      res.status(400).json({
        message: '"' + String(err.value) + '" is not a valid id',
      });
      return;
    }

    console.error(err);
    res.status(500).json({ message: "Something went wrong" });
  }
);

export default app;
