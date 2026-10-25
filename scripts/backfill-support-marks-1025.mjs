// LEDGER-RESIDUAL-1025: mark cloudflare-storage's past runs that produced no
// outcome with the support function they served, through runs-service's owner
// door (POST /v1/platform-runs/support-marks/{preview,apply}, x-service-name
// cloudflare-storage). Run inside the cloudflare-service container:
//
//   node scripts/backfill-support-marks-1025.mjs            # preview only
//   node scripts/backfill-support-marks-1025.mjs --apply    # write the marks
//
// Every group is read from our own records, never estimated: the platform
// upload runs (task upload-base64-platform, org-less, no parent) are paired with
// the org-less rows of cloudflare_service.files by day (each day holds ONE
// folder) or, on 2026-08-02 / 2026-10-18, by start time (each run starts ~2 s
// before its file row):
//   chat-service/images/platform  2026-06-25 108, 09-19 21, 10-04 1, 10-09 692
//       = the R2 store of an image chat-service generated for no caller run;
//         chat-service marked those generate-image runs platform_llm.
//   investor-updates/gateway-verify.png, verify-1785663231.png (08-02 09:32, 09:33)
//   chat-service/transcription-probe/probe5min.mp4 (10-18 10:37)
//       = staff probes.
//   investor-updates/Screenshot…png, screenshot-…png (08-02 12:58, 13:15)
//       = the staff investor-update composer (admin.distribute.you).
// Plus one org upload (2026-09-29) made under api-service POST /v1/orgs/uploads,
// a root that declares nothing: an org storing a file is a product feature.
// Idempotent: a replay finds every run already marked and writes nothing.

const RUNS = process.env.RUNS_SERVICE_URL;
const KEY = process.env.RUNS_SERVICE_API_KEY;
if (!RUNS || !KEY) throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY are required");
const apply = process.argv.includes("--apply");
const markedBy = "cloudflare-service LEDGER-RESIDUAL-1025";

const day = (d) => ({
  taskNames: ["upload-base64-platform"],
  topLevelOnly: true,
  offOutcomeOnly: true,
  offAncestorMarkOnly: true,
  startedAfter: `${d}T00:00:00Z`,
  startedBefore: new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString(),
});

const CHAT_IMAGE = "R2 store of an image chat-service generated for no caller run (its generate-image run is platform_llm); files row under chat-service/images/platform";
const groups = [
  ...["2026-06-25", "2026-09-19", "2026-10-04", "2026-10-09"].map((d) => ({ kind: "platform_llm", reason: CHAT_IMAGE, ...day(d) })),
  {
    kind: "staff_experiment",
    reason: "staff probe uploads: investor-updates/gateway-verify.png, investor-updates/verify-1785663231.png, chat-service/transcription-probe/probe5min.mp4",
    runIds: ["79628def-1e9f-4008-ba57-bded3f286271", "5e7c3a98-c446-46cd-be5c-95730b5e46f3", "b2ab5a90-ce3c-4582-b426-b2c59dc46ea3"],
  },
  {
    kind: "product_feature",
    reason: "images uploaded by staff in the investor-update composer (admin.distribute.you, POST /v1/platform-uploads)",
    runIds: ["7f6ba87d-bfe4-4899-bb39-315be3487fd0", "5a666c8a-4596-4491-8d8c-fbb185b27362"],
  },
  {
    kind: "product_feature",
    reason: "an org stored a file through POST /v1/orgs/uploads (root api-service run declares nothing)",
    runIds: ["15717af5-0f22-488a-a462-e703aa6ea943"],
  },
];

async function call(step, body) {
  const res = await fetch(`${RUNS}/v1/platform-runs/support-marks/${step}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": KEY, "x-service-name": "cloudflare-storage" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${step} ${res.status}: ${text}`);
  return JSON.parse(text);
}

for (const g of groups) {
  const body = { ...g, markedBy };
  const label = `${g.kind} ${g.runIds ? `${g.runIds.length} runIds` : g.startedAfter.slice(0, 10)}`;
  console.log(label, "preview", JSON.stringify(await call("preview", body)));
  if (apply) console.log(label, "apply", JSON.stringify(await call("apply", body)));
}
