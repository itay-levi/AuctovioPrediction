// MiroFish inference engine client (Hetzner VPS)
import { engineBreaker } from "./circuit-breaker.server";

const ENGINE_URL = process.env.ENGINE_URL;
const ENGINE_API_KEY = process.env.ENGINE_API_KEY;

if (!ENGINE_URL) {
  throw new Error("ENGINE_URL is not configured");
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
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

export interface DeltaSimulationPayload {
  simulationId: string;     // new simulation id
  originalSimulationId: string;
  shopDomain: string;
  shopType: string;
  productJson: unknown;
  agentCount: number;
  deltaParams: { price?: number; shippingDays?: number };
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
  return engineBreaker.execute(async () => {
    const res = await fetch(`${ENGINE_URL}/miroshop/simulate`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Engine error ${res.status}: ${text}`);
    }

    return res.json() as Promise<{ queued: boolean; estimatedMtCost: number }>;
  });
}

export async function triggerDeltaSimulation(
  payload: DeltaSimulationPayload
): Promise<{ queued: boolean; estimatedMtCost: number }> {
  return engineBreaker.execute(async () => {
    const res = await fetch(`${ENGINE_URL}/miroshop/simulate/delta`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Engine delta error ${res.status}: ${text}`);
    }

    return res.json() as Promise<{ queued: boolean; estimatedMtCost: number }>;
  });
}

export async function classifyStoreNiche(
  shopDomain: string,
  sampleProductTitles: string[]
): Promise<string> {
  return engineBreaker.execute(async () => {
    const res = await fetch(`${ENGINE_URL}/miroshop/classify`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ shopDomain, sampleProductTitles }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Classify error ${res.status}`);
    }

    const data = (await res.json()) as { niche: string };
    return data.niche;
  });
}

export async function checkEngineHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/miroshop/health`, {
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
