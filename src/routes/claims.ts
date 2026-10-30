import { Router, type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
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

export const claimRouter = Router();

claimRouter.use(requireAuth);

claimRouter.get(
  "/received",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ownedItems = await Item.find({ ownerId: req.userId }).select("_id");
      const claims = await Claim.find({
        itemId: { $in: ownedItems.map((item) => item._id) },
      }).sort({
        claimDate: -1,
        _id: -1,
      });

      res.json(claims);
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

      const itemExists = await Item.exists({ _id: itemId });
      if (!itemExists) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }

      const claim = await Claim.create({
        itemId,
        claimantId: req.userId!,
        proof,
      });

      res.status(201).json(claim);
    } catch (err) {
      next(err);
    }
  },
);

claimRouter.patch(
  "/:id/status",
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

      const item = await Item.findById(claim.itemId);
      if (!item) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }

      if (String(item.ownerId) !== req.userId) {
        res.status(403).json({
          message: "You cannot decide claims for this item",
        });
        return;
      }

      const session = await mongoose.startSession();
      let decidedClaim: ClaimDoc | null = null;

      try {
        await session.withTransaction(async () => {
          const updatedClaim = await Claim.findOneAndUpdate(
            { _id: req.params.id, status: "pending" },
            { $set: { status } },
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
                ownerId: req.userId,
                status: { $ne: "claimed" },
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
