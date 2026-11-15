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
import { toItemDto } from "../src/utils/itemDto.js";
import { classifyApprovedClaimQueue } from "../src/routes/claims.js";
import { ownerMaySetReportedCustodyFilter, sufficientFoundCustodyFilter } from "../src/utils/custody.js";

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

function matchingItemQuery(total: number, page: number, limit: number) {
  const returned = Math.max(0, Math.min(limit, total - (page - 1) * limit));
  return {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(Array.from({ length: returned }, (_, index) => ({
      _id: `item-${index}`,
      title: `Found item ${index}`,
      description: "A found item with a clear description",
      location: "Library",
      dateReported: new Date("2026-11-14T00:00:00.000Z"),
      status: "found",
    }))),
  };
}

describe("conservative Item legacy interpretation", () => {
  const item = { title: "Historical report", description: "Old details", location: "Library", dateReported: new Date() };

  it("maps only pure legacy lost, found, and claimed records", () => {
    expect(toItemDto({ ...item, status: "lost" })).toMatchObject({ reportType: "lost", lifecycleStatus: "open", status: "lost" });
    expect(toItemDto({ ...item, status: "found" })).toMatchObject({ reportType: "found", lifecycleStatus: "open", status: "found" });
    expect(toItemDto({ ...item, status: "claimed" })).toMatchObject({ reportType: "unknown", lifecycleStatus: "unknown", status: "claimed" });
  });

  it.each([
    { status: undefined },
    { status: "invalid" },
    { status: "found", reportType: "found" },
    { status: "claimed", reportType: "found", lifecycleStatus: "open" },
    { status: "found", reportType: "found", lifecycleStatus: "reserved" },
    { status: "claimed", reportType: "found", lifecycleStatus: "returned" },
    { status: "lost", reportType: "lost", lifecycleStatus: "returned" },
  ])("marks insufficient or contradictory Item states unavailable: %o", (fields) => {
    expect(toItemDto({ ...item, ...fields })).toMatchObject({ reportType: "unknown", lifecycleStatus: "unknown", status: "unknown" });
  });
});

