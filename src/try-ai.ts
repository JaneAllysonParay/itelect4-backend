import "dotenv/config";
import { reviewItemReport } from "./ai/gemini.js";

async function main(): Promise<void> {
  try {
    const review = await reviewItemReport(
      "Black wallet lost near the library. It has a small silver zipper and a visible scratch on the lower-right corner.",
    );

    console.log(JSON.stringify(review, null, 2));
  } catch (err: unknown) {
    console.error("Gemini call failed:", err);
    process.exit(1);
  }
}

void main();
