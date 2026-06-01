import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";

export async function loader(_args: LoaderFunctionArgs) {
  return json({ error: "Method Not Allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  // Always require auth — fail closed if ENV is missing
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("Authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // 20 min matches the in-process expireStuckSimulations threshold so the
  // cron sweep never kills sims that the loaders would still treat as live.
  // Engine phase 2/3 work can legitimately exceed 15 min on large panels.
  const cutoff = new Date(Date.now() - 20 * 60 * 1000);

  const result = await db.simulation.updateMany({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      failureReason: "The analysis timed out. The AI model took longer than expected. Please try again.",
    } as Parameters<typeof db.simulation.updateMany>[0]["data"],
  });

  console.info("[Cron] cleanup", { expired: result.count });
  return json({ expired: result.count });
}
