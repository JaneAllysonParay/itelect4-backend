import { Router, type NextFunction, type Request, type Response } from "express";
import mongoose, { type PipelineStage } from "mongoose";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { Claim } from "../models/Claim.js";
import { Item } from "../models/Item.js";
import { User } from "../models/User.js";
import type { ClaimDoc } from "../types/index.js";
import { toItemDto } from "../utils/itemDto.js";
import { hasSufficientFoundCustody, sufficientFoundCustodyFilter } from "../utils/custody.js";
import { paginationQuerySchema, setPaginationHeaders } from "../utils/pagination.js";

interface IdParam { id: string }

class ClaimDecisionConflict extends Error {}
class ClaimSubmissionConflict extends Error {}
class HandoverConflict extends Error {}
class PickupInstructionConflict extends Error {}

const queueSchema = z.enum([
  "pending",
  "awaiting_handover",
  "completed",
  "rejected",
  "legacy",
]).default("pending");

const newClaimSchema = z.object({
  itemId: z.string().trim().min(1).max(100),
  proof: z.string().trim().min(5).max(1000),
});

const decisionSchema = z.object({ status: z.enum(["approved", "rejected"]) });
const handoverSchema = z.object({
  confirmed: z.literal(true),
  internalNote: z.string().trim().max(1000).optional(),
});
const pickupInstructionsSchema = z.object({
  pickupInstructions: z.string().trim().min(5).max(1000),
});

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === 11000;
}

function isFoundOpen(value: unknown): boolean {
  const item = jsonRecord(value);
  return ((item.reportType === "found" && item.lifecycleStatus === "open" && item.status === "found") ||
    (item.reportType === undefined && item.lifecycleStatus === undefined && item.status === "found")) &&
    hasSufficientFoundCustody(item);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const maybeDocument = value as { toObject?: () => Record<string, unknown> };
  return typeof maybeDocument.toObject === "function"
    ? maybeDocument.toObject()
    : value as Record<string, unknown>;
}

