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
  Tabs,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import {
  getSimulation,
  getPreviousCompletedSimulation,
  getLabPartnerSimulation,
  saveComparisonSummary,
} from "../services/simulation.server";
import { compareLabSimulations } from "../services/engine.server";
import { getStore } from "../services/store.server";
import { ConfidenceGauge } from "../components/ConfidenceGauge";
import { AnalyticsSafeBadge } from "../components/AnalyticsSafeBadge";
import { IntelligenceExport } from "../components/IntelligenceExport";
import { RecommendationsPanel } from "../components/RecommendationsPanel";
import type { Recommendation, TrustAudit } from "../components/RecommendationsPanel";
import { OnboardingTour } from "../components/OnboardingTour";

type ScoreBreakdown = {
  panelScore: number;
  qualityBonus: number;
  floorApplied: boolean;
  floorValue: number | null;
};

type LabConfigData = {
  audience: string;
  skepticism: number;
  coreConcern: string;
  brutalityLevel?: number;
  preset?: string;
};

type LabComparisonSummary = {
  scoreDelta: number;
  whyGap: string;
  divergenceTopics: string[];
  targetPersonaCard: string;
  baselineLabel: string;
  targetLabel: string;
};

type GapItem = {
  question: string;
  status: "ANSWERED" | "PARTIAL" | "MISSING";
  evidence: string;
};

