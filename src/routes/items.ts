import { Router, type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Claim } from "../models/Claim.js";
import { Item } from "../models/Item.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createReportSchema, itemListQuerySchema, resolveReportSchema, updateReportSchema } from "../schemas/items.js";
import { classifyItemState, toItemDto } from "../utils/itemDto.js";
import { ownerMaySetReportedCustodyFilter, staffMayConfirmCustodyFilter } from "../utils/custody.js";
import { paginationQuerySchema, setPaginationHeaders } from "../utils/pagination.js";

interface IdParam { id: string }

class ItemConflict extends Error {}
class ItemNotFound extends Error {}
class ItemInvalidInput extends Error {}

const serverControlledFields = new Set([
  "lifecycleStatus",
  "resolvedAt",
  "resolvedBy",
  "reservedAt",
  "reservedBy",
  "reservedClaimId",
  "handoverAt",
  "handoverBy",
  "handoverClaimId",
  "handoverInternalNote",
  "custodyConfirmedAt",
  "custodyConfirmedBy",
  "archivedAt",
  "claimRevision",
]);

function hasServerControlledFields(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => serverControlledFields.has(key));
}

export const itemRouter = Router();

function parseQuery(req: Request) {
  return itemListQuerySchema.safeParse(req.query);
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function itemFilter(query: z.infer<typeof itemListQuerySchema>, ownerId?: string) {
  const conditions: Record<string, unknown>[] = ownerId ? [] : [{ archivedAt: null }];
  if (ownerId) conditions.push({ ownerId });

  if (query.reportType || query.lifecycleStatus) {
    const canonicalStates = [
      { reportType: "lost", lifecycleStatus: "open", status: "lost" },
      { reportType: "lost", lifecycleStatus: "resolved", status: "lost" },
      { reportType: "found", lifecycleStatus: "open", status: "found" },
      { reportType: "found", lifecycleStatus: "reserved", status: "claimed" },
      { reportType: "found", lifecycleStatus: "returned", status: "claimed" },
    ].filter((state) =>
      (!query.reportType || state.reportType === query.reportType) &&
      (!query.lifecycleStatus || state.lifecycleStatus === query.lifecycleStatus),
    );
    const safeStates: Record<string, unknown>[] = canonicalStates.map((state) => state);
    if (!query.lifecycleStatus || query.lifecycleStatus === "open") {
      const legacyTypes = query.reportType ? [query.reportType] : ["lost", "found"];
      safeStates.push({
        reportType: { $exists: false },
        lifecycleStatus: { $exists: false },
        status: { $in: legacyTypes },
      });
    }
    conditions.push({ $or: safeStates.length ? safeStates : [{ _id: { $exists: false } }] });
  }
  if (query.category) conditions.push({ category: query.category });
  if (query.location) conditions.push({ location: new RegExp(regexEscape(query.location), "i") });
  if (query.from || query.to) {
    const eventRange: Record<string, Date> = {};
    if (query.from) eventRange.$gte = new Date(query.from);
    if (query.to) eventRange.$lte = new Date(query.to);
    conditions.push({ eventAt: eventRange });
  }
  if (query.q) {
    const search = new RegExp(regexEscape(query.q), "i");
    conditions.push({ $or: [{ title: search }, { description: search }, { location: search }] });
  }
  return { $and: conditions };
}

const completedHandoverExpression = {
  $and: [
    { $eq: ["$status", "approved"] },
    { $eq: ["$item.reportType", "found"] },
    { $eq: ["$item.lifecycleStatus", "returned"] },
    { $eq: ["$item.status", "claimed"] },
    { $eq: ["$item.reservedClaimId", "$_id"] },
    { $eq: ["$item.handoverClaimId", "$_id"] },
    { $eq: [{ $type: "$handoverAt" }, "date"] },
    { $eq: [{ $type: "$item.handoverAt" }, "date"] },
    { $eq: ["$handoverAt", "$item.handoverAt"] },
    { $eq: ["$handoverBy", "$item.handoverBy"] },
    { $ne: ["$handoverBy", null] },
    { $ne: ["$handoverBy", ""] },
  ],
};

async function activeClaimItemIds(itemIds: unknown[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const claims = await Claim.aggregate([
    { $match: { itemId: { $in: itemIds }, status: { $in: ["pending", "approved"] } } },
    { $lookup: { from: Item.collection.name, localField: "itemId", foreignField: "_id", as: "item" } },
    { $set: { item: { $arrayElemAt: ["$item", 0] } } },
    { $set: { _completedHandover: completedHandoverExpression } },
    {
      $match: {
        $or: [
          { status: "pending" },
          { $and: [{ status: "approved" }, { _completedHandover: false }] },
        ],
      },
    },
    { $group: { _id: "$itemId" } },
  ]);
  return new Set(claims.map((claim) => String(claim._id)));
}

type ItemHandoverRecord = {
  _id: unknown;
  archivedAt?: unknown;
  reportType?: unknown;
  lifecycleStatus?: unknown;
  status?: unknown;
  reservedClaimId?: unknown;
  handoverClaimId?: unknown;
  handoverAt?: unknown;
  handoverBy?: unknown;
};

async function verifiedCompletedHandoverItemIds(items: ItemHandoverRecord[]): Promise<Set<string>> {
  const candidates = items.filter((item) => {
    const state = classifyItemState(item);
    return state.lifecycleStatus === "returned" &&
      item.handoverAt instanceof Date &&
      Boolean(item.handoverBy) &&
      Boolean(item.handoverClaimId) &&
      String(item.handoverClaimId) === String(item.reservedClaimId);
  });
  if (candidates.length === 0) return new Set();

  const claims = await Claim.aggregate([
    {
      $match: {
        _id: { $in: candidates.map((item) => item.handoverClaimId) },
        status: "approved",
      },
    },
    { $project: { _id: 1, itemId: 1, handoverAt: 1, handoverBy: 1 } },
  ]);
  const claimsById = new Map(claims.map((claim) => [String(claim._id), claim]));
  const verified = new Set<string>();
  for (const item of candidates) {
    const claim = claimsById.get(String(item.handoverClaimId));
    if (!claim || String(claim.itemId) !== String(item._id)) continue;
    if (!(claim.handoverAt instanceof Date) || claim.handoverAt.getTime() !== (item.handoverAt as Date).getTime()) continue;
    if (!claim.handoverBy || String(claim.handoverBy) !== String(item.handoverBy)) continue;
    verified.add(String(item._id));
  }
  return verified;
}

function toVerifiedItemDto(
  item: unknown,
  verifiedHandoverIds: Set<string>,
  options: { includeStaffFields?: boolean } = {},
) {
  const dto = toItemDto(item, options);
  if (dto.lifecycleStatus === "returned" && !verifiedHandoverIds.has(dto.id)) {
    return { ...dto, reportType: "unknown" as const, lifecycleStatus: "unknown" as const, status: "unknown" as const };
  }
  return dto;
}

function canArchiveItem(
  item: ItemHandoverRecord,
  activeItemIds: Set<string>,
  completedItemIds: Set<string>,
): boolean {
  const state = classifyItemState(item);
  if (item.archivedAt) return false;
  if (activeItemIds.has(String(item._id))) return false;
  if (state.reportType === "lost") return state.lifecycleStatus === "open" || state.lifecycleStatus === "resolved";
  if (state.reportType === "found" && state.lifecycleStatus === "open") return true;
  return state.reportType === "found" && state.lifecycleStatus === "returned" && completedItemIds.has(String(item._id));
}

function badInput(res: Response, issues: readonly { message: string }[]) {
  res.status(400).json({ message: "Invalid input", errors: issues.map((issue) => issue.message) });
}

itemRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsedQuery = parseQuery(req);
    if (!parsedQuery.success) {
      badInput(res, parsedQuery.error.issues);
      return;
    }
    const { page, limit } = parsedQuery.data;
    try {
      const filter = itemFilter(parsedQuery.data);
      const [items, total] = await Promise.all([
        Item.find(filter as never)
          .sort({ dateReported: -1, _id: 1 })
          .skip((page - 1) * limit)
          .limit(limit),
        Item.countDocuments(filter as never),
      ]);
      setPaginationHeaders(res, page, limit, total);
      const verifiedHandoverIds = await verifiedCompletedHandoverItemIds(items as ItemHandoverRecord[]);
      res.json(items.map((item) => toVerifiedItemDto(item, verifiedHandoverIds)));
    } catch (err) {
      next(err);
    }
  },
);