describe("old frontend create compatibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("accepts the old found-report shape without inventing event or custody history", async () => {
    mockAuthenticatedUser("owner-1");
    const saved = {
      _id: "item-1", title: "Blue tumbler", description: "Blue tumbler with a silver lid", location: "Library",
      dateReported: new Date("2026-11-14T08:00:00.000Z"), status: "found", reportType: "found",
      lifecycleStatus: "open", ownerId: "owner-1",
    };
    const create = vi.spyOn(Item, "create").mockResolvedValue(saved as never);

    const response = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ title: "Blue tumbler", description: "Blue tumbler with a silver lid", location: "Library", status: "found" });

    expect(response.status).toBe(201);
    const payload = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({ reportType: "found", lifecycleStatus: "open", status: "found", ownerId: "owner-1" });
    expect(payload).not.toHaveProperty("eventAt");
    expect(payload).not.toHaveProperty("custodyStatus");
    expect(payload).not.toHaveProperty("custodyConfirmedAt");
    expect(response.body.eventAt).toBeNull();
    expect(response.body.custodyStatus).toBeNull();
    expect(response.body).toMatchObject({ reportType: "found", lifecycleStatus: "open", status: "found" });

    const publicList = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([saved]),
    };
    vi.spyOn(Item, "find").mockReturnValue(publicList as never);
    vi.spyOn(Item, "countDocuments").mockResolvedValue(1 as never);
    vi.spyOn(Claim, "aggregate").mockResolvedValue([] as never);
    const browseResponse = await request(app).get("/api/items?page=1&limit=20");

    expect(browseResponse.status).toBe(200);
    expect(browseResponse.body[0]).toMatchObject({ reportType: "found", lifecycleStatus: "open", status: "found", custodyStatus: null });
  });

  it.each([
    { title: "Blue tumbler", description: "Silver lid", location: "Library", status: "found", reportType: "lost" },
    { title: "Blue tumbler", description: "Silver lid", location: "Library", status: "claimed" },
  ])("rejects incompatible old-client report types: %o", async (body) => {
    mockAuthenticatedUser("owner-1");
    const create = vi.spyOn(Item, "create");

    const response = await request(app)
      .post("/api/items")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("missing custody found-report safeguards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it("rejects a new Claim for an old-client found report without custody before opening a transaction", async () => {
    mockAuthenticatedUser("claimant-1");
    vi.spyOn(Item, "findOne").mockResolvedValue({
      _id: "item-1", reportType: "found", lifecycleStatus: "open", status: "found", ownerId: "owner-1",
    } as never);
    const startSession = vi.spyOn(mongoose, "startSession");

    const response = await request(app)
      .post("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("claimant-1")}`)
      .send({ itemId: "item-1", proof: "A distinctive scratch on the base" });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/valid custody information/i);
    expect(startSession).not.toHaveBeenCalled();
  });

  it("requires the same custody predicate inside the Claim creation transaction", async () => {
    mockAuthenticatedUser("claimant-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    vi.spyOn(Item, "findOne").mockResolvedValue({
      _id: "item-1", reportType: "found", lifecycleStatus: "open", status: "found", ownerId: "owner-1",
      custodyStatus: "finder_reported",
    } as never);
    vi.spyOn(Claim, "exists").mockResolvedValue(null);
    vi.spyOn(Claim, "findOne").mockReturnValue(sessionQuery(null) as never);
    vi.spyOn(Claim, "create").mockResolvedValue([{ _id: "claim-1" }] as never);
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);

    const response = await request(app)
      .post("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("claimant-1")}`)
      .send({ itemId: "item-1", proof: "A distinctive scratch on the base" });

    expect(response.status).toBe(409);
    const filter = update.mock.calls[0]?.[0] as { $and?: unknown[] };
    expect(filter.$and).toContainEqual(sufficientFoundCustodyFilter);
  });

  it("does not approve a pending Claim against a found report with missing custody", async () => {
    mockAuthenticatedUser("security-1", "security");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    vi.spyOn(Claim, "findById").mockResolvedValue({ _id: "claim-1", itemId: "item-1", status: "pending" } as never);
    vi.spyOn(Claim, "findOneAndUpdate").mockResolvedValue({ _id: "claim-1", status: "approved" } as never);
    const itemUpdate = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);

    const response = await request(app)
      .patch("/api/claims/claim-1/status")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`)
      .send({ status: "approved" });

    expect(response.status).toBe(409);
    const filter = itemUpdate.mock.calls[0]?.[0] as { $and?: unknown[] };
    expect(filter.$and).toContainEqual(sufficientFoundCustodyFilter);
  });

  it("lets the owner complete missing reporter custody and exposes missing reports to staff review", async () => {
    const missingCustody = {
      _id: "item-1", title: "Blue tumbler", description: "Blue tumbler with a silver lid", location: "Library",
      reportType: "found", lifecycleStatus: "open", status: "found", ownerId: "owner-1", archivedAt: null,
    };
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    vi.spyOn(Item, "findOne").mockReturnValue(sessionQuery(missingCustody) as never);
    vi.spyOn(Claim, "findOne").mockReturnValue(sessionQuery(null) as never);
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue({ ...missingCustody, custodyStatus: "finder_reported" } as never);

    const patchResponse = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ custodyStatus: "finder_reported" });

    expect(patchResponse.status).toBe(200);
    expect((update.mock.calls[0]?.[0] as { $and?: unknown[] }).$and).toContainEqual(ownerMaySetReportedCustodyFilter);

    vi.restoreAllMocks();
    mockAuthenticatedUser("security-1", "security");
    const listQuery = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([missingCustody]),
    };
    const list = vi.spyOn(Item, "find").mockReturnValue(listQuery as never);
    vi.spyOn(Item, "countDocuments").mockResolvedValue(1 as never);

    const staffResponse = await request(app)
      .get("/api/items/staff/custody?page=1&limit=20")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`);

    expect(staffResponse.status).toBe(200);
    expect(staffResponse.body).toHaveLength(1);
    expect(staffResponse.body[0]).toMatchObject({ reportType: "found", lifecycleStatus: "open", custodyStatus: null });
    expect(JSON.stringify(list.mock.calls[0]?.[0])).toContain('"custodyStatus":{"$exists":false}');
  });
});

