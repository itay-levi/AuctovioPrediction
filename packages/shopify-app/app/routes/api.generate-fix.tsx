import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { generateFix } from "../services/engine.server";

const SUPPORTED_SIGNALS = new Set(["return_policy", "no_shipping_info", "no_contact_info"]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const body = await request.json() as { signal?: string };
  const signal = body?.signal ?? "";

  if (!SUPPORTED_SIGNALS.has(signal)) {
    return Response.json({ error: "Unsupported signal" }, { status: 400 });
  }

  const store = await getStore(shopDomain);
  const productType = store?.shopType ?? "general retail products";

  try {
    const result = await generateFix(signal, productType);
    return Response.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
};
