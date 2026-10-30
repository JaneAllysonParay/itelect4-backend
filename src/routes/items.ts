import { Router, type NextFunction, type Request, type Response } from "express";
import { Item } from "../models/Item.js";
import { requireAuth } from "../middleware/auth.js";
import type { NewItemBody } from "../types/index.js";

interface IdParam {
  id: string;
}

export const itemRouter = Router();

itemRouter.get(
  "/",
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await Item.find().sort({
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

      if (body.title !== undefined) update.title = body.title;
      if (body.description !== undefined) update.description = body.description;
      if (body.location !== undefined) update.location = body.location;
      if (body.status !== undefined) update.status = body.status;

      const item = await Item.findOneAndUpdate(
        {
          _id: req.params.id,
          ownerId: req.userId!,
        },
        update,
        {
          returnDocument: "after",
          runValidators: true,
        }
      );

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

itemRouter.delete(
  "/:id",
  requireAuth,
  async (
    req: Request<IdParam>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const item = await Item.findOneAndDelete({
        _id: req.params.id,
        ownerId: req.userId!,
      });

      if (!item) {
        res.status(404).json({ message: "No item with that id" });
        return;
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
