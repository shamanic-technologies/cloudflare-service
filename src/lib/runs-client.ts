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
  identity: RunIdentity
): Promise<CreateRunResult> {
  const response = await fetch(`${RUNS_SERVICE_URL}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RUNS_SERVICE_API_KEY,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      ...(identity.runId ? { "x-run-id": identity.runId } : {}),
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
