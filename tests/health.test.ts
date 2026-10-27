import request from "supertest";
import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
}));

vi.mock("../src/config/db.js", () => ({
  connectDB: mocks.connectDB,
}));

import { app } from "../src/app.js";

describe("GET /api/health", () => {
  it("reports the API and database as healthy when the connection succeeds", async () => {
    mocks.connectDB.mockResolvedValueOnce(undefined);
    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, db: true });
  });

  it("returns a deliberate unavailable response when the database connection fails", async () => {
    mocks.connectDB.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: true, db: false });
  });
});
