import { Router, type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { Claim } from "../models/Claim.js";
import { Item } from "../models/Item.js";
import type { ClaimDoc, NewClaimBody } from "../types/index.js";

interface IdParam {
  id: string;
}

interface ClaimDecisionBody {
  status?: string;
}

class ClaimDecisionConflict extends Error {}
class ClaimSubmissionConflict extends Error {}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === 11000
  );
}

export const claimRouter = Router();

claimRouter.use(requireAuth);

claimRouter.get(
  "/received",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ownedItems = await Item.find({ ownerId: req.userId }).select(
        "_id title description location dateReported status archivedAt",
      );
      const claims = await Claim.find({
        itemId: { $in: ownedItems.map((item) => item._id) },
      })
        .select("-proof")
        .sort({
          claimDate: -1,
          _id: -1,
        });

      const itemsById = new Map(
        ownedItems.map((item) => [String(item._id), item]),
      );
      res.json(
        claims.map((claim) => ({
          ...claim.toJSON(),
          item: itemsById.get(String(claim.itemId))?.toJSON() ?? null,
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.get(
  "/review",
  requireRole("security", "admin"),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const claims = await Claim.find({ status: "pending" })
        .select("-claimantId")
        .sort({
          claimDate: -1,
          _id: -1,
        });
      const items = await Item.find({
        _id: { $in: claims.map((claim) => claim.itemId) },
      }).select(
        "_id title description location dateReported status archivedAt",
      );
      const itemsById = new Map(items.map((item) => [String(item._id), item]));

      res.json(
        claims.map((claim) => ({
          ...claim.toJSON(),
          item: itemsById.get(String(claim.itemId))?.toJSON() ?? null,
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const claims = await Claim.find({ claimantId: req.userId }).sort({
        claimDate: -1,
        _id: -1,
      });

      res.json(claims);
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.post(
  "/",
  async (
    req: Request<Record<string, string>, unknown, NewClaimBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { itemId, proof } = req.body ?? {};

      if (typeof itemId !== "string" || typeof proof !== "string") {
        res.status(400).json({ message: "Item and proof are required" });
        return;
      }

      const item = await Item.findOne({ _id: itemId, archivedAt: null });
      if (!item) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }

      if (String(item.ownerId) === req.userId) {
        res.status(403).json({ message: "You cannot claim your own item" });
        return;
      }

      if (item.status !== "found") {
        res.status(409).json({ message: "Only found items are eligible to claim" });
        return;
      }

      const existingClaim = await Claim.exists({
        itemId,
        claimantId: req.userId,
      });
      if (existingClaim) {
        res.status(409).json({
          message: "You have already submitted a claim for this item",
        });
        return;
      }

      const session = await mongoose.startSession();
      let createdClaim: ClaimDoc | null = null;

      try {
        await session.withTransaction(async () => {
          const availableItem = await Item.findOneAndUpdate(
            {
              _id: itemId,
              ownerId: { $ne: req.userId },
              status: "found",
              archivedAt: null,
            },
            { $inc: { claimRevision: 1 } },
            { returnDocument: "after", runValidators: true, session },
          );

          if (!availableItem) {
            throw new ClaimSubmissionConflict(
              "This item is no longer available to claim",
            );
          }

          const activeClaim = await Claim.findOne({
            itemId,
            claimantId: req.userId,
          }).session(session);

          if (activeClaim) {
            throw new ClaimSubmissionConflict(
              "You have already submitted a claim for this item",
            );
          }

          const [claim] = await Claim.create(
            [
              {
                itemId,
                claimantId: req.userId!,
                proof,
              },
            ],
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
          res.status(409).json({
            message: "You have already submitted a claim for this item",
          });
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
  async (
    req: Request<IdParam, unknown, ClaimDecisionBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const status = req.body?.status;
    if (status !== "approved" && status !== "rejected") {
      res.status(400).json({
        message: "Status must be approved or rejected",
      });
      return;
    }

    try {
      const claim = await Claim.findById(req.params.id);
      if (!claim) {
        res.status(404).json({ message: "No claim with that id" });
        return;
      }

      if (claim.status !== "pending") {
        res.status(409).json({
          message: "Only pending claims can be decided",
        });
        return;
      }

      const session = await mongoose.startSession();
      let decidedClaim: ClaimDoc | null = null;
      const reviewedAt = new Date();

      try {
        await session.withTransaction(async () => {
          const updatedClaim = await Claim.findOneAndUpdate(
            { _id: req.params.id, status: "pending" },
            {
              $set: {
                status,
                reviewedAt,
                reviewedBy: req.userId,
              },
            },
            { returnDocument: "after", runValidators: true, session },
          );

          if (!updatedClaim) {
            throw new ClaimDecisionConflict(
              "This claim has already been decided",
            );
          }

          decidedClaim = updatedClaim;

          if (status === "approved") {
            const updatedItem = await Item.findOneAndUpdate(
              {
                _id: claim.itemId,
                status: "found",
                archivedAt: null,
              },
              { $set: { status: "claimed" } },
              { returnDocument: "after", runValidators: true, session },
            );

            if (!updatedItem) {
              throw new ClaimDecisionConflict(
                "This item is already claimed or unavailable",
              );
            }
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
