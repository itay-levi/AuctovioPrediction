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
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
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

const ARCHETYPE_META: Record<string, {
  emoji: string;
  name: string;
  focus: string;
  personality: string;
  dealbreakers: string[];
  shopTypeHints: Record<string, string>;
}> = {
  budget_optimizer: {
    emoji: "💰",
    name: "Budget Optimizer",
    focus: "Price vs. market value",
    personality: "Analytical and skeptical. Will compare your price against competitors before committing.",
    dealbreakers: ["Price feels unjustified", "No sale/discount signal", "Shipping cost surprise at checkout"],
    shopTypeHints: {
      fashion: "Checks if price matches fabric quality signals and brand positioning.",
      electronics: "Cross-references spec-to-price ratio against known market alternatives.",
      home_decor: "Evaluates perceived durability vs. cost — looks for 'premium' justification.",
      default: "Evaluates whether the price feels fair for what's being offered.",
    },
  },
  brand_loyalist: {
    emoji: "⭐",
    name: "Brand Loyalist",
    focus: "Trust & social proof",
    personality: "Needs to feel safe. Scans for reviews, guarantees, and brand credibility first.",
    dealbreakers: ["No reviews or very few", "Missing return policy", "No trust badges", "Generic product photography"],
    shopTypeHints: {
      fashion: "Looks for brand story, sustainability claims, and customer photo reviews.",
      electronics: "Needs warranty info, brand reputation, and spec accuracy.",
      home_decor: "Checks 'as shown' credibility — wants real-home photos, not studio shots.",
      default: "Scans for social proof: reviews, guarantees, and brand legitimacy.",
    },
  },
  research_analyst: {
    emoji: "🔬",
    name: "Research Analyst",
    focus: "Specs & comparisons",
    personality: "Methodical and detail-oriented. Reads every word of the description. Notices missing info.",
    dealbreakers: ["Vague or incomplete description", "No size/dimensions", "Missing material info", "No comparison context"],
    shopTypeHints: {
      fashion: "Checks fabric composition, care instructions, sizing chart completeness.",
      electronics: "Goes deep on specs — processor, battery, compatibility. Notices any omissions.",
      home_decor: "Needs exact dimensions, material details, and assembly requirements.",
      default: "Evaluates completeness and accuracy of product information.",
    },
  },
  impulse_decider: {
    emoji: "⚡",
    name: "Impulse Decider",
    focus: "Visuals & emotional pull",
    personality: "Makes fast gut decisions. Your hero image is everything. Bad photos = instant pass.",
    dealbreakers: ["Weak hero image", "No lifestyle photography", "Boring title", "No urgency signal"],
    shopTypeHints: {
      fashion: "Reacts entirely to the first photo — needs to see the item worn on a real person.",
      electronics: "Wants a 'wow' feature highlighted prominently — not buried in specs.",
      home_decor: "Needs to visualise it in their home. Room-setting photos are essential.",
      default: "Judges by first impression — hero image, title hook, and emotional appeal.",
    },
  },
  gift_seeker: {
    emoji: "🎁",
    name: "Gift Seeker",
    focus: "Gifting appeal & packaging",
    personality: "Buying for someone else. Prioritizes presentation, gift-worthiness, and fast shipping.",
    dealbreakers: ["No gift wrapping option", "Slow shipping", "Product feels too personal/niche", "No 'perfect gift for' framing"],
    shopTypeHints: {
      fashion: "Evaluates if sizing is giftable — looks for gift notes, free returns on sizing.",
      electronics: "Checks if the product feels 'giftable' and whether box presentation matters.",
      home_decor: "Loves items that look impressive unboxed. Packaging photos help a lot.",
      default: "Evaluates giftability: presentation, shipping speed, and perceived value.",
    },
  },
};

function archetypeMeta(id: string) {
  return ARCHETYPE_META[id] ?? {
    emoji: "🧑",
    name: id,
    focus: "General evaluation",
    personality: "Evaluates the listing holistically.",
    dealbreakers: [],
    shopTypeHints: {},
  };
}

// The standard 5-archetype roster the engine always assembles
const ROSTER_ORDER = ["budget_optimizer", "brand_loyalist", "research_analyst", "impulse_decider", "gift_seeker"];

