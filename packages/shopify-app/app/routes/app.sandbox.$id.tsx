import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { Page, Text, BlockStack, Button, Banner, Card, Badge, InlineStack } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import { getStore, getMtBudgetStatus } from "../services/store.server";
import { getSimulation, getSimulationLabRoot, canRunSimulation, createRetakeSimulation } from "../services/simulation.server";
import { requireTier } from "../services/gates.server";
import { fetchProductById, fetchStoreContext } from "../services/products.server";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import db from "../db.server";
import { AGENT_COUNTS } from "../services/store.server";
import { triggerDeltaSimulation } from "../services/engine.server";
import {
  ComparisonLaboratory,
  type ExperimentCard,
  type PriceBatchResult,
  type ScenarioHistoryRow,
  type TrustAuditFriction,
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

type RetakeVerdict = {
  lens: string;
  verdict: "Pass" | "Improving" | "Fail";
  delta: string;
  polishingTouch: string;
};

type RetakeEvaluation = {
  verdicts: RetakeVerdict[];
  overallVerdict: "Pass" | "Improving" | "Fail";
  overallPolishingTouch: string;
};

type RetakeRow = {
  id: string;
  status: string;
  score: number | null;
  retakeEvaluation: unknown;
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

  const [loaded, store] = await Promise.all([
    getSimulation(params.id!),
    getStore(shopDomain),
  ]);

  if (!loaded || loaded.storeId !== store?.id) {
    throw new Response("Not found", { status: 404 });
  }
  // Opening the lab on a what-if/delta record shows the wrong "baseline" (child logs + prices).
  if (loaded.originalSimulationId) {
    throw redirect(`/app/sandbox/${loaded.originalSimulationId}`);
  }
  const simulation = loaded;
  if (simulation.status !== "COMPLETED") {
    throw new Response("Simulation must be completed first", { status: 400 });
  }

  const tier = store?.planTier ?? "FREE";
  const isDev = process.env.NODE_ENV === "development";
  const isPro = isDev || tier === "PRO" || tier === "ENTERPRISE";

  const [deltas, retakeSims] = await Promise.all([
    db.simulation.findMany({
      where: { originalSimulationId: simulation.id, simulationType: { not: "RETAKE" } },
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
    }),
    db.simulation.findMany({
      where: { originalSimulationId: simulation.id, simulationType: "RETAKE" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        status: true,
        score: true,
        retakeEvaluation: true,
        createdAt: true,
      },
    }),
  ]);

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

  function frictionFromReportJson(rj: unknown): PriceBatchResult["friction"] {
    const r = rj as {
      friction?: {
        price?: { dropoutPct?: number };
        trust?: { dropoutPct?: number };
        logistics?: { dropoutPct?: number };
      };
    } | null;
    if (!r?.friction) return null;
    return {
      price: r.friction.price?.dropoutPct,
      trust: r.friction.trust?.dropoutPct,
      logistics: r.friction.logistics?.dropoutPct,
    };
  }

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
      friction: frictionFromReportJson(d.reportJson),
    };
  });

  return {
    simulation,
    store,
    deltas,
    retakeSims,
    report,
    productDna,
    isPro,
    latestWhatIfDelta,
    latestWhatIfAgentLogs,
    priceBatchResults,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  await requireTier(shopDomain, "PRO", "sandbox");

  const formData = await request.formData();
  const intent = (formData.get("intent") as string | null) ?? "run_whatif";
  const priceOverride = formData.get("price") ? Number(formData.get("price")) : undefined;
  const shippingDays = formData.get("shippingDays") ? Number(formData.get("shippingDays")) : undefined;
  const activeExperiment = (formData.get("activeExperiment") as string | null) || undefined;

  const [originalSim, store] = await Promise.all([
    getSimulationLabRoot(params.id!),
    getStore(shopDomain),
  ]);

  if (!originalSim || originalSim.storeId !== store?.id) {
    return { error: "Simulation not found" };
  }

  const { allowed, reason } = await canRunSimulation(shopDomain, store.id);
  if (!allowed) {
    return { error: reason };
  }

  const tier = store.planTier;
  const agentCount = AGENT_COUNTS[tier];
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const callbackUrl = `${appUrl}/webhooks/engine/callback`;
  const productDna = (originalSim as { productDna?: unknown }).productDna ?? undefined;

  if (intent === "run_retake") {
    await requireTier(shopDomain, "PRO", "retake");

    const productId = (originalSim.productJson as { id?: string } | null)?.id;
    if (!productId) {
      return { error: "Product ID not found — cannot re-fetch the latest listing." };
    }

    const freshProduct = await fetchProductById(admin, productId);
    if (!freshProduct) {
      return { error: "Could not fetch the latest version of your product from Shopify." };
    }

    const storeContext = await fetchStoreContext(admin).catch(() => null) ?? undefined;

    const retakeSim = await createRetakeSimulation(
      originalSim,
      freshProduct,
      shopDomain,
      store.shopType ?? "general_retail",
      tier,
      appUrl,
      undefined,
      storeContext,
    );

    console.info(`[Retake] Created ${retakeSim.id} for original ${originalSim.id}`);
    throw redirect(`/app/sandbox/${originalSim.id}`);
  }

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
          skipFloor: true,
        }).catch((err: unknown) => {
          console.error(`[Engine] Experiment card "${card.name}" trigger failed:`, err);
          db.simulation
            .update({
              where: { id: deltaSim.id },
              data: {
                status: "FAILED",
                failureReason: "The experiment could not be started. Please try again.",
              } as Parameters<typeof db.simulation.update>[0]["data"],
            })
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
          skipFloor: true,
        }).catch((err: unknown) => {
          console.error(`[Engine] Price batch ${pct}% trigger failed:`, err);
          db.simulation
            .update({
              where: { id: deltaSim.id },
              data: {
                status: "FAILED",
                failureReason: "The price simulation could not be started. Please try again.",
              } as Parameters<typeof db.simulation.update>[0]["data"],
            })
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
    skipFloor: true,
  }).catch((err: unknown) => {
    console.error("[Engine] Delta trigger failed:", err);
    db.simulation
      .update({
        where: { id: deltaSim.id },
        data: {
          status: "FAILED",
          failureReason: "The scenario could not be started. Please try again.",
        } as Parameters<typeof db.simulation.update>[0]["data"],
      })
      .catch(() => {});
  });

  throw redirect(`/app/sandbox/${originalSim.id}`);
};