itemRouter.get(
  "/mine",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsedQuery = parseQuery(req);
    if (!parsedQuery.success) {
      badInput(res, parsedQuery.error.issues);
      return;
    }
    const { page, limit } = parsedQuery.data;
    try {
      const filter = itemFilter(parsedQuery.data, req.userId!);
      const [items, total] = await Promise.all([
        Item.find(filter as never)
          .sort({ dateReported: -1, _id: 1 })
          .skip((page - 1) * limit)
          .limit(limit),
        Item.countDocuments(filter as never),
      ]);
      setPaginationHeaders(res, page, limit, total);
      const activeItemIds = await activeClaimItemIds(items.map((item) => item._id));
      const completedItemIds = await verifiedCompletedHandoverItemIds(items as ItemHandoverRecord[]);
      res.json(items.map((item) => ({
        ...toVerifiedItemDto(item, completedItemIds),
        hasActiveClaims: activeItemIds.has(String(item._id)),
        canArchive: canArchiveItem(item as ItemHandoverRecord, activeItemIds, completedItemIds),
      })));
    } catch (err) {
      next(err);
    }
  },
);

itemRouter.get(
  "/mine/:id",
  requireAuth,
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    try {
      const item = await Item.findOne({ _id: req.params.id, ownerId: req.userId });
      if (!item) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }
      const active = await activeClaimItemIds([item._id]);
      const completed = await verifiedCompletedHandoverItemIds([item as ItemHandoverRecord]);
      res.json({
        ...toVerifiedItemDto(item, completed),
        hasActiveClaims: active.has(String(item._id)),
        canArchive: canArchiveItem(item as ItemHandoverRecord, active, completed),
      });
    } catch (err) {
      next(err);
    }
  },
);