function PanelRosterCard({
  archetypeId,
  hasVoted,
  verdict,
  dynamicName,
  dynamicEmoji,
}: {
  archetypeId: string;
  shopType: string;
  hasVoted: boolean;
  verdict?: string;
  dynamicName?: string;
  dynamicEmoji?: string;
}) {
  const staticMeta = archetypeMeta(archetypeId);
  const displayName = dynamicName ?? staticMeta.name;
  const displayEmoji = dynamicEmoji ?? staticMeta.emoji;

  return (
    <Box
      borderWidth="025"
      borderColor={
        verdict === "BUY" ? "border-success"
        : verdict === "REJECT" ? "border-critical"
        : verdict ? "border-caution"
        : "border"
      }
      borderRadius="200"
      padding="400"
      background={
        verdict === "BUY" ? "bg-surface-success"
        : verdict === "REJECT" ? "bg-surface-critical"
        : verdict ? "bg-surface-caution"
        : "bg-surface"
      }
    >
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="300" blockAlign="center">
          <Text as="span" variant="headingLg">{displayEmoji}</Text>
          <Text as="p" variant="headingSm">{displayName}</Text>
        </InlineStack>
        {hasVoted && verdict ? (
          <Badge tone={verdict === "BUY" ? "success" : verdict === "REJECT" ? "critical" : "warning"}>
            {verdict}
          </Badge>
        ) : (
          <InlineStack gap="200" blockAlign="center">
            <Spinner size="small" />
            <Text as="span" variant="bodySm" tone="subdued">Deliberating…</Text>
          </InlineStack>
        )}
      </InlineStack>
    </Box>
  );
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
    shopType: store?.shopType ?? "default",
    isDev: process.env.NODE_ENV === "development",
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

function AgentCard({ log }: {
  log: {
    agentId: string;
    archetype: string;
    archetypeName?: string | null;
    archetypeEmoji?: string | null;
    phase: number;
    verdict: string;
    reasoning: string;
  };
  index?: number;
}) {
  // Use dynamic name/emoji from DB if available, fall back to static map
  const staticMeta = archetypeMeta(log.archetype);
  const displayName = log.archetypeName ?? staticMeta.name;
  const displayEmoji = log.archetypeEmoji ?? staticMeta.emoji;

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
            <Text as="span" variant="headingSm">{displayEmoji} {displayName}</Text>
            <Badge tone="info">{`Phase ${log.phase}`}</Badge>
          </InlineStack>
          <Badge tone={isBuy ? "success" : isReject ? "critical" : "warning"}>
            {log.verdict}
          </Badge>
        </InlineStack>
        <Divider />
        <Text as="p" variant="bodyMd">"{log.reasoning}"</Text>
      </BlockStack>
    </Box>
  );
}

