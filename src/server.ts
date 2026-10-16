import "dotenv/config";
import { app } from "./app.js";
import { connectDB } from "./config/db.js";

const PORT = Number(process.env.PORT) || 4000;

function reportConnectionError(err: unknown): void {
  const errorName = err instanceof Error ? err.name : "UnknownError";
  console.error(`Could not connect to MongoDB (${errorName}). Requests will retry the connection.`);
}

try {
  connectDB().catch(reportConnectionError);
} catch (err) {
  reportConnectionError(err);
}

app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
});
