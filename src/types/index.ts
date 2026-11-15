import type { Types } from "mongoose";

export interface User {
  id: string;
  name: string;
  email: string;
  role: "student" | "security" | "admin";
  isActive: boolean;
}

export interface Item {
  id: string;
  title: string;
  description: string;
  location: string;
  dateReported: Date;
  /** Canonical report category. Missing on historical documents. */
  reportType?: "lost" | "found";
  /** Canonical workflow state. Missing on historical documents. */
  lifecycleStatus?: "open" | "reserved" | "returned" | "resolved";
  /** Time the property was lost or found, separate from dateReported. */
  eventAt?: Date;
  category?: "electronics" | "clothing" | "bags" | "keys" | "documents" | "accessories" | "other";
  /** User-reported custody is not staff verification. */
  custodyStatus?: "finder_reported" | "security_reported" | "security_confirmed";
  custodyConfirmedAt?: Date;
  custodyConfirmedBy?: string;
  reservedAt?: Date;
  reservedBy?: string;
  reservedClaimId?: string;
  resolvedAt?: Date;
  resolvedBy?: string;
  handoverAt?: Date;
  handoverBy?: string;
  handoverClaimId?: string;
  handoverInternalNote?: string;
  status: "lost" | "found" | "claimed";
  ownerId: string;
  archivedAt?: Date | null;
  claimRevision?: number;
}

export interface Claim {
  id: string;
  itemId: string;
  claimantId: string;
  claimDate: Date;
  status: "pending" | "approved" | "rejected";
  proof: string;
  reviewedAt?: Date;
  reviewedBy?: string;
  decisionSource?: "staff" | "system";
  decisionReason?: string;
  decisionAt?: Date;
  handoverAt?: Date;
  handoverBy?: string;
  pickupInstructions?: string;
}

export type UserRole = User["role"];

export type UserDoc = Omit<User, "id"> & {
  password: string;
};

export type ItemDoc = Omit<Item, "id" | "ownerId"> & {
  ownerId: Types.ObjectId;
  custodyConfirmedBy?: Types.ObjectId;
  reservedBy?: Types.ObjectId;
  reservedClaimId?: Types.ObjectId;
  resolvedBy?: Types.ObjectId;
  handoverBy?: Types.ObjectId;
  handoverClaimId?: Types.ObjectId;
};

export type ClaimDoc = Omit<
  Claim,
  "id" | "itemId" | "claimantId" | "reviewedBy" | "handoverBy"
> & {
  itemId: Types.ObjectId;
  claimantId: Types.ObjectId;
  reviewedBy?: Types.ObjectId;
  handoverBy?: Types.ObjectId;
};

export type NewClaimBody = Pick<Claim, "proof"> & {
  itemId: string;
};

export type NewItemBody = Pick<Item, "title" | "description" | "location"> & {
  reportType: "lost" | "found";
  eventAt: string;
  category?: Item["category"];
  custodyStatus?: "finder_reported" | "security_reported";
};

export type ItemUpdateBody = Partial<
  Pick<NewItemBody, "title" | "description" | "location" | "eventAt" | "category" | "custodyStatus">
>;

export interface ApiItemDto {
  id: string;
  title: string;
  description: string;
  location: string;
  dateReported: string;
  reportType: "lost" | "found" | "unknown";
  lifecycleStatus: "open" | "reserved" | "returned" | "resolved" | "unknown";
  eventAt: string | null;
  category: Item["category"] | null;
  custodyStatus: Item["custodyStatus"] | null;
  status: Item["status"] | "unknown";
  ownerId: string;
  archivedAt: string | null;
  hasActiveClaims?: boolean;
  canArchive?: boolean;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  reservedAt?: string | null;
  reservedBy?: string | null;
  reservedClaimId?: string | null;
  handoverAt?: string | null;
  handoverBy?: string | null;
  handoverClaimId?: string | null;
  handoverInternalNote?: string | null;
  custodyConfirmedAt?: string | null;
  custodyConfirmedBy?: string | null;
}
