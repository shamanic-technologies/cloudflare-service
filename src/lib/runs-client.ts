const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

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
  const response = await fetch(`${RUNS_SERVICE_URL}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(RUNS_SERVICE_API_KEY ? { "X-Api-Key": RUNS_SERVICE_API_KEY } : {}),
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
  await fetch(`${RUNS_SERVICE_URL}/runs/${runId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(RUNS_SERVICE_API_KEY ? { "X-Api-Key": RUNS_SERVICE_API_KEY } : {}),
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
    },
    body: JSON.stringify({ status }),
  });
}
