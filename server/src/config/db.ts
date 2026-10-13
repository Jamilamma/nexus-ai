import mongoose from "mongoose";

/**
 * Connects to MongoDB with a short server-selection timeout (so we fail
 * fast instead of hanging for 30s+) and a few retries (so a temporarily
 * paused/waking Atlas cluster doesn't kill the whole server on the first
 * blip).
 *
 * If it still can't connect after all attempts, it throws a descriptive
 * error explaining the most common causes, instead of a generic Mongoose
 * timeout error that doesn't tell you what to actually go check.
 */
export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set in the environment.");
  }

  mongoose.set("strictQuery", true);

  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
      });

      console.log(`[db] connected -> ${mongoose.connection.name}`);

      mongoose.connection.on("error", (err) => {
        console.error("[db] connection error:", err);
      });

      mongoose.connection.on("disconnected", () => {
        console.warn("[db] disconnected from MongoDB.");
      });

      return;
    } catch (err: any) {
      console.error(
        `[db] connection attempt ${attempt}/${maxAttempts} failed: ${err.message}`
      );

      if (attempt === maxAttempts) {
        throw new Error(
          `Could not connect to MongoDB after ${maxAttempts} attempts.\n` +
            `Most likely causes:\n` +
            `  1) Your Atlas cluster is paused — resume it in the Atlas dashboard.\n` +
            `  2) Your current IP isn't allow-listed — Atlas > Network Access > Add current IP.\n` +
            `  3) Wrong username/password in MONGODB_URI.\n` +
            `Original error: ${err.message}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}