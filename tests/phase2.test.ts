import "dotenv/config";
import jwt from "jsonwebtoken";
import mongoose, { type ClientSession } from "mongoose";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connectDB: vi.fn(async () => undefined) }));
vi.mock("../src/config/db.js", () => ({ connectDB: mocks.connectDB }));

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

describe("Phase 2 report lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("creates a canonical found report using the authenticated reporter", async () => {
    mockAuthenticatedUser("reporter-1");
    const eventAt = "2026-11-13T08:00:00.000Z";
    const create = vi.spyOn(Item, "create").mockResolvedValue({
      id: "item-1", title: "Blue tumbler", description: "Blue insulated tumbler", location: "Library",
      dateReported: new Date("2026-11-14T00:00:00.000Z"), eventAt: new Date(eventAt), reportType: "found",
      lifecycleStatus: "open", custodyStatus: "security_reported", status: "found", ownerId: "reporter-1",
    } as never);

    const response = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({
        title: "Blue tumbler", description: "Blue insulated tumbler", location: "Library",
        reportType: "found", eventAt, category: "electronics", custodyStatus: "security_reported",
        ownerId: "forged-owner", status: "found",
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ reportType: "found", lifecycleStatus: "open", status: "found", ownerId: "reporter-1", custodyStatus: "security_reported" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: "Blue tumbler", reportType: "found", lifecycleStatus: "open", status: "found",
      custodyStatus: "security_reported", eventAt: new Date(eventAt), ownerId: "reporter-1",
    }));
  });

  it("rejects client-supplied lifecycle transitions before creating or editing a report", async () => {
    mockAuthenticatedUser("reporter-1");
    const create = vi.spyOn(Item, "create");
    const update = vi.spyOn(Item, "findOneAndUpdate");
    const startSession = vi.spyOn(mongoose, "startSession");

    const createResponse = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({
        title: "Blue tumbler", description: "Blue insulated tumbler", location: "Library",
        reportType: "found", eventAt: "2026-11-13T08:00:00.000Z", custodyStatus: "finder_reported",
        lifecycleStatus: "returned",
      });
    const updateResponse = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({ title: "Blue tumbler recovered", lifecycleStatus: "returned" });

    expect(createResponse.status).toBe(400);
    expect(updateResponse.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid event times before inserting a report", async () => {
    mockAuthenticatedUser("reporter-1");
    const create = vi.spyOn(Item, "create");
    const missingResponse = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({ title: "Blue tumbler", description: "Blue insulated tumbler", location: "Library", reportType: "lost" });
    const invalidResponse = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({ title: "Blue tumbler", description: "Blue insulated tumbler", location: "Library", reportType: "lost", eventAt: "tomorrow" });
    const futureResponse = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({
        title: "Blue tumbler", description: "Blue insulated tumbler", location: "Library",
        reportType: "lost", eventAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(missingResponse.status).toBe(400);
    expect(invalidResponse.status).toBe(400);
    expect(futureResponse.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires user-reported custody for a new found report", async () => {
    mockAuthenticatedUser("reporter-1");
    const create = vi.spyOn(Item, "create");
    const response = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({
        title: "Blue tumbler", description: "Blue insulated tumbler", location: "Library",
        reportType: "found", eventAt: "2026-11-13T08:00:00.000Z",
      });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the reporter scope server-controlled and bounds My Reports pagination", async () => {
    mockAuthenticatedUser("reporter-1");
    const query = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        { _id: "item-1", id: "item-1", title: "Lost keys", description: "Silver key ring", location: "Hall", status: "lost", ownerId: "reporter-1", dateReported: new Date(), lifecycleStatus: "open", reportType: "lost" },
      ]),
    };
    const find = vi.spyOn(Item, "find").mockReturnValue(query as never);
    vi.spyOn(Item, "countDocuments").mockResolvedValue(1 as never);
    vi.spyOn(Claim, "aggregate").mockResolvedValue([] as never);

    const response = await request(app)
      .get("/api/items/mine?page=2&limit=10&reporterId=someone-else")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`);

    expect(response.status).toBe(200);
    expect(find).toHaveBeenCalledWith({ $and: [{ ownerId: "reporter-1" }] });
    expect(query.skip).toHaveBeenCalledWith(10);
    expect(query.limit).toHaveBeenCalledWith(10);
    expect(response.headers["x-page"]).toBe("2");
    expect(response.body[0]).toMatchObject({ ownerId: "reporter-1", hasActiveClaims: false });
  });

  it("does not invent type or handover details for a legacy claimed report", async () => {
    const find = vi.spyOn(Item, "findOne").mockResolvedValue({
      _id: "legacy-item", id: "legacy-item", title: "Old report", description: "Historical record",
      location: "Library", status: "claimed", ownerId: "reporter-1", dateReported: new Date("2025-01-01T00:00:00.000Z"),
    } as never);
    const response = await request(app).get("/api/items/legacy-item");

    expect(response.status).toBe(200);
    expect(response.body.reportType).toBe("unknown");
    expect(response.body.lifecycleStatus).toBe("unknown");
    expect(response.body).not.toHaveProperty("handoverAt");
    expect(response.body.status).toBe("claimed");
    expect(find).toHaveBeenCalledWith({ _id: "legacy-item", archivedAt: null });
  });

  it("does not present a returned Item without a matching approved Claim as completed", async () => {
    vi.spyOn(Item, "findOne").mockResolvedValue({
      _id: "item-1", id: "item-1", title: "Blue tumbler", description: "Blue tumbler", location: "Library",
      status: "claimed", reportType: "found", lifecycleStatus: "returned", ownerId: "reporter-1",
      reservedClaimId: "claim-1", handoverClaimId: "claim-1", handoverAt: new Date("2026-11-14T00:00:00.000Z"), handoverBy: "security-1",
    } as never);
    vi.spyOn(Claim, "aggregate").mockResolvedValue([] as never);

    const response = await request(app).get("/api/items/item-1");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reportType: "unknown", lifecycleStatus: "unknown", status: "unknown" });
  });

  it("resolves an active lost report with server time and actor metadata", async () => {
    mockAuthenticatedUser("reporter-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue({
      id: "item-1", _id: "item-1", title: "Lost keys", status: "lost", reportType: "lost",
      lifecycleStatus: "resolved", ownerId: "reporter-1", resolvedAt: new Date(), resolvedBy: "reporter-1",
    } as never);

    const response = await request(app)
      .post("/api/items/item-1/resolve")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`)
      .send({ confirmed: true, resolvedBy: "forged-user", resolvedAt: "2000-01-01T00:00:00.000Z" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reportType: "lost", lifecycleStatus: "resolved", status: "lost" });
    expect(response.body).not.toHaveProperty("resolvedBy");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ $and: expect.any(Array) }), {
      $set: expect.objectContaining({ lifecycleStatus: "resolved", resolvedAt: expect.any(Date), resolvedBy: "reporter-1" }),
      $inc: { claimRevision: 1 },
    }, expect.objectContaining({ session, runValidators: true }));
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation before starting a lost-report resolution", async () => {
    mockAuthenticatedUser("reporter-1");
    const startSession = vi.spyOn(mongoose, "startSession");
    const response = await request(app)
      .post("/api/items/item-1/resolve")
      .set("Authorization", `Bearer ${tokenFor("reporter-1")}`);

    expect(response.status).toBe(400);
    expect(startSession).not.toHaveBeenCalled();
  });

  it("denies a different student access to a reporter's resolution action", async () => {
    mockAuthenticatedUser("student-2");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);
    vi.spyOn(Item, "findOne").mockReturnValue(sessionQuery(null) as never);

    const response = await request(app)
      .post("/api/items/item-1/resolve")
      .set("Authorization", `Bearer ${tokenFor("student-2")}`)
      .send({ confirmed: true });

    expect(response.status).toBe(404);
    expect(update.mock.calls[0]?.[0]).toMatchObject({ $and: expect.arrayContaining([expect.objectContaining({ ownerId: "student-2" })]) });
  });
});

