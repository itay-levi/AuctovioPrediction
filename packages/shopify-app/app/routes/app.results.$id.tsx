import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
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
  SkeletonDisplayText,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { getSimulation } from "../services/simulation.server";
import { getStore } from "../services/store.server";
import { ConfidenceGauge } from "../components/ConfidenceGauge";
import { SwarmGrid } from "../components/SwarmGrid";
import { FrictionReport } from "../components/FrictionReport";

type ReportJson = {
  friction?: {
    price?: { dropoutPct?: number; topObjections?: string[] };
    trust?: { dropoutPct?: number; topObjections?: string[] };
    logistics?: { dropoutPct?: number; topObjections?: string[] };
  };
  summary?: string;
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

  return { simulation, tier: store.planTier };
};

function phaseLabel(phase: number): string {
  if (phase === 0) return "Queued";
  if (phase === 1) return "Vibe Check (Phase 1/3)";
  if (phase === 2) return "Panel Debate (Phase 2/3)";
  if (phase === 3) return "Finalizing Report";
  return "Complete";
}

export default function ResultsPage() {
  const { simulation, tier } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();

  const isDone = simulation.status === "COMPLETED" || simulation.status === "FAILED";
  const isPro = tier === "PRO" || tier === "ENTERPRISE";

  // Poll every 5s while running
  useEffect(() => {
    if (isDone) return;
    const interval = setInterval(revalidate, 5000);
    return () => clearInterval(interval);
  }, [isDone, revalidate]);

  const report = simulation.reportJson as ReportJson | null;

  const frictionData = {
    price: {
      dropoutPct: report?.friction?.price?.dropoutPct ?? 0,
      topObjections: report?.friction?.price?.topObjections ?? [],
    },
    trust: {
      dropoutPct: report?.friction?.trust?.dropoutPct ?? 0,
      topObjections: report?.friction?.trust?.topObjections ?? [],
    },
    logistics: {
      dropoutPct: report?.friction?.logistics?.dropoutPct ?? 0,
      topObjections: report?.friction?.logistics?.topObjections ?? [],
    },
  };

  return (
    <Page>
      <TitleBar
        title="Analysis Results"
        breadcrumbs={[{ content: "Dashboard", url: "/app" }]}
      />
      <BlockStack gap="500">
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
                {phaseLabel(simulation.phase)} — your customer panel is working…
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">Auto-refreshing every 5s</Text>
            </InlineStack>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  {simulation.score != null ? (
                    <>
                      <ConfidenceGauge score={simulation.score} size={200} />
                      {simulation.imageScore != null && (
                        <InlineStack align="center" gap="200">
                          <Text as="span" variant="bodySm" tone="subdued">
                            Visual quality:
                          </Text>
                          <Badge tone={simulation.imageScore >= 70 ? "success" : simulation.imageScore >= 40 ? "warning" : "critical"}>
                            {simulation.imageScore}/100
                          </Badge>
                        </InlineStack>
                      )}
                    </>
                  ) : (
                    <BlockStack gap="200">
                      <SkeletonDisplayText size="large" />
                      <SkeletonBodyText lines={2} />
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {report?.summary && (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">Summary</Text>
                    <Text as="p" variant="bodyMd">{report.summary}</Text>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section>
            <BlockStack gap="400">
              {/* Swarm Grid */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Customer Panel</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Green = would buy · Red = rejected · Hover for reason
                  </Text>
                  <SwarmGrid
                    agentCount={simulation.agentLogs.length || 5}
                    logs={simulation.agentLogs.map((l) => ({
                      agentId: l.agentId,
                      archetype: l.archetype,
                      verdict: l.verdict,
                      reasoning: l.reasoning,
                    }))}
                  />
                </BlockStack>
              </Card>

              {/* Friction Report */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Friction Breakdown</Text>
                  {isDone ? (
                    <FrictionReport friction={frictionData} isPro={isPro} />
                  ) : (
                    <SkeletonBodyText lines={6} />
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>

        {isDone && (
          <InlineStack gap="300">
            <Button url="/app/simulate" variant="primary">
              Run Another Analysis
            </Button>
            <Button url={`/app/sandbox/${simulation.id}`} disabled={!isPro}>
              {isPro ? "Open What-If Sandbox" : "What-If Sandbox (Pro)"}
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}
