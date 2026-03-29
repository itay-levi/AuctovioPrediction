// MiroFish inference engine client (Hetzner VPS)

const ENGINE_URL = process.env.ENGINE_URL;
const ENGINE_API_KEY = process.env.ENGINE_API_KEY;

if (!ENGINE_URL) {
  throw new Error("ENGINE_URL is not configured");
}

interface EngineHeaders {
  "Content-Type": string;
  Authorization?: string;
}

function headers(): EngineHeaders {
  const h: EngineHeaders = { "Content-Type": "application/json" };
  if (ENGINE_API_KEY) {
    h["Authorization"] = `Bearer ${ENGINE_API_KEY}`;
  }
  return h;
}

export interface TriggerSimulationPayload {
  simulationId: string;
  shopDomain: string;
  shopType: string;
  productUrl: string;
  productJson: unknown;
  agentCount: number; // 5 | 25 | 50 based on plan tier
  callbackUrl: string;
}

export interface SimulationPhaseResult {
  simulationId: string;
  phase: 1 | 2 | 3;
  score?: number;
  imageScore?: number;
  agentLogs?: AgentLogEntry[];
  reportJson?: unknown;
}

export interface AgentLogEntry {
  agentId: string;
  archetype: string;
  phase: number;
  verdict: "BUY" | "REJECT" | "ABSTAIN";
  reasoning: string;
}

export async function triggerSimulation(
  payload: TriggerSimulationPayload
): Promise<{ queued: boolean; estimatedMtCost: number }> {
  const res = await fetch(`${ENGINE_URL}/simulate`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Engine error ${res.status}: ${text}`);
  }

  return res.json() as Promise<{ queued: boolean; estimatedMtCost: number }>;
}

export async function getSimulationStatus(
  simulationId: string
): Promise<{ phase: number; status: string }> {
  const res = await fetch(`${ENGINE_URL}/simulate/${simulationId}/status`, {
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Engine status check failed: ${res.status}`);
  }

  return res.json() as Promise<{ phase: number; status: string }>;
}

export async function checkEngineHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`, {
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
