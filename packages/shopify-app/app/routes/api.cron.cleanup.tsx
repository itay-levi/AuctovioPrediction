import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";

export async function loader(_args: LoaderFunctionArgs) {
  return json({ error: "Method Not Allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  const result = await db.simulation.updateMany({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      updatedAt: { lt: fifteenMinutesAgo },
    },
    data: { status: "FAILED" },
  });

  return json({ expired: result.count });
}
