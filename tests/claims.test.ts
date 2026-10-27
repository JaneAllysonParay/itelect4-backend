import "dotenv/config";
import jwt from "jsonwebtoken";
import mongoose, { type ClientSession } from "mongoose";
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

function tokenFor(userId: string): string {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: "5m" });
}

describe("PATCH /api/claims/:id/status", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("requires authentication", async () => {
    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .send({ status: "approved" });

    expect(response.status).toBe(401);
  });

  it("does not let a non-owner decide a claim for someone else's item", async () => {
    vi.spyOn(Claim, "findById").mockResolvedValue(
      { itemId: "item-1", status: "pending" } as never,
    );
    vi.spyOn(Item, "findById").mockResolvedValue(
      { ownerId: "owner-1" } as never,
    );
    const sessionSpy = vi.spyOn(mongoose, "startSession");

    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .set("Authorization", `Bearer ${tokenFor("someone-else")}`)
      .send({ status: "approved" });

    expect(response.status).toBe(403);
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("lets the item owner approve a pending claim and marks the item claimed", async () => {
    vi.spyOn(Claim, "findById").mockResolvedValue(
      { itemId: "item-1", status: "pending" } as never,
    );
    vi.spyOn(Item, "findById").mockResolvedValue(
      { ownerId: "owner-1" } as never,
    );

    const session = {
      withTransaction: vi.fn(
        async (operation: () => Promise<void>) => operation(),
      ),
      endSession: vi.fn(async () => undefined),
    } as unknown as ClientSession;
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateClaim = vi
      .spyOn(Claim, "findOneAndUpdate")
      .mockResolvedValue({ id: "claim-1", status: "approved" } as never);
    const updateItem = vi
      .spyOn(Item, "findOneAndUpdate")
      .mockResolvedValue({ id: "item-1", status: "claimed" } as never);

    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ status: "approved" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("approved");
    expect(updateClaim).toHaveBeenCalledWith(
      { _id: "claim-1", status: "pending" },
      { $set: { status: "approved" } },
      expect.objectContaining({ session, runValidators: true }),
    );
    expect(updateItem).toHaveBeenCalledWith(
      {
        _id: "item-1",
        ownerId: "owner-1",
        status: { $ne: "claimed" },
      },
      { $set: { status: "claimed" } },
      expect.objectContaining({ session, runValidators: true }),
    );
    expect(session.endSession).toHaveBeenCalledOnce();
  });
});
