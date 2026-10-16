import "dotenv/config";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "./config/db.js";
import { starterItems } from "./data/items.js";
import { Item } from "./models/Item.js";
import { User } from "./models/User.js";

const seedOwnerEmail = "starter-items@itelect4.invalid";

async function seed(): Promise<void> {
  await connectDB();

  let seedOwner = await User.findOne({ email: seedOwnerEmail });
  if (!seedOwner) {
    seedOwner = await User.create({
      name: "Starter Item Seed Owner",
      email: seedOwnerEmail,
      password: randomBytes(48).toString("base64url"),
      role: "student",
      isActive: false,
    });
  }

  for (const item of starterItems) {
    await Item.updateOne(
      { ownerId: seedOwner._id, title: item.title },
      {
        $set: item,
        $setOnInsert: { ownerId: seedOwner._id },
      },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  const starterCount = await Item.countDocuments({
    ownerId: seedOwner._id,
    title: { $in: starterItems.map(({ title }) => title) },
  });
  console.log(`Starter items present for seed owner: ${starterCount}/${starterItems.length}`);
}

seed()
  .catch((err: unknown) => {
    const errorName = err instanceof Error ? err.name : "UnknownError";
    console.error(`Item seed failed (${errorName}). Check MONGODB_URI and Atlas network access.`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
