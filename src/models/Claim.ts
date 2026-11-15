import { model, Schema } from "mongoose";
import type { ClaimDoc } from "../types/index.js";

const claimSchema = new Schema<ClaimDoc>({
  itemId: {
    type: Schema.Types.ObjectId,
    ref: "Item",
    required: true,
  },
  claimantId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  claimDate: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  proof: {
    type: String,
    required: [true, "Proof is required"],
    trim: true,
    minlength: [5, "Proof must be at least 5 characters"],
    maxlength: [1000, "Proof cannot exceed 1000 characters"],
  },
  reviewedAt: {
    type: Date,
  },
  reviewedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  decisionSource: {
    type: String,
    enum: ["staff", "system"],
  },
  decisionReason: {
    type: String,
    trim: true,
    maxlength: [500, "Decision reason cannot exceed 500 characters"],
  },
  decisionAt: {
    type: Date,
  },
  handoverAt: {
    type: Date,
  },
  handoverBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  pickupInstructions: {
    type: String,
    trim: true,
    maxlength: [1000, "Pickup instructions cannot exceed 1000 characters"],
  },
});

claimSchema.set("toJSON", {
  transform: (_document, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

claimSchema.index({ claimantId: 1, claimDate: -1, _id: -1 });
claimSchema.index({ itemId: 1, claimDate: -1, _id: -1 });
claimSchema.index({ status: 1, claimDate: -1, _id: -1 });

export const Claim = model<ClaimDoc>("Claim", claimSchema);