describe("Phase 2 staff custody and physical handover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("denies students custody confirmation and handover before database writes", async () => {
    mockAuthenticatedUser("student-1", "student");
    const updateItem = vi.spyOn(Item, "findOneAndUpdate");
    const updateClaim = vi.spyOn(Claim, "findOneAndUpdate");
    const startSession = vi.spyOn(mongoose, "startSession");

    const custodyResponse = await request(app)
      .post("/api/items/item-1/custody/confirm")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`);
    const handoverResponse = await request(app)
      .post("/api/claims/claim-1/handover")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`)
      .send({ confirmed: true });

    expect(custodyResponse.status).toBe(403);
    expect(handoverResponse.status).toBe(403);
    expect(updateItem).not.toHaveBeenCalled();
    expect(updateClaim).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("records a handover atomically only for the approved Claim's reserved found Item", async () => {
    mockAuthenticatedUser("security-1", "security");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const handoverAt = new Date("2026-11-14T00:00:00.000Z");
    const claimDoc = {
      _id: "claim-1", itemId: "item-1", status: "approved", handoverAt, handoverBy: "security-1",
    };
    const itemDoc = {
      _id: "item-1", id: "item-1", title: "Blue tumbler", description: "Blue tumbler", location: "Library",
      status: "claimed", reportType: "found", lifecycleStatus: "returned", ownerId: "reporter-1",
      reservedClaimId: "claim-1", handoverClaimId: "claim-1", handoverAt, handoverBy: "security-1",
    };
    const updateClaim = vi.spyOn(Claim, "findOneAndUpdate").mockResolvedValue(claimDoc as never);
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(itemDoc as never);
    vi.spyOn(Item, "findById").mockReturnValue({ select: vi.fn().mockResolvedValue(itemDoc) } as never);

    const response = await request(app)
      .post("/api/claims/claim-1/handover")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`)
      .send({ confirmed: true, internalNote: "Verified at handover", handoverBy: "forged-user", handoverAt: "2000-01-01T00:00:00.000Z" });

    expect(response.status).toBe(200);
    expect(response.body.handoverAt).toBeTruthy();
    expect(response.body.item).toMatchObject({ reportType: "found", lifecycleStatus: "returned", handoverClaimId: "claim-1" });
    expect(updateClaim).toHaveBeenCalledWith({ _id: "claim-1", status: "approved", handoverAt: { $exists: false }, handoverBy: { $exists: false } }, {
      $set: { handoverAt: expect.any(Date), handoverBy: "security-1" },
    }, expect.objectContaining({ session, runValidators: true }));
    expect(updateItem).toHaveBeenCalledWith(expect.objectContaining({
      _id: "item-1", reportType: "found", lifecycleStatus: "reserved", status: "claimed", reservedClaimId: "claim-1", archivedAt: null,
    }), { $set: expect.objectContaining({ lifecycleStatus: "returned", handoverAt: expect.any(Date), handoverBy: "security-1", handoverClaimId: "claim-1", handoverInternalNote: "Verified at handover" }) }, expect.objectContaining({ session, runValidators: true }));
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("does not record a handover for a pending or historical Claim", async () => {
    mockAuthenticatedUser("admin-1", "admin");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateClaim = vi.spyOn(Claim, "findOneAndUpdate").mockResolvedValue(null);
    const updateItem = vi.spyOn(Item, "findOneAndUpdate");

    const response = await request(app)
      .post("/api/claims/legacy-claim/handover")
      .set("Authorization", `Bearer ${tokenFor("admin-1")}`)
      .send({ confirmed: true });

    expect(response.status).toBe(409);
    expect(updateClaim).toHaveBeenCalledWith({ _id: "legacy-claim", status: "approved", handoverAt: { $exists: false }, handoverBy: { $exists: false } }, expect.any(Object), expect.objectContaining({ session }));
    expect(updateItem).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("lets authorized staff set private pickup instructions only for the reserved Claim", async () => {
    mockAuthenticatedUser("security-1", "security");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const claim = { _id: "claim-1", itemId: "item-1", status: "approved" };
    const claimById = vi.spyOn(Claim, "findById").mockReturnValue(sessionQuery(claim) as never);
    const itemById = vi.spyOn(Item, "findOne").mockReturnValue(sessionQuery({
      _id: "item-1", reportType: "found", lifecycleStatus: "reserved", status: "claimed", reservedClaimId: "claim-1", archivedAt: null,
    }) as never);
    const updateClaim = vi.spyOn(Claim, "findOneAndUpdate").mockResolvedValue({
      id: "claim-1", status: "approved", pickupInstructions: "Contact campus security for the current pickup arrangement.",
    } as never);

    const response = await request(app)
      .patch("/api/claims/claim-1/pickup-instructions")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`)
      .send({ pickupInstructions: "Contact campus security for the current pickup arrangement.", reviewedBy: "forged-user" });

    expect(response.status).toBe(200);
    expect(response.body.pickupInstructions).toMatch(/campus security/i);
    expect(claimById).toHaveBeenCalledWith("claim-1");
    expect(itemById).toHaveBeenCalledWith(expect.objectContaining({
      _id: "item-1", reportType: "found", lifecycleStatus: "reserved", reservedClaimId: "claim-1", archivedAt: null,
      handoverAt: { $exists: false }, handoverBy: { $exists: false }, handoverClaimId: { $exists: false }, handoverInternalNote: { $exists: false },
    }));
    expect(updateClaim).toHaveBeenCalledWith(
      { _id: "claim-1", status: "approved", handoverAt: { $exists: false }, handoverBy: { $exists: false } },
      { $set: { pickupInstructions: "Contact campus security for the current pickup arrangement." } },
      expect.objectContaining({ session, runValidators: true }),
    );
  });
});