itemRouter.get(
  "/staff/custody",
  requireAuth,
  requireRole("security", "admin"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsedPage = paginationQuerySchema.safeParse(req.query);
    if (!parsedPage.success) {
      badInput(res, parsedPage.error.issues);
      return;
    }
    const { page, limit } = parsedPage.data;
    const filter = {
      $and: [
        { archivedAt: null },
        {
          $or: [
            { reportType: "found", lifecycleStatus: "open", status: "found" },
            { reportType: "found", lifecycleStatus: "reserved", status: "claimed" },
            { reportType: { $exists: false }, lifecycleStatus: { $exists: false }, status: "found" },
          ],
        },
        {
          $or: [
            { custodyStatus: { $exists: false } },
            { custodyStatus: null },
            { custodyStatus: { $in: ["finder_reported", "security_reported"] } },
          ],
        },
      ],
    };
    try {
      const [items, total] = await Promise.all([
        Item.find(filter as never)
        .sort({ eventAt: -1, dateReported: -1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
        Item.countDocuments(filter as never),
      ]);
      setPaginationHeaders(res, page, limit, total);
      res.json(items.map((item) => toItemDto(item, { includeStaffFields: true })));
    } catch (err) {
      next(err);
    }
  },
);

itemRouter.get(
  "/:id",
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    try {
      const item = await Item.findOne({ _id: req.params.id, archivedAt: null });
      if (!item) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }
      const verifiedHandoverIds = await verifiedCompletedHandoverItemIds([item as ItemHandoverRecord]);
      res.json(toVerifiedItemDto(item, verifiedHandoverIds));
    } catch (err) {
      next(err);
    }
  },
);

