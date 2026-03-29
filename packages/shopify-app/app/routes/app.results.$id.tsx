import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  Banner,
  SkeletonBodyText,
  Box,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { getSimulation } from "../services/simulation.server";
import { getStore } from "../services/store.server";
import { ConfidenceGauge } from "../components/ConfidenceGauge";
import { FrictionReport } from "../components/FrictionReport";
import { AnalyticsSafeBadge } from "../components/AnalyticsSafeBadge";
import { IntelligenceExport } from "../components/IntelligenceExport";

type ReportJson = {
  friction?: {
    price?: { dropoutPct?: number; topObjections?: string[] };
    trust?: { dropoutPct?: number; topObjections?: string[] };
    logistics?: { dropoutPct?: number; topObjections?: string[] };
  };
  summary?: string;
};

const ARCHETYPE_META: Record<string, { emoji: string; name: string; focus: string }> = {
  budget_optimizer:  { emoji: "💰", name: "Budget Optimizer",  focus: "Price vs. market value" },
  brand_loyalist:    { emoji: "⭐", name: "Brand Loyalist",    focus: "Trust & social proof" },
  research_analyst:  { emoji: "🔬", name: "Research Analyst",  focus: "Specs & comparisons" },
  impulse_decider:   { emoji: "⚡", name: "Impulse Decider",   focus: "Visuals & FOMO" },
  gift_seeker:       { emoji: "🎁", name: "Gift Seeker",       focus: "Gifting appeal & packaging" },
};

function archetypeMeta(id: string) {
  return ARCHETYPE_META[id] ?? { emoji: "🧑", name: id, focus: "General evaluation" };
}

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

  const productJson = simulation.productJson as { title?: string } | null;
  return {
    simulation,
    tier: store.planTier,
    productTitle: productJson?.title ?? "Product",
  };
};

