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

function tokenFor(userId: string, role?: string): string {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET!, { expiresIn: "5m" });
}

function transactionSession(): ClientSession {
  return {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
    endSession: vi.fn(async () => undefined),
  } as unknown as ClientSession;
}

describe("claim access and eligibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("requires authentication", async () => {
    const response = await request(app).post("/api/claims").send({
      itemId: "item-1",
      proof: "Blue scratch on the base",
    });

    expect(response.status).toBe(401);
  });

  it("rejects requests from accounts that have since been deactivated", async () => {
    mockAuthenticatedUser("student-1", "student", false);
    const findClaims = vi.spyOn(Claim, "find");

    const response = await request(app)
      .get("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`);

    expect(response.status).toBe(403);
    expect(findClaims).not.toHaveBeenCalled();
  });

  it("does not let an item owner or student decide a claim, even with a forged role claim", async () => {
    mockAuthenticatedUser("student-1", "student");
    const findClaim = vi.spyOn(Claim, "findById");
    const sessionSpy = vi.spyOn(mongoose, "startSession");

    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .set("Authorization", `Bearer ${tokenFor("student-1", "admin")}`)
      .send({ status: "approved" });

    expect(response.status).toBe(403);
    expect(findClaim).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("rejects self-claims", async () => {
    mockAuthenticatedUser("owner-1");
    vi.spyOn(Item, "findOne").mockResolvedValue(
      { ownerId: "owner-1", status: "found" } as never,
    );
    const createClaim = vi.spyOn(Claim, "create");

    const response = await request(app)
      .post("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ itemId: "item-1", proof: "Distinctive keychain color" });

    expect(response.status).toBe(403);
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("rejects claims for items that are already claimed", async () => {
    mockAuthenticatedUser("student-1");
    vi.spyOn(Item, "findOne").mockResolvedValue(
      { ownerId: "owner-1", status: "claimed" } as never,
    );
    const createClaim = vi.spyOn(Claim, "create");

    const response = await request(app)
      .post("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`)
      .send({ itemId: "item-1", proof: "Distinctive keychain color" });

    expect(response.status).toBe(409);
    expect(createClaim).not.toHaveBeenCalled();
  });

  it("rejects claims against lost-item reports", async () => {
    mockAuthenticatedUser("student-1");
    vi.spyOn(Item, "findOne").mockResolvedValue(
      { ownerId: "owner-1", status: "lost" } as never,
    );
    const claimExists = vi.spyOn(Claim, "exists");
    const sessionSpy = vi.spyOn(mongoose, "startSession");

    const response = await request(app)
      .post("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`)
      .send({ itemId: "item-1", proof: "Distinctive keychain color" });

    expect(response.status).toBe(409);
    expect(claimExists).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it.each(["pending", "approved", "rejected"] as const)(
    "prevents a second claim when a previous claim is %s",
    async (previousStatus) => {
      mockAuthenticatedUser("student-1");
      vi.spyOn(Item, "findOne").mockResolvedValue(
        { ownerId: "owner-1", status: "found" } as never,
      );
      const exists = vi
        .spyOn(Claim, "exists")
        .mockResolvedValue(
          { _id: "claim-1", status: previousStatus } as never,
        );
      const createClaim = vi.spyOn(Claim, "create");

      const response = await request(app)
        .post("/api/claims")
        .set("Authorization", `Bearer ${tokenFor("student-1")}`)
        .send({ itemId: "item-1", proof: "Distinctive keychain color" });

      expect(response.status).toBe(409);
      expect(exists).toHaveBeenCalledWith({
        itemId: "item-1",
        claimantId: "student-1",
      });
      expect(createClaim).not.toHaveBeenCalled();
    },
  );

  it("rechecks claims of any status inside the item lock transaction", async () => {
    mockAuthenticatedUser("student-1");
    vi.spyOn(Item, "findOne").mockResolvedValue(
      { ownerId: "owner-1", status: "found" } as never,
    );
    vi.spyOn(Claim, "exists").mockResolvedValue(null);
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(
      { id: "item-1" } as never,
    );
    const claimQuery = {
      session: vi
        .fn()
        .mockResolvedValue({ id: "rejected-claim", status: "rejected" }),
    };
    const findClaim = vi
      .spyOn(Claim, "findOne")
      .mockReturnValue(claimQuery as never);
    const createClaim = vi.spyOn(Claim, "create");

    const response = await request(app)
      .post("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`)
      .send({ itemId: "item-1", proof: "Distinctive keychain color" });

    expect(response.status).toBe(409);
    expect(findClaim).toHaveBeenCalledWith({
      itemId: "item-1",
      claimantId: "student-1",
    });
    expect(createClaim).not.toHaveBeenCalled();
    expect(claimQuery.session).toHaveBeenCalledWith(session);
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("creates an eligible claim for the authenticated user", async () => {
    mockAuthenticatedUser("student-1");
    vi.spyOn(Item, "findOne").mockResolvedValue(
      { ownerId: "owner-1", status: "found" } as never,
    );
    vi.spyOn(Claim, "exists").mockResolvedValue(null);
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const lockItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(
      { id: "item-1" } as never,
    );
    const claimQuery = { session: vi.fn().mockResolvedValue(null) };
    vi.spyOn(Claim, "findOne").mockReturnValue(claimQuery as never);
    const createClaim = vi.spyOn(Claim, "create").mockResolvedValue(
      [{ id: "claim-1", claimantId: "student-1", status: "pending" }] as never,
    );

    const response = await request(app)
      .post("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("student-1")}`)
      .send({
        itemId: "item-1",
        proof: "A unique mark on the back",
        claimantId: "someone-else",
        status: "rejected",
      });

    expect(response.status).toBe(201);
    expect(createClaim).toHaveBeenCalledWith(
      [
        {
          itemId: "item-1",
          claimantId: "student-1",
          proof: "A unique mark on the back",
        },
      ],
      { session },
    );
    expect(lockItem).toHaveBeenCalledWith(
      {
        _id: "item-1",
        ownerId: { $ne: "student-1" },
        status: "found",
        archivedAt: null,
      },
      { $inc: { claimRevision: 1 } },
      expect.objectContaining({ session, runValidators: true }),
    );
    expect(claimQuery.session).toHaveBeenCalledWith(session);
    expect(session.endSession).toHaveBeenCalledOnce();
  });
});

describe("claim proof visibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("omits proof from an item owner's received-claims response", async () => {
    mockAuthenticatedUser("owner-1");
    const findOwnedItems = vi.spyOn(Item, "find").mockReturnValue(
      {
        select: vi.fn().mockResolvedValue([
          {
            _id: "item-1",
            toJSON: () => ({ id: "item-1", title: "Blue tumbler" }),
          },
        ]),
      } as never,
    );
    const claimQuery = {
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockResolvedValue([
        {
          itemId: "item-1",
          toJSON: () => ({ id: "claim-1", status: "pending" }),
        },
      ]),
    };
    const findClaims = vi.spyOn(Claim, "find").mockReturnValue(claimQuery as never);

    const response = await request(app)
      .get("/api/claims/received")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`);

    expect(response.status).toBe(200);
    expect(findOwnedItems).toHaveBeenCalledWith({ ownerId: "owner-1" });
    expect(findClaims).toHaveBeenCalledWith({ itemId: { $in: ["item-1"] } });
    expect(claimQuery.select).toHaveBeenCalledWith("-proof");
    expect(response.body[0].item).toEqual({ id: "item-1", title: "Blue tumbler" });
    expect(response.body[0]).not.toHaveProperty("proof");
  });

  it("keeps review metadata optional for claims created before this change", () => {
    const legacyClaim = new Claim({
      itemId: new mongoose.Types.ObjectId(),
      claimantId: new mongoose.Types.ObjectId(),
      proof: "Distinctive old proof",
    }).toJSON();

    expect(legacyClaim.status).toBe("pending");
    expect(legacyClaim).not.toHaveProperty("reviewedAt");
    expect(legacyClaim).not.toHaveProperty("reviewedBy");
  });

  it("does not add a unique claimant-and-item index", () => {
    const hasUniqueClaimantItemIndex = Claim.schema.indexes().some(
      ([keys, options]) =>
        options.unique === true && keys.itemId === 1 && keys.claimantId === 1,
    );

    expect(hasUniqueClaimantItemIndex).toBe(false);
  });
});

describe("staff claim review", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("lets staff review pending claims with archived item context and no claimant ID", async () => {
    mockAuthenticatedUser("security-1", "security");
    const claimDoc = {
      itemId: "item-1",
      toJSON: () => ({ id: "claim-1", status: "pending", proof: "proof text" }),
    };
    const query = {
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockResolvedValue([claimDoc]),
    };
    const findClaims = vi.spyOn(Claim, "find").mockReturnValue(query as never);
    const itemDoc = {
      _id: "item-1",
      toJSON: () => ({
        id: "item-1",
        title: "Blue tumbler",
        description: "Blue with a silver lid",
        status: "found",
        location: "Library",
        dateReported: "2026-11-12T00:00:00.000Z",
        archivedAt: "2026-11-13T00:00:00.000Z",
      }),
    };
    const itemQuery = { select: vi.fn().mockResolvedValue([itemDoc]) };
    const findItems = vi.spyOn(Item, "find").mockReturnValue(itemQuery as never);

    const response = await request(app)
      .get("/api/claims/review")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`);

    expect(response.status).toBe(200);
    expect(findClaims).toHaveBeenCalledWith({ status: "pending" });
    expect(query.select).toHaveBeenCalledWith("-claimantId");
    expect(findItems).toHaveBeenCalledWith({ _id: { $in: ["item-1"] } });
    expect(response.body[0].item.title).toBe("Blue tumbler");
    expect(response.body[0].item.archivedAt).toBe("2026-11-13T00:00:00.000Z");
    expect(response.body[0]).not.toHaveProperty("claimantId");
  });

  it("returns a safe missing-item context for a legacy pending claim", async () => {
    mockAuthenticatedUser("security-1", "security");
    const claimQuery = {
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockResolvedValue([
        {
          itemId: "missing-item",
          toJSON: () => ({ id: "claim-1", status: "pending", proof: "proof text" }),
        },
      ]),
    };
    vi.spyOn(Claim, "find").mockReturnValue(claimQuery as never);
    vi.spyOn(Item, "find").mockReturnValue(
      { select: vi.fn().mockResolvedValue([]) } as never,
    );

    const response = await request(app)
      .get("/api/claims/review")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`);

    expect(response.status).toBe(200);
    expect(response.body[0].item).toBeNull();
    expect(response.body[0].proof).toBe("proof text");
  });

  it("lets authorized staff approve a pending claim and records optional review metadata", async () => {
    mockAuthenticatedUser("security-1", "security");
    vi.spyOn(Claim, "findById").mockResolvedValue(
      { itemId: "item-1", status: "pending" } as never,
    );

    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateClaim = vi.spyOn(Claim, "findOneAndUpdate").mockResolvedValue(
      { id: "claim-1", status: "approved" } as never,
    );
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(
      { id: "item-1", status: "claimed" } as never,
    );

    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`)
      .send({ status: "approved" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("approved");
    expect(updateClaim).toHaveBeenCalledWith(
      { _id: "claim-1", status: "pending" },
      {
        $set: expect.objectContaining({
          status: "approved",
          reviewedBy: "security-1",
          reviewedAt: expect.any(Date),
        }),
      },
      expect.objectContaining({ session, runValidators: true }),
    );
    expect(updateItem).toHaveBeenCalledWith(
      {
        _id: "item-1",
        status: "found",
        archivedAt: null,
      },
      { $set: { status: "claimed" } },
      expect.objectContaining({ session, runValidators: true }),
    );
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("lets an admin reject a pending claim without changing the item", async () => {
    mockAuthenticatedUser("admin-1", "admin");
    vi.spyOn(Claim, "findById").mockResolvedValue(
      { itemId: "item-1", status: "pending" } as never,
    );

    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateClaim = vi.spyOn(Claim, "findOneAndUpdate").mockResolvedValue(
      { id: "claim-1", status: "rejected" } as never,
    );
    const updateItem = vi.spyOn(Item, "findOneAndUpdate");

    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .set("Authorization", `Bearer ${tokenFor("admin-1")}`)
      .send({ status: "rejected" });

    expect(response.status).toBe(200);
    expect(updateClaim).toHaveBeenCalledWith(
      { _id: "claim-1", status: "pending" },
      {
        $set: expect.objectContaining({
          status: "rejected",
          reviewedBy: "admin-1",
          reviewedAt: expect.any(Date),
        }),
      },
      expect.objectContaining({ session, runValidators: true }),
    );
    expect(updateItem).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("does not approve a pending claim when its item is archived or unavailable", async () => {
    mockAuthenticatedUser("security-1", "security");
    vi.spyOn(Claim, "findById").mockResolvedValue(
      { itemId: "item-1", status: "pending" } as never,
    );

    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const updateClaim = vi.spyOn(Claim, "findOneAndUpdate").mockResolvedValue(
      { id: "claim-1", status: "approved" } as never,
    );
    const updateItem = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);

    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`)
      .send({ status: "approved" });

    expect(response.status).toBe(409);
    expect(updateClaim).toHaveBeenCalledOnce();
    expect(updateItem).toHaveBeenCalledWith(
      { _id: "item-1", status: "found", archivedAt: null },
      { $set: { status: "claimed" } },
      expect.objectContaining({ session, runValidators: true }),
    );
    expect(session.endSession).toHaveBeenCalledOnce();
  });
});