describe("Phase 2 claim eligibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it.each(["reserved", "returned", "resolved"] as const)(
    "rejects a Claim for a %s report",
    async (lifecycleStatus) => {
      mockAuthenticatedUser("student-1", "student");
      vi.spyOn(Item, "findOne").mockResolvedValue({
        _id: "item-1", ownerId: "reporter-1", reportType: "found", lifecycleStatus,
        status: lifecycleStatus === "reserved" || lifecycleStatus === "returned" ? "claimed" : "found",
      } as never);
      const exists = vi.spyOn(Claim, "exists");

      const response = await request(app)
        .post("/api/claims")
        .set("Authorization", `Bearer ${tokenFor("student-1")}`)
        .send({ itemId: "item-1", proof: "A scratch on the back" });

      expect(response.status).toBe(409);
      expect(exists).not.toHaveBeenCalled();
    },
  );
});

describe("student Claim privacy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("returns only the signed-in claimant's Claim and private pickup instructions", async () => {
    mockAuthenticatedUser("student-1");
    const findClaims = vi.spyOn(Claim, "aggregate").mockResolvedValue([{
      rows: [{
        _id: "claim-1", itemId: "item-1", claimantId: "student-1", status: "approved",
        proof: "A scratch on the back", pickupInstructions: "Use the instructions staff provided.",
        item: {
          _id: "item-1", title: "Blue tumbler", status: "claimed", reportType: "found", lifecycleStatus: "reserved",
          ownerId: "reporter-1", location: "Library", reservedClaimId: "claim-1", archivedAt: null,
        },
      }],
      count: [{ value: 1 }],
    }] as never);

    const response = await request(app)
      .get("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`);

    expect(response.status).toBe(200);
    expect(findClaims).toHaveBeenCalledOnce();
    expect(findClaims.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      { $match: { $expr: { $eq: [{ $toString: "$claimantId" }, "student-1"] } } },
    ]));
    expect(response.body[0]).toMatchObject({
      id: "claim-1", claimantId: "student-1", proof: "A scratch on the back",
      pickupInstructions: "Use the instructions staff provided.", item: { title: "Blue tumbler" },
    });
    expect(response.body[0]).not.toHaveProperty("handoverBy");
  });

  it("does not expose pickup instructions or handover completion without a matching workflow", async () => {
    mockAuthenticatedUser("student-1");
    vi.spyOn(Claim, "aggregate").mockResolvedValue([{
      rows: [{
        _id: "claim-1", itemId: "item-1", claimantId: "student-1", status: "approved",
        pickupInstructions: "Old or mismatched pickup details.",
        handoverAt: new Date("2026-11-14T00:00:00.000Z"), handoverBy: "security-1",
        item: {
          _id: "item-1", title: "Blue tumbler", status: "claimed", reportType: "found", lifecycleStatus: "returned",
          reservedClaimId: "another-claim", handoverClaimId: "claim-1",
          handoverAt: new Date("2026-11-14T00:00:00.000Z"), handoverBy: "security-1",
        },
      }],
      count: [{ value: 1 }],
    }] as never);

    const response = await request(app)
      .get("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`);

    expect(response.status).toBe(200);
    expect(response.body[0]).not.toHaveProperty("pickupInstructions");
    expect(response.body[0]).not.toHaveProperty("handoverAt");
    expect(response.body[0].item).toMatchObject({ reportType: "unknown", lifecycleStatus: "unknown" });
  });
});