itemRouter.post(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // `status` remains accepted as the old report-type spelling; it never
    // controls lifecycle or reviewer/handover state.
    const rawBody = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const legacyClientRequest = rawBody.reportType === undefined && (rawBody.status === "lost" || rawBody.status === "found");
    if (rawBody.status !== undefined && rawBody.status !== "lost" && rawBody.status !== "found") {
      res.status(400).json({ message: "Legacy status may only identify a lost or found report" });
      return;
    }
    if (rawBody.reportType !== undefined && rawBody.status !== undefined && rawBody.reportType !== rawBody.status) {
      res.status(400).json({ message: "reportType and legacy status must agree" });
      return;
    }
    if (hasServerControlledFields(rawBody)) {
      res.status(400).json({ message: "Lifecycle and custody confirmation fields are server-controlled" });
      return;
    }
    if (!legacyClientRequest && typeof rawBody.eventAt !== "string") {
      res.status(400).json({ message: "An event date and time is required" });
      return;
    }
    if (!legacyClientRequest && rawBody.reportType === "found" && rawBody.custodyStatus !== "finder_reported" && rawBody.custodyStatus !== "security_reported") {
      res.status(400).json({ message: "Select the current reported custody information for a found item" });
      return;
    }
    const parsed = createReportSchema.safeParse({
      ...rawBody,
      reportType: rawBody.reportType ?? rawBody.status,
    });
    if (!parsed.success) {
      badInput(res, parsed.error.issues);
      return;
    }

    try {
      const report = parsed.data;
      const item = await Item.create({
        title: report.title,
        description: report.description,
        location: report.location,
        dateReported: new Date(),
        ...(report.eventAt ? { eventAt: new Date(report.eventAt) } : {}),
        category: report.category,
        reportType: report.reportType,
        lifecycleStatus: "open",
        status: report.reportType,
        ...(report.reportType === "found" && report.custodyStatus ? { custodyStatus: report.custodyStatus } : {}),
        ownerId: req.userId!,
      });
      res.status(201).json(toItemDto(item));
    } catch (err) {
      next(err);
    }
  },
);

itemRouter.patch(
  "/:id",
  requireAuth,
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    if (hasServerControlledFields(req.body)) {
      res.status(400).json({ message: "Lifecycle and custody confirmation fields are server-controlled" });
      return;
    }
    const parsed = updateReportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badInput(res, parsed.error.issues);
      return;
    }
    const update: Record<string, unknown> = { ...parsed.data };
    if (typeof update.eventAt === "string") update.eventAt = new Date(update.eventAt);
    if (update.category === null) delete update.category;

    const session = await mongoose.startSession();
    try {
      let updatedItem: Awaited<ReturnType<typeof Item.findOneAndUpdate>> | null = null;
      await session.withTransaction(async () => {
        const openOwnedFilter = {
          $and: [
            { _id: req.params.id, ownerId: req.userId!, archivedAt: null },
            { $or: [
              { reportType: "lost", lifecycleStatus: "open", status: "lost" },
              { reportType: "found", lifecycleStatus: "open", status: "found" },
              { reportType: { $exists: false }, lifecycleStatus: { $exists: false }, status: { $in: ["lost", "found"] } },
            ] },
          ],
        };
        const existing = await Item.findOne(openOwnedFilter as never).session(session);
        if (!existing) {
          const owned = await Item.findOne({ _id: req.params.id, ownerId: req.userId! }).session(session);
          if (!owned) throw new ItemNotFound("No item with that id");
          throw new ItemConflict("This report is archived, reserved, resolved, returned, or unavailable for editing");
        }
        if (update.custodyStatus && !(existing.reportType === "found" || (!existing.reportType && existing.status === "found"))) {
          throw new ItemInvalidInput("Custody information applies only to found reports");
        }
        if (update.custodyStatus && existing.custodyStatus === "security_confirmed") {
          throw new ItemConflict("Campus staff have confirmed custody; the verified state cannot be changed by the report owner");
        }
        const activeClaim = await Claim.findOne({
          itemId: req.params.id,
          status: { $in: ["pending", "approved"] },
        }).session(session);
        if (activeClaim) throw new ItemConflict("Reports with pending or approved claims cannot be edited");

        const updateFilter = update.custodyStatus
          ? {
              $and: [
                openOwnedFilter,
                ownerMaySetReportedCustodyFilter,
              ],
            }
          : openOwnedFilter;
        updatedItem = await Item.findOneAndUpdate(
          updateFilter as never,
          { $set: update, $inc: { claimRevision: 1 } },
          { returnDocument: "after", runValidators: true, session },
        );
        if (!updatedItem) throw new ItemConflict("This report changed and is no longer editable");
      });
      res.json(toItemDto(updatedItem));
    } catch (err) {
      if (err instanceof ItemNotFound) {
        res.status(404).json({ message: err.message });
        return;
      }
      if (err instanceof ItemConflict) {
        res.status(409).json({ message: err.message });
        return;
      }
      if (err instanceof ItemInvalidInput) {
        res.status(400).json({ message: err.message });
        return;
      }
      next(err);
    } finally {
      await session.endSession();
    }
  },
);