describe("custody DTO evidence", () => {
  const foundOpen = { status: "found", reportType: "found", lifecycleStatus: "open" };

  it("displays security-confirmed custody only with both a staff actor and timestamp", () => {
    const confirmedAt = new Date("2026-11-14T08:00:00.000Z");
    const staffActor = new mongoose.Types.ObjectId("64b000000000000000000001");
    expect(toItemDto({ ...foundOpen, custodyStatus: "security_confirmed", custodyConfirmedAt: confirmedAt, custodyConfirmedBy: staffActor }).custodyStatus)
      .toBe("security_confirmed");
    expect(toItemDto({ ...foundOpen, custodyStatus: "security_confirmed", custodyConfirmedAt: confirmedAt }).custodyStatus)
      .toBeNull();
    expect(toItemDto({ ...foundOpen, custodyStatus: "security_confirmed", custodyConfirmedBy: staffActor }).custodyStatus)
      .toBeNull();
  });

  it("keeps reporter custody distinct and suppresses contradictory stored confirmation fields", () => {
    expect(toItemDto({ ...foundOpen, custodyStatus: "security_reported" }).custodyStatus)
      .toBe("security_reported");
    expect(toItemDto({ ...foundOpen, custodyStatus: "finder_reported", custodyConfirmedAt: new Date(), custodyConfirmedBy: new mongoose.Types.ObjectId("64b000000000000000000001") }).custodyStatus)
      .toBeNull();
  });
});

describe("approved Claim queue classification", () => {
  const handoverAt = new Date("2026-11-14T08:00:00.000Z");
  const approvedClaim = { _id: "claim-1", itemId: "item-1", status: "approved" };
  const reservedItem = {
    _id: "item-1", reportType: "found", lifecycleStatus: "reserved", status: "claimed",
    reservedClaimId: "claim-1", archivedAt: null,
  };
  const completedItem = {
    ...reservedItem, lifecycleStatus: "returned", handoverAt,
    handoverBy: "security-1", handoverClaimId: "claim-1",
  };

  it("classifies canonical reservations and fully recorded handovers as actionable/completed", () => {
    expect(classifyApprovedClaimQueue(approvedClaim, reservedItem)).toBe("awaiting_handover");
    expect(classifyApprovedClaimQueue({ ...approvedClaim, handoverAt, handoverBy: "security-1" }, completedItem)).toBe("completed");
  });

  it.each([
    ["Item timestamp without Claim timestamp", approvedClaim, { ...completedItem, lifecycleStatus: "reserved", handoverAt }],
    ["Claim timestamp without Item timestamp", { ...approvedClaim, handoverAt, handoverBy: "security-1" }, reservedItem],
    ["mismatched handover Claim ID", { ...approvedClaim, handoverAt, handoverBy: "security-1" }, { ...completedItem, handoverClaimId: "claim-other" }],
    ["mismatched reservation Claim ID", approvedClaim, { ...reservedItem, reservedClaimId: "claim-other" }],
    ["missing Item", approvedClaim, null],
    ["legacy approved Claim without canonical reservation", approvedClaim, { _id: "item-1", status: "claimed" }],
  ])("routes %s to staff reconciliation", (_label, claim, item) => {
    expect(classifyApprovedClaimQueue(claim, item)).toBe("legacy");
  });

  it("returns the three evidence-based workflow outcomes in the My Claims API", async () => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
    mockAuthenticatedUser("claimant-1");
    vi.spyOn(Claim, "aggregate").mockResolvedValue([{
      rows: [
        {
          _id: "claim-awaiting", itemId: "item-awaiting", status: "approved",
          item: { _id: "item-awaiting", status: "claimed", reportType: "found", lifecycleStatus: "reserved", reservedClaimId: "claim-awaiting" },
        },
        {
          _id: "claim-complete", itemId: "item-complete", status: "approved", handoverAt, handoverBy: "security-1",
          item: { _id: "item-complete", status: "claimed", reportType: "found", lifecycleStatus: "returned", reservedClaimId: "claim-complete", handoverClaimId: "claim-complete", handoverAt, handoverBy: "security-1" },
        },
        { _id: "claim-legacy", itemId: "missing-item", status: "approved", item: null },
      ],
      count: [{ value: 3 }],
    }] as never);

    const response = await request(app)
      .get("/api/claims")
      .set("Authorization", `Bearer ${tokenFor("claimant-1")}`);

    expect(response.status).toBe(200);
    expect(response.body.map((claim: { approvedWorkflowStatus: string }) => claim.approvedWorkflowStatus))
      .toEqual(["awaiting_handover", "completed", "legacy"]);
    expect(response.body[2]).not.toHaveProperty("handoverAt");
  });
});