type ReportJson = {
  friction?: {
    price?: { dropoutPct?: number; topObjections?: string[] };
    trust?: { dropoutPct?: number; topObjections?: string[] };
    logistics?: { dropoutPct?: number; topObjections?: string[] };
  };
  summary?: string;
  scoreBreakdown?: ScoreBreakdown;
  labConfig?: LabConfigData;
  gapItems?: GapItem[];
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

function PersonaCard({
  log,
}: {
  log: {
    agentId: string;
    archetype: string;
    archetypeName?: string | null;
    archetypeEmoji?: string | null;
    personaName?: string | null;
    personaAge?: number | null;
    personaOccupation?: string | null;
    personaMotivation?: string | null;
    nicheConcern?: string | null;
    phase: number;
    verdict: string;
    reasoning: string;
  };
}) {
  const staticMeta = archetypeMeta(log.archetype);
  const emoji = log.archetypeEmoji ?? staticMeta.emoji;
  const archetypeLabel = log.archetypeName ?? staticMeta.name;

  const hasPersona = log.personaName && log.personaName !== archetypeLabel;
  const displayName = hasPersona ? log.personaName : archetypeLabel;
  const ageOccupation = hasPersona && log.personaAge
    ? `${log.personaAge}, ${log.personaOccupation || "Professional"}`
    : staticMeta.focus;

  const isBuy = log.verdict === "BUY";
  const isReject = log.verdict === "REJECT";

  return (
    <Box
      borderWidth="025"
      borderColor={isBuy ? "border-success" : isReject ? "border-critical" : "border"}
      borderRadius="200"
      padding="400"
      background={isBuy ? "bg-surface-success" : isReject ? "bg-surface-critical" : "bg-surface"}
    >
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start">
          <InlineStack gap="300" blockAlign="center">
            <Text as="span" variant="headingLg">{emoji}</Text>
            <BlockStack gap="050">
              <Text as="p" variant="headingSm">{displayName}</Text>
              <Text as="p" variant="bodySm" tone="subdued">{ageOccupation}</Text>
            </BlockStack>
          </InlineStack>
          <BlockStack gap="100" inlineAlign="end">
            <Badge tone={isBuy ? "success" : isReject ? "critical" : "warning"}>
              {log.verdict}
            </Badge>
            <Badge tone="info">{archetypeLabel}</Badge>
          </BlockStack>
        </InlineStack>

        {log.personaMotivation && (
          <InlineStack gap="200">
            <Badge>{log.personaMotivation}</Badge>
          </InlineStack>
        )}

        {log.nicheConcern && (
          <Text as="p" variant="bodySm" tone="subdued">
            💡 Why I'm here: {log.nicheConcern}
          </Text>
        )}

        <Divider />

        <Text as="p" variant="bodyMd">"{log.reasoning}"</Text>
      </BlockStack>
    </Box>
  );
}

type RosterLog = {
  agentId: string;
  archetype: string;
  archetypeName?: string | null;
  archetypeEmoji?: string | null;
  personaName?: string | null;
  personaAge?: number | null;
  personaOccupation?: string | null;
  personaMotivation?: string | null;
  nicheConcern?: string | null;
  verdict: string;
};

function PanelMemberExpandCard({ log }: { log: RosterLog }) {
  const [expanded, setExpanded] = useState(false);
  const staticMeta = archetypeMeta(log.archetype);
  const emoji = log.archetypeEmoji ?? staticMeta.emoji;
  const archetypeLabel = log.archetypeName ?? staticMeta.name;

  const hasPersona = log.personaName && log.personaName !== archetypeLabel;
  const displayName = hasPersona ? log.personaName : archetypeLabel;
  const ageOccupation = hasPersona && log.personaAge
    ? `${log.personaAge}, ${log.personaOccupation || "Professional"}`
    : staticMeta.focus;

  const isBuy = log.verdict === "BUY";
  const isReject = log.verdict === "REJECT";

  return (
    <Box
      borderWidth="025"
      borderColor={isBuy ? "border-success" : isReject ? "border-critical" : "border"}
      borderRadius="200"
      padding="400"
      background={isBuy ? "bg-surface-success" : isReject ? "bg-surface-critical" : "bg-surface"}
    >
      <BlockStack gap="300">
        {/* Always-visible header row */}
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Text as="span" variant="headingLg">{emoji}</Text>
            <BlockStack gap="050">
              <Text as="p" variant="headingSm">{displayName}</Text>
              <Text as="p" variant="bodySm" tone="subdued">{ageOccupation}</Text>
            </BlockStack>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            {log.personaMotivation && <Badge>{log.personaMotivation}</Badge>}
            <Badge tone={isBuy ? "success" : isReject ? "critical" : "warning"}>
              {log.verdict}
            </Badge>
            <Button variant="plain" size="slim" onClick={() => setExpanded(!expanded)}>
              {expanded ? "▲ Less" : "▼ Profile"}
            </Button>
          </InlineStack>
        </InlineStack>

        {/* Expanded profile */}
        {expanded && (
          <BlockStack gap="300">
            <Divider />

            <InlineStack gap="400" wrap align="start">
              {/* Shopping style */}
              <Box minWidth="200px">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">SHOPPING STYLE</Text>
                  <Text as="p" variant="bodyMd">{staticMeta.personality}</Text>
                </BlockStack>
              </Box>

              {/* Focused on */}
              <Box minWidth="160px">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">FOCUSED ON</Text>
                  <Text as="p" variant="bodyMd">{staticMeta.focus}</Text>
                </BlockStack>
              </Box>
            </InlineStack>

            {/* Dealbreakers */}
            {staticMeta.dealbreakers.length > 0 && (
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">DEALBREAKERS</Text>
                <InlineStack gap="200" wrap>
                  {staticMeta.dealbreakers.map((d, i) => (
                    <Badge key={i} tone="critical">{`🚫 ${d}`}</Badge>
                  ))}
                </InlineStack>
              </BlockStack>
            )}

            {/* Product-specific reason */}
            {log.nicheConcern && (
              <Box
                padding="300"
                background="bg-surface-magic"
                borderRadius="200"
                borderWidth="025"
                borderColor="border-magic"
              >
                <InlineStack gap="200" blockAlign="start">
                  <Text as="span" variant="bodyMd">💡</Text>
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="semibold" tone="magic">Why evaluating this product</Text>
                    <Text as="p" variant="bodyMd">{log.nicheConcern}</Text>
                  </BlockStack>
                </InlineStack>
              </Box>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Box>
  );
}

function PanelRosterCard({ log }: { log: RosterLog }) {
  return <PanelMemberExpandCard log={log} />;
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

  const productJson = simulation.productJson as { title?: string; id?: string } | null;

  // ── Lab dual-sim: fetch partner baseline when this is a Lab run ─────────────
  let labPartner: {
    id: string;
    status: string;
    score: number | null;
    reportJson: unknown;
    isBaseline: boolean;
    comparisonSummary: unknown;
  } | null = null;
  let labComparison: LabComparisonSummary | null = null;

  if (simulation.labGroupId) {
    labPartner = await getLabPartnerSimulation(simulation.labGroupId, simulation.id);

    // Both sims complete → generate or return cached comparison summary
    if (
      simulation.status === "COMPLETED" &&
      labPartner?.status === "COMPLETED" &&
      simulation.score != null &&
      labPartner.score != null
    ) {
      // Use target = non-baseline, baseline = isBaseline
      const targetSim  = simulation.isBaseline ? labPartner : simulation;
      const baselineSim = simulation.isBaseline ? simulation : labPartner;
      const targetReport  = (targetSim.reportJson  as Record<string, unknown>) ?? {};
      const baselineReport = (baselineSim.reportJson as Record<string, unknown>) ?? {};
      const targetLabConfig = (targetReport.labConfig ?? null) as LabConfigData | null;

      // Return cached comparison if already computed
      const cachedSummary = targetSim.comparisonSummary as LabComparisonSummary | null;
      if (cachedSummary?.whyGap) {
        labComparison = cachedSummary;
      } else if (targetLabConfig) {
        try {
          labComparison = await compareLabSimulations({
            productTitle: productJson?.title ?? "Product",
            baselineReport,
            targetReport,
            baselineScore: baselineSim.score ?? 0,
            targetScore: targetSim.score ?? 0,
            labConfig: {
              audience: (targetLabConfig.audience ?? "general") as "general" | "professional" | "gen_z" | "luxury",
              skepticism: targetLabConfig.skepticism ?? 5,
              coreConcern: targetLabConfig.coreConcern ?? "",
              brutalityLevel: targetLabConfig.brutalityLevel ?? 5,
              preset: targetLabConfig.preset ?? "",
            },
          });
          // Cache it on the target simulation so we don't call the engine on every page load
          await saveComparisonSummary(targetSim.id, labComparison as object);
        } catch (e) {
          console.error("[Lab compare] Failed to generate comparison summary:", e);
        }
      }
    }
  }

  // ── Previous run comparison (non-Lab flow) ───────────────────────────────────
  const previousSim = !simulation.labGroupId && simulation.status === "COMPLETED"
    ? await getPreviousCompletedSimulation(
        store.id,
        simulation.productUrl,
        simulation.createdAt,
        simulation.id,
      )
    : null;

  const scoreDelta =
    !simulation.labGroupId &&
    simulation.score != null &&
    previousSim?.score != null
      ? simulation.score - previousSim.score
      : null;

  // Killers from the previous run that are no longer present = resolved
  type KillerStub = { signal: string; label: string; severity: "high" | "medium"; fix: string };
  const previousKillers: KillerStub[] = previousSim?.trustAudit
    ? ((previousSim.trustAudit as { trustKillers?: KillerStub[] })?.trustKillers ?? [])
    : [];
  const currentKillerSignals = new Set(
    ((simulation.trustAudit as { trustKillers?: KillerStub[] } | null)?.trustKillers ?? []).map(
      (k) => k.signal,
    ),
  );
  const resolvedKillers = previousKillers.filter((k) => !currentKillerSignals.has(k.signal));

  // Construct Shopify admin edit URL for this product
  // Shopify GID format: "gid://shopify/Product/123456789"
  const productGid = productJson?.id ?? "";
  const productNumericId = productGid.split("/").pop() ?? "";
  const editUrl = productNumericId
    ? `https://${store.shopDomain}/admin/products/${productNumericId}`
    : null;

  return {
    simulation,
    tier: store.planTier,
    shopDomain: store.shopDomain,
    productTitle: productJson?.title ?? "Product",
    shopType: store?.shopType ?? "default",
    isDev: process.env.NODE_ENV === "development",
    scoreDelta,
    resolvedKillers,
    editUrl,
    labComparison,
    labPartnerStatus: labPartner?.status ?? null,
    labPartnerScore: labPartner?.score ?? null,
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

export default function ResultsPage() {
  const { simulation, tier, shopDomain, productTitle, isDev, scoreDelta, resolvedKillers, editUrl, labComparison, labPartnerStatus, labPartnerScore } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const isDone = simulation.status === "COMPLETED" || simulation.status === "FAILED";
  const isPro = isDev || tier === "PRO" || tier === "ENTERPRISE";

  // Start on Panel Debate when live; auto-switch to Overview when analysis completes
  const [selectedTab, setSelectedTab] = useState(isDone ? 0 : 1);

  useEffect(() => {
    if (isDone) setSelectedTab(0);
  }, [isDone]);

  useEffect(() => {
    if (isDone) return;
    const interval = setInterval(revalidate, 4000);
    return () => clearInterval(interval);
  }, [isDone, revalidate]);

  useEffect(() => {
    if (isDone) return;
    const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [isDone]);

  const report = simulation.reportJson as ReportJson | null;
  const labConfig = report?.labConfig ?? null;

  const AUDIENCE_LABELS: Record<string, string> = {
    general: "🌍 General Public",
    professional: "💼 Professional Buyers",
    gen_z: "⚡ Gen-Z Shoppers",
    luxury: "💎 Luxury Shoppers",
  };
  const SKEPTICISM_LABELS: Record<number, string> = { 1: "The Fan", 5: "Average Buyer", 9: "The Auditor" };
  const CONCERN_LABELS: Record<string, string> = {
    price: "💰 Price & Value",
    trust: "🛡️ Trust",
    shipping: "📦 Shipping",
    quality: "🛠️ Quality",
  };
  const frictionData = {
    price:     { dropoutPct: report?.friction?.price?.dropoutPct ?? 0,     topObjections: report?.friction?.price?.topObjections ?? [] },
    trust:     { dropoutPct: report?.friction?.trust?.dropoutPct ?? 0,     topObjections: report?.friction?.trust?.topObjections ?? [] },
    logistics: { dropoutPct: report?.friction?.logistics?.dropoutPct ?? 0, topObjections: report?.friction?.logistics?.topObjections ?? [] },
  };

  const phase1Logs = simulation.agentLogs.filter((l) => l.phase === 1);
  const phase2Logs = simulation.agentLogs.filter((l) => l.phase === 2);

  const phase1ByArchetype = new Map<string, typeof phase1Logs[number]>();
  for (const log of phase1Logs) {
    if (!phase1ByArchetype.has(log.archetype)) phase1ByArchetype.set(log.archetype, log);
  }

  const isPending = simulation.status === "PENDING" || (simulation.status === "RUNNING" && phase1Logs.length === 0);

  function formatElapsed(seconds: number) {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  // ── TL;DR ────────────────────────────────────────────────────────────────────
  const synthesisText = (simulation as unknown as { synthesisText?: string | null }).synthesisText;
  const topFrictionCat = report?.friction
    ? Object.entries({
        trust: report.friction.trust?.dropoutPct ?? 0,
        price: report.friction.price?.dropoutPct ?? 0,
        logistics: report.friction.logistics?.dropoutPct ?? 0,
      }).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null
    : null;
  const topFrictionLabel: Record<string, string> = {
    trust: "trust & credibility", price: "price concerns", logistics: "shipping & logistics",
  };
  const score = simulation.score ?? 0;
  const tldr = simulation.score == null ? null :
    synthesisText ? synthesisText.split(".")[0] + "." :
    score >= 80  ? `Your "${productTitle}" earned a strong ${score}/100 — your panel is mostly on board${topFrictionCat ? `, with minor friction around ${topFrictionLabel[topFrictionCat]}` : ""}.` :
    score >= 60  ? `Your "${productTitle}" scored ${score}/100 — ${topFrictionCat ? `${topFrictionLabel[topFrictionCat]} is the main barrier to more conversions` : "a few targeted fixes could push you significantly higher"}.` :
    `Your "${productTitle}" scored ${score}/100 — ${topFrictionCat ? `${Math.round((report?.friction?.[topFrictionCat as keyof typeof report.friction] as { dropoutPct?: number })?.dropoutPct ?? 0)}% of your panel dropped out over ${topFrictionLabel[topFrictionCat]}` : "critical issues are blocking the majority of your panel"}.`;
  const tldrTone = score >= 80 ? "success" : score >= 60 ? "warning" : "critical";

  // ── Tab badge counts ─────────────────────────────────────────────────────────
  const gapItems = report?.gapItems ?? [];
  const gapIssueCount = gapItems.filter(g => g.status === "MISSING" || g.status === "PARTIAL").length;
  const issueCount =
    ((simulation as unknown as { trustAudit?: { trustKillers?: unknown[] } }).trustAudit?.trustKillers?.length ?? 0) +
    ((simulation as unknown as { recommendations?: unknown[] }).recommendations?.length ?? 0) +
    gapIssueCount;

  const tabs = [
    { id: "overview",    content: "📊 Overview",    accessibilityLabel: "Overview" },
    { id: "debate",      content: isDone ? "🎙️ Panel Debate ✓" : "🎙️ Panel Debate",  accessibilityLabel: "Panel Debate" },
    { id: "action-plan", content: isDone && issueCount > 0 ? `🎯 Action Plan (${issueCount})` : "🎯 Action Plan", accessibilityLabel: "Action Plan" },
  ];

  // ── 3-column friction data ───────────────────────────────────────────────────
  const frictionCols = [
    { key: "price"     as const, label: "Price Sensitivity",  emoji: "💰" },
    { key: "trust"     as const, label: "Trust & Social Proof", emoji: "🛡️" },
    { key: "logistics" as const, label: "Logistics & Delivery", emoji: "📦" },
  ];
  type FrictionSev = "critical" | "warning" | "growth";
  const frictionSevConfig: Record<FrictionSev, { tone: "critical"|"warning"|"success"; bg: "bg-surface-critical"|"bg-surface-caution"|"bg-surface-success"; border: "border-critical"|"border-caution"|"border-success"; icon: string; label: string }> = {
    critical: { tone: "critical", bg: "bg-surface-critical", border: "border-critical", icon: "🔴", label: "Critical" },
    warning:  { tone: "warning",  bg: "bg-surface-caution",  border: "border-caution",  icon: "🟡", label: "Warning" },
    growth:   { tone: "success",  bg: "bg-surface-success",  border: "border-success",  icon: "🟢", label: "Strong" },
  };

  return (
    <Page>
      <OnboardingTour
        storageKey="miroshop:tour:results"
        label="New"
        steps={[
          { title: "Understand the score", body: "The Overview tab shows your score and the 3 friction categories side by side — no scrolling needed. Red = fix first." },
          { title: "Watch the live debate", body: "The Panel Debate tab shows each panelist's reasoning in real time as the analysis runs." },
          { title: "Get your action plan", body: "The Action Plan tab lists every trust killer and recommendation ranked by impact. Use Fix-it buttons for one-click policy generation." },
        ]}
      />
      <TitleBar
        title={isDone ? `Results — ${productTitle}` : `Analysing — ${productTitle}`}
        breadcrumbs={[
          { content: "Dashboard", url: "/app" },
          { content: "History", url: "/app/history" },
        ]}
      />
      <BlockStack gap="400">

        {/* ── Status banners ── */}
        {simulation.status === "FAILED" && (
          <Banner tone="critical">
            <Text as="p" variant="bodyMd">Analysis failed. This has not used your budget. Please try again.</Text>
          </Banner>
        )}

        {!isDone && (
          <Banner tone="info">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="300" blockAlign="center">
                <Spinner size="small" />
                <Text as="p" variant="bodyMd">Your customer panel is working — new results appear every few seconds</Text>
              </InlineStack>
              <InlineStack gap="200">
                {elapsedSeconds > 0 && <Text as="p" variant="bodySm" tone="subdued">{formatElapsed(elapsedSeconds)}</Text>}
                <Text as="p" variant="bodySm" tone="subdued">Auto-refreshing</Text>
              </InlineStack>
            </InlineStack>
          </Banner>
        )}

        {/* ── TL;DR — shown when complete ── */}
        {isDone && tldr && (
          <Banner tone={tldrTone}>
            <InlineStack gap="300" blockAlign="start">
              <Text as="span" variant="headingMd">{score >= 80 ? "✅" : score >= 60 ? "⚠️" : "🚨"}</Text>
              <BlockStack gap="050">
                <Text as="p" variant="bodyMd" fontWeight="semibold">TL;DR — {tldr}</Text>
                <AnalyticsSafeBadge />
              </BlockStack>
            </InlineStack>
          </Banner>
        )}

        {/* ── Tabs ── */}
        <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>

          {/* ════════════ TAB 0: OVERVIEW ════════════ */}
          {selectedTab === 0 && (
            <Box paddingBlockStart="400">
              <BlockStack gap="500">

                {/* Score (left 1/3) + Friction 3-columns (right 2/3) */}
                <Layout>
                  <Layout.Section variant="oneThird">
                    <Card>
                      <BlockStack gap="300">
                        <Text as="h2" variant="headingMd">Customer Confidence Score</Text>
                        {simulation.score != null ? (
                          <ConfidenceGauge score={simulation.score} size={200} />
                        ) : (
                          <BlockStack gap="200">
                            <SkeletonBodyText lines={3} />
                            <Text as="p" variant="bodySm" tone="subdued" alignment="center">Score revealed after Phase 3</Text>
                          </BlockStack>
                        )}

                        {simulation.status === "COMPLETED" && report?.scoreBreakdown && (
                          <Box padding="300" borderWidth="025" borderRadius="200" borderColor="border" background="bg-surface-secondary">
                            <BlockStack gap="150">
                              <Text as="p" variant="bodySm" fontWeight="semibold" tone="subdued">Score breakdown</Text>
                              <InlineStack align="space-between">
                                <Text as="p" variant="bodySm">Panel votes</Text>
                                <Text as="p" variant="bodySm" fontWeight="semibold">{report.scoreBreakdown.panelScore}</Text>
                              </InlineStack>
                              {report.scoreBreakdown.qualityBonus > 0 && (
                                <InlineStack align="space-between">
                                  <Text as="p" variant="bodySm">Listing quality bonus</Text>
                                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="success">+{report.scoreBreakdown.qualityBonus}</Text>
                                </InlineStack>
                              )}
                              {report.scoreBreakdown.floorApplied && (
                                <InlineStack align="space-between">
                                  <Text as="p" variant="bodySm">Trust floor</Text>
                                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="caution">→ min {report.scoreBreakdown.floorValue}</Text>
                                </InlineStack>
                              )}
                            </BlockStack>
                          </Box>
                        )}

                        {simulation.status === "COMPLETED" && editUrl && (
                          <Button url={editUrl} external variant="plain" size="slim">
                            ✏️ Edit this product in Shopify →
                          </Button>
                        )}
                      </BlockStack>
                    </Card>
                  </Layout.Section>

                  <Layout.Section>
                    <Card>
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h2" variant="headingMd">Friction Breakdown</Text>
                          {!isDone && <Text as="p" variant="bodySm" tone="subdued">Ready after analysis completes</Text>}
                        </InlineStack>
                        {isDone ? (
                          <InlineStack gap="300" wrap={false} blockAlign="start">
                            {frictionCols.map(({ key, label, emoji }) => {
                              const pct = frictionData[key].dropoutPct;
                              const objections = frictionData[key].topObjections;
                              const sev: FrictionSev = pct >= 40 ? "critical" : pct >= 15 ? "warning" : "growth";
                              const cfg = frictionSevConfig[sev];
                              return (
                                <Box key={key} borderWidth="025" borderColor={cfg.border} borderRadius="200" padding="300" background={cfg.bg}>
                                  <BlockStack gap="200">
                                    <InlineStack align="space-between" blockAlign="center">
                                      <Text as="p" variant="headingSm">{emoji} {label}</Text>
                                      <Badge tone={cfg.tone}>{`${cfg.icon} ${cfg.label}`}</Badge>
                                    </InlineStack>
                                    <Text as="p" variant="headingLg" fontWeight="bold">{pct}%</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">dropout rate</Text>
                                    {objections.length > 0 && (
                                      <>
                                        <Divider />
                                        <BlockStack gap="100">
                                          <Text as="p" variant="bodySm">• {objections[0]}</Text>
                                          {isPro && objections.slice(1).map((obj, i) => (
                                            <Text key={i} as="p" variant="bodySm">• {obj}</Text>
                                          ))}
                                          {!isPro && objections.length > 1 && (
                                            <Text as="p" variant="bodySm" tone="subdued">
                                              <span style={{ filter: "blur(4px)", userSelect: "none" }}>+{objections.length - 1} more</span>{" "}(Pro)
                                            </Text>
                                          )}
                                        </BlockStack>
                                      </>
                                    )}
                                  </BlockStack>
                                </Box>
                              );
                            })}
                          </InlineStack>
                        ) : (
                          <SkeletonBodyText lines={5} />
                        )}
                      </BlockStack>
                    </Card>
                  </Layout.Section>
                </Layout>

                {/* Listing Coverage — gap analysis scorecard */}
                {isDone && report?.gapItems && report.gapItems.length > 0 && (
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="050">
                          <Text as="h2" variant="headingMd">Listing Coverage</Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            How well your listing answers the questions real buyers ask before purchasing
                          </Text>
                        </BlockStack>
                        {(() => {
                          const answered = report.gapItems!.filter(g => g.status === "ANSWERED").length;
                          const total = report.gapItems!.length;
                          const tone = answered === total ? "success" : answered >= total / 2 ? "warning" : "critical";
                          return (
                            <Badge tone={tone} size="large">
                              {`${answered} / ${total} answered`}
                            </Badge>
                          );
                        })()}
                      </InlineStack>
                      <BlockStack gap="200">
                        {report.gapItems.map((item, i) => {
                          const isAnswered = item.status === "ANSWERED";
                          const isPartial  = item.status === "PARTIAL";
                          const isMissing  = item.status === "MISSING";
                          return (
                            <Box
                              key={i}
                              padding="300"
                              borderWidth="025"
                              borderRadius="200"
                              borderColor={isAnswered ? "border-success" : isMissing ? "border-critical" : "border-caution"}
                              background={isAnswered ? "bg-surface-success" : isMissing ? "bg-surface-critical" : "bg-surface-caution"}
                            >
                              <InlineStack align="space-between" blockAlign="start" gap="300">
                                <InlineStack gap="200" blockAlign="start">
                                  <Text as="span" variant="bodyMd">
                                    {isAnswered ? "✅" : isMissing ? "❌" : "⚠️"}
                                  </Text>
                                  <BlockStack gap="100">
                                    <Text as="p" variant="bodyMd" fontWeight={isMissing ? "semibold" : "regular"}>
                                      {item.question}
                                    </Text>
                                    {(isPartial || isAnswered) && item.evidence && item.evidence !== "(not found)" && (
                                      <Text as="p" variant="bodySm" tone="subdued">
                                        → "{item.evidence}"
                                      </Text>
                                    )}
                                    {isMissing && (
                                      <Text as="p" variant="bodySm" tone="critical">
                                        Not addressed — add this to your listing
                                      </Text>
                                    )}
                                  </BlockStack>
                                </InlineStack>
                                <Badge tone={isAnswered ? "success" : isMissing ? "critical" : "warning"}>
                                  {item.status}
                                </Badge>
                              </InlineStack>
                            </Box>
                          );
                        })}
                      </BlockStack>
                    </BlockStack>
                  </Card>
                )}

                {/* Panel consensus summary */}
                {report?.summary && (
                  <Card>
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">Panel Consensus</Text>
                      <Text as="p" variant="bodyMd">{report.summary}</Text>
                    </BlockStack>
                  </Card>
                )}

                {/* Scenario Comparison Lab */}
                {simulation.labGroupId && (
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="h2" variant="headingMd">Scenario comparison lab</Text>
                          <Text as="p" variant="bodySm" tone="subdued">General-public baseline vs. your custom scenario, run in parallel.</Text>
                        </BlockStack>
                        <Badge tone="info">Lab Run</Badge>
                      </InlineStack>

                      {labConfig && (
                        <InlineStack gap="200" wrap>
                          {labConfig.preset && (
                            <Badge tone="magic">
                              {({ soft_launch: "Soft launch", skeptic_audit: "Skeptic audit", holiday_rush: "Holiday rush" } as Record<string, string>)[labConfig.preset] ?? labConfig.preset}
                            </Badge>
                          )}
                          <Badge>{AUDIENCE_LABELS[labConfig.audience] ?? labConfig.audience}</Badge>
                          <Badge tone={labConfig.skepticism <= 3 ? "success" : labConfig.skepticism >= 8 ? "critical" : "warning"}>
                            {SKEPTICISM_LABELS[labConfig.skepticism as keyof typeof SKEPTICISM_LABELS] ?? `Skepticism ${labConfig.skepticism}`}
                          </Badge>
                          {labConfig.coreConcern && (
                            <Badge tone="info">{`Focus: ${CONCERN_LABELS[labConfig.coreConcern] ?? labConfig.coreConcern}`}</Badge>
                          )}
                          {(labConfig.brutalityLevel ?? 5) >= 7 && (
                            <Badge tone="critical">{`Brutality ${labConfig.brutalityLevel ?? 5}/10`}</Badge>
                          )}
                        </InlineStack>
                      )}

                      {!labComparison && (labPartnerStatus !== "COMPLETED" || simulation.status !== "COMPLETED") && (
                        <Box padding="400" borderWidth="025" borderRadius="200" borderColor="border" background="bg-surface-secondary">
                          <InlineStack gap="300" blockAlign="center">
                            <Spinner size="small" />
                            <BlockStack gap="100">
                              <Text as="p" variant="bodyMd" fontWeight="semibold">Both panels are running in parallel</Text>
                              <InlineStack gap="400">
                                <Text as="p" variant="bodySm" tone="subdued">Baseline: {labPartnerStatus === "COMPLETED" ? `✅ ${labPartnerScore ?? "—"}` : "⏳ Running…"}</Text>
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {labConfig ? (AUDIENCE_LABELS[labConfig.audience] ?? "Target") : "Target"}: {simulation.status === "COMPLETED" ? `✅ ${simulation.score ?? "—"}` : "⏳ Running…"}
                                </Text>
                              </InlineStack>
                            </BlockStack>
                          </InlineStack>
                        </Box>
                      )}

                      {labComparison && simulation.score != null && (
                        <BlockStack gap="400">
                          <InlineStack gap="400" wrap={false}>
                            <Box padding="400" borderWidth="025" borderRadius="200" borderColor="border" background="bg-surface-secondary">
                              <BlockStack gap="200">
                                <Text as="p" variant="headingSm" tone="subdued">🌍 {labComparison.baselineLabel}</Text>
                                <Text as="p" variant="headingXl" fontWeight="bold">{labPartnerScore ?? "—"}</Text>
                                <Text as="p" variant="bodySm" tone="subdued">Baseline panel</Text>
                              </BlockStack>
                            </Box>
                            <Box padding="400" borderWidth="025" borderRadius="200" borderColor={labComparison.scoreDelta >= 0 ? "border-success" : "border-critical"} background={labComparison.scoreDelta >= 0 ? "bg-surface-success" : "bg-surface-critical"}>
                              <BlockStack gap="200" inlineAlign="center">
                                <Text as="p" variant="headingSm" alignment="center">Δ Score</Text>
                                <Text as="p" variant="headingXl" fontWeight="bold" tone={labComparison.scoreDelta > 0 ? "success" : "critical"} alignment="center">
                                  {labComparison.scoreDelta > 0 ? `+${labComparison.scoreDelta}` : `${labComparison.scoreDelta}`}
                                </Text>
                                <Text as="p" variant="bodySm" tone="subdued" alignment="center">points</Text>
                              </BlockStack>
                            </Box>
                            <Box padding="400" borderWidth="025" borderRadius="200" borderColor={labComparison.scoreDelta >= 0 ? "border-success" : "border-critical"} background={labComparison.scoreDelta >= 0 ? "bg-surface-success" : "bg-surface-critical"}>
                              <BlockStack gap="200">
                                <Text as="p" variant="headingSm">🎯 {labComparison.targetLabel}</Text>
                                <Text as="p" variant="headingXl" fontWeight="bold">{simulation.isBaseline ? labPartnerScore : simulation.score}</Text>
                                <Text as="p" variant="bodySm" tone="subdued">Your scenario</Text>
                              </BlockStack>
                            </Box>
                          </InlineStack>

                          {labComparison.whyGap && (
                            <Box padding="400" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border-magic">
                              <BlockStack gap="200">
                                <Text as="p" variant="headingSm">💡 The Gap Explained</Text>
                                <Text as="p" variant="bodyMd">"{labComparison.whyGap}"</Text>
                              </BlockStack>
                            </Box>
                          )}

                          {labComparison.divergenceTopics?.length > 0 && (
                            <BlockStack gap="200">
                              <Text as="p" variant="headingSm">Top Divergence Points</Text>
                              <InlineStack gap="200" wrap>
                                {labComparison.divergenceTopics.map((t) => <Badge key={t} tone="warning">{t}</Badge>)}
                              </InlineStack>
                            </BlockStack>
                          )}

                          {labComparison.targetPersonaCard && (
                            <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                              <BlockStack gap="200">
                                <Text as="p" variant="headingSm">👥 {labComparison.targetLabel} — Who They Are</Text>
                                <Text as="p" variant="bodyMd" tone="subdued">{labComparison.targetPersonaCard}</Text>
                              </BlockStack>
                            </Box>
                          )}

                          {report?.friction && (() => {
                            const topCat = Object.entries({
                              Trust: report.friction?.trust?.dropoutPct ?? 0,
                              Price: report.friction?.price?.dropoutPct ?? 0,
                              Logistics: report.friction?.logistics?.dropoutPct ?? 0,
                            }).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "quality";
                            return (
                              <Box padding="300" background="bg-surface-critical" borderRadius="200">
                                <InlineStack gap="200" blockAlign="start">
                                  <Text as="span" variant="bodyMd">⚠️</Text>
                                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                                    This audience rejected primarily on {topCat.toLowerCase()} concerns. Fix those first before targeting this segment.
                                  </Text>
                                </InlineStack>
                              </Box>
                            );
                          })()}
                        </BlockStack>
                      )}
                    </BlockStack>
                  </Card>
                )}

                {isDone && (
                  <InlineStack gap="300">
                    <Button url="/app/simulate" variant="primary">Run Another Panel Check</Button>
                    <Button url={`/app/sandbox/${simulation.id}`} disabled={!isPro}>
                      {isPro ? "Open What-If Sandbox" : "What-If Sandbox (Pro)"}
                    </Button>
                    <Button url="/app/history" variant="plain">View History</Button>
                  </InlineStack>
                )}

              </BlockStack>
            </Box>
          )}

          {/* ════════════ TAB 1: PANEL DEBATE ════════════ */}
          {selectedTab === 1 && (
            <Box paddingBlockStart="400">
              <BlockStack gap="400">
                <PhaseBar phase={simulation.phase} status={simulation.status} />

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
                            : `${phase1Logs.length} of ${ROSTER_ORDER.length} panelists have voted`}
                        </Text>
                      </BlockStack>
                      {isPending && <Spinner size="small" />}
                      {!isPending && phase1Logs.length === ROSTER_ORDER.length && <Badge tone="success">All voted</Badge>}
                    </InlineStack>
                    <BlockStack gap="300">
                      {phase1Logs.length === 0 ? (
                        Array.from({ length: 5 }).map((_, i) => (
                          <Box key={i} borderWidth="025" borderColor="border" borderRadius="200" padding="400" background="bg-surface">
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="300" blockAlign="center">
                                <Text as="span" variant="headingLg">🧑</Text>
                                <BlockStack gap="100">
                                  <Text as="p" variant="headingSm" tone="subdued">Panelist {i + 1}</Text>
                                  <Text as="p" variant="bodySm" tone="subdued">Building a persona tailored to this product…</Text>
                                </BlockStack>
                              </InlineStack>
                              <InlineStack gap="200" blockAlign="center">
                                <Spinner size="small" />
                                <Text as="span" variant="bodySm" tone="subdued">Profiling…</Text>
                              </InlineStack>
                            </InlineStack>
                          </Box>
                        ))
                      ) : (
                        Array.from(phase1ByArchetype.values()).map((log) => (
                          <PanelRosterCard key={log.agentId} log={log} />
                        ))
                      )}
                    </BlockStack>
                  </BlockStack>
                </Card>

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
                        {phase1Logs.map((log) => <PersonaCard key={log.agentId + log.phase} log={log} />)}
                      </BlockStack>
                    </BlockStack>
                  </Card>
                )}

                {(simulation.phase >= 2 || phase2Logs.length > 0) && (
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between">
                        <Text as="h2" variant="headingMd">🔥 Phase 2 — Panel Debate</Text>
                        {phase2Logs.length > 0 && <Badge tone="info">{`${phase2Logs.length} debate entries`}</Badge>}
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Panelists challenge each other. If too positive, a dissenter is forced to find flaws.
                      </Text>
                      {phase2Logs.length === 0 ? (
                        <SkeletonBodyText lines={4} />
                      ) : (
                        <BlockStack gap="300">
                          {phase2Logs.map((log) => <PersonaCard key={log.agentId + log.phase} log={log} />)}
                        </BlockStack>
                      )}
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            </Box>
          )}

          {/* ════════════ TAB 2: ACTION PLAN ════════════ */}
          {selectedTab === 2 && (
            <Box paddingBlockStart="400">
              <BlockStack gap="400">

                {!isDone && (
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">The Action Plan will be ready once your analysis completes.</Text>
                  </Banner>
                )}

                {isDone && simulation.score != null && (
                  <RecommendationsPanel
                    recommendations={(simulation as unknown as { recommendations?: Recommendation[] }).recommendations ?? []}
                    trustAudit={(simulation as unknown as { trustAudit?: TrustAudit }).trustAudit ?? null}
                    score={simulation.score}
                    productTitle={productTitle}
                    shopDomain={shopDomain}
                    scoreDelta={scoreDelta}
                    resolvedKillers={resolvedKillers}
                  />
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

                {isDone && (
                  <InlineStack gap="300">
                    <Button url="/app/simulate" variant="primary">Run Another Panel Check</Button>
                    <Button url="/app/history" variant="plain">View History</Button>
                  </InlineStack>
                )}

              </BlockStack>
            </Box>
          )}

        </Tabs>

      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