export default function SandboxPage() {
  const {
    simulation,
    deltas: rawDeltas,
    retakeSims: rawRetakeSims,
    report,
    productDna,
    isPro,
    latestWhatIfDelta,
    latestWhatIfAgentLogs,
    priceBatchResults,
  } = useLoaderData<typeof loader>();
  const deltas = rawDeltas as DeltaRow[];
  const retakeSims = rawRetakeSims as RetakeRow[];
  const latestRetake = retakeSims[0] ?? null;
  const retakeRunning = latestRetake?.status === "PENDING" || latestRetake?.status === "RUNNING";
  const retakeEvaluation = latestRetake?.retakeEvaluation as RetakeEvaluation | null;
  const hasRecs = Array.isArray((simulation as { recommendations?: unknown }).recommendations)
    && ((simulation as { recommendations: unknown[] }).recommendations).length > 0;

  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const isSubmitting = fetcher.state !== "idle";

  const batchRunning = priceBatchResults.some(
    (r) => r.status === "PENDING" || r.status === "RUNNING"
  );

  const hasInProgress = deltas.some((d) => d.status === "PENDING" || d.status === "RUNNING");
  const [deltaElapsed, setDeltaElapsed] = useState(0);
  const [deltaStale, setDeltaStale] = useState(false);
  const prevHasInProgress = useRef(hasInProgress);

  // Reset stale state when a new run starts
  useEffect(() => {
    if (hasInProgress && !prevHasInProgress.current) {
      setDeltaElapsed(0);
      setDeltaStale(false);
    }
    prevHasInProgress.current = hasInProgress;
  }, [hasInProgress]);

  // Keep polling while running — slow to 10s after stale threshold, never stop
  useEffect(() => {
    if (!hasInProgress && !retakeRunning) return;
    const interval = setInterval(revalidate, deltaStale ? 10000 : 4000);
    return () => clearInterval(interval);
  }, [hasInProgress, retakeRunning, deltaStale, revalidate]);

  useEffect(() => {
    if (!hasInProgress) { setDeltaElapsed(0); return; }
    const timer = setInterval(() => setDeltaElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [hasInProgress]);

  // Show stale notice after 10 min (What-If panels are faster than root scans)
  useEffect(() => {
    if (deltaElapsed >= 600 && hasInProgress && !deltaStale) {
      setDeltaStale(true);
    }
  }, [deltaElapsed, hasInProgress, deltaStale]);

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

  function selectExperimentCard(id: string) {
    setSelectedCardId(id);
  }

  const runLabel = isSubmitting
    ? "Queueing…"
    : selectedCard
      ? `Preview “${selectedCard.name}” vs baseline`
      : "Preview change vs baseline";

  const baselineScore = simulation.score ?? 0;
  const baselinePhase1 = simulation.agentLogs.filter((l) => l.phase === 1);
  const baselinePhase2 = simulation.agentLogs.filter((l) => l.phase === 2);
  const labPhase1 = latestWhatIfAgentLogs.filter((l) => l.phase === 1);
  const labPhase2 = latestWhatIfAgentLogs.filter((l) => l.phase === 2);

  const labScore = latestWhatIfDelta?.score ?? null;
  const dpLatest = latestWhatIfDelta?.deltaParams as { price?: number; shippingDays?: number } | null;

  const scenarioHistory: ScenarioHistoryRow[] = deltas
    .filter((d) => !(d.deltaParams as { setGroupId?: string } | null)?.setGroupId)
    .map((d) => {
      const dp = d.deltaParams as { price?: number; shippingDays?: number } | null;
      return {
        id: d.id,
        status: d.status,
        score: d.score,
        createdAt: d.createdAt,
        price: dp?.price ?? null,
        shippingDays: dp?.shippingDays ?? null,
      };
    });

  return (
    <Page fullWidth>
      <TitleBar
        title="Comparison laboratory"
        breadcrumbs={[
          { content: "Dashboard", url: "/app" },
          { content: "History", url: "/app/history" },
          { content: "Results", url: `/app/results/${simulation.id}` },
        ]}
      />
      <BlockStack gap="500">
        {fetcher.data?.error && (
          <Banner tone="critical" title="Could not start analysis">
            <Text as="p" variant="bodyMd">{fetcher.data.error}</Text>
          </Banner>
        )}

        {deltaStale && hasInProgress && (
          <Banner tone="warning" title="Analysis is taking longer than expected">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                The connection to the analysis engine may have been interrupted. You can wait for it to complete or run a new scenario.
              </Text>
              <Button onClick={revalidate} variant="plain">Refresh now</Button>
            </BlockStack>
          </Banner>
        )}

        <ComparisonLaboratory
          simulationId={simulation.id}
          productUrl={simulation.productUrl}
          baselineScore={baselineScore}
          baselinePhase1={baselinePhase1}
          labPhase1={labPhase1}
          baselinePhase2={baselinePhase2}
          labPhase2={labPhase2}
          priceDropoutPct={priceDropoutPct}
          logisticsDropoutPct={logisticsDropoutPct}
          trustDropoutPct={trustDropoutPct}
          trustAudit={(simulation.trustAudit as TrustAuditFriction | null) ?? null}
          experimentCards={experimentCards}
          isPro={isPro}
          basePrice={basePrice}
          price={price}
          setPrice={setPrice}
          shippingDays={shippingDays}
          setShippingDays={setShippingDays}
          selectedCardId={selectedCardId}
          toggleCard={toggleCard}
          selectExperimentCard={selectExperimentCard}
          runLabel={runLabel}
          isSubmitting={isSubmitting}
          latestRunning={!!latestRunning}
          deltaElapsed={deltaElapsed}
          deltaStale={deltaStale}
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
          scenarioHistory={scenarioHistory}
        />

        {/* ── Retake Test (PRO) ─────────────────────────────────────────── */}
        {isPro && hasRecs && (
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Retake Test</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Made changes to your listing based on the Golden Actions? Run a retake to see
                  your new score and get a Pass / Improving / Fail verdict on each fix.
                </Text>
              </BlockStack>

              {retakeRunning && (
                <Banner tone="info" title="Retake panel is running…">
                  <Text as="p" variant="bodyMd">
                    The full panel is re-evaluating your updated listing. This takes 2–4 minutes.
                  </Text>
                </Banner>
              )}

              {!retakeRunning && retakeEvaluation && (
                <BlockStack gap="300">
                  <InlineStack gap="200" align="start">
                    <Badge
                      tone={
                        retakeEvaluation.overallVerdict === "Pass"
                          ? "success"
                          : retakeEvaluation.overallVerdict === "Improving"
                          ? "warning"
                          : "critical"
                      }
                    >
                      Overall: {retakeEvaluation.overallVerdict}
                    </Badge>
                    {latestRetake?.score != null && (
                      <Badge tone="info">
                        New score: {latestRetake.score}/100
                        {(simulation.score ?? 0) > 0 && (
                          <> ({latestRetake.score - (simulation.score ?? 0) >= 0 ? "+" : ""}{latestRetake.score - (simulation.score ?? 0)} pts)</>
                        )}
                      </Badge>
                    )}
                  </InlineStack>

                  {retakeEvaluation.verdicts.map((v) => (
                    <Card key={v.lens}>
                      <BlockStack gap="200">
                        <InlineStack gap="200" align="start">
                          <Text as="span" variant="headingSm">{v.lens}</Text>
                          <Badge
                            tone={
                              v.verdict === "Pass"
                                ? "success"
                                : v.verdict === "Improving"
                                ? "warning"
                                : "critical"
                            }
                          >
                            {v.verdict}
                          </Badge>
                        </InlineStack>
                        <Text as="p" variant="bodyMd">{v.delta}</Text>
                        {v.polishingTouch && (
                          <Banner tone={v.verdict === "Fail" ? "critical" : "warning"}>
                            <Text as="p" variant="bodyMd">
                              <Text as="span" fontWeight="bold">Next step: </Text>
                              {v.polishingTouch}
                            </Text>
                          </Banner>
                        )}
                      </BlockStack>
                    </Card>
                  ))}

                  {retakeEvaluation.overallPolishingTouch && retakeEvaluation.overallVerdict !== "Pass" && (
                    <Banner tone="info" title="Your highest-leverage next action">
                      <Text as="p" variant="bodyMd">{retakeEvaluation.overallPolishingTouch}</Text>
                    </Banner>
                  )}
                </BlockStack>
              )}

              {!retakeRunning && (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="run_retake" />
                  <Button
                    submit
                    variant={retakeEvaluation ? "plain" : "primary"}
                    loading={fetcher.state !== "idle" && fetcher.formData?.get("intent") === "run_retake"}
                    disabled={retakeRunning}
                  >
                    {retakeEvaluation ? "Run another retake" : "I've made these changes — run retake"}
                  </Button>
                </fetcher.Form>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
