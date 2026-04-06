import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { Page, Text, BlockStack, InlineStack, Button, Badge } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { getSimulation } from "../services/simulation.server";
import { requireTier } from "../services/gates.server";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import db from "../db.server";
import { AGENT_COUNTS } from "../services/store.server";
import { triggerDeltaSimulation } from "../services/engine.server";
import {
  ComparisonLaboratory,
  type ExperimentCard,
  type PriceBatchResult,
} from "../components/sandbox/ComparisonLaboratory";

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

type AgentLogSlim = {
  agentId: string;
  archetype: string;
  archetypeName: string | null;
  archetypeEmoji: string | null;
  personaName: string | null;
  phase: number;
  verdict: string;
  reasoning: string;
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

  const latestWhatIfDelta = deltas.find(
    (d) =>
      d.status === "COMPLETED" &&
      d.score != null &&
      !(d.deltaParams as { experimentCardId?: string } | null)?.experimentCardId,
  );

  let latestWhatIfAgentLogs: {
    agentId: string;
    archetype: string;
    archetypeName: string | null;
    archetypeEmoji: string | null;
    personaName: string | null;
    phase: number;
    verdict: string;
    reasoning: string;
  }[] = [];

  if (latestWhatIfDelta) {
    const row = await db.simulation.findUnique({
      where: { id: latestWhatIfDelta.id },
      select: {
        agentLogs: {
          orderBy: { createdAt: "asc" },
          select: {
            agentId: true,
            archetype: true,
            archetypeName: true,
            archetypeEmoji: true,
            personaName: true,
            phase: true,
            verdict: true,
            reasoning: true,
          },
        },
      },
    });
    latestWhatIfAgentLogs = row?.agentLogs ?? [];
  }

  const report = simulation.reportJson as {
    friction?: {
      price?: { dropoutPct?: number };
      trust?: { dropoutPct?: number };
      logistics?: { dropoutPct?: number };
    };
  } | null;

  const productDna = (simulation as { productDna?: unknown }).productDna as ProductDna | null;

  // ── Price batch results ───────────────────────────────────────────────────
  const agentLogSelect = {
    agentId: true, archetype: true, archetypeName: true,
    archetypeEmoji: true, personaName: true,
    phase: true, verdict: true, reasoning: true,
  } as const;

  const priceBatchDeltas = (deltas as DeltaRow[]).filter((d) => {
    const dp = d.deltaParams as { batchGroupId?: string } | null;
    return dp?.batchGroupId?.startsWith("price_batch_");
  });

  // Latest group first (deltas are already sorted by createdAt desc)
  const latestBatchGroupId = priceBatchDeltas.length > 0
    ? (priceBatchDeltas[0].deltaParams as { batchGroupId: string }).batchGroupId
    : null;

  const latestBatchDeltas = latestBatchGroupId
    ? priceBatchDeltas.filter(
        (d) => (d.deltaParams as { batchGroupId: string }).batchGroupId === latestBatchGroupId
      )
    : [];

  // Fetch agent logs for completed batch sims in parallel
  const completedBatchSims = latestBatchDeltas.filter((d) => d.status === "COMPLETED");
  const batchLogsResults = completedBatchSims.length > 0
    ? await Promise.all(
        completedBatchSims.map((d) =>
          db.simulation.findUnique({
            where: { id: d.id },
            select: { agentLogs: { orderBy: { createdAt: "asc" }, select: agentLogSelect } },
          })
        )
      )
    : [];

  const batchLogsMap: Record<string, AgentLogSlim[]> = {};
  completedBatchSims.forEach((d, i) => {
    batchLogsMap[d.id] = batchLogsResults[i]?.agentLogs ?? [];
  });

  const priceBatchResults: PriceBatchResult[] = latestBatchDeltas.map((d) => {
    const dp = d.deltaParams as { price?: number; pctDelta?: number } | null;
    const logs = batchLogsMap[d.id] ?? [];
    return {
      id: d.id,
      price: dp?.price ?? 0,
      pctDelta: dp?.pctDelta ?? 0,
      status: d.status,
      score: d.score,
      phase1Logs: logs.filter((l) => l.phase === 1),
      phase2Logs: logs.filter((l) => l.phase === 2),
      comparisonInsight: d.comparisonInsight,
    };
  });

  return {
    simulation,
    store,
    deltas,
    report,
    productDna,
    isPro,
    latestWhatIfDelta,
    latestWhatIfAgentLogs,
    priceBatchResults,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

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
      }),
    );

    throw redirect(`/app/sandbox/${originalSim.id}`);
  }

  if (intent === "batch_price_optimize") {
    const batchGroupId = `price_batch_${originalSim.id}_${Date.now()}`;
    const rawPrice = parseFloat(
      (originalSim.productJson as { variants?: { price?: string }[] } | null)
        ?.variants?.[0]?.price ?? "50"
    );
    const baseP = rawPrice > 0 ? rawPrice : 50;
    const pctDeltas = [-5, -10, -15];

    await Promise.all(
      pctDeltas.map(async (pct) => {
        const newPrice = Math.round(baseP * (1 + pct / 100) * 100) / 100;
        const deltaSim = await db.simulation.create({
          data: {
            storeId: store.id,
            productUrl: originalSim.productUrl,
            productJson: originalSim.productJson as object,
            status: "PENDING",
            phase: 0,
            mtCost: agentCount * 2,
            originalSimulationId: originalSim.id,
            deltaParams: { price: newPrice, pctDelta: pct, batchGroupId } as object,
          },
        });

        triggerDeltaSimulation({
          simulationId: deltaSim.id,
          originalSimulationId: originalSim.id,
          shopDomain,
          shopType: store.shopType ?? "general_retail",
          productJson: originalSim.productJson,
          agentCount,
          deltaParams: { price: newPrice },
          callbackUrl,
          priority: 1,
          originalScore: originalSim.score ?? undefined,
          originalFriction: (originalSim.reportJson as { friction?: unknown } | null)?.friction ?? undefined,
          originalTrustAudit: (originalSim as { trustAudit?: unknown }).trustAudit ?? undefined,
          productDna,
          isPro: true,
        }).catch((err: unknown) => {
          console.error(`[Engine] Price batch ${pct}% trigger failed:`, err);
          db.simulation
            .update({ where: { id: deltaSim.id }, data: { status: "FAILED" } })
            .catch(() => {});
        });
      }),
    );

    throw redirect(`/app/sandbox/${originalSim.id}`);
  }

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

