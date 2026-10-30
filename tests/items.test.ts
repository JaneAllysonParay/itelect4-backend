import "dotenv/config";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
}));

vi.mock("../src/config/db.js", () => ({
  connectDB: mocks.connectDB,
}));

import { app } from "../src/app.js";
import { Item } from "../src/models/Item.js";

function tokenFor(userId: string): string {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: "5m" });
}

describe("POST /api/items", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("uses the authenticated owner and ignores client-controlled fields", async () => {
    const createItem = vi.spyOn(Item, "create").mockResolvedValue(
      {
        id: "item-1",
        title: "Blue tumbler",
        description: "Blue insulated tumbler",
        location: "Library",
        status: "found",
        ownerId: "owner-from-token",
      } as never,
    );

    const response = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("owner-from-token")}`)
      .send({
        title: "Blue tumbler",
        description: "Blue insulated tumbler",
        location: "Library",
        status: "found",
        ownerId: "someone-else",
        dateReported: "2000-01-01T00:00:00.000Z",
      });

    expect(response.status).toBe(201);
    expect(createItem).toHaveBeenCalledWith({
      title: "Blue tumbler",
      description: "Blue insulated tumbler",
      location: "Library",
      status: "found",
      ownerId: "owner-from-token",
    });
  });
});