function PhaseBar({ phase, status }: { phase: number; status: string }) {
  const phases = [
    { n: 1, label: "Vibe Check",     desc: "Each panelist gives an independent first impression" },
    { n: 2, label: "Panel Debate",   desc: "Panelists argue, challenge each other, dissenter injected" },
    { n: 3, label: "Final Verdict",  desc: "Consensus vote and friction report generated" },
  ];
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Analysis Progress</Text>
        <InlineStack gap="400" wrap={false}>
          {phases.map((p) => {
            const done = phase > p.n || status === "COMPLETED";
            const active = phase === p.n && status === "RUNNING";
            return (
              <Box
                key={p.n}
                borderWidth="025"
                borderColor={done ? "border-success" : active ? "border-magic" : "border"}
                borderRadius="200"
                padding="300"
                background={done ? "bg-surface-success" : active ? "bg-surface-magic" : "bg-surface-disabled"}
              >
                <BlockStack gap="100">
                  <InlineStack gap="200" align="start">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {done ? "✅" : active ? "⏳" : "⬜"} Phase {p.n}
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="headingSm">{p.label}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{p.desc}</Text>
                </BlockStack>
              </Box>
            );
          })}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function AgentCard({ log, index }: { log: { agentId: string; archetype: string; phase: number; verdict: string; reasoning: string }; index: number }) {
  const meta = archetypeMeta(log.archetype);
  const isBuy = log.verdict === "BUY";
  const isReject = log.verdict === "REJECT";
  return (
    <Box
      borderWidth="025"
      borderColor={isBuy ? "border-success" : isReject ? "border-critical" : "border"}
      borderRadius="200"
      padding="300"
      background={isBuy ? "bg-surface-success" : isReject ? "bg-surface-critical" : "bg-surface"}
    >
      <BlockStack gap="200">
        <InlineStack align="space-between">
          <InlineStack gap="200">
            <Text as="span" variant="headingSm">{meta.emoji} {meta.name}</Text>
            <Badge tone="info">{`Phase ${log.phase}`}</Badge>
          </InlineStack>
          <Badge tone={isBuy ? "success" : isReject ? "critical" : "warning"}>
            {log.verdict}
          </Badge>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">Focus: {meta.focus}</Text>
        <Divider />
        <Text as="p" variant="bodyMd">"{log.reasoning}"</Text>
      </BlockStack>
    </Box>
  );
}

export default function ResultsPage() {
  const { simulation, tier, productTitle } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();

  const isDone = simulation.status === "COMPLETED" || simulation.status === "FAILED";
  const isPro = tier === "PRO" || tier === "ENTERPRISE";

  useEffect(() => {
    if (isDone) return;
    const interval = setInterval(revalidate, 4000);
    return () => clearInterval(interval);
  }, [isDone, revalidate]);

  const report = simulation.reportJson as ReportJson | null;
  const frictionData = {
    price:     { dropoutPct: report?.friction?.price?.dropoutPct ?? 0,     topObjections: report?.friction?.price?.topObjections ?? [] },
    trust:     { dropoutPct: report?.friction?.trust?.dropoutPct ?? 0,     topObjections: report?.friction?.trust?.topObjections ?? [] },
    logistics: { dropoutPct: report?.friction?.logistics?.dropoutPct ?? 0, topObjections: report?.friction?.logistics?.topObjections ?? [] },
  };

  const phase1Logs = simulation.agentLogs.filter((l) => l.phase === 1);
  const phase2Logs = simulation.agentLogs.filter((l) => l.phase === 2);

  return (
    <Page>
      <TitleBar
        title="Live Panel Analysis"
      />
      <BlockStack gap="500">

        <AnalyticsSafeBadge />

        {simulation.status === "FAILED" && (
          <Banner tone="critical">
            <Text as="p" variant="bodyMd">
              Analysis failed. This has not used your budget. Please try again.
            </Text>
          </Banner>
        )}

        {!isDone && (
          <Banner tone="info">
            <InlineStack align="space-between">
              <Text as="p" variant="bodyMd">
                Your customer panel is working — new results appear every few seconds
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">Auto-refreshing</Text>
            </InlineStack>
          </Banner>
        )}

        <PhaseBar phase={simulation.phase} status={simulation.status} />

        <Layout>
          {/* Left col — score + summary */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Customer Confidence Score</Text>
                  {simulation.score != null ? (
                    <ConfidenceGauge score={simulation.score} size={200} />
                  ) : (
                    <BlockStack gap="200">
                      <SkeletonBodyText lines={3} />
                      <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                        Score revealed after Phase 3
                      </Text>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {report?.summary && (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">Panel Summary</Text>
                    <Text as="p" variant="bodyMd">{report.summary}</Text>
                  </BlockStack>
                </Card>
              )}

              {isDone && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Friction Breakdown</Text>
                    <FrictionReport friction={frictionData} isPro={isPro} />
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>

          {/* Right col — live agent feed */}
          <Layout.Section>
            <BlockStack gap="400">

              {/* Phase 1 feed */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">⚡ Phase 1 — First Impressions</Text>
                    {phase1Logs.length > 0 && (
                      <Badge tone={phase1Logs.some(l => l.verdict === "REJECT") ? "critical" : "success"}>
                        {`${phase1Logs.filter(l => l.verdict === "BUY").length}/${phase1Logs.length} would buy`}
                      </Badge>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Each panelist independently evaluates the listing — no groupthink yet.
                  </Text>
                  {phase1Logs.length === 0 ? (
                    simulation.phase >= 1 || simulation.status === "RUNNING"
                      ? <SkeletonBodyText lines={4} />
                      : <Text as="p" variant="bodySm" tone="subdued">Waiting to start…</Text>
                  ) : (
                    <BlockStack gap="300">
                      {phase1Logs.map((log, i) => <AgentCard key={log.agentId + log.phase} log={log} index={i} />)}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Phase 2 feed */}
              {(simulation.phase >= 2 || phase2Logs.length > 0) && (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingMd">🔥 Phase 2 — Panel Debate</Text>
                      {phase2Logs.length > 0 && (
                        <Badge tone="info">{`${phase2Logs.length} debate entries`}</Badge>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Panelists challenge each other. If too positive, a dissenter is forced to find flaws.
                    </Text>
                    {phase2Logs.length === 0 ? (
                      <SkeletonBodyText lines={4} />
                    ) : (
                      <BlockStack gap="300">
                        {phase2Logs.map((log, i) => <AgentCard key={log.agentId + log.phase} log={log} index={i} />)}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>
              )}

            </BlockStack>
          </Layout.Section>
        </Layout>

        {isDone && (
          <InlineStack gap="300">
            <Button url="/app/simulate" variant="primary">Run Another Panel Check</Button>
            <Button url={`/app/sandbox/${simulation.id}`} disabled={!isPro}>
              {isPro ? "Open What-If Sandbox" : "What-If Sandbox (Pro)"}
            </Button>
          </InlineStack>
        )}

        {isDone && (
          <IntelligenceExport
            simulationId={simulation.id}
            productTitle={productTitle}
            agentLogs={simulation.agentLogs}
            isPro={isPro}
            isEnterprise={tier === "ENTERPRISE"}
            existingSynthesis={(simulation as { synthesisText?: string | null }).synthesisText ?? null}
          />
        )}

      </BlockStack>
    </Page>
  );
}