describe("custody confirmation integrity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ["title", { title: "Updated verified tumbler" }],
    ["description", { description: "Updated description of the verified tumbler" }],
  ] as const)("preserves staff confirmation while an owner updates the %s", async (_field, body) => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const confirmedAt = new Date("2026-11-14T08:00:00.000Z");
    const existing = {
      _id: "item-1", title: "Blue tumbler", description: "Blue tumbler with a silver lid", location: "Library",
      status: "found", reportType: "found", lifecycleStatus: "open", ownerId: "owner-1", archivedAt: null,
      custodyStatus: "security_confirmed", custodyConfirmedAt: confirmedAt, custodyConfirmedBy: new mongoose.Types.ObjectId("64b000000000000000000001"),
    };
    vi.spyOn(Item, "findOne").mockReturnValue(sessionQuery(existing) as never);
    vi.spyOn(Claim, "findOne").mockReturnValue(sessionQuery(null) as never);
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue({ ...existing, ...body } as never);

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.custodyStatus).toBe("security_confirmed");
    expect(update.mock.calls[0]?.[1]).toEqual({ $set: body, $inc: { claimRevision: 1 } });
    expect(update.mock.calls[0]?.[0]).not.toMatchObject({ custodyStatus: { $not: expect.anything() } });
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("rejects a reported downgrade after staff confirmation", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    vi.spyOn(Item, "findOne").mockReturnValue(sessionQuery({
      status: "found", reportType: "found", lifecycleStatus: "open", ownerId: "owner-1",
      custodyStatus: "security_confirmed", archivedAt: null,
    }) as never);
    const update = vi.spyOn(Item, "findOneAndUpdate");

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ custodyStatus: "finder_reported" });

    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not let a non-owner change custody information", async () => {
    mockAuthenticatedUser("another-user");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    const findItem = vi.spyOn(Item, "findOne")
      .mockReturnValueOnce(sessionQuery(null) as never)
      .mockReturnValueOnce(sessionQuery(null) as never);
    const update = vi.spyOn(Item, "findOneAndUpdate");

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("another-user")}`)
      .send({ custodyStatus: "finder_reported" });

    expect(response.status).toBe(404);
    expect(findItem).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects client attempts to clear staff confirmation metadata", async () => {
    mockAuthenticatedUser("owner-1");
    const sessionSpy = vi.spyOn(mongoose, "startSession");
    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ title: "Updated", custodyConfirmedAt: null, custodyConfirmedBy: null });

    expect(response.status).toBe(400);
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("uses a conditional custody predicate so a racing confirmation cannot be downgraded", async () => {
    mockAuthenticatedUser("owner-1");
    const session = transactionSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
    vi.spyOn(Item, "findOne").mockReturnValue(sessionQuery({
      status: "found", reportType: "found", lifecycleStatus: "open", ownerId: "owner-1",
      custodyStatus: "finder_reported", archivedAt: null,
    }) as never);
    vi.spyOn(Claim, "findOne").mockReturnValue(sessionQuery(null) as never);
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);

    const response = await request(app)
      .patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor("owner-1")}`)
      .send({ custodyStatus: "security_reported" });

    expect(response.status).toBe(409);
    expect(update).toHaveBeenCalledOnce();
    expect((update.mock.calls[0]?.[0] as { $and?: unknown[] }).$and).toContainEqual(ownerMaySetReportedCustodyFilter);
  });

  it("keeps a confirmed custody record idempotent when staff repeats confirmation", async () => {
    mockAuthenticatedUser("security-1", "security");
    const confirmedAt = new Date("2026-11-14T08:00:00.000Z");
    const existing = {
      _id: "item-1", status: "found", reportType: "found", lifecycleStatus: "open", ownerId: "owner-1",
      custodyStatus: "security_confirmed", custodyConfirmedAt: confirmedAt, custodyConfirmedBy: new mongoose.Types.ObjectId("64b000000000000000000002"),
    };
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(null);
    const find = vi.spyOn(Item, "findOne").mockResolvedValue(existing as never);

    const response = await request(app)
      .post("/api/items/item-1/custody/confirm")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`);

    expect(response.status).toBe(200);
    expect(response.body.custodyStatus).toBe("security_confirmed");
    expect(update).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ custodyConfirmedAt: { $type: "date" } }));
  });

  it("returns staff actor and server time on the first custody confirmation", async () => {
    mockAuthenticatedUser("security-1", "security");
    const confirmed = {
      _id: "item-1", title: "Blue tumbler", description: "Blue tumbler", location: "Library", status: "found",
      reportType: "found", lifecycleStatus: "open", ownerId: "owner-1", custodyStatus: "security_confirmed",
      custodyConfirmedAt: new Date(), custodyConfirmedBy: "security-1",
    };
    const update = vi.spyOn(Item, "findOneAndUpdate").mockResolvedValue(confirmed as never);

    const response = await request(app)
      .post("/api/items/item-1/custody/confirm")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`)
      .send({ custodyConfirmedBy: "forged-user", custodyConfirmedAt: "2000-01-01" });

    expect(response.status).toBe(200);
    expect(update.mock.calls[0]?.[1]).toEqual({ $set: {
      custodyStatus: "security_confirmed",
      custodyConfirmedAt: expect.any(Date),
      custodyConfirmedBy: "security-1",
    } });
  });
});

