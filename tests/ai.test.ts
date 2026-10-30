import "dotenv/config";
import { ApiError } from "@google/genai";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
  reviewItemReport: vi.fn(),
}));

vi.mock("../src/config/db.js", () => ({
  connectDB: mocks.connectDB,
}));

vi.mock("../src/ai/gemini.js", () => ({
  AiReplyError: class AiReplyError extends Error {},
  reviewItemReport: mocks.reviewItemReport,
}));

import { app } from "../src/app.js";

function tokenFor(userId: string): string {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, {
    expiresIn: "5m",
  });
}

describe("POST /api/ai authentication", () => {
  beforeEach(() => {
    mocks.connectDB.mockClear();
    mocks.reviewItemReport.mockReset();
  });

  it("answers 401 when there is no token", async () => {
    const response = await request(app)
      .post("/api/ai")
      .send({ prompt: "A blue tumbler was lost near the library." });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe(
      "No token. Send Authorization: Bearer <token>",
    );
    expect(mocks.connectDB).toHaveBeenCalledTimes(1);
  });

  it("answers 401 when the token was signed with another secret", async () => {
    const forgedToken = jwt.sign({ userId: "someone" }, "not-the-secret");

    const response = await request(app)
      .post("/api/ai")
      .set("Authorization", "Bearer " + forgedToken)
      .send({ prompt: "A blue tumbler was lost near the library." });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe("Token is invalid or has expired");
  });

  it("lets a valid token through, then validates the item-report body", async () => {
    const token = tokenFor("test-user");

    const response = await request(app)
      .post("/api/ai")
      .set("Authorization", "Bearer " + token)
      .send({ prompt: "Too short" });

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([
      "Describe the item report in at least 20 characters.",
    ]);
  });

  it("returns a friendly 503 when Gemini is temporarily unavailable", async () => {
    const upstreamError = Object.assign(
      Object.create(ApiError.prototype) as ApiError,
      { status: 503, message: "provider stack detail" },
    );
    mocks.reviewItemReport.mockRejectedValueOnce(upstreamError);

    const response = await request(app)
      .post("/api/ai")
      .set("Authorization", `Bearer ${tokenFor("test-user")}`)
      .send({ prompt: "A blue water bottle was lost near the library." });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message:
        "The AI service is temporarily unavailable. Please try again shortly.",
    });
    expect(JSON.stringify(response.body)).not.toContain("provider stack detail");
  });
});
