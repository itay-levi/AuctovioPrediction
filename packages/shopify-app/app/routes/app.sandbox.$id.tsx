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
  CalloutCard,
  DataTable,
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

type ExperimentCard = {
  id: string;
  name: string;
  hypothesis: string;
  targetAgent: string;
  rationale: string;
};

type ProductDna = {
  coreFear?: string;
  coreDesire?: string;
  archetypeAxis?: string;
  experimentCards?: ExperimentCard[];
};

type DeltaRow = {
  id: string;
  status: string;
  score: number | null;
  deltaParams: unknown;
  reportJson: unknown;
  trustAudit: unknown;
  comparisonInsight: string | null;
  labGroupId: string | null;
  createdAt: string;
};

const AXIS_EMOJI: Record<string, string> = {
  "Sensory/Experience": "🌿",
  "Intimacy/Privacy": "🔒",
  "Efficacy/Result": "📊",
  "Status/Identity": "✨",
};

const AGENT_LABELS: Record<string, string> = {
  budget_optimizer: "💰 Budget Optimizer",
  brand_loyalist: "⭐ Brand Loyalist",
  research_analyst: "🔬 Research Analyst",
  impulse_decider: "⚡ Impulse Decider",
  gift_seeker: "🎁 Gift Seeker",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

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

  const tier = store?.planTier ?? "FREE";
  const isDev = process.env.NODE_ENV === "development";
  const isPro = isDev || tier === "PRO" || tier === "ENTERPRISE";

  const deltas = await db.simulation.findMany({
    where: { originalSimulationId: simulation.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      status: true,
      score: true,
      deltaParams: true,
      reportJson: true,
      trustAudit: true,
      comparisonInsight: true,
      labGroupId: true,
      createdAt: true,
    },
  });

  const report = simulation.reportJson as {
    friction?: { price?: { dropoutPct?: number }; trust?: { dropoutPct?: number }; logistics?: { dropoutPct?: number } };
  } | null;

  const productDna = (simulation as { productDna?: unknown }).productDna as ProductDna | null;

  return { simulation, store, deltas, report, productDna, isPro };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // PRO gate — even with locked UI, protect the action
  await requireTier(shopDomain, "PRO");

  const formData = await request.formData();
  const intent = (formData.get("intent") as string | null) ?? "run_whatif";
  const priceOverride = formData.get("price") ? Number(formData.get("price")) : undefined;
  const shippingDays = formData.get("shippingDays") ? Number(formData.get("shippingDays")) : undefined;
  const activeExperiment = (formData.get("activeExperiment") as string | null) || undefined;

  const [originalSim, store] = await Promise.all([
    getSimulation(params.id!),
    getStore(shopDomain),
  ]);

  if (!originalSim || originalSim.storeId !== store?.id) {
    return { error: "Simulation not found" };
  }

  const tier = store.planTier;
  const agentCount = AGENT_COUNTS[tier];
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const callbackUrl = `${appUrl}/webhooks/engine/callback`;
  const productDna = (originalSim as { productDna?: unknown }).productDna ?? undefined;

  // ── Simulate All Cards — fire 3 delta sims in parallel ─────────────────────
  if (intent === "simulate_all") {
    const cards = (productDna as ProductDna | undefined)?.experimentCards ?? [];
    if (cards.length === 0) {
      return { error: "No experiment cards available. Run a new analysis first." };
    }
    const setGroupId = `expset_${originalSim.id}_${Date.now()}`;

    await Promise.all(
      cards.map(async (card) => {
        const deltaSim = await db.simulation.create({
          data: {
            storeId: store.id,
            productUrl: originalSim.productUrl,
            productJson: originalSim.productJson as object,
            status: "PENDING",
            phase: 0,
            mtCost: agentCount * 2,
            originalSimulationId: originalSim.id,
            deltaParams: { experimentCardId: card.id, experimentCardName: card.name, setGroupId } as object,
            labGroupId: setGroupId,
          },
        });

        triggerDeltaSimulation({
          simulationId: deltaSim.id,
          originalSimulationId: originalSim.id,
          shopDomain,
          shopType: store.shopType ?? "general_retail",
          productJson: originalSim.productJson,
          agentCount,
          deltaParams: {},
          callbackUrl,
          priority: 1,
          originalScore: originalSim.score ?? undefined,
          originalFriction: (originalSim.reportJson as { friction?: unknown } | null)?.friction ?? undefined,
          originalTrustAudit: (originalSim as { trustAudit?: unknown }).trustAudit ?? undefined,
          productDna,
          activeExperiment: card.hypothesis,
          isPro: true,
        }).catch((err: unknown) => {
          console.error(`[Engine] Experiment card "${card.name}" trigger failed:`, err);
          db.simulation
            .update({ where: { id: deltaSim.id }, data: { status: "FAILED" } })
            .catch(() => {});
        });
      })
    );

    throw redirect(`/app/sandbox/${originalSim.id}`);
  }

  // ── Single what-if run ──────────────────────────────────────────────────────
  const deltaParams = { price: priceOverride, shippingDays };
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

  triggerDeltaSimulation({
    simulationId: deltaSim.id,
    originalSimulationId: originalSim.id,
    shopDomain,
    shopType: store.shopType ?? "general_retail",
    productJson: originalSim.productJson,
    agentCount,
    deltaParams,
    callbackUrl,
    priority: 1,
    originalScore: originalSim.score ?? undefined,
    originalFriction: (originalSim.reportJson as { friction?: unknown } | null)?.friction ?? undefined,
    originalTrustAudit: (originalSim as { trustAudit?: unknown }).trustAudit ?? undefined,
    productDna,
    activeExperiment,
    isPro: tier === "PRO" || tier === "ENTERPRISE",
  }).catch((err: unknown) => {
    console.error("[Engine] Delta trigger failed:", err);
    db.simulation
      .update({ where: { id: deltaSim.id }, data: { status: "FAILED" } })
      .catch(() => {});
  });

  throw redirect(`/app/sandbox/${originalSim.id}`);
};