itemRouter.post(
  "/:id/resolve",
  requireAuth,
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    const parsed = resolveReportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badInput(res, parsed.error.issues);
      return;
    }
    const isStaff = req.userRole === "security" || req.userRole === "admin";
    const session = await mongoose.startSession();
    try {
      let resolved: Awaited<ReturnType<typeof Item.findOneAndUpdate>> | null = null;
      await session.withTransaction(async () => {
        const ownerCondition = isStaff ? {} : { ownerId: req.userId! };
        resolved = await Item.findOneAndUpdate(
          {
            $and: [
              { _id: req.params.id, archivedAt: null, ...ownerCondition },
              { $or: [
                { reportType: "lost", lifecycleStatus: "open", status: "lost" },
                { reportType: { $exists: false }, lifecycleStatus: { $exists: false }, status: "lost" },
              ] },
            ],
          } as never,
          {
            $set: {
              lifecycleStatus: "resolved",
              resolvedAt: new Date(),
              resolvedBy: req.userId!,
            },
            $inc: { claimRevision: 1 },
          },
          { returnDocument: "after", runValidators: true, session },
        );
        if (!resolved) {
          const visible = await Item.findOne({
            _id: req.params.id,
            ...(isStaff ? {} : { ownerId: req.userId! }),
          }).session(session);
          if (!visible) throw new ItemNotFound("No item with that id");
          throw new ItemConflict("Only an active, unresolved lost report can be resolved");
        }
      });
      res.json(toItemDto(resolved, { includeStaffFields: isStaff }));
    } catch (err) {
      if (err instanceof ItemNotFound) {
        res.status(404).json({ message: err.message });
        return;
      }
      if (err instanceof ItemConflict) {
        res.status(409).json({ message: err.message });
        return;
      }
      next(err);
    } finally {
      await session.endSession();
    }
  },
);

itemRouter.post(
  "/:id/custody/confirm",
  requireAuth,
  requireRole("security", "admin"),
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    try {
      const confirmedAt = new Date();
      const item = await Item.findOneAndUpdate(
        {
          $and: [
            { _id: req.params.id, archivedAt: null },
            staffMayConfirmCustodyFilter,
            { $or: [
              { reportType: "found", lifecycleStatus: "open", status: "found" },
              { reportType: "found", lifecycleStatus: "reserved", status: "claimed" },
              { reportType: { $exists: false }, lifecycleStatus: { $exists: false }, status: "found" },
            ] },
          ],
        } as never,
        {
          $set: {
            custodyStatus: "security_confirmed",
            custodyConfirmedAt: confirmedAt,
            custodyConfirmedBy: req.userId!,
          },
        },
        { returnDocument: "after", runValidators: true },
      );
      if (!item) {
        const alreadyConfirmed = await Item.findOne({
          _id: req.params.id,
          archivedAt: null,
          reportType: "found",
          custodyStatus: "security_confirmed",
          custodyConfirmedAt: { $type: "date" },
          custodyConfirmedBy: { $type: "objectId" },
          $or: [
            { reportType: "found", lifecycleStatus: "open", status: "found" },
            { reportType: "found", lifecycleStatus: "reserved", status: "claimed" },
            { reportType: "found", lifecycleStatus: "returned", status: "claimed" },
            { reportType: { $exists: false }, lifecycleStatus: { $exists: false }, status: "found" },
          ],
        } as never);
        if (alreadyConfirmed) {
          res.json(toItemDto(alreadyConfirmed, { includeStaffFields: true }));
          return;
        }
        res.status(409).json({ message: "This report cannot be confirmed as in campus security custody" });
        return;
      }
      res.json(toItemDto(item, { includeStaffFields: true }));
    } catch (err) {
      next(err);
    }
  },
);