function dateTime(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function hasMatchingHandover(claim: Record<string, unknown>, item: Record<string, unknown>, claimId: string): boolean {
  const claimAt = dateTime(claim.handoverAt);
  const itemAt = dateTime(item.handoverAt);
  const itemId = String(item.id ?? item._id ?? "");
  const claimItemId = String(claim.itemId ?? "");
  const claimActor = String(claim.handoverBy ?? "");
  const itemActor = String(item.handoverBy ?? "");
  return claim.status === "approved" &&
    claimAt !== null && claimAt === itemAt &&
    claimActor.length > 0 && itemActor.length > 0 && claimActor === itemActor &&
    String(item.reportType) === "found" &&
    String(item.lifecycleStatus) === "returned" &&
    String(item.status) === "claimed" &&
    claimItemId === itemId &&
    String(item.reservedClaimId ?? "") === claimId &&
    String(item.handoverClaimId ?? "") === claimId;
}

function hasNoHandoverMetadata(claim: Record<string, unknown>, item: Record<string, unknown>): boolean {
  return claim.handoverAt === undefined && claim.handoverBy === undefined &&
    item.handoverAt === undefined && item.handoverBy === undefined &&
    item.handoverClaimId === undefined && item.handoverInternalNote === undefined;
}

function hasMatchingReservation(claim: Record<string, unknown>, item: Record<string, unknown>, claimId: string): boolean {
  return claim.status === "approved" &&
    String(claim.itemId ?? "") === String(item.id ?? item._id ?? "") &&
    item.reportType === "found" && item.lifecycleStatus === "reserved" && item.status === "claimed" &&
    String(item.reservedClaimId ?? "") === claimId &&
    (item.archivedAt === undefined || item.archivedAt === null);
}

export type ApprovedClaimQueue = "awaiting_handover" | "completed" | "legacy";

/** Shared application-level classification used for API state and regression tests. */
export function classifyApprovedClaimQueue(claimValue: unknown, itemValue: unknown | null): ApprovedClaimQueue {
  const claim = jsonRecord(claimValue);
  const item = itemValue === null ? null : jsonRecord(itemValue);
  if (item === null) return "legacy";
  const id = String(claim.id ?? claim._id ?? "");
  if (hasMatchingHandover(claim, item, id)) return "completed";
  if (hasMatchingReservation(claim, item, id) && hasNoHandoverMetadata(claim, item)) return "awaiting_handover";
  return "legacy";
}

function claimDto(claim: unknown, item: unknown | null, options: {
  staff?: boolean;
  hideClaimant?: boolean;
  hidePrivateFields?: boolean;
  hideStaffActors?: boolean;
} = {}) {
  const dto = jsonRecord(claim);
  const id = String(dto.id ?? dto._id ?? "");
  const claimant = dto.claimant;
  delete dto.claimant;
  delete dto._id;
  delete dto.__v;
  dto.id = id;
  if (dto.itemId !== undefined) dto.itemId = String(dto.itemId);
  if (dto.claimantId !== undefined) dto.claimantId = String(dto.claimantId);
  if (dto.reviewedBy !== undefined) dto.reviewedBy = String(dto.reviewedBy);
  if (dto.handoverBy !== undefined) dto.handoverBy = String(dto.handoverBy);
  const itemRecord = jsonRecord(item);
  const approvedWorkflowStatus = dto.status === "approved" ? classifyApprovedClaimQueue(dto, item) : null;
  if (approvedWorkflowStatus !== null) dto.approvedWorkflowStatus = approvedWorkflowStatus;
  const verifiedHandover = approvedWorkflowStatus === "completed";
  if (dto.handoverAt !== undefined && !verifiedHandover) {
    delete dto.handoverAt;
    delete dto.handoverBy;
  }
  const activeReservation = approvedWorkflowStatus === "awaiting_handover";
  if (!activeReservation) delete dto.pickupInstructions;
  if (options.staff && typeof claimant === "object" && claimant !== null) {
    const staffClaimant = claimant as Record<string, unknown>;
    dto.claimant = {
      name: typeof staffClaimant.name === "string" ? staffClaimant.name : "",
      email: typeof staffClaimant.email === "string" ? staffClaimant.email : "",
    };
  }
  if (options.hideClaimant) delete dto.claimantId;
  if (options.hidePrivateFields) {
    delete dto.proof;
    delete dto.pickupInstructions;
    delete dto.handoverBy;
  }
  if (options.hideStaffActors) {
    delete dto.reviewedBy;
    delete dto.handoverBy;
  }
  return {
    ...dto,
    item: item
      ? toItemDto(
          itemRecord.lifecycleStatus === "returned" && !verifiedHandover
            ? { ...itemRecord, lifecycleStatus: null }
            : item,
          { includeStaffFields: options.staff },
        )
      : null,
  };
}

const itemProjection = [
  "_id title description location dateReported reportType lifecycleStatus eventAt category custodyStatus",
  "status archivedAt ownerId reservedAt reservedBy reservedClaimId resolvedAt resolvedBy",
  "handoverAt handoverBy handoverClaimId handoverInternalNote custodyConfirmedAt custodyConfirmedBy",
].join(" ");

const validReservationExpression = {
  $and: [
    { $eq: ["$item.reportType", "found"] },
    { $eq: ["$item.lifecycleStatus", "reserved"] },
    { $eq: ["$item.status", "claimed"] },
    { $eq: ["$item.reservedClaimId", "$_id"] },
    { $eq: [{ $ifNull: ["$item.archivedAt", null] }, null] },
  ],
};

const noHandoverMetadataExpression = {
  $and: [
    { $eq: [{ $type: "$handoverAt" }, "missing"] },
    { $eq: [{ $type: "$handoverBy" }, "missing"] },
    { $eq: [{ $type: "$item.handoverAt" }, "missing"] },
    { $eq: [{ $type: "$item.handoverBy" }, "missing"] },
    { $eq: [{ $type: "$item.handoverClaimId" }, "missing"] },
    { $eq: [{ $type: "$item.handoverInternalNote" }, "missing"] },
  ],
};

const validCompletionExpression = {
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

function itemJoinStages(): PipelineStage[] {
  return [
    { $lookup: { from: Item.collection.name, localField: "itemId", foreignField: "_id", as: "joinedItems" } },
    { $set: { item: { $arrayElemAt: ["$joinedItems", 0] } } },
  ] as PipelineStage[];
}

function staffClaimantJoinStages(): PipelineStage[] {
  return [
    {
      $lookup: {
        from: User.collection.name,
        let: { claimantId: "$claimantId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$claimantId"] } } },
          { $project: { _id: 0, name: 1, email: 1 } },
        ],
        as: "claimant",
      },
    },
    { $set: { claimant: { $arrayElemAt: ["$claimant", 0] } } },
  ] as PipelineStage[];
}

