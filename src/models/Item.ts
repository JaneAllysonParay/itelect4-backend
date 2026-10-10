import { model, Schema } from "mongoose";
import type { ItemDoc } from "../types/index.js";

const itemSchema = new Schema<ItemDoc>({
  title: {
    type: String,
    required: [true, "Title is required"],
    trim: true,
    minlength: [2, "Title must be at least 2 characters"],
    maxlength: [100, "Title cannot exceed 100 characters"],
  },
  description: {
    type: String,
    required: [true, "Description is required"],
    trim: true,
    minlength: [5, "Description must be at least 5 characters"],
    maxlength: [1000, "Description cannot exceed 1000 characters"],
  },
  location: {
    type: String,
    required: [true, "Location is required"],
    trim: true,
    minlength: [2, "Location must be at least 2 characters"],
    maxlength: [200, "Location cannot exceed 200 characters"],
  },
  dateReported: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["lost", "found", "claimed"],
    required: [true, "Status is required"],
    lowercase: true,
    trim: true,
  },
  ownerId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
});

itemSchema.set("toJSON", {
  transform: (_document, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Item = model<ItemDoc>("Item", itemSchema);

