if (!process.env.RUNS_SERVICE_URL) {
  throw new Error("[cloudflare-service] RUNS_SERVICE_URL is not set");
}
if (!process.env.RUNS_SERVICE_API_KEY) {
  throw new Error("[cloudflare-service] RUNS_SERVICE_API_KEY is not set");
}

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

interface RunIdentity {
  orgId: string;
  userId: string;
  runId?: string;
}

interface CreateRunResult {
  id: string;
}

export async function createRun(
  task: { serviceName: string; taskName: string },
  identity: RunIdentity,
  forwardHeaders?: Record<string, string>
): Promise<CreateRunResult> {
  const response = await fetch(`${RUNS_SERVICE_URL}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RUNS_SERVICE_API_KEY,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      ...(identity.runId ? { "x-run-id": identity.runId } : {}),
      ...(forwardHeaders ?? {}),
    },
    body: JSON.stringify({
      serviceName: task.serviceName,
      taskName: task.taskName,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create run: ${error}`);
  }

  return (await response.json()) as CreateRunResult;
}

export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity: RunIdentity
): Promise<void> {
  await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RUNS_SERVICE_API_KEY,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
    },
    body: JSON.stringify({ status }),
  });
}

export interface CostItem {
  costName: string;
  costSource: "platform" | "org";
  quantity: number;
}

export async function declareActualCost(
  runId: string,
  item: CostItem,
  identity: RunIdentity,
  forwardHeaders?: Record<string, string>
): Promise<void> {
  const response = await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}/costs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RUNS_SERVICE_API_KEY,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      ...(forwardHeaders ?? {}),
    },
    body: JSON.stringify({
      items: [
        {
          costName: item.costName,
          costSource: item.costSource,
          quantity: item.quantity,
          status: "actual",
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `runs-service declareActualCost failed: status=${response.status} body=${body}`
    );
  }
}

// --- Platform runs (org-less / internal service callers) ---

const SERVICE_NAME = "cloudflare-storage";

/**
 * Whose work a platform run is (cost ledger): the caller's run it is made for
 * (the new run becomes its child and rides its outcome or support mark), or the
 * support function it serves when no run stands behind it. Never both.
 */
export type PlatformRunOwnership =
  | { parentRunId: string; support?: undefined }
  | { support: { kind: string; reason: string }; parentRunId?: undefined };

/**
 * Create a platform-level run (no org/user identity). Auth is X-Api-Key +
 * x-service-name. There is no affordability authorize for platform spend.
 */
export async function createPlatformRun(
  task: { serviceName: string; taskName: string },
  forwardHeaders?: Record<string, string>,
  ownership?: PlatformRunOwnership
): Promise<CreateRunResult> {
  const response = await fetch(`${RUNS_SERVICE_URL}/v1/platform-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RUNS_SERVICE_API_KEY,
      "x-service-name": SERVICE_NAME,
      ...(forwardHeaders ?? {}),
    },
    body: JSON.stringify({
      serviceName: task.serviceName,
      taskName: task.taskName,
      ...(ownership?.parentRunId ? { parentRunId: ownership.parentRunId } : {}),
      ...(ownership?.support ? { support: ownership.support } : {}),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create platform run: ${error}`);
  }

  return (await response.json()) as CreateRunResult;
}

/**
 * Declare an ACTUAL cost on a platform run. costSource is always "platform"
 * (no org balance to bill). Fails loud on non-2xx so a cost that can't be
 * declared blocks the upload.
 */
export async function declarePlatformActualCost(
  runId: string,
  item: { costName: string; quantity: number },
  forwardHeaders?: Record<string, string>
): Promise<void> {
  const response = await fetch(`${RUNS_SERVICE_URL}/v1/platform-runs/${runId}/costs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RUNS_SERVICE_API_KEY,
      "x-service-name": SERVICE_NAME,
      ...(forwardHeaders ?? {}),
    },
    body: JSON.stringify({
      items: [
        {
          costName: item.costName,
          costSource: "platform",
          quantity: item.quantity,
          status: "actual",
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `runs-service declarePlatformActualCost failed: status=${response.status} body=${body}`
    );
  }
}

export async function updatePlatformRun(
  runId: string,
  status: "completed" | "failed"
): Promise<void> {
  await fetch(`${RUNS_SERVICE_URL}/v1/platform-runs/${runId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RUNS_SERVICE_API_KEY,
      "x-service-name": SERVICE_NAME,
    },
    body: JSON.stringify({ status }),
  });
}