async function sendPaginatedClaims(
  res: Response,
  page: number,
  limit: number,
  stages: PipelineStage[],
  options: Parameters<typeof claimDto>[2],
): Promise<void> {
  const [result] = await Claim.aggregate([
    ...stages,
    {
      $facet: {
        rows: [
          { $sort: { claimDate: -1 as const, _id: -1 as const } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $project: { joinedItems: 0, _isValidReservation: 0, _isValidCompletion: 0, _isNoHandoverMetadata: 0 } },
        ],
        count: [{ $count: "value" }],
      },
    },
  ] as PipelineStage[]);
  const total = Number(result?.count?.[0]?.value ?? 0);
  setPaginationHeaders(res, page, limit, total);
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  res.json(rows.map((row) => {
    const item = row.item ?? null;
    const claim = { ...row };
    delete claim.item;
    return claimDto(claim, item, options);
  }));
}

export const claimRouter = Router();
claimRouter.use(requireAuth);

claimRouter.get(
  "/received",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsedPage = paginationQuerySchema.safeParse(req.query);
    if (!parsedPage.success) {
      res.status(400).json({ message: "Invalid pagination values", errors: parsedPage.error.issues.map((issue) => issue.message) });
      return;
    }
    const { page, limit } = parsedPage.data;
    try {
      await sendPaginatedClaims(res, page, limit, [
        ...itemJoinStages(),
        { $match: { $expr: { $eq: [{ $toString: "$item.ownerId" }, req.userId] } } },
      ], { hideClaimant: true, hidePrivateFields: true, hideStaffActors: true });
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.get(
  "/review",
  requireRole("security", "admin"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsedQueue = queueSchema.safeParse(req.query.queue ?? "pending");
    if (!parsedQueue.success) {
      res.status(400).json({ message: "queue must be pending, awaiting_handover, completed, rejected, or legacy" });
      return;
    }
    const queue = parsedQueue.data;
    const parsedPage = paginationQuerySchema.safeParse(req.query);
    if (!parsedPage.success) {
      res.status(400).json({ message: "Invalid pagination values", errors: parsedPage.error.issues.map((issue) => issue.message) });
      return;
    }
    const { page, limit } = parsedPage.data;

    try {
      const initialStatus = queue === "pending" ? "pending" : queue === "rejected" ? "rejected" : "approved";
      const stages: PipelineStage[] = [
        { $match: { status: initialStatus } },
        ...itemJoinStages(),
        ...staffClaimantJoinStages(),
      ];
      if (queue === "awaiting_handover" || queue === "completed" || queue === "legacy") {
        stages.push({
          $set: {
            _isValidReservation: validReservationExpression,
            _isValidCompletion: validCompletionExpression,
            _isNoHandoverMetadata: noHandoverMetadataExpression,
          },
        });
        if (queue === "awaiting_handover") {
          stages.push({
            $match: {
              $expr: {
                $and: ["$_isValidReservation", "$_isNoHandoverMetadata", { $not: ["$_isValidCompletion"] }],
              },
            },
          });
        } else if (queue === "completed") {
          stages.push({ $match: { _isValidCompletion: true } });
        } else {
          stages.push({
            $match: {
              $expr: {
                $not: [
                  {
                    $or: [
                      "$_isValidCompletion",
                      { $and: ["$_isValidReservation", "$_isNoHandoverMetadata"] },
                    ],
                  },
                ],
              },
            },
          });
        }
      }
      await sendPaginatedClaims(res, page, limit, stages, { staff: true, hideClaimant: true });
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsedPage = paginationQuerySchema.safeParse(req.query);
    if (!parsedPage.success) {
      res.status(400).json({ message: "Invalid pagination values", errors: parsedPage.error.issues.map((issue) => issue.message) });
      return;
    }
    const { page, limit } = parsedPage.data;
    try {
      await sendPaginatedClaims(res, page, limit, [
        { $match: { $expr: { $eq: [{ $toString: "$claimantId" }, req.userId] } } },
        ...itemJoinStages(),
      ], { hideStaffActors: true });
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = newClaimSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Item and valid ownership proof are required" });
      return;
    }
    const { itemId, proof } = parsed.data;

    try {
      const item = await Item.findOne({ _id: itemId, archivedAt: null });
      if (!item) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }
      if (String(item.ownerId) === req.userId) {
        res.status(403).json({ message: "You cannot claim your own item" });
        return;
      }
      if (!isFoundOpen(item)) {
        res.status(409).json({ message: "Only open found reports with valid custody information are eligible to claim" });
        return;
      }

      const existingClaim = await Claim.exists({ itemId, claimantId: req.userId });
      if (existingClaim) {
        res.status(409).json({ message: "You have already submitted a claim for this item" });
        return;
      }

      const session = await mongoose.startSession();
      let createdClaim: ClaimDoc | null = null;
      try {
        await session.withTransaction(async () => {
          const availableItem = await Item.findOneAndUpdate(
            {
              $and: [
                { _id: itemId, ownerId: { $ne: req.userId }, archivedAt: null },
                { $or: [
                  { reportType: "found", lifecycleStatus: "open", status: "found" },
                  { reportType: { $exists: false }, lifecycleStatus: { $exists: false }, status: "found" },
                ] },
                sufficientFoundCustodyFilter,
              ],
            } as never,
            { $inc: { claimRevision: 1 } },
            { returnDocument: "after", runValidators: true, session },
          );
          if (!availableItem) {
            throw new ClaimSubmissionConflict("This item is no longer available to claim");
          }

          const anyPreviousClaim = await Claim.findOne({ itemId, claimantId: req.userId }).session(session);
          if (anyPreviousClaim) {
            throw new ClaimSubmissionConflict("You have already submitted a claim for this item");
          }

          const [claim] = await Claim.create(
            [{ itemId, claimantId: req.userId!, proof }],
            { session },
          );
          createdClaim = claim;
        });
      } catch (err) {
        if (err instanceof ClaimSubmissionConflict) {
          res.status(409).json({ message: err.message });
          return;
        }
        if (isDuplicateKeyError(err)) {
          res.status(409).json({ message: "You have already submitted a claim for this item" });
          return;
        }
        next(err);
        return;
      } finally {
        await session.endSession();
      }
      res.status(201).json(createdClaim);
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.patch(
  "/:id/status",
  requireRole("security", "admin"),
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Status must be approved or rejected" });
      return;
    }
    const { status } = parsed.data;

    try {
      const claim = await Claim.findById(req.params.id);
      if (!claim) {
        res.status(404).json({ message: "No claim with that id" });
        return;
      }
      if (claim.status !== "pending") {
        res.status(409).json({ message: "Only pending claims can be decided" });
        return;
      }

      const session = await mongoose.startSession();
      let decidedClaim: ClaimDoc | null = null;
      const decisionAt = new Date();
      try {
        await session.withTransaction(async () => {
          const updatedClaim = await Claim.findOneAndUpdate(
            { _id: req.params.id, status: "pending" },
            {
              $set: {
                status,
                reviewedAt: decisionAt,
                reviewedBy: req.userId,
                decisionAt,
                decisionSource: "staff",
              },
            },
            { returnDocument: "after", runValidators: true, session },
          );
          if (!updatedClaim) throw new ClaimDecisionConflict("This claim has already been decided");
          decidedClaim = updatedClaim;

          if (status === "approved") {
            const item = await Item.findOneAndUpdate(
              {
                $and: [
                  { _id: claim.itemId, archivedAt: null },
                  { $or: [
                    { reportType: "found", lifecycleStatus: "open", status: "found" },
                    { reportType: { $exists: false }, lifecycleStatus: { $exists: false }, status: "found" },
                  ] },
                  sufficientFoundCustodyFilter,
                ],
              } as never,
              {
                $set: {
                  status: "claimed",
                  reportType: "found",
                  lifecycleStatus: "reserved",
                  reservedAt: decisionAt,
                  reservedBy: req.userId,
                  reservedClaimId: req.params.id,
                },
                $inc: { claimRevision: 1 },
              },
              { returnDocument: "after", runValidators: true, session },
            );
            if (!item) throw new ClaimDecisionConflict("This item is already reserved or unavailable");

            await Claim.updateMany(
              { itemId: claim.itemId, _id: { $ne: req.params.id }, status: "pending" },
              {
                $set: {
                  status: "rejected",
                  decisionSource: "system",
                  decisionReason: "This item is no longer available",
                  decisionAt,
                },
              },
              { runValidators: true, session },
            );
          }
        });
      } catch (err) {
        if (err instanceof ClaimDecisionConflict) {
          res.status(409).json({ message: err.message });
          return;
        }
        next(err);
        return;
      } finally {
        await session.endSession();
      }
      res.json(decidedClaim);
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.patch(
  "/:id/pickup-instructions",
  requireRole("security", "admin"),
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    const parsed = pickupInstructionsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Pickup instructions must be 5 to 1000 characters" });
      return;
    }
    const session = await mongoose.startSession();
    try {
      let updated: ClaimDoc | null = null;
      await session.withTransaction(async () => {
        const claim = await Claim.findById(req.params.id).session(session);
        if (!claim || claim.status !== "approved") {
          throw new PickupInstructionConflict("Only approved claims awaiting handover can receive pickup instructions");
        }
        const item = await Item.findOne({
          _id: claim.itemId,
          reportType: "found",
          lifecycleStatus: "reserved",
          status: "claimed",
          reservedClaimId: claim._id,
          archivedAt: null,
          handoverAt: { $exists: false },
          handoverBy: { $exists: false },
          handoverClaimId: { $exists: false },
          handoverInternalNote: { $exists: false },
        } as never).session(session);
        if (!item || classifyApprovedClaimQueue(claim, item) !== "awaiting_handover") {
          throw new PickupInstructionConflict("This approved claim is a legacy or unavailable case requiring staff review");
        }
        updated = await Claim.findOneAndUpdate(
          { _id: req.params.id, status: "approved", handoverAt: { $exists: false }, handoverBy: { $exists: false } },
          { $set: { pickupInstructions: parsed.data.pickupInstructions } },
          { returnDocument: "after", runValidators: true, session },
        );
        if (!updated) throw new PickupInstructionConflict("This claim changed and cannot be updated");
      });
      res.json(updated);
    } catch (err) {
      if (err instanceof PickupInstructionConflict) {
        res.status(409).json({ message: err.message });
        return;
      }
      next(err);
    } finally {
      await session.endSession();
    }
  },
);

claimRouter.post(
  "/:id/handover",
  requireRole("security", "admin"),
  async (req: Request<IdParam>, res: Response, next: NextFunction): Promise<void> => {
    const parsed = handoverSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Explicit confirmation that physical handover occurred is required" });
      return;
    }
    const session = await mongoose.startSession();
    try {
      const handoverAt = new Date();
      let handedOver: ClaimDoc | null = null;
      await session.withTransaction(async () => {
        const claim = await Claim.findOneAndUpdate(
          {
            _id: req.params.id,
            status: "approved",
            handoverAt: { $exists: false },
            handoverBy: { $exists: false },
          },
          {
            $set: {
              handoverAt,
              handoverBy: req.userId,
            },
          },
          { returnDocument: "after", runValidators: true, session },
        );
        if (!claim) throw new HandoverConflict("Only an approved claim without a recorded handover can be confirmed");

        const item = await Item.findOneAndUpdate(
          {
            _id: claim.itemId,
            reportType: "found",
            lifecycleStatus: "reserved",
            status: "claimed",
            reservedClaimId: claim._id,
            archivedAt: null,
            handoverAt: { $exists: false },
            handoverBy: { $exists: false },
            handoverClaimId: { $exists: false },
            handoverInternalNote: { $exists: false },
          } as never,
          {
            $set: {
              lifecycleStatus: "returned",
              handoverAt,
              handoverBy: req.userId,
              handoverClaimId: claim._id,
              handoverInternalNote: parsed.data.internalNote,
            },
          },
          { returnDocument: "after", runValidators: true, session },
        );
        if (!item) throw new HandoverConflict("The item is not reserved for this claim or is unavailable; historical cases require staff review");
        handedOver = claim;
      });

      const item = handedOver
        ? await Item.findById((handedOver as ClaimDoc).itemId).select(itemProjection)
        : null;
      res.json(claimDto(handedOver, item, { staff: true }));
    } catch (err) {
      if (err instanceof HandoverConflict) {
        res.status(409).json({ message: err.message });
        return;
      }
      next(err);
    } finally {
      await session.endSession();
    }
  },
);
