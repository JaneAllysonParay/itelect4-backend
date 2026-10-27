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
  status: "lost" | "found" | "claimed";
  ownerId: string;
}

export interface Claim {
  id: string;
  itemId: string;
  claimantId: string;
  claimDate: Date;
  status: "pending" | "approved" | "rejected";
  proof: string;
}

export type UserDoc = Omit<User, "id"> & {
  password: string;
};

export type ItemDoc = Omit<Item, "id" | "ownerId"> & {
  ownerId: Types.ObjectId;
};

export type ClaimDoc = Omit<
  Claim,
  "id" | "itemId" | "claimantId"
> & {
  itemId: Types.ObjectId;
  claimantId: Types.ObjectId;
};

export type NewClaimBody = Pick<Claim, "proof"> & {
  itemId: string;
};

export type NewItemBody = Pick<
  Item,
  "title" | "description" | "location" | "status"
>;
