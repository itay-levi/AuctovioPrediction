import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  RangeSlider,
  Button,
  Banner,
  Badge,
  Divider,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { getSimulation } from "../services/simulation.server";
import { requireTier } from "../services/gates.server";
import { ConfidenceGauge } from "../components/ConfidenceGauge";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import db from "../db.server";
import { AGENT_COUNTS } from "../services/store.server";
import { triggerDeltaSimulation } from "../services/engine.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  await requireTier(shopDomain, "PRO");

  const [simulation, store] = await Promise.all([
    getSimulation(params.id!),
    getStore(shopDomain),
  ]);

  if (!simulation || simulation.storeId !== store?.id) {
    throw new Response("Not found", { status: 404 });
  }
  if (simulation.status !== "COMPLETED") {
    throw new Response("Simulation must be completed first", { status: 400 });
  }

  // Load existing delta runs for this simulation
  const deltas = await db.simulation.findMany({
    where: { originalSimulationId: simulation.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      status: true,
      score: true,
      deltaParams: true,
      reportJson: true,
      trustAudit: true,
      comparisonInsight: true,
      createdAt: true,
    },
  });

  const report = simulation.reportJson as {
    friction?: { price?: { dropoutPct?: number }; trust?: { dropoutPct?: number }; logistics?: { dropoutPct?: number } };
  } | null;

  return { simulation, store, deltas, report };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  await requireTier(shopDomain, "PRO");

  const formData = await request.formData();
  const priceOverride = formData.get("price") ? Number(formData.get("price")) : undefined;
  const shippingDays = formData.get("shippingDays") ? Number(formData.get("shippingDays")) : undefined;

  const [originalSim, store] = await Promise.all([
    getSimulation(params.id!),
    getStore(shopDomain),
  ]);

  if (!originalSim || originalSim.storeId !== store?.id) {
    return { error: "Simulation not found" };
  }

  const deltaParams = { price: priceOverride, shippingDays };

  // Create delta simulation record
  const tier = store.planTier;
  const agentCount = AGENT_COUNTS[tier];
  const deltaSim = await db.simulation.create({
    data: {
      storeId: store.id,
      productUrl: originalSim.productUrl,
      productJson: originalSim.productJson as object,
      status: "PENDING",
      phase: 0,
      mtCost: agentCount * 2,
      originalSimulationId: originalSim.id,
      deltaParams: deltaParams as object,
    },
  });

  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  triggerDeltaSimulation({
    simulationId: deltaSim.id,
    originalSimulationId: originalSim.id,
    shopDomain,
    shopType: store.shopType ?? "general_retail",
    productJson: originalSim.productJson,
    agentCount,
    deltaParams,
    callbackUrl: `${appUrl}/webhooks/engine/callback`,
    priority: 1,  // What-If runs yield to initial scans
    originalScore: originalSim.score ?? undefined,
    originalFriction: (originalSim.reportJson as { friction?: unknown } | null)?.friction ?? undefined,
    originalTrustAudit: (originalSim as { trustAudit?: unknown }).trustAudit ?? undefined,
  }).catch((err: unknown) => {
    console.error("[Engine] Delta trigger failed:", err);
    db.simulation
      .update({ where: { id: deltaSim.id }, data: { status: "FAILED" } })
      .catch(() => {});
  });

  throw redirect(`/app/sandbox/${originalSim.id}`);
};

