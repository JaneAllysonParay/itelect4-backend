import type { ItemDoc } from "../types/index.js";

type StarterItem = Pick<
  ItemDoc,
  "title" | "description" | "location" | "dateReported" | "status"
>;

export const starterItems: StarterItem[] = [
  {
    title: "Blue Tumbler",
    description: "1 Liter Blue Tumbler",
    location: "E-Library",
    dateReported: new Date("2026-08-21T00:00:00.000Z"),
    status: "lost",
  },
  {
    title: "Black Umbrella",
    description: "Foldable black umbrella",
    location: "College Lobby",
    dateReported: new Date("2026-08-21T00:00:00.000Z"),
    status: "lost",
  },
];
