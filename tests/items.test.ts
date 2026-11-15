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

function sessionQuery<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) };
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
        custodyStatus: "finder_reported",
        eventAt: "2026-11-13T08:00:00.000Z",
        ownerId: "someone-else",
        dateReported: "2000-01-01T00:00:00.000Z",
      });

    expect(response.status).toBe(201);
    expect(createItem).toHaveBeenCalledWith(expect.objectContaining({
      title: "Blue tumbler",
      description: "Blue insulated tumbler",
      location: "Library",
      status: "found",
      reportType: "found",
      lifecycleStatus: "open",
      custodyStatus: "finder_reported",
      eventAt: new Date("2026-11-13T08:00:00.000Z"),
      dateReported: expect.any(Date),
      ownerId: "owner-from-token",
    }));
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
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateItem = vi.spyOn(Item, "findOneAndUpdate");
    const findItem = vi.spyOn(Item, "findOne")
      .mockReturnValueOnce(sessionQuery(null) as never)
      .mockReturnValueOnce(sessionQuery({ status: "claimed", lifecycleStatus: "reserved", archivedAt: null }) as never);

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ title: "Updated tumbler" });

    expect(response.status).toBe(409);
    expect(updateItem).not.toHaveBeenCalled();
    expect(findItem).toHaveBeenCalledTimes(2);
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["title", { title: "Updated tumbler" }],
    ["description", { description: "Updated blue tumbler description" }],
    ["location", { location: "Updated library location" }],
    ["event time", { eventAt: "2026-11-13T08:00:00.000Z" }],
    ["mixed fields", { title: "Updated tumbler", location: "Library", eventAt: "2026-11-13T08:00:00.000Z" }],
  ] as const)("keeps a claimed item read-only for %s PATCH bodies", async (_field, body) => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateItem = vi.spyOn(Item, "findOneAndUpdate");
    const findOwnedItem = vi.spyOn(Item, "findOne")
      .mockReturnValueOnce(sessionQuery(null) as never)
      .mockReturnValueOnce(sessionQuery({ status: "claimed", lifecycleStatus: "reserved", archivedAt: null }) as never);

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send(body);

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/editing/i);
    expect(updateItem).not.toHaveBeenCalled();
    expect(findOwnedItem).toHaveBeenCalledWith({
      _id: "item-1",
      ownerId: "owner-1",
    });
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("allows the owner to update an unclaimed item", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const openItem = { id: "item-1", _id: "item-1", status: "found", reportType: "found", lifecycleStatus: "open", title: "Blue tumbler", ownerId: "owner-1", archivedAt: null };
    vi.spyOn(Item, "findOne").mockReturnValueOnce(sessionQuery(openItem) as never);
    vi.spyOn(Claim, "findOne").mockReturnValue(sessionQuery(null) as never);
    const updatedItem = { id: "item-1", status: "found", reportType: "found", lifecycleStatus: "open", title: "Updated tumbler", ownerId: "owner-1" };
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
      expect.any(Object),
      { $set: { title: "Updated tumbler" }, $inc: { claimRevision: 1 } },
      expect.objectContaining({ runValidators: true, session }),
    );
  });

  it("does not reveal a claimed item's status to a non-owner", async () => {
    mockAuthenticatedUser("another-user");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateItem = vi.spyOn(Item, "findOneAndUpdate");
    const findOwnedItem = vi.spyOn(Item, "findOne")
      .mockReturnValueOnce(sessionQuery(null) as never)
      .mockReturnValueOnce(sessionQuery(null) as never);

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("another-user")}`)
      .send({ title: "Attempted edit" });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("No item with that id");
    expect(updateItem).not.toHaveBeenCalled();
    expect(findOwnedItem).toHaveBeenCalledWith({
      _id: "item-1",
      ownerId: "another-user",
    });
  });

  it("does not allow an owner to edit an archived item", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    vi.spyOn(Item, "findOneAndUpdate");
    vi.spyOn(Item, "findOne")
      .mockReturnValueOnce(sessionQuery(null) as never)
      .mockReturnValueOnce(sessionQuery({ status: "found", archivedAt: new Date() }) as never);

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ title: "Attempted edit" });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/editing/i);
  });

  it("archives an owned item only when it has no pending or approved claims", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const archiveItem = vi
      .spyOn(Item, "findOneAndUpdate")
      .mockResolvedValueOnce({ id: "item-1", reportType: "found", lifecycleStatus: "open", status: "found" } as never)
      .mockResolvedValueOnce({ id: "item-1", archivedAt: new Date() } as never);
    const pendingClaimQuery = { session: vi.fn().mockResolvedValue(null) };
    const approvedClaimQuery = { session: vi.fn().mockResolvedValue(null) };
    const findActiveClaims = vi.spyOn(Claim, "exists")
      .mockReturnValueOnce(pendingClaimQuery as never)
      .mockReturnValueOnce(approvedClaimQuery as never);
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
    expect(findActiveClaims).toHaveBeenNthCalledWith(1, { itemId: "item-1", status: "pending" });
    expect(findActiveClaims).toHaveBeenNthCalledWith(2, { itemId: "item-1", status: "approved" });
    expect(pendingClaimQuery.session).toHaveBeenCalledWith(session);
    expect(approvedClaimQuery.session).toHaveBeenCalledWith(session);
    expect(deleteItem).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it.each(["pending", "approved"] as const)(
    "blocks archival when an active %s claim exists and rolls back the item lock",
    async (activeStatus) => {
      mockAuthenticatedUser("owner-1");
      const session = transactionSession();
      vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
      const itemToArchive = { id: "item-1", reportType: "found", lifecycleStatus: "open", status: "found" };
      const lockItem = vi
        .spyOn(Item, "findOneAndUpdate")
        .mockResolvedValue(itemToArchive as never);
      const pendingClaimQuery = { session: vi.fn().mockResolvedValue(activeStatus === "pending" ? { _id: "claim-pending" } : null) };
      const approvedClaimQuery = { session: vi.fn().mockResolvedValue(activeStatus === "approved" ? { _id: "claim-approved" } : null) };
      const findActiveClaims = vi.spyOn(Claim, "exists")
        .mockReturnValueOnce(pendingClaimQuery as never)
        .mockReturnValueOnce(approvedClaimQuery as never);

      const response = await request(app)
        .delete("/api/items/item-1")
        .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

      expect(response.status).toBe(409);
      expect(lockItem).toHaveBeenCalledOnce();
      expect(findActiveClaims).toHaveBeenCalledTimes(activeStatus === "pending" ? 1 : 2);
      expect(lockItem).toHaveBeenCalledWith(
        expect.any(Object),
        { $inc: { claimRevision: 1 } },
        expect.objectContaining({ session }),
      );
      expect(session.endSession).toHaveBeenCalledOnce();
    },
  );

  it("archives a returned Item only after the linked Claim confirms the same handover", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const handoverAt = new Date("2026-11-14T08:00:00.000Z");
    const returnedItem = {
      _id: "item-1", id: "item-1", reportType: "found", lifecycleStatus: "returned", status: "claimed",
      reservedClaimId: "claim-1", handoverClaimId: "claim-1", handoverAt, handoverBy: "security-1",
    };
    const archiveItem = vi.spyOn(Item, "findOneAndUpdate")
      .mockResolvedValueOnce(returnedItem as never)
      .mockResolvedValueOnce({ ...returnedItem, archivedAt: new Date() } as never);
    vi.spyOn(Claim, "exists")
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(null) } as never)
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(null) } as never);
    const claim = { _id: "claim-1", itemId: "item-1", status: "approved", handoverAt, handoverBy: "security-1" };
    const completedClaim = vi.spyOn(Claim, "findOne").mockReturnValue(sessionQuery(claim) as never);

    const response = await request(app)
      .delete("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

    expect(response.status).toBe(204);
    expect(completedClaim).toHaveBeenCalledWith({ _id: "claim-1", itemId: "item-1", status: "approved", handoverAt, handoverBy: "security-1" });
    expect(archiveItem).toHaveBeenCalledTimes(2);
  });

  it("keeps an inconsistent returned Item out of owner archive eligibility", async () => {
    mockAuthenticatedUser("owner-1");
    const item = {
      _id: "item-1", id: "item-1", reportType: "found", lifecycleStatus: "returned", status: "claimed",
      reservedClaimId: "claim-1", handoverClaimId: "claim-1", handoverAt: new Date("2026-11-14T08:00:00.000Z"), handoverBy: "security-1",
    };
    vi.spyOn(Item, "findOne").mockResolvedValue(item as never);
    vi.spyOn(Claim, "aggregate").mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);

    const response = await request(app)
      .get("/api/items/mine/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ hasActiveClaims: false, canArchive: false, reportType: "unknown", lifecycleStatus: "unknown", status: "unknown" });
  });

  it("marks a returned Item archivable only when its approved Claim matches the handover", async () => {
    mockAuthenticatedUser("owner-1");
    const handoverAt = new Date("2026-11-14T08:00:00.000Z");
    const item = {
      _id: "item-1", id: "item-1", reportType: "found", lifecycleStatus: "returned", status: "claimed",
      reservedClaimId: "claim-1", handoverClaimId: "claim-1", handoverAt, handoverBy: "security-1",
    };
    vi.spyOn(Item, "findOne").mockResolvedValue(item as never);
    vi.spyOn(Claim, "aggregate")
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{
        _id: "claim-1", itemId: "item-1", status: "approved", handoverAt, handoverBy: "security-1",
      }] as never);

    const response = await request(app)
      .get("/api/items/mine/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ hasActiveClaims: false, canArchive: true, lifecycleStatus: "returned" });
  });

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
    const query = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "visible-item", status: "found" }]),
    };
    const findItems = vi.spyOn(Item, "find").mockReturnValue(query as never);
    vi.spyOn(Item, "countDocuments").mockResolvedValue(1 as never);

    const response = await request(app).get("/api/items");

    expect(response.status).toBe(200);
    expect(findItems).toHaveBeenCalledWith({ $and: [{ archivedAt: null }] });
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
