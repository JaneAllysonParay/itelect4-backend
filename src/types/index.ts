import type { Types } from "mongoose";

export interface User {
  id: number;
  name: string;
  email: string;
  role: "student" | "security" | "admin";
  isActive: boolean;
}

export interface Item {
  id: number;
  title: string;
  description: string;
  location: string;
  dateReported: Date;
  status: "lost" | "found" | "claimed";
  ownerId: number;
}

export interface Claim {
  id: number;
  itemId: number;
  claimantId: number;
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

export type NewItemBody = Pick<
  Item,
  "title" | "description" | "location" | "status"
>;