describe("authoritative pagination and bounded Claim queues", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.connectDB.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    { total: 0, page: 1, length: 0, more: "false" },
    { total: 1, page: 1, length: 1, more: "false" },
    { total: 19, page: 1, length: 19, more: "false" },
    { total: 20, page: 1, length: 20, more: "false" },
    { total: 21, page: 1, length: 20, more: "true" },
    { total: 40, page: 1, length: 20, more: "true" },
    { total: 40, page: 2, length: 20, more: "false" },
    { total: 21, page: 2, length: 1, more: "false" },
  ])("sets item pagination headers for total=$total page=$page", async ({ total, page, length, more }) => {
    const query = matchingItemQuery(total, page, 20);
    vi.spyOn(Item, "find").mockReturnValue(query as never);
    vi.spyOn(Item, "countDocuments").mockResolvedValue(total as never);

    const response = await request(app).get(`/api/items?page=${page}&limit=20`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(length);
    expect(response.headers["x-page"]).toBe(String(page));
    expect(response.headers["x-page-size"]).toBe("20");
    expect(response.headers["x-total-count"]).toBe(String(total));
    expect(response.headers["x-has-more"]).toBe(more);
    expect(query.skip).toHaveBeenCalledWith((page - 1) * 20);
  });

  it("rejects out-of-range page and size values before database access", async () => {
    const find = vi.spyOn(Item, "find");
    const response = await request(app).get("/api/items?page=0&limit=51");
    expect(response.status).toBe(400);
    expect(find).not.toHaveBeenCalled();
  });

  it("keeps returned reports out of the current staff custody queue", async () => {
    mockAuthenticatedUser("security-1", "security");
    const query = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const find = vi.spyOn(Item, "find").mockReturnValue(query as never);
    vi.spyOn(Item, "countDocuments").mockResolvedValue(0 as never);

    const response = await request(app)
      .get("/api/items/staff/custody")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`);

    expect(response.status).toBe(200);
    const filter = JSON.stringify(find.mock.calls[0]?.[0]);
    expect(filter).not.toContain('"lifecycleStatus":"returned"');
    expect(filter).toContain('"custodyStatus":{"$exists":false}');
  });

  it.each([
    { path: "/api/claims?page=6&limit=20", user: "student-1", role: "student" },
    { path: "/api/claims/received?page=6&limit=20", user: "owner-1", role: "student" },
    { path: "/api/claims/review?queue=pending&page=6&limit=20", user: "security-1", role: "security" },
  ])("keeps all records reachable through pages for $path", async ({ path, user, role }) => {
    mockAuthenticatedUser(user, role as "student" | "security");
    const aggregate = vi.spyOn(Claim, "aggregate").mockResolvedValue([{ rows: [], count: [{ value: 121 }] }] as never);

    const response = await request(app).get(path).set("Authorization", `Bearer ${tokenFor(user)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(response.headers["x-page"]).toBe("6");
    expect(response.headers["x-total-count"]).toBe("121");
    expect(response.headers["x-has-more"]).toBe("true");
    const pipeline = aggregate.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    const facetIndex = pipeline.findIndex((stage) => "$facet" in stage);
    expect(facetIndex).toBeGreaterThan(0);
    expect(pipeline.slice(0, facetIndex).some((stage) => "$match" in stage)).toBe(true);
    const facet = pipeline[facetIndex]?.$facet as { rows: Array<Record<string, unknown>> };
    expect(facet.rows).toEqual(expect.arrayContaining([{ $skip: 100 }, { $limit: 20 }]));
  });

  it("filters the staff legacy queue against Item reservation and completion metadata before paging", async () => {
    mockAuthenticatedUser("security-1", "security");
    const aggregate = vi.spyOn(Claim, "aggregate").mockResolvedValue([{ rows: [], count: [{ value: 105 }] }] as never);

    const response = await request(app)
      .get("/api/claims/review?queue=legacy&page=6&limit=20")
      .set("Authorization", `Bearer ${tokenFor("security-1")}`);

    expect(response.status).toBe(200);
    expect(response.headers["x-total-count"]).toBe("105");
    const pipeline = aggregate.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    const facetIndex = pipeline.findIndex((stage) => "$facet" in stage);
    expect(pipeline.slice(0, facetIndex)).toEqual(expect.arrayContaining([
      { $match: { status: "approved" } },
      expect.objectContaining({ $lookup: expect.any(Object) }),
      expect.objectContaining({ $set: expect.objectContaining({ _isValidReservation: expect.any(Object), _isValidCompletion: expect.any(Object) }) }),
    ]));
    expect(facetIndex).toBeGreaterThan(3);
  });

  it.skipIf(!(process.env.CORS_ORIGIN ?? "").split(",").some((origin) => origin.trim()))("exposes pagination headers only through configured frontend CORS origins", async () => {
    const allowedOrigin = (process.env.CORS_ORIGIN ?? "").split(",").map((origin) => origin.trim()).find(Boolean)!;
    const response = await request(app)
      .options("/api/items")
      .set("Origin", allowedOrigin)
      .set("Access-Control-Request-Method", "GET");
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(response.headers["access-control-expose-headers"]).toContain("X-Has-More");
    expect(response.headers["access-control-expose-headers"]).toContain("X-Total-Count");
  });
});
