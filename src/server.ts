import "dotenv/config";
import { app } from "./app.js";
import { connectDB } from "./config/db.js";

const PORT = Number(process.env.PORT) || 4000;

async function start(): Promise<void> {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log("API on http://localhost:" + PORT);
    });
  } catch (err) {
    console.error("Could not start:", err);
    process.exit(1);
  }
}

void start();