itemRouter.delete(
  "/:id",
  requireAuth,
  async (
    req: Request<IdParam>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const itemToArchive = await Item.findOneAndUpdate(
          {
            _id: req.params.id,
            ownerId: req.userId!,
            archivedAt: null,
          },
          { $inc: { claimRevision: 1 } },
          { returnDocument: "after", runValidators: true, session },
        );

        if (!itemToArchive) {
          const existingItem = await Item.findOne({
            _id: req.params.id,
            ownerId: req.userId!,
          }).session(session);
          if (!existingItem) throw new ItemNotFound("No item with that id");
          if (existingItem.archivedAt) return;
          throw new ItemConflict("This report could not be archived");
        }

        const itemState = classifyItemState(itemToArchive);
        if (itemState.reportType === "unknown" || itemState.lifecycleStatus === "unknown") {
          throw new ItemConflict("This historical report has an ambiguous state and requires staff review before archival");
        }
        if (itemState.lifecycleStatus === "reserved") {
          throw new ItemConflict("A reserved item cannot be archived while it is awaiting handover");
        }

        const hasPendingClaim = await Claim.exists({ itemId: req.params.id, status: "pending" }).session(session);
        if (hasPendingClaim) throw new ItemConflict("Items with pending claims cannot be archived");

        let completedClaimId: unknown;
        if (itemState.lifecycleStatus === "returned") {
          const handoverAt = itemToArchive.handoverAt;
          const handoverClaimId = itemToArchive.handoverClaimId;
          const handoverBy = itemToArchive.handoverBy;
          if (!handoverAt || !handoverClaimId || !handoverBy || itemToArchive.reservedClaimId?.toString() !== handoverClaimId.toString()) {
            throw new ItemConflict("This returned report has no complete, matching handover record and requires staff review");
          }
          const completedClaim = await Claim.findOne({
            _id: handoverClaimId,
            itemId: req.params.id,
            status: "approved",
            handoverAt,
            handoverBy,
          }).session(session);
          if (!completedClaim) {
            throw new ItemConflict("The Claim handover record does not match this returned report");
          }
          completedClaimId = completedClaim._id;
        }

        const unresolvedApprovedClaim = await Claim.exists({
          itemId: req.params.id,
          status: "approved",
          ...(completedClaimId ? { _id: { $ne: completedClaimId } } : {}),
        }).session(session);
        if (unresolvedApprovedClaim) {
          throw new ItemConflict("An approved Claim without a matching completed handover is still active");
        }

        const archivedItem = await Item.findOneAndUpdate(
          { _id: req.params.id, ownerId: req.userId!, archivedAt: null },
          { $set: { archivedAt: new Date() } },
          { returnDocument: "after", runValidators: true, session },
        );
        if (!archivedItem) throw new ItemConflict("This report could not be archived");
      });
    } catch (err) {
      if (err instanceof ItemNotFound) {
        res.status(404).json({ message: err.message });
        return;
      }
      if (err instanceof ItemConflict) {
        res.status(409).json({ message: err.message });
        return;
      }
      next(err);
      return;
    } finally {
      await session.endSession();
    }

    res.status(204).send();
  },
);
