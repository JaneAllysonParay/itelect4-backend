import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
}));

vi.mock("../src/config/db.js", () => ({
  connectDB: mocks.connectDB,
}));

import { app } from "../src/app.js";
import { User } from "../src/models/User.js";

describe("authentication request validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("rejects invalid registration fields before querying the database", async () => {
    const findUser = vi.spyOn(User, "findOne");

    const response = await request(app).post("/api/auth/register").send({
      name: "  ",
      email: "not-an-email",
      password: "short",
    });

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([
      "Enter a valid email address.",
      "At least 8 characters.",
      "Enter your name.",
    ]);
    expect(findUser).not.toHaveBeenCalled();
  });

  it("rejects invalid login fields before querying the database", async () => {
    const findUser = vi.spyOn(User, "findOne");

    const response = await request(app).post("/api/auth/login").send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Validation failed");
    expect(findUser).not.toHaveBeenCalled();
  });
});
