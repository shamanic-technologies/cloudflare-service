import "./instrument.js";
import * as Sentry from "@sentry/node";
import express from "express";
import { readFileSync } from "fs";
import { apiKeyAuth } from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import uploadRouter from "./routes/upload.js";
import filesRouter from "./routes/files.js";
import imagesRouter from "./routes/images.js";
import botTrafficRouter from "./routes/bot-traffic.js";
import { runMigrations } from "./db/migrate.js";
import { startBotTrafficScheduler } from "./lib/bot-traffic/scheduler.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json({ limit: "100mb" }));
app.use(apiKeyAuth);

// OpenAPI spec
app.get("/openapi.json", (_req, res) => {
  try {
    const spec = readFileSync("openapi.json", "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.send(spec);
  } catch {
    res.status(404).json({ error: "OpenAPI spec not found" });
  }
});

// Routes
app.use(healthRouter);
app.use(uploadRouter);
app.use(filesRouter);
app.use(imagesRouter);
app.use(botTrafficRouter);

app.listen(PORT, () => {
  console.log(`cloudflare-storage-service listening on port ${PORT}`);
  // Migrations run AFTER listen so a slow DB cannot fail the deploy health
  // check; the bot-traffic capture is armed only once its tables exist.
  runMigrations()
    .then(() => {
      console.log("[cloudflare-service] migrations complete");
      startBotTrafficScheduler();
    })
    .catch((err) => {
      console.error("[cloudflare-service] migrations failed, bot-traffic capture NOT armed:", err);
      Sentry.captureException(err, { tags: { job: "migrations" } });
    });
});

export { app };