export default function ResultsPage() {
  const { simulation, tier, productTitle, shopType, isDev } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const isDone = simulation.status === "COMPLETED" || simulation.status === "FAILED";
  const isPro = isDev || tier === "PRO" || tier === "ENTERPRISE";

  useEffect(() => {
    if (isDone) return;
    const interval = setInterval(revalidate, 4000);
    return () => clearInterval(interval);
  }, [isDone, revalidate]);

  // Elapsed timer to show progress while waiting
  useEffect(() => {
    if (isDone) return;
    const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [isDone]);

  const report = simulation.reportJson as ReportJson | null;
  const frictionData = {
    price:     { dropoutPct: report?.friction?.price?.dropoutPct ?? 0,     topObjections: report?.friction?.price?.topObjections ?? [] },
    trust:     { dropoutPct: report?.friction?.trust?.dropoutPct ?? 0,     topObjections: report?.friction?.trust?.topObjections ?? [] },
    logistics: { dropoutPct: report?.friction?.logistics?.dropoutPct ?? 0, topObjections: report?.friction?.logistics?.topObjections ?? [] },
  };

  const phase1Logs = simulation.agentLogs.filter((l) => l.phase === 1);
  const phase2Logs = simulation.agentLogs.filter((l) => l.phase === 2);

  // Build a verdict map so roster cards know who has voted
  // Build a map of archetype_id → {verdict, name, emoji} from actual vote data
  const phase1VerdictMap = Object.fromEntries(
    phase1Logs.map((l) => [l.archetype, {
      verdict: l.verdict,
      name: l.archetypeName ?? archetypeMeta(l.archetype).name,
      emoji: l.archetypeEmoji ?? archetypeMeta(l.archetype).emoji,
    }])
  );

  const isPending = simulation.status === "PENDING" || (simulation.status === "RUNNING" && phase1Logs.length === 0);

  function formatElapsed(seconds: number) {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  return (
    <Page>
      <TitleBar title="Live Panel Analysis" />
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
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="300" blockAlign="center">
                <Spinner size="small" />
                <Text as="p" variant="bodyMd">
                  Your customer panel is working — new results appear every few seconds
                </Text>
              </InlineStack>
              <InlineStack gap="300">
                {elapsedSeconds > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">{formatElapsed(elapsedSeconds)}</Text>
                )}
                <Text as="p" variant="bodySm" tone="subdued">Auto-refreshing</Text>
              </InlineStack>
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

          {/* Right col — panel roster + live agent feed */}
          <Layout.Section>
            <BlockStack gap="400">

              {/* Panel Roster — always visible, shows who's in the panel and their live status */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        {isPending ? "🧑‍🤝‍🧑 Assembling Your Panel…" : "🧑‍🤝‍🧑 Your Customer Panel"}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {isPending
                          ? "These 5 AI shoppers are about to evaluate your product. Here's who they are and what they'll look for."
                          : `${phase1Logs.length} of ${ROSTER_ORDER.length} panelists have voted so far`}
                      </Text>
                    </BlockStack>
                    {isPending && <Spinner size="small" />}
                    {!isPending && phase1Logs.length === ROSTER_ORDER.length && (
                      <Badge tone="success">All voted</Badge>
                    )}
                  </InlineStack>

                  <BlockStack gap="300">
                    {phase1Logs.length === 0 ? (
                      // Pre-vote: show loading placeholders (we don't know names yet)
                      Array.from({ length: 5 }).map((_, i) => (
                        <Box key={i} borderWidth="025" borderColor="border" borderRadius="200" padding="400" background="bg-surface">
                          <InlineStack align="space-between" blockAlign="center">
                            <InlineStack gap="300" blockAlign="center">
                              <Text as="span" variant="headingLg">🧑</Text>
                              <BlockStack gap="100">
                                <Text as="p" variant="headingSm" tone="subdued">Panelist {i + 1}</Text>
                                <Text as="p" variant="bodySm" tone="subdued">The AI is assembling a panel tailored to this product…</Text>
                              </BlockStack>
                            </InlineStack>
                            <InlineStack gap="200" blockAlign="center">
                              <Spinner size="small" />
                              <Text as="span" variant="bodySm" tone="subdued">Generating…</Text>
                            </InlineStack>
                          </InlineStack>
                        </Box>
                      ))
                    ) : (
                      // Post-vote: show actual dynamic agent names and verdicts
                      phase1Logs.map((log) => {
                        const info = phase1VerdictMap[log.archetype];
                        return (
                          <PanelRosterCard
                            key={log.agentId}
                            archetypeId={log.archetype}
                            shopType={shopType ?? "default"}
                            hasVoted
                            verdict={info?.verdict}
                            dynamicName={info?.name}
                            dynamicEmoji={info?.emoji}
                          />
                        );
                      })
                    )}
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* Phase 1 full reasoning — appears once votes start coming in */}
              {phase1Logs.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingMd">⚡ Phase 1 — First Impressions</Text>
                      <Badge tone={phase1Logs.some(l => l.verdict === "REJECT") ? "critical" : "success"}>
                        {`${phase1Logs.filter(l => l.verdict === "BUY").length}/${phase1Logs.length} would buy`}
                      </Badge>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Each panelist independently evaluates the listing — no groupthink yet.
                    </Text>
                    <BlockStack gap="300">
                      {phase1Logs.map((log, i) => <AgentCard key={log.agentId + log.phase} log={log} index={i} />)}
                    </BlockStack>
                  </BlockStack>
                </Card>
              )}

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

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
