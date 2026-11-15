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
  reportType: {
    type: String,
    enum: ["lost", "found"],
  },
  lifecycleStatus: {
    type: String,
    enum: ["open", "reserved", "returned", "resolved"],
  },
  eventAt: {
    type: Date,
  },
  category: {
    type: String,
    enum: ["electronics", "clothing", "bags", "keys", "documents", "accessories", "other"],
  },
  custodyStatus: {
    type: String,
    enum: ["finder_reported", "security_reported", "security_confirmed"],
  },
  custodyConfirmedAt: {
    type: Date,
  },
  custodyConfirmedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  reservedAt: {
    type: Date,
  },
  reservedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  reservedClaimId: {
    type: Schema.Types.ObjectId,
    ref: "Claim",
  },
  resolvedAt: {
    type: Date,
  },
  resolvedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  handoverAt: {
    type: Date,
  },
  handoverBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  handoverClaimId: {
    type: Schema.Types.ObjectId,
    ref: "Claim",
  },
  handoverInternalNote: {
    type: String,
    trim: true,
    maxlength: [1000, "Handover note cannot exceed 1000 characters"],
  },
  status: {
    type: String,
    enum: ["lost", "found", "claimed"],
    required: [true, "Status is required"],
    lowercase: true,
    trim: true,
  },
  archivedAt: {
    type: Date,
    default: null,
  },
  claimRevision: {
    type: Number,
    select: false,
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
    delete ret.claimRevision;
    return ret;
  },
});

export const Item = model<ItemDoc>("Item", itemSchema);

