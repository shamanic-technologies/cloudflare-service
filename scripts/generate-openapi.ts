import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { writeFileSync } from "fs";
import { registry } from "../src/schemas.js";

const generator = new OpenApiGeneratorV3(registry.definitions);

const doc = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Cloudflare Storage Service",
    version: "1.0.0",
    description: "Stores and serves files on Cloudflare R2",
  },
  servers: [{ url: "/" }],
});

writeFileSync("openapi.json", JSON.stringify(doc, null, 2));
console.log("Generated openapi.json");
