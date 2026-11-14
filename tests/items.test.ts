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
import { mockAuthenticatedUser } from "./authHelpers.js";

function tokenFor(userId: string): string {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: "5m" });
}

function transactionSession(): ClientSession {
  return {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn(async () => undefined),
  } as unknown as ClientSession;
}

describe("POST /api/items", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("uses the authenticated owner and ignores client-controlled fields", async () => {
    mockAuthenticatedUser("owner-from-token");
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

  it("rejects creating an item directly as claimed", async () => {
    mockAuthenticatedUser("owner-1");
    const createItem = vi.spyOn(Item, "create");

    const response = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ status: "claimed" });

    expect(response.status).toBe(400);
    expect(createItem).not.toHaveBeenCalled();
  });

  it("rejects direct updates to the claimed status", async () => {
    mockAuthenticatedUser("owner-1");
    const updateItem = vi.spyOn(Item, "findOneAndUpdate");

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ status: "claimed" });

    expect(response.status).toBe(400);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("returns a conflict when an owner tries to reopen an item that has been claimed", async () => {
    mockAuthenticatedUser("owner-1");
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(
      null,
    );
    vi.spyOn(Item, "findOne").mockResolvedValue(
      { status: "claimed", archivedAt: null } as never,
    );

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ status: "found" });

    expect(response.status).toBe(409);
    expect(updateItem).toHaveBeenCalledWith(
      {
        _id: "item-1",
        ownerId: "owner-1",
        archivedAt: null,
        status: { $ne: "claimed" },
      },
      { status: "found" },
      expect.objectContaining({ runValidators: true }),
    );
  });

  it.each([
    ["title", { title: "Updated tumbler" }],
    ["description", { description: "Updated blue tumbler description" }],
    ["location", { location: "Updated library location" }],
    ["status", { status: "found" }],
    ["mixed fields", { title: "Updated tumbler", location: "Library", status: "lost" }],
  ] as const)("keeps a claimed item read-only for %s PATCH bodies", async (_field, body) => {
    mockAuthenticatedUser("owner-1");
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);
    const findOwnedItem = vi.spyOn(Item, "findOne").mockResolvedValue(
      { status: "claimed", archivedAt: null } as never,
    );

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send(body);

    expect(response.status).toBe(409);
    expect(response.body.message).toBe("Claimed items cannot be edited");
    expect(updateItem).toHaveBeenCalledWith(
      {
        _id: "item-1",
        ownerId: "owner-1",
        archivedAt: null,
        status: { $ne: "claimed" },
      },
      body,
      expect.objectContaining({ runValidators: true }),
    );
    expect(findOwnedItem).toHaveBeenCalledWith({
      _id: "item-1",
      ownerId: "owner-1",
    });
  });

  it("allows the owner to update an unclaimed item", async () => {
    mockAuthenticatedUser("owner-1");
    const updatedItem = { id: "item-1", status: "found", title: "Updated tumbler" };
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(
      updatedItem as never,
    );

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ title: "Updated tumbler" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "item-1", title: "Updated tumbler" });
    expect(updateItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $ne: "claimed" } }),
      { title: "Updated tumbler" },
      expect.objectContaining({ runValidators: true }),
    );
  });

  it("does not reveal a claimed item's status to a non-owner", async () => {
    mockAuthenticatedUser("another-user");
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);
    const findOwnedItem = vi.spyOn(Item, "findOne").mockResolvedValue(null);

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("another-user")}`)
      .send({ title: "Attempted edit" });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("No item with that id");
    expect(updateItem).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "another-user", status: { $ne: "claimed" } }),
      { title: "Attempted edit" },
      expect.any(Object),
    );
    expect(findOwnedItem).toHaveBeenCalledWith({
      _id: "item-1",
      ownerId: "another-user",
    });
  });

  it("does not allow an owner to edit an archived item", async () => {
    mockAuthenticatedUser("owner-1");
    vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);
    vi.spyOn(Item, "findOne").mockResolvedValue(
      { status: "found", archivedAt: new Date() } as never,
    );

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ title: "Attempted edit" });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("No item with that id");
  });

  it("archives an owned item only when it has no pending or approved claims", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const archiveItem = vi
      .spyOn(Item, "findOneAndUpdate")
      .mockResolvedValueOnce({ id: "item-1" } as never)
      .mockResolvedValueOnce({ id: "item-1", archivedAt: new Date() } as never);
    const activeClaimQuery = {
      session: vi.fn().mockResolvedValue(null),
    };
    const findClaim = vi.spyOn(Claim, "findOne").mockReturnValue(activeClaimQuery as never);
    const deleteItem = vi.spyOn(Item, "findOneAndDelete");

    const response = await request(app)
      .delete("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

    expect(response.status).toBe(204);
    expect(archiveItem).toHaveBeenCalledWith(
      { _id: "item-1", ownerId: "owner-1", archivedAt: null },
      { $inc: { claimRevision: 1 } },
      expect.objectContaining({ runValidators: true, session }),
    );
    expect(archiveItem).toHaveBeenNthCalledWith(
      2,
      { _id: "item-1", ownerId: "owner-1", archivedAt: null },
      { $set: { archivedAt: expect.any(Date) } },
      expect.objectContaining({ runValidators: true, session }),
    );
    expect(findClaim).toHaveBeenCalledWith({
      itemId: "item-1",
      status: { $in: ["pending", "approved"] },
    });
    expect(activeClaimQuery.session).toHaveBeenCalledWith(session);
    expect(deleteItem).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it.each(["pending", "approved"] as const)(
    "blocks archival when an active %s claim exists and rolls back the item lock",
    async (activeStatus) => {
      mockAuthenticatedUser("owner-1");
      const session = transactionSession();
      vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
      const lockItem = vi
        .spyOn(Item, "findOneAndUpdate")
        .mockResolvedValue({ id: "item-1" } as never);
      const activeClaimQuery = {
        session: vi
          .fn()
          .mockResolvedValue({ id: "claim-1", status: activeStatus }),
      };
      vi.spyOn(Claim, "findOne").mockReturnValue(activeClaimQuery as never);

      const response = await request(app)
        .delete("/api/items/item-1")
        .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

      expect(response.status).toBe(409);
      expect(lockItem).toHaveBeenCalledOnce();
      expect(lockItem).toHaveBeenCalledWith(
        expect.any(Object),
        { $inc: { claimRevision: 1 } },
        expect.objectContaining({ session }),
      );
      expect(session.endSession).toHaveBeenCalledOnce();
    },
  );

  it("returns 204 for an already archived owned item without mutating it again", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);
    const archivedItem = { archivedAt: new Date("2026-11-13T00:00:00.000Z") };
    const existingItemQuery = {
      session: vi.fn().mockResolvedValue(archivedItem),
    };
    const findOwnedItem = vi.spyOn(Item, "findOne").mockReturnValue(existingItemQuery as never);
    const findClaim = vi.spyOn(Claim, "findOne");

    const response = await request(app)
      .delete("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

    expect(response.status).toBe(204);
    expect(updateItem).toHaveBeenCalledOnce();
    expect(findOwnedItem).toHaveBeenCalledWith({ _id: "item-1", ownerId: "owner-1" });
    expect(existingItemQuery.session).toHaveBeenCalledWith(session);
    expect(findClaim).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });
});

describe("public item visibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("hides archived item reports from the public listing", async () => {
    const query = { sort: vi.fn().mockResolvedValue([{ id: "visible-item" }]) };
    const findItems = vi.spyOn(Item, "find").mockReturnValue(query as never);

    const response = await request(app).get("/api/items");

    expect(response.status).toBe(200);
    expect(findItems).toHaveBeenCalledWith({ archivedAt: null });
  });

  it("keeps claimed item reports readable", async () => {
    const claimedItem = { id: "claimed-item", title: "Claimed item", status: "claimed" };
    const findItem = vi.spyOn(Item, "findOne").mockResolvedValue(claimedItem as never);

    const response = await request(app).get("/api/items/claimed-item");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "claimed-item", status: "claimed" });
    expect(findItem).toHaveBeenCalledWith({ _id: "claimed-item", archivedAt: null });
  });
});