// ── Confidence Shift Badge ────────────────────────────────────────────────────
function ConfidenceShift({ baseline, current }: { baseline: number; current: number }) {
  const diff = current - baseline;
  const sign = diff > 0 ? "+" : "";
  const color = diff > 0 ? "#1B5E20" : diff < 0 ? "#B71C1C" : "#555";
  const bg = diff > 0 ? "#E8F5E9" : diff < 0 ? "#FFEBEE" : "#F5F5F5";
  const label = diff > 0 ? "▲ Confidence Shift" : diff < 0 ? "▼ Confidence Shift" : "No Shift";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "16px 24px",
        background: bg,
        borderRadius: 8,
        border: `1.5px solid ${color}22`,
      }}
    >
      <span style={{ fontSize: 32, fontWeight: 700, color, lineHeight: 1 }}>
        {sign}{diff} pts
      </span>
      <span style={{ fontSize: 12, color, marginTop: 4, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
        {baseline} → {current} / 100
      </span>
    </div>
  );
}

export default function SandboxPage() {
  const { simulation, deltas: rawDeltas, report, productDna, isPro } = useLoaderData<typeof loader>();
  const deltas = rawDeltas as DeltaRow[];
  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const isSubmitting = fetcher.state !== "idle";

  const hasInProgress = deltas.some((d) => d.status === "PENDING" || d.status === "RUNNING");
  useEffect(() => {
    if (!hasInProgress) return;
    const interval = setInterval(revalidate, 4000);
    return () => clearInterval(interval);
  }, [hasInProgress, revalidate]);

  const latestCompleted = deltas.find(
    (d) => d.status === "COMPLETED" && d.score != null &&
    !(d.deltaParams as { experimentCardId?: string } | null)?.experimentCardId
  );
  const latestRunning = deltas.find((d) => d.status === "PENDING" || d.status === "RUNNING");

  // Experiment set — group by setGroupId for summary table
  const allSetGroupIds = [
    ...new Set(
      deltas
        .map((d) => (d.deltaParams as { setGroupId?: string } | null)?.setGroupId)
        .filter(Boolean) as string[]
    ),
  ];
  const latestSetGroupId = allSetGroupIds[0] ?? null;
  const experimentSetDeltas = latestSetGroupId
    ? deltas.filter((d) => (d.deltaParams as { setGroupId?: string } | null)?.setGroupId === latestSetGroupId)
    : [];
  const allSetCompleted = experimentSetDeltas.length > 0 && experimentSetDeltas.every((d) => d.status === "COMPLETED" || d.status === "FAILED");

  const productJson = simulation.productJson as { variants?: { price?: string }[] } | null;
  const basePrice = parseFloat(productJson?.variants?.[0]?.price ?? "0");
  const [price, setPrice] = useState(basePrice > 0 ? basePrice : 50);
  const [shippingDays, setShippingDays] = useState(7);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  const priceDropoutPct = report?.friction?.price?.dropoutPct ?? 0;
  const logisticsDropoutPct = report?.friction?.logistics?.dropoutPct ?? 0;

  const experimentCards = productDna?.experimentCards ?? [];
  const selectedCard = experimentCards.find((c) => c.id === selectedCardId) ?? null;
  const axisLabel = productDna?.archetypeAxis ?? null;

  function toggleCard(id: string) {
    setSelectedCardId((prev) => (prev === id ? null : id));
  }

  const runLabel = isSubmitting
    ? "Queueing…"
    : selectedCard
    ? `Test: ${selectedCard.name}`
    : "Run What-If Panel";

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
        {/* ── Left column: baseline data ── */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {/* Baseline score */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Baseline Score</Text>
                <ConfidenceGauge score={simulation.score ?? 0} size={160} />
                <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                  Original simulation score
                </Text>
              </BlockStack>
            </Card>

            {/* Friction hints */}
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
              </BlockStack>
            </Card>

            {/* Product psychology */}
            {productDna && (productDna.coreFear || productDna.coreDesire) && (
              <Card>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">Product Psychology</Text>
                    {axisLabel && (
                      <Badge tone="info">{`${AXIS_EMOJI[axisLabel] ?? ""} ${axisLabel}`}</Badge>
                    )}
                  </InlineStack>
                  {productDna.coreFear && (
                    <Box padding="200" background="bg-surface-critical" borderRadius="100">
                      <Text as="p" variant="bodySm">
                        <Text as="span" fontWeight="semibold">Core fear: </Text>
                        {productDna.coreFear}
                      </Text>
                    </Box>
                  )}
                  {productDna.coreDesire && (
                    <Box padding="200" background="bg-surface-success" borderRadius="100">
                      <Text as="p" variant="bodySm">
                        <Text as="span" fontWeight="semibold">Core desire: </Text>
                        {productDna.coreDesire}
                      </Text>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        {/* ── Right column: comparison + controls ── */}
        <Layout.Section>
          <BlockStack gap="400">

            {/* ── Confidence Shift comparison ── */}
            {latestCompleted && (() => {
              const dp = latestCompleted.deltaParams as { price?: number; shippingDays?: number } | null;
              const scoreDiff = (latestCompleted.score ?? 0) - (simulation.score ?? 0);
              const origTrust = simulation as { trustAudit?: { trustKillers?: { label: string }[] } | null };
              const origPolicyStatus = origTrust.trustAudit?.trustKillers?.some(k => k.label.toLowerCase().includes("return"))
                ? "No Return Policy" : "Has Return Policy";

              return (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Comparison</Text>

                    {/* Confidence Shift badge */}
                    <ConfidenceShift baseline={simulation.score ?? 0} current={latestCompleted.score ?? 0} />

                    <Divider />

                    {/* Side-by-side table */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                      <BlockStack gap="200">
                        <Text as="p" variant="headingSm" tone="subdued">Baseline</Text>
                        <Text as="p" variant="bodyMd">💰 ${basePrice > 0 ? basePrice.toFixed(2) : "—"}</Text>
                        <Text as="p" variant="bodyMd">🚚 {report?.friction?.logistics?.dropoutPct != null ? `${report.friction.logistics.dropoutPct}% logistics friction` : "Shipping: unknown"}</Text>
                        <Text as="p" variant="bodyMd">🛡️ {origPolicyStatus}</Text>
                        <Text as="p" variant="headingMd">Score: {simulation.score ?? "—"}/100</Text>
                      </BlockStack>
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
                        <Text as="p" variant="bodyMd">
                          🚚 {dp?.shippingDays != null ? `${dp.shippingDays}d shipping` : "Unchanged"}
                        </Text>
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

                    {latestCompleted.comparisonInsight && (
                      <>
                        <Divider />
                        <Box padding="400" borderRadius="200" background="bg-surface-secondary" borderWidth="025" borderColor="border">
                          <BlockStack gap="100">
                            <Text as="p" variant="headingSm">🤖 AI Insight</Text>
                            <Text as="p" variant="bodyMd">{latestCompleted.comparisonInsight}</Text>
                          </BlockStack>
                        </Box>
                      </>
                    )}

                    <Button url={`/app/results/${latestCompleted.id}`} size="slim" variant="plain">
                      View full What-If report →
                    </Button>
                  </BlockStack>
                </Card>
              );
            })()}

            {latestRunning && !latestCompleted && (
              <Banner tone="info">
                <Text as="p" variant="bodyMd">Panel is running — score updates automatically…</Text>
              </Banner>
            )}

            {/* ── Experiment Cards ── */}
            {experimentCards.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">🧪 Experiment Cards</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {isPro
                          ? "Select a hypothesis to test — agents will debate this specific change."
                          : "Upgrade to Pro to test these hypotheses with your AI panel."}
                      </Text>
                    </BlockStack>
                    {isPro && experimentCards.length >= 2 && (
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="simulate_all" />
                        <Button
                          size="slim"
                          variant="secondary"
                          submit
                          loading={isSubmitting}
                          disabled={!!latestRunning}
                        >
                          ▶ Simulate All Cards
                        </Button>
                      </fetcher.Form>
                    )}
                  </InlineStack>

                  <BlockStack gap="200">
                    {experimentCards.map((card) => {
                      const isSelected = selectedCardId === card.id;
                      return (
                        <Box
                          key={card.id}
                          padding="300"
                          borderWidth="025"
                          borderRadius="200"
                          borderColor={isSelected ? "border-magic" : "border"}
                          background={isSelected ? "bg-surface-magic" : "bg-surface"}
                        >
                          <BlockStack gap="150">
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="200" blockAlign="center">
                                <Text as="p" variant="bodyMd" fontWeight="semibold">
                                  {card.name}
                                </Text>
                                {card.targetAgent && (
                                  <Badge tone="info">
                                    {AGENT_LABELS[card.targetAgent] ?? card.targetAgent}
                                  </Badge>
                                )}
                              </InlineStack>
                              {isPro ? (
                                <Button
                                  size="slim"
                                  variant={isSelected ? "primary" : "secondary"}
                                  onClick={() => toggleCard(card.id)}
                                >
                                  {isSelected ? "Selected ✓" : "Select"}
                                </Button>
                              ) : (
                                <Badge tone="warning">🔒 Pro</Badge>
                              )}
                            </InlineStack>
                            <Text as="p" variant="bodySm">{card.hypothesis}</Text>
                            {card.rationale && (
                              <Text as="p" variant="bodySm" tone="subdued">{card.rationale}</Text>
                            )}
                          </BlockStack>
                        </Box>
                      );
                    })}
                  </BlockStack>

                  {selectedCard && (
                    <Banner tone="info">
                      <Text as="p" variant="bodySm">
                        <Text as="span" fontWeight="semibold">Active hypothesis: </Text>
                        {selectedCard.hypothesis}
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            )}

            {/* ── Experiment Set Summary Table ── */}
            {allSetCompleted && experimentSetDeltas.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">📊 Experiment Results</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Which hypothesis moved the needle the most?
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "numeric", "text", "text"]}
                    headings={["Experiment", "Score", "vs Baseline", "Status"]}
                    rows={[...experimentSetDeltas]
                      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                      .map((d) => {
                        const dp = d.deltaParams as { experimentCardName?: string } | null;
                        const cardName = dp?.experimentCardName ?? "Experiment";
                        const score = d.score;
                        const diff = score != null ? score - (simulation.score ?? 0) : null;
                        const diffStr = diff == null ? "—" : diff > 0 ? `+${diff} pts ▲` : diff < 0 ? `${diff} pts ▼` : "No change";
                        const statusStr = d.status === "COMPLETED" ? "✓" : d.status === "FAILED" ? "✗" : "⏳";
                        return [cardName, score != null ? `${score}/100` : "—", diffStr, statusStr];
                      })}
                  />
                  <InlineStack gap="200" wrap>
                    {experimentSetDeltas
                      .filter((d) => d.status === "COMPLETED")
                      .map((d) => {
                        const dp = d.deltaParams as { experimentCardName?: string } | null;
                        return (
                          <Button key={d.id} url={`/app/results/${d.id}`} size="slim" variant="plain">
                            View {dp?.experimentCardName ?? "result"} →
                          </Button>
                        );
                      })}
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {/* ── Run a new scenario ── */}
            {isPro ? (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Run a What-If Scenario</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {selectedCard
                      ? "Panel will debate the selected experiment. Optionally adjust price and shipping too."
                      : "Adjust price and shipping, then re-run the panel to see score impact."}
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
                    <input type="hidden" name="intent" value="run_whatif" />
                    <input type="hidden" name="activeExperiment" value={selectedCard?.hypothesis ?? ""} />
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
                        {runLabel}
                      </Button>
                    </BlockStack>
                  </fetcher.Form>
                </BlockStack>
              </Card>
            ) : (
              /* Locked CTA for free tier */
              <CalloutCard
                title="Unlock the What-If Sandbox"
                illustration="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be2a489e0be08b4f9d7a4e5ad25de5b84974268e8cbbd17af_small.png"
                primaryAction={{ content: "Upgrade to Pro", url: "/app/billing" }}
              >
                <Text as="p" variant="bodyMd">
                  Pro gives you unlimited What-If simulations, Experiment Cards, and Vision Analysis —
                  so you can test price, shipping, and listing changes before going live.
                </Text>
              </CalloutCard>
            )}

            {/* All scenarios history */}
            {deltas.filter((d) => !(d.deltaParams as { setGroupId?: string } | null)?.setGroupId).length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">All Scenarios</Text>
                  {deltas
                    .filter((d) => !(d.deltaParams as { setGroupId?: string } | null)?.setGroupId)
                    .map((delta) => {
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