export default function SandboxPage() {
  const { simulation, deltas, report } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const isSubmitting = fetcher.state !== "idle";

  // Poll while any delta is still running
  const hasInProgress = deltas.some((d) => d.status === "PENDING" || d.status === "RUNNING");
  useEffect(() => {
    if (!hasInProgress) return;
    const interval = setInterval(revalidate, 4000);
    return () => clearInterval(interval);
  }, [hasInProgress, revalidate]);

  // Most recent completed delta — shown prominently next to baseline
  const latestCompleted = deltas.find((d) => d.status === "COMPLETED" && d.score != null);
  const latestRunning = deltas.find((d) => d.status === "PENDING" || d.status === "RUNNING");

  // Extract base price from productJson
  const productJson = simulation.productJson as { variants?: { price?: string }[] } | null;
  const basePrice = parseFloat(productJson?.variants?.[0]?.price ?? "0");
  const [price, setPrice] = useState(basePrice > 0 ? basePrice : 50);
  const [shippingDays, setShippingDays] = useState(7);

  const priceDropoutPct = report?.friction?.price?.dropoutPct ?? 0;
  const logisticsDropoutPct = report?.friction?.logistics?.dropoutPct ?? 0;

  return (
    <Page>
      <TitleBar
        title="What-If Sandbox"
        breadcrumbs={[
          { content: "Dashboard", url: "/app" },
          { content: "History", url: "/app/history" },
          { content: "Results", url: `/app/results/${simulation.id}` },
        ]}
      />
      <Layout>
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {/* Score comparison — baseline vs latest what-if */}
            <Card>
              <BlockStack gap="400">
                {latestCompleted ? (
                  <>
                    <InlineStack align="space-between" blockAlign="start" gap="400">
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued" alignment="center">Baseline</Text>
                        <ConfidenceGauge score={simulation.score ?? 0} size={130} />
                      </BlockStack>
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued" alignment="center">What-If Result</Text>
                        <ConfidenceGauge score={latestCompleted.score!} size={130} />
                      </BlockStack>
                    </InlineStack>
                    {(() => {
                      const diff = (latestCompleted.score ?? 0) - (simulation.score ?? 0);
                      return diff !== 0 ? (
                        <Banner tone={diff > 0 ? "success" : "critical"}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {diff > 0 ? `+${diff} points` : `${diff} points`} vs baseline
                          </Text>
                        </Banner>
                      ) : (
                        <Banner tone="info">
                          <Text as="p" variant="bodyMd">No change from baseline</Text>
                        </Banner>
                      );
                    })()}
                  </>
                ) : (
                  <>
                    <Text as="h2" variant="headingMd">Baseline Score</Text>
                    <ConfidenceGauge score={simulation.score ?? 0} size={160} />
                    <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                      Original simulation score
                    </Text>
                  </>
                )}
                {latestRunning && (
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">Panel is running — score updates automatically…</Text>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Friction Hints</Text>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm">Price friction</Text>
                  <Badge tone={priceDropoutPct > 30 ? "critical" : "warning"}>
                    {`${priceDropoutPct}% dropout`}
                  </Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm">Logistics friction</Text>
                  <Badge tone={logisticsDropoutPct > 30 ? "critical" : "warning"}>
                    {`${logisticsDropoutPct}% dropout`}
                  </Badge>
                </InlineStack>
                <Divider />
                <Text as="p" variant="bodySm" tone="subdued">
                  Adjust sliders to see how changes affect conversion confidence.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">

            {/* ── Comparison table — shown when at least one delta is completed ── */}
            {latestCompleted && (() => {
              const dp = latestCompleted.deltaParams as { price?: number; shippingDays?: number } | null;
              const origReport = report;
              const deltaReport = (latestCompleted.reportJson as typeof report) ?? null;
              const origTrust = simulation as { trustAudit?: { trustKillers?: { label: string; severity: string }[] } | null };
              const scoreDiff = (latestCompleted.score ?? 0) - (simulation.score ?? 0);

              const origPolicyStatus = origTrust.trustAudit?.trustKillers?.some(k => k.label.toLowerCase().includes("return"))
                ? "No Return Policy" : "Has Return Policy";
              const shippingLabel = dp?.shippingDays != null ? `${dp.shippingDays}d shipping` : "Unchanged";

              return (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">📊 Comparison</Text>

                    {/* Side-by-side table */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                      {/* Original column */}
                      <BlockStack gap="200">
                        <Text as="p" variant="headingSm" tone="subdued">Original</Text>
                        <Text as="p" variant="bodyMd">💰 ${basePrice > 0 ? basePrice.toFixed(2) : "—"}</Text>
                        <Text as="p" variant="bodyMd">🚚 {origReport?.friction?.logistics?.dropoutPct != null ? `${origReport.friction.logistics.dropoutPct}% logistics friction` : "Shipping: unknown"}</Text>
                        <Text as="p" variant="bodyMd">🛡️ {origPolicyStatus}</Text>
                        <Text as="p" variant="headingMd">Score: {simulation.score ?? "—"}/100</Text>
                      </BlockStack>

                      {/* What-If column */}
                      <BlockStack gap="200">
                        <Text as="p" variant="headingSm" tone={scoreDiff > 0 ? "success" : "critical"}>What-If</Text>
                        <Text as="p" variant="bodyMd">
                          💰 ${dp?.price != null ? Number(dp.price).toFixed(2) : (basePrice > 0 ? basePrice.toFixed(2) : "—")}
                          {dp?.price != null && basePrice > 0 && dp.price !== basePrice && (
                            <span style={{ color: dp.price < basePrice ? "#2E7D32" : "#C62828", marginLeft: 6 }}>
                              {dp.price < basePrice ? `↓ -$${(basePrice - dp.price).toFixed(2)}` : `↑ +$${(dp.price - basePrice).toFixed(2)}`}
                            </span>
                          )}
                        </Text>
                        <Text as="p" variant="bodyMd">🚚 {shippingLabel}</Text>
                        <Text as="p" variant="bodyMd">🛡️ {origPolicyStatus} <span style={{ color: "#999", fontSize: "0.8em" }}>(unchanged)</span></Text>
                        <Text as="p" variant="headingMd">
                          Score: {latestCompleted.score ?? "—"}/100
                          {scoreDiff !== 0 && (
                            <span style={{ color: scoreDiff > 0 ? "#2E7D32" : "#C62828", marginLeft: 8, fontSize: "0.9em" }}>
                              ({scoreDiff > 0 ? `+${scoreDiff}` : scoreDiff} pts)
                            </span>
                          )}
                        </Text>
                      </BlockStack>
                    </div>

                    <Divider />

                    {/* AI Insight */}
                    {latestCompleted.comparisonInsight ? (
                      <Box padding="400" borderRadius="200" background="bg-surface-secondary" borderWidth="025" borderColor="border">
                        <BlockStack gap="100">
                          <Text as="p" variant="headingSm">🤖 AI Insight</Text>
                          <Text as="p" variant="bodyMd">{latestCompleted.comparisonInsight}</Text>
                        </BlockStack>
                      </Box>
                    ) : latestRunning ? (
                      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                        <Text as="p" variant="bodySm" tone="subdued">AI Insight generating…</Text>
                      </Box>
                    ) : null}

                    <Button url={`/app/results/${latestCompleted.id}`} size="slim" variant="plain">
                      View full What-If report →
                    </Button>
                  </BlockStack>
                </Card>
              );
            })()}

            {/* ── Run a new scenario ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Run a What-If Scenario</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Adjust price and shipping, then re-run the panel to see score impact.
                </Text>

                {fetcher.data?.error && (
                  <Banner tone="critical">
                    <Text as="p" variant="bodyMd">{fetcher.data.error}</Text>
                  </Banner>
                )}

                {latestRunning && (
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      A What-If panel is currently running — results will appear above automatically.
                    </Text>
                  </Banner>
                )}

                <fetcher.Form method="post">
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        Price: ${price.toFixed(2)}
                      </Text>
                      <RangeSlider
                        label="Price override"
                        labelHidden
                        min={1}
                        max={Math.max(500, basePrice * 3)}
                        step={1}
                        value={price}
                        onChange={(v) => setPrice(v as number)}
                        output
                        prefix="$1"
                        suffix={`$${Math.max(500, basePrice * 3)}`}
                      />
                      <input type="hidden" name="price" value={price} />
                      {basePrice > 0 && price !== basePrice && (
                        <Text as="p" variant="bodySm" tone={price < basePrice ? "success" : "critical"}>
                          {price < basePrice
                            ? `↓ $${(basePrice - price).toFixed(2)} cheaper than original`
                            : `↑ $${(price - basePrice).toFixed(2)} more than original`}
                        </Text>
                      )}
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        Shipping: {shippingDays} day{shippingDays !== 1 ? "s" : ""}
                      </Text>
                      <RangeSlider
                        label="Shipping days"
                        labelHidden
                        min={1}
                        max={21}
                        step={1}
                        value={shippingDays}
                        onChange={(v) => setShippingDays(v as number)}
                        output
                        prefix="1 day"
                        suffix="21 days"
                      />
                      <input type="hidden" name="shippingDays" value={shippingDays} />
                    </BlockStack>

                    <Button variant="primary" submit loading={isSubmitting} disabled={!!latestRunning}>
                      {isSubmitting ? "Queueing…" : "Run What-If Panel"}
                    </Button>
                  </BlockStack>
                </fetcher.Form>
              </BlockStack>
            </Card>

            {/* ── Previous scenarios history ── */}
            {deltas.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">All Scenarios</Text>
                  {deltas.map((delta) => {
                    const dp = delta.deltaParams as { price?: number; shippingDays?: number } | null;
                    return (
                      <InlineStack key={delta.id} align="space-between" blockAlign="center">
                        <BlockStack gap="0">
                          <Text as="p" variant="bodyMd">
                            {dp?.price != null ? `$${Number(dp.price).toFixed(2)}` : "original price"}
                            {dp?.shippingDays != null ? ` · ${dp.shippingDays}d shipping` : ""}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {new Date(delta.createdAt).toLocaleDateString()}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={delta.status === "COMPLETED" ? "success" : delta.status === "FAILED" ? "critical" : "info"}>
                            {delta.status}
                          </Badge>
                          {delta.score != null && (
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {delta.score}/100
                            </Text>
                          )}
                          {delta.status === "COMPLETED" && (
                            <Button url={`/app/results/${delta.id}`} size="slim" variant="plain">View</Button>
                          )}
                        </InlineStack>
                      </InlineStack>
                    );
                  })}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