export default function SandboxPage() {
  const {
    simulation,
    deltas: rawDeltas,
    report,
    productDna,
    isPro,
    latestWhatIfDelta,
    latestWhatIfAgentLogs,
    priceBatchResults,
  } = useLoaderData<typeof loader>();
  const deltas = rawDeltas as DeltaRow[];
  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const isSubmitting = fetcher.state !== "idle";

  const batchRunning = priceBatchResults.some(
    (r) => r.status === "PENDING" || r.status === "RUNNING"
  );

  const hasInProgress = deltas.some((d) => d.status === "PENDING" || d.status === "RUNNING");
  useEffect(() => {
    if (!hasInProgress) return;
    const interval = setInterval(revalidate, 4000);
    return () => clearInterval(interval);
  }, [hasInProgress, revalidate]);

  const latestRunning = deltas.find((d) => d.status === "PENDING" || d.status === "RUNNING");

  const allSetGroupIds = [
    ...new Set(
      deltas
        .map((d) => (d.deltaParams as { setGroupId?: string } | null)?.setGroupId)
        .filter(Boolean) as string[],
    ),
  ];
  const latestSetGroupId = allSetGroupIds[0] ?? null;
  const experimentSetDeltas = latestSetGroupId
    ? deltas.filter((d) => (d.deltaParams as { setGroupId?: string } | null)?.setGroupId === latestSetGroupId)
    : [];
  const allSetCompleted =
    experimentSetDeltas.length > 0 &&
    experimentSetDeltas.every((d) => d.status === "COMPLETED" || d.status === "FAILED");

  const productJson = simulation.productJson as { variants?: { price?: string }[] } | null;
  const basePrice = parseFloat(productJson?.variants?.[0]?.price ?? "0");
  const [price, setPrice] = useState(basePrice > 0 ? basePrice : 50);
  const [shippingDays, setShippingDays] = useState(7);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  const priceDropoutPct = report?.friction?.price?.dropoutPct ?? 0;
  const logisticsDropoutPct = report?.friction?.logistics?.dropoutPct ?? 0;
  const trustDropoutPct = report?.friction?.trust?.dropoutPct ?? 0;

  const experimentCards = productDna?.experimentCards ?? [];
  const selectedCard = experimentCards.find((c) => c.id === selectedCardId) ?? null;

  function toggleCard(id: string) {
    setSelectedCardId((prev) => (prev === id ? null : id));
  }

  const runLabel = isSubmitting
    ? "Queueing…"
    : selectedCard
      ? `Run: ${selectedCard.name}`
      : "Run What-If";

  const baselineScore = simulation.score ?? 0;
  const baselinePhase1 = simulation.agentLogs.filter((l) => l.phase === 1);
  const baselinePhase2 = simulation.agentLogs.filter((l) => l.phase === 2);
  const labPhase1 = latestWhatIfAgentLogs.filter((l) => l.phase === 1);
  const labPhase2 = latestWhatIfAgentLogs.filter((l) => l.phase === 2);

  const labScore = latestWhatIfDelta?.score ?? null;
  const dpLatest = latestWhatIfDelta?.deltaParams as { price?: number; shippingDays?: number } | null;

  return (
    <Page>
      <TitleBar
        title="Comparison laboratory"
        breadcrumbs={[
          { content: "Dashboard", url: "/app" },
          { content: "History", url: "/app/history" },
          { content: "Results", url: `/app/results/${simulation.id}` },
        ]}
      />
      <BlockStack gap="500">
        <ComparisonLaboratory
          simulationId={simulation.id}
          baselineScore={baselineScore}
          baselinePhase1={baselinePhase1}
          labPhase1={labPhase1}
          baselinePhase2={baselinePhase2}
          labPhase2={labPhase2}
          priceDropoutPct={priceDropoutPct}
          logisticsDropoutPct={logisticsDropoutPct}
          trustDropoutPct={trustDropoutPct}
          experimentCards={experimentCards}
          isPro={isPro}
          basePrice={basePrice}
          price={price}
          setPrice={setPrice}
          shippingDays={shippingDays}
          setShippingDays={setShippingDays}
          selectedCardId={selectedCardId}
          toggleCard={toggleCard}
          runLabel={runLabel}
          isSubmitting={isSubmitting}
          latestRunning={!!latestRunning}
          fetcher={fetcher}
          fetcherError={fetcher.data?.error}
          labScore={labScore}
          latestCompletedInsight={latestWhatIfDelta?.comparisonInsight ?? null}
          latestCompletedId={latestWhatIfDelta?.id ?? null}
          latestDeltaPrice={dpLatest?.price ?? null}
          latestDeltaShipping={dpLatest?.shippingDays ?? null}
          experimentSetDeltas={experimentSetDeltas}
          allSetCompleted={allSetCompleted}
          priceBatchResults={priceBatchResults as PriceBatchResult[]}
          batchRunning={batchRunning}
        />

        {deltas.filter((d) => !(d.deltaParams as { setGroupId?: string } | null)?.setGroupId).length >
          0 && (
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Scenario history
            </Text>
            {deltas
              .filter((d) => !(d.deltaParams as { setGroupId?: string } | null)?.setGroupId)
              .map((delta) => {
                const dp = delta.deltaParams as { price?: number; shippingDays?: number } | null;
                return (
                  <InlineStack key={delta.id} align="space-between" blockAlign="center">
                    <BlockStack gap="0">
                      <Text as="p" variant="bodyMd">
                        {dp?.price != null ? `$${Number(dp.price).toFixed(2)}` : "Original price"}
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
                        <Button url={`/app/results/${delta.id}`} size="slim" variant="plain">
                          View
                        </Button>
                      )}
                    </InlineStack>
                  </InlineStack>
                );
              })}
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
