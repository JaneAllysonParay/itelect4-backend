import bcrypt from "bcryptjs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
}));

vi.mock("../src/config/db.js", () => ({
  connectDB: mocks.connectDB,
}));

import { app } from "../src/app.js";
import { Claim } from "../src/models/Claim.js";
import { Item } from "../src/models/Item.js";
import { User } from "../src/models/User.js";

describe("authentication endpoint rate limits", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
    process.env.JWT_SECRET = "auth-rate-limit-test-secret";
  });

  it("limits registration and login independently without trusting forwarded IP headers", async () => {
    const findUser = vi.spyOn(User, "findOne");
    const createUser = vi.spyOn(User, "create").mockResolvedValue(
      { toJSON: () => ({ id: "student-1", role: "student" }) } as never,
    );

    const invalidRegistration = await request(app)
      .post("/api/auth/register")
      .send({ name: "", email: "bad", password: "short" });
    expect(invalidRegistration.status).toBe(400);

    findUser.mockResolvedValueOnce(null as never);
    const successfulRegistration = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Jamie Student",
        email: "jamie@example.invalid",
        password: "safe-password",
      });
    expect(successfulRegistration.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith({
      name: "Jamie Student",
      email: "jamie@example.invalid",
      password: "safe-password",
    });

    findUser.mockResolvedValue({ _id: "student-1" } as never);
    const duplicateRegistration = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Jamie Student",
        email: "jamie@example.invalid",
        password: "safe-password",
      });
    expect(duplicateRegistration.status).toBe(409);

    for (let attempt = 4; attempt <= 5; attempt += 1) {
      const repeatedRegistration = await request(app)
        .post("/api/auth/register")
        .send({
          name: "Jamie Student",
          email: "jamie@example.invalid",
          password: "safe-password",
        });
      expect(repeatedRegistration.status).toBe(409);
    }

    const limitedRegistration = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Jamie Student",
        email: "jamie@example.invalid",
        password: "safe-password",
      });
    expect(limitedRegistration.status).toBe(429);
    expect(limitedRegistration.body.message).toBe(
      "Too many authentication attempts. Please try again later.",
    );

    const passwordHash = await bcrypt.hash("correct-password", 4);
    const loginUser = {
      _id: "student-1",
      isActive: true,
      password: passwordHash,
      role: "student",
      toJSON: () => ({ id: "student-1", role: "student" }),
    };
    findUser.mockReturnValueOnce(
      { select: vi.fn().mockResolvedValue(loginUser) } as never,
    );

    const successfulLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "jamie@example.invalid", password: "correct-password" });
    expect(successfulLogin.status).toBe(200);
    expect(successfulLogin.body.token).toEqual(expect.any(String));

    findUser.mockReturnValue(
      { select: vi.fn().mockResolvedValue(null) } as never,
    );
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const failedLogin = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", `198.51.100.${attempt}`)
        .send({ email: "jamie@example.invalid", password: "wrong-password" });
      expect(failedLogin.status).toBe(401);
    }

    const limitedLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "jamie@example.invalid", password: "wrong-password" });
    expect(limitedLogin.status).toBe(429);
    expect(limitedLogin.body.message).toBe(
      "Too many authentication attempts. Please try again later.",
    );

    const spoofedIpLogin = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.77")
      .send({ email: "jamie@example.invalid", password: "wrong-password" });
    expect(spoofedIpLogin.status).toBe(429);

    const itemQuery = { sort: vi.fn().mockResolvedValue([]) };
    vi.spyOn(Item, "find").mockReturnValue(itemQuery as never);
    const itemRequest = await request(app).get("/api/items");
    expect(itemRequest.status).toBe(200);

    const activeUserQuery = {
      select: vi.fn().mockResolvedValue({
        _id: "student-1",
        isActive: true,
        role: "student",
      }),
    };
    vi.spyOn(User, "findById").mockReturnValue(activeUserQuery as never);
    const claimQuery = { sort: vi.fn().mockResolvedValue([]) };
    vi.spyOn(Claim, "find").mockReturnValue(claimQuery as never);
    const claimRequest = await request(app)
      .get("/api/claims")
      .set("Authorization", `Bearer ${successfulLogin.body.token}`);
    expect(claimRequest.status).toBe(200);
  });
});
