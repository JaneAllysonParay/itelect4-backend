import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Claim } from "../models/Claim.js";
import { Item } from "../models/Item.js";
import type { NewClaimBody } from "../types/index.js";

export const claimRouter = Router();

claimRouter.use(requireAuth);

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
