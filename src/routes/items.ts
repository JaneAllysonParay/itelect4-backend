import { Router, type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import { Claim } from "../models/Claim.js";
import { Item } from "../models/Item.js";
import { requireAuth } from "../middleware/auth.js";
import type { NewItemBody } from "../types/index.js";

interface IdParam {
  id: string;
}

class ItemArchiveConflict extends Error {}
class ItemNotFound extends Error {}

export const itemRouter = Router();

itemRouter.get(
  "/",
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await Item.find({ archivedAt: null }).sort({
        dateReported: -1,
        _id: 1,
      });

      res.json(items);
    } catch (err) {
      next(err);
    }
  }
);

itemRouter.get(
  "/:id",
  async (
    req: Request<IdParam>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const item = await Item.findOne({
        _id: req.params.id,
        archivedAt: null,
      });

      if (!item) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }

      res.json(item);
    } catch (err) {
      next(err);
    }
  }
);

itemRouter.post(
  "/",
  requireAuth,
  async (
    req: Request<Record<string, string>, unknown, NewItemBody>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { title, description, location, status } = req.body ?? {};

      if (status !== "lost" && status !== "found") {
        res.status(400).json({ message: "Status must be lost or found" });
        return;
      }

      const item = await Item.create({
        title,
        description,
        location,
        status,
        ownerId: req.userId!,
      });

      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  }
);

itemRouter.patch(
  "/:id",
  requireAuth,
  async (
    req: Request<IdParam, unknown, Partial<NewItemBody>>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const body = req.body;
      const update: Partial<NewItemBody> = {};

      if (
        body.status !== undefined &&
        body.status !== "lost" &&
        body.status !== "found"
      ) {
        res.status(400).json({ message: "Status must be lost or found" });
        return;
      }

      if (body.title !== undefined) update.title = body.title;
      if (body.description !== undefined) update.description = body.description;
      if (body.location !== undefined) update.location = body.location;
      if (body.status !== undefined) update.status = body.status;

      const filter = {
        _id: req.params.id,
        ownerId: req.userId!,
        archivedAt: null,
        status: { $ne: "claimed" },
      };

      const item = await Item.findOneAndUpdate(
        filter as never,
        update,
        {
          returnDocument: "after",
          runValidators: true,
        }
      );

      if (!item) {
        const existingOwnedItem = await Item.findOne({
          _id: req.params.id,
          ownerId: req.userId!,
        });

        if (
          existingOwnedItem &&
          !existingOwnedItem.archivedAt &&
          existingOwnedItem.status === "claimed"
        ) {
          res.status(409).json({ message: "Claimed items cannot be edited" });
          return;
        }

        res.status(404).json({ message: "No item with that id" });
        return;
      }

      res.json(item);
    } catch (err) {
      next(err);
    }
  }
);

itemRouter.delete(
  "/:id",
  requireAuth,
  async (
    req: Request<IdParam>,
    res: Response,
    next: NextFunction
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

          if (!existingItem) {
            throw new ItemNotFound("No item with that id");
          }

          if (existingItem.archivedAt) {
            return;
          }

          throw new ItemArchiveConflict("This item could not be archived");
        }

        const activeClaim = await Claim.findOne({
          itemId: req.params.id,
          status: { $in: ["pending", "approved"] },
        }).session(session);

        if (activeClaim) {
          throw new ItemArchiveConflict(
            "Items with pending or approved claims cannot be archived",
          );
        }

        const archivedItem = await Item.findOneAndUpdate(
          {
            _id: req.params.id,
            ownerId: req.userId!,
            archivedAt: null,
          },
          { $set: { archivedAt: new Date() } },
          { returnDocument: "after", runValidators: true, session },
        );

        if (!archivedItem) {
          throw new ItemArchiveConflict("This item could not be archived");
        }
      });
    } catch (err) {
      if (err instanceof ItemNotFound) {
        res.status(404).json({ message: err.message });
        return;
      }
      if (err instanceof ItemArchiveConflict) {
        res.status(409).json({ message: err.message });
        return;
      }
      next(err);
      return;
    } finally {
      await session.endSession();
    }

    res.status(204).send();
  }
);
