import "./instrument.js";
import express from "express";
import { readFileSync } from "fs";
import { apiKeyAuth } from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import uploadRouter from "./routes/upload.js";
import filesRouter from "./routes/files.js";

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

app.listen(PORT, () => {
  console.log(`cloudflare-storage-service listening on port ${PORT}`);
});

export { app };
