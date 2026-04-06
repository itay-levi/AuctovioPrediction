import type { FetcherWithComponents } from "@remix-run/react";

type SandboxActionData = { error?: string } | undefined;
import { useState } from "react";
import {
  Button,
  Banner,
  Text,
  BlockStack,
  InlineStack,
  RangeSlider,
  CalloutCard,
  SkeletonBodyText,
} from "@shopify/polaris";
import { ConfidenceGauge } from "../ConfidenceGauge";
import { sanitizeAgentReasoning } from "../../utils/sanitizeAgentReasoning";
import styles from "./ComparisonLaboratory.module.css";

const ROSTER_ORDER = [
  "budget_optimizer",
  "brand_loyalist",
  "research_analyst",
  "impulse_decider",
  "gift_seeker",
] as const;

type AgentLogLite = {
  agentId: string;
  archetype: string;
  archetypeName?: string | null;
  archetypeEmoji?: string | null;
  personaName?: string | null;
  phase: number;
  verdict: string;
  reasoning: string;
};

export type ExperimentCard = {
  id: string;
  name: string;
  hypothesis: string;
  targetAgent: string;
  rationale: string;
};

export type PriceBatchResult = {
  id: string;
  price: number;
  pctDelta: number;
  status: string;
  score: number | null;
  phase1Logs: AgentLogLite[];
  phase2Logs: AgentLogLite[];
  comparisonInsight: string | null;
  /** Parsed from simulation reportJson.friction.*.dropoutPct when present */
  friction: {
    price?: number;
    trust?: number;
    logistics?: number;
  } | null;
};

type DeltaRow = {
  id: string;
  status: string;
  score: number | null;
  deltaParams: unknown;
  comparisonInsight: string | null;
  createdAt: string;
};

const ARCHETYPE_FALLBACK: Record<string, { emoji: string; name: string }> = {
  budget_optimizer: { emoji: "💰", name: "Budget Optimizer" },
  brand_loyalist: { emoji: "⭐", name: "Brand Loyalist" },
  research_analyst: { emoji: "🔬", name: "Research Analyst" },
  impulse_decider: { emoji: "⚡", name: "Impulse Decider" },
  gift_seeker: { emoji: "🎁", name: "Gift Seeker" },
};

// ── Static friction category metadata ────────────────────────────────────────
export type TrustAuditFriction = {
  hasShippingInfo?: boolean;
  hasReturnPolicy?: boolean;
  hasContact?: boolean;
} | null;

const FRICTION_META: Record<"price" | "logistics" | "trust", {
  icon: string;
  label: string;
  bullets: [string, string];
  bulletsWhenShippingPresent?: [string, string];
  impact: string;
  impactWhenShippingPresent?: string;
}> = {
  price: {
    icon: "💰",
    label: "Price Sensitivity",
    bullets: [
      "No cost-per-serving or value breakdown visible",
      "Missing comparison to alternatives or market context",
    ],
    impact: "Shoppers leave because the price feels arbitrary — not because it's too high.",
  },
  logistics: {
    icon: "📦",
    label: "Logistics & Returns",
    bullets: [
      "Return policy unclear for opened or used items",
      "No shipping timeline, threshold, or handling note visible",
    ],
    bulletsWhenShippingPresent: [
      "Shipping or delivery details appear in the listing — check if timelines feel specific enough",
      "Returns may still need clearer windows or process steps for hesitant buyers",
    ],
    impact: "Buyers won't commit without knowing what happens if it doesn't work out.",
    impactWhenShippingPresent:
      "Some shipping cues exist — panel dropout here often means timing, cost clarity, or returns still feel vague.",
  },
  trust: {
    icon: "🛡️",
    label: "Trust & Social Proof",
    bullets: [
      "No reviews, star rating, or testimonials above the fold",
      "Brand story and certifications absent from the listing",
    ],
    impact: "First-time buyers can't trust a brand they haven't encountered before.",
  },
};

type FrictionSev = "critical" | "warning" | "growth";

const SEV_CARD_CLS: Record<FrictionSev, string> = {
  critical: styles.frictionSevCritical,
  warning:  styles.frictionSevWarning,
  growth:   styles.frictionSevGrowth,
};

const SEV_BADGE_CLS: Record<FrictionSev, string> = {
  critical: styles.sevBadgeCritical,
  warning:  styles.sevBadgeWarning,
  growth:   styles.sevBadgeGrowth,
};

const SEV_LABEL: Record<FrictionSev, string> = {
  critical: "Critical",
  warning:  "Warning",
  growth:   "Strong",
};

function getRecommendation(score: number): { emoji: string; text: string; cls: string } {
  if (score >= 80) return { emoji: "✅", text: "Strong — ready to scale",                     cls: styles.recStrong   };
  if (score >= 65) return { emoji: "⚡", text: "Moderate — fix Price & Trust first",          cls: styles.recModerate };
  if (score >= 45) return { emoji: "⚠️", text: "Mixed — multiple barriers blocking buyers",  cls: styles.recMixed    };
  return              { emoji: "🚨", text: "Needs work — critical friction blocking conversion", cls: styles.recLow  };
}

function metaForArchetype(archetype: string, log: AgentLogLite) {
  const fb = ARCHETYPE_FALLBACK[archetype] ?? { emoji: "🧑", name: archetype };
  return {
    emoji: log.archetypeEmoji ?? fb.emoji,
    archetypeName: log.archetypeName ?? fb.name,
    displayName: log.personaName || log.archetypeName || fb.name,
  };
}

function phase1ByArchetype(logs: AgentLogLite[]) {
  const map = new Map<string, AgentLogLite>();
  for (const log of logs.filter((l) => l.phase === 1)) {
    if (!map.has(log.archetype)) map.set(log.archetype, log);
  }
  return map;
}

function verdictClass(v: string) {
  if (v === "BUY") return styles.verdictBuy;
  if (v === "REJECT") return styles.verdictReject;
  return styles.verdictOther;
}

const AGENT_BUBBLE: Record<string, string> = {
  budget_optimizer: styles.bubbleBudget,
  brand_loyalist: styles.bubbleLoyalist,
  research_analyst: styles.bubbleAnalyst,
  impulse_decider: styles.bubbleImpulse,
  gift_seeker: styles.bubbleGift,
};

const AGENT_AVATAR: Record<string, string> = {
  budget_optimizer: styles.avatarBudget,
  brand_loyalist: styles.avatarLoyalist,
  research_analyst: styles.avatarAnalyst,
  impulse_decider: styles.avatarImpulse,
  gift_seeker: styles.avatarGift,
};

function initialsFromLog(log: AgentLogLite): string {
  const name = (log.personaName || log.archetypeName || log.archetype || "A").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0][0] ?? "";
    const b = parts[1][0] ?? "";
    return (a + b).toUpperCase();
  }
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return (name[0] ?? "?").toUpperCase();
}

function buildDebateItems(logs: AgentLogLite[]) {
  type Item = { type: "bubble"; log: AgentLogLite } | { type: "challenge" };
  const items: Item[] = [];
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const prev = logs[i - 1];
    if (
      prev &&
      prev.verdict !== log.verdict &&
      (prev.verdict === "BUY" || prev.verdict === "REJECT") &&
      (log.verdict === "BUY" || log.verdict === "REJECT")
    ) {
      items.push({ type: "challenge" });
    }
    items.push({ type: "bubble", log });
  }
  return items;
}

function PersonaRows({
  baselineMap,
  labMap,
}: {
  baselineMap: Map<string, AgentLogLite>;
  labMap: Map<string, AgentLogLite>;
}) {
  return (
    <div className={styles.panelGrid}>
      {ROSTER_ORDER.map((arch) => {
        const b = baselineMap.get(arch);
        const l = labMap.get(arch);
        if (!b && !l) return null;
        const base = b ?? l!;
        const m = metaForArchetype(arch, base);
        const bv = b?.verdict ?? "—";
        const lv = l?.verdict ?? null;
        const converted = Boolean(lv) && bv === "REJECT" && lv === "BUY";
        const safeReason = sanitizeAgentReasoning(base.reasoning);
        const snippet = safeReason.slice(0, 88);
        const hasMore = safeReason.length > 88;
        return (
          <div key={arch} className={`${styles.panelCard} ${converted ? styles.panelCardConverted : ""}`}>
            <div className={styles.pcTop}>
              <span className={styles.pcEmoji}>{m.emoji}</span>
              <div className={styles.pcMeta}>
                <span className={styles.pcName}>{m.displayName}</span>
                <span className={styles.pcArch}>{m.archetypeName}</span>
              </div>
              <div className={styles.pcVerdicts}>
                <span className={`${styles.verdict} ${verdictClass(bv)}`}>{bv}</span>
                {lv != null && lv !== "" && (
                  <>
                    <span className={styles.pcArrow}>→</span>
                    <span className={`${styles.verdict} ${verdictClass(lv)}`}>{lv}</span>
                    {converted && <span className={styles.convertedTag}>Converted</span>}
                  </>
                )}
                {lv == null && labMap.size > 0 && (
                  <span className={styles.pcPending}>→ …</span>
                )}
              </div>
            </div>
            {safeReason && (
              <details className={styles.pcDetails}>
                <summary className={styles.pcSummary}>
                  <span className={styles.pcSnippet}>
                    &ldquo;{snippet}{hasMore ? "…" : ""}&rdquo;
                  </span>
                  <span className={styles.pcExpandHint}>Expand</span>
                </summary>
                <p className={styles.pcFull}>&ldquo;{safeReason}&rdquo;</p>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Meter({ label, value, animate }: { label: string; value: number; animate?: boolean }) {
  const v = Math.max(0, Math.min(100, value));
  const barGradient =
    v >= 70 ? "linear-gradient(90deg,#059669,#34d399)" :
    v >= 45 ? "linear-gradient(90deg,#b45309,#fbbf24)" :
              "linear-gradient(90deg,#991b1b,#f87171)";
  const glowColor =
    v >= 70 ? "rgba(52,211,153,0.4)" :
    v >= 45 ? "rgba(251,191,36,0.35)" :
              "rgba(248,113,113,0.35)";
  return (
    <div className={styles.meterWrap}>
      <div className={styles.meterLabel}>
        <span>{label}</span>
        <span style={{ fontWeight: 700, color: "var(--lab-text)" }}>{v}%</span>
      </div>
      <div className={styles.meterBar}>
        <div
          className={`${styles.meterFill} ${animate ? styles.meterFillShift : ""}`}
          style={{ width: `${v}%`, background: barGradient, boxShadow: `0 0 10px ${glowColor}` }}
        />
        <div className={styles.meterTick} style={{ left: "40%" }} />
        <div className={styles.meterTick} style={{ left: "60%" }} />
        <div className={styles.meterTick} style={{ left: "80%" }} />
      </div>
      <div className={styles.meterTickLabels}>
        <span style={{ left: "40%" }}>40%</span>
        <span style={{ left: "60%" }}>60%</span>
        <span style={{ left: "80%" }}>80%</span>
      </div>
    </div>
  );
}

function FrictionCards({
  pricePct,
  logisticsPct,
  trustPct,
  trustAudit,
}: {
  pricePct: number;
  logisticsPct: number;
  trustPct: number;
  trustAudit: TrustAuditFriction;
}) {
  const items: { key: "price" | "logistics" | "trust"; pct: number }[] = [
    { key: "price",     pct: pricePct     },
    { key: "logistics", pct: logisticsPct },
    { key: "trust",     pct: trustPct     },
  ];
  return (
    <div className={styles.frictionGrid}>
      {items.map(({ key, pct }) => {
        const meta = FRICTION_META[key];
        const sev: FrictionSev = pct >= 40 ? "critical" : pct >= 15 ? "warning" : "growth";
        const useShippingAligned =
          key === "logistics" &&
          trustAudit?.hasShippingInfo &&
          meta.bulletsWhenShippingPresent &&
          meta.impactWhenShippingPresent;
        const bullets = useShippingAligned ? meta.bulletsWhenShippingPresent! : meta.bullets;
        const impact = useShippingAligned ? meta.impactWhenShippingPresent! : meta.impact;
        return (
          <div key={key} className={`${styles.frictionCard} ${SEV_CARD_CLS[sev]}`}>
            <div className={styles.fcHeader}>
              <span className={styles.fcIcon}>{meta.icon}</span>
              <span className={styles.fcLabel}>{meta.label}</span>
              <span className={`${styles.sevBadge} ${SEV_BADGE_CLS[sev]}`}>{SEV_LABEL[sev]}</span>
            </div>
            <div className={styles.fcStat}>
              <span className={styles.fcPct}>{Math.round(pct)}%</span>
              <span className={styles.fcPctLabel}>dropout</span>
            </div>
            <div className={styles.fcDivider} />
            <ul className={styles.fcBullets}>
              {bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
            <div className={styles.fcDivider} />
            <p className={styles.fcImpact}>
              <strong>Impact: </strong>{impact}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ── Price Optimizer helpers ─────────────────────────────────────────────────
export function pickBestSweepRun(results: PriceBatchResult[]): PriceBatchResult | null {
  const ok = results.filter((r) => r.status === "COMPLETED" && r.score != null);
  if (!ok.length) return null;
  return ok.reduce((best, r) => {
    const rs = r.score ?? 0;
    const bs = best.score ?? 0;
    if (rs > bs) return r;
    if (rs < bs) return best;
    return r.pctDelta > best.pctDelta ? r : best;
  });
}

function blockerSummaryPhrase(price: number, logistics: number, trust: number): string {
  const items = [
    { label: "trust and social proof", v: trust },
    { label: "price sensitivity", v: price },
    { label: "logistics and returns", v: logistics },
  ].sort((a, b) => b.v - a.v);
  const top = items[0];
  const second = items[1];
  if (top.v < 12) {
    return "dropout is relatively balanced across drivers — use panel notes for nuance.";
  }
  if (second.v >= top.v - 4) {
    return `${top.label} and ${second.label} remain the strongest modeled dropout drivers.`;
  }
  return `${top.label} remains the dominant modeled dropout driver.`;
}

function buildPriceSweepTakeaway(
  baselineScore: number,
  bestScore: number,
  blockerPhrase: string,
): string {
  const delta = bestScore - baselineScore;
  if (delta >= 5) {
    return `Discounting lifted modeled intent by about ${delta} points; still validate with trust and shipping experiments before you rely on it. ${blockerPhrase.charAt(0).toUpperCase()}${blockerPhrase.slice(1)}`;
  }
  if (delta <= -2) {
    return `Lowering price did not improve modeled intent. ${blockerPhrase.charAt(0).toUpperCase()}${blockerPhrase.slice(1)}`;
  }
  return `Price had limited impact on the headline score. ${blockerPhrase.charAt(0).toUpperCase()}${blockerPhrase.slice(1)}`;
}

function matchExperimentByTerms(cards: ExperimentCard[], terms: string[]): ExperimentCard | undefined {
  const t = terms.map((x) => x.toLowerCase()).filter(Boolean);
  if (!t.length) return undefined;
  return cards.find((c) => {
    const h = `${c.name} ${c.hypothesis}`.toLowerCase();
    return t.some((term) => h.includes(term));
  });
}

function dropoutDeltaText(before: number, after: number | undefined): string {
  if (after == null || Number.isNaN(after)) return `${Math.round(before)}% → —`;
  const d = Math.round(after - before);
  const sign = d > 0 ? "+" : "";
  return `${Math.round(before)}% → ${Math.round(after)}% (${sign}${d} pts)`;
}

function dropoutDeltaClass(before: number, after: number | undefined): string {
  if (after == null || Number.isNaN(after)) return styles.poDeltaNeutral;
  const d = after - before;
  if (d < -1) return styles.poDeltaGood;
  if (d > 1) return styles.poDeltaBad;
  return styles.poDeltaFlat;
}

function dropoutDeltaCaption(before: number, after: number | undefined): string {
  if (after == null || Number.isNaN(after)) return "No simulated split in this report";
  const d = after - before;
  if (d < -1) return "Lower dropout vs. baseline";
  if (d > 1) return "Higher dropout vs. baseline";
  return "Roughly flat vs. baseline";
}

const PRICE_OPT_NEXT_STEPS: {
  title: string;
  body: string;
  impact: string;
  terms: string[];
}[] = [
  {
    title: "Clarify value vs. alternatives",
    body: "Give price-sensitive buyers a reason your offer wins on total value, not sticker price alone.",
    impact: "Estimated +3–8 pts when price friction leads dropout",
    terms: ["value", "comparison", "alternative", "price"],
  },
  {
    title: "Surface reviews and trust",
    body: "Add visible ratings, testimonials, or guarantees so first-time buyers can commit.",
    impact: "Estimated +4–10 pts when trust leads dropout",
    terms: ["review", "trust", "rating", "testimonial", "guarantee"],
  },
  {
    title: "Shipping and returns clarity",
    body: "Spell out timelines, thresholds, and what happens if the product is not a fit.",
    impact: "Estimated +3–8 pts when logistics leads dropout",
    terms: ["shipping", "return", "delivery", "logistics"],
  },
  {
    title: "Run a focused What-If",
    body: "Change one lever at a time with an experiment card or custom hypothesis below.",
    impact: "Isolate which barrier actually moves the panel",
    terms: [],
  },
];

// ── Price Optimizer ───────────────────────────────────────────────────────────
function PriceOptimizerSection({
  basePrice,
  baselineScore,
  priceDropoutPct,
  logisticsDropoutPct,
  trustDropoutPct,
  priceBatchResults,
  batchRunning,
  isSubmitting,
  selectedChipId,
  onChipClick,
  experimentCards,
  selectExperimentCard,
  onOptimizerNavHint,
  fetcher,
}: {
  basePrice: number;
  baselineScore: number;
  priceDropoutPct: number;
  logisticsDropoutPct: number;
  trustDropoutPct: number;
  priceBatchResults: PriceBatchResult[];
  batchRunning: boolean;
  isSubmitting: boolean;
  selectedChipId: string | null;
  onChipClick: (r: PriceBatchResult | null) => void;
  experimentCards: ExperimentCard[];
  selectExperimentCard: (id: string) => void;
  onOptimizerNavHint: (message: string) => void;
  fetcher: FetcherWithComponents<SandboxActionData>;
}) {
  const hasBatch = priceBatchResults.length > 0;
  const isBusy = isSubmitting || batchRunning;

  // Find best ROI chip: highest (scoreDelta / priceLost) where scoreDelta > 0
  const recommended = priceBatchResults
    .filter((r) => r.status === "COMPLETED" && r.score != null && r.score > baselineScore)
    .reduce<PriceBatchResult | null>((best, r) => {
      const priceLost = basePrice - r.price;
      if (priceLost <= 0) return best;
      const roi = (r.score! - baselineScore) / priceLost;
      if (!best) return r;
      const bestLost = basePrice - best.price;
      const bestRoi = bestLost > 0 ? (best.score! - baselineScore) / bestLost : -Infinity;
      return roi > bestRoi ? r : best;
    }, null);

  // Sort chips -5, -10, -15 (least to most aggressive)
  const sortedChips = [...priceBatchResults].sort((a, b) => b.pctDelta - a.pctDelta);

  const batchFullyComplete =
    sortedChips.length === 3 &&
    sortedChips.every((r) => r.status === "COMPLETED" && r.score != null);

  const bestSweep = pickBestSweepRun(priceBatchResults);
  const showCompletionSummary = hasBatch && batchFullyComplete && !isBusy && bestSweep != null;

  function scrollToExperiments() {
    document.getElementById("experiment-dashboard")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function runExperimentStep(terms: string[]) {
    scrollToExperiments();
    const match = matchExperimentByTerms(experimentCards, terms);
    if (match) {
      selectExperimentCard(match.id);
      onOptimizerNavHint(
        "We selected a matching experiment card below. Adjust sliders if needed, then run What-If.",
      );
    } else {
      onOptimizerNavHint(
        "Pick an experiment card below (or write a custom hypothesis), adjust price or shipping if needed, then run What-If.",
      );
    }
  }

  const blockerPhrase = blockerSummaryPhrase(
    priceDropoutPct,
    logisticsDropoutPct,
    trustDropoutPct,
  );
  const bestScore = bestSweep?.score ?? baselineScore;
  const scoreDelta = bestScore - baselineScore;

  return (
    <div className={styles.priceOptBand}>
      <div className={styles.priceOptHeader}>
        <div>
          <div className={styles.priceOptTitleRow}>
            <span className={styles.priceOptIcon}>⚗️</span>
            <span className={styles.priceOptLabel}>Price Optimizer</span>
            {hasBatch && (
              <span className={styles.priceOptTag}>
                {batchRunning
                  ? "Running…"
                  : batchFullyComplete
                    ? "Completed"
                    : "In progress / partial"}
              </span>
            )}
          </div>
          {!hasBatch && (
            <p className={styles.priceOptSubtitle}>
              Runs −5%, −10%, −15% in parallel · uses cached DNA · no re-extraction
            </p>
          )}
          {showCompletionSummary && (
            <p className={styles.poRunCompleteTitle}>Price Optimizer run — completed</p>
          )}
        </div>
        <fetcher.Form method="post" style={{ flexShrink: 0 }}>
          <input type="hidden" name="intent" value="batch_price_optimize" />
          <button
            type="submit"
            className={styles.priceOptRunBtn}
            disabled={isBusy}
          >
            {isBusy ? "Running…" : hasBatch ? "↺ Re-run sweep" : "⚗️ Run Price Sweep"}
          </button>
        </fetcher.Form>
      </div>

      {batchRunning && hasBatch && (
        <div className={styles.priceOptRunningBlock}>
          <Text as="p" variant="bodySm" tone="subdued">
            Running three price scenarios in parallel. This usually takes a few minutes — the page
            refreshes as each panel completes.
          </Text>
          <div style={{ marginTop: 10 }}>
            <SkeletonBodyText lines={3} />
          </div>
        </div>
      )}

      {showCompletionSummary && bestSweep && (
        <>
          <p className={styles.poTakeaway}>
            <strong>Takeaway: </strong>
            {buildPriceSweepTakeaway(baselineScore, bestScore, blockerPhrase)}
          </p>

          <div className={styles.poImpactGrid}>
            <div className={styles.poImpactCard}>
              <span className={styles.poImpactLabel}>Overall score</span>
              <span className={styles.poImpactValue}>
                {baselineScore} → {bestScore}
              </span>
              <span
                className={`${styles.poImpactDelta} ${
                  scoreDelta > 2
                    ? styles.poDeltaGood
                    : scoreDelta < -2
                      ? styles.poDeltaBad
                      : styles.poDeltaFlat
                }`}
              >
                {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta} pts vs. baseline
              </span>
            </div>
            <div className={styles.poImpactCard}>
              <span className={styles.poImpactLabel}>Price dropout</span>
              <span className={styles.poImpactValue}>
                {dropoutDeltaText(priceDropoutPct, bestSweep.friction?.price)}
              </span>
              <span
                className={`${styles.poImpactDelta} ${dropoutDeltaClass(
                  priceDropoutPct,
                  bestSweep.friction?.price,
                )}`}
              >
                {dropoutDeltaCaption(priceDropoutPct, bestSweep.friction?.price)}
              </span>
            </div>
            <div className={styles.poImpactCard}>
              <span className={styles.poImpactLabel}>Trust dropout</span>
              <span className={styles.poImpactValue}>
                {dropoutDeltaText(trustDropoutPct, bestSweep.friction?.trust)}
              </span>
              <span
                className={`${styles.poImpactDelta} ${dropoutDeltaClass(
                  trustDropoutPct,
                  bestSweep.friction?.trust,
                )}`}
              >
                {dropoutDeltaCaption(trustDropoutPct, bestSweep.friction?.trust)}
              </span>
            </div>
            <div className={styles.poImpactCard}>
              <span className={styles.poImpactLabel}>Logistics dropout</span>
              <span className={styles.poImpactValue}>
                {dropoutDeltaText(logisticsDropoutPct, bestSweep.friction?.logistics)}
              </span>
              <span
                className={`${styles.poImpactDelta} ${dropoutDeltaClass(
                  logisticsDropoutPct,
                  bestSweep.friction?.logistics,
                )}`}
              >
                {dropoutDeltaCaption(logisticsDropoutPct, bestSweep.friction?.logistics)}
              </span>
            </div>
          </div>

          <div className={styles.poInsightCard}>
            <span className={styles.poInsightKicker}>Main insight</span>
            <p className={styles.poInsightBody}>
              {bestSweep.comparisonInsight?.trim() ||
                `Best sweep at ${bestSweep.pctDelta}% ($${bestSweep.price.toFixed(2)}) scored ${bestScore}. Use the steps below to address remaining friction.`}
            </p>
            <p className={styles.poInsightRec}>
              <strong>Recommendation: </strong>
              {scoreDelta >= 5
                ? "Capture margin impact before you scale the discount; pair with trust or logistics tests."
                : scoreDelta <= -2
                  ? "Pause broad discounting; prioritize listing and policy clarity over price cuts."
                  : "Treat price as one lever among several — run targeted What-Ifs on trust and fulfillment next."}
            </p>
          </div>

          <div className={styles.poStepsSection}>
            <h3 className={styles.poStepsHeading}>Recommended next steps</h3>
            <p className={styles.poStepsSub}>
              Each card links to your experiment dashboard. Estimated ranges are directional, not guarantees.
            </p>
            <div className={styles.poStepsGrid}>
              {PRICE_OPT_NEXT_STEPS.map((step) => (
                <div key={step.title} className={styles.poStepCard}>
                  <h4 className={styles.poStepTitle}>{step.title}</h4>
                  <p className={styles.poStepBody}>{step.body}</p>
                  <p className={styles.poStepImpact}>{step.impact}</p>
                  <button
                    type="button"
                    className={styles.poStepRunBtn}
                    onClick={() => runExperimentStep(step.terms)}
                  >
                    Run this experiment →
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {hasBatch && (
        <div className={showCompletionSummary ? styles.poSimCompact : undefined}>
          {showCompletionSummary && (
            <p className={styles.poSimCompactTitle}>Simulation results (best sweep highlighted)</p>
          )}
          <div
            className={`${styles.priceChipRow} ${showCompletionSummary ? styles.priceChipRowCompact : ""}`}
          >
          {sortedChips.map((r) => {
            const isPending = r.status === "PENDING" || r.status === "RUNNING";
            const isDone = r.status === "COMPLETED" && r.score != null;
            const isFailed = r.status === "FAILED";
            const isBestSweep = showCompletionSummary && bestSweep?.id === r.id;
            const isRec = recommended?.id === r.id;
            const chipScoreDelta = isDone ? r.score! - baselineScore : null;
            const isSelected = selectedChipId === r.id;

            const barColor =
              r.score != null && r.score >= 70
                ? styles.chipBarGood
                : r.score != null && r.score >= 45
                  ? styles.chipBarMid
                  : styles.chipBarLow;

            const scoreColorCls =
              r.score != null && r.score >= 70
                ? styles.chipScoreGood
                : r.score != null && r.score >= 45
                  ? styles.chipScoreMid
                  : styles.chipScoreLow;

            return (
              <button
                key={r.id}
                type="button"
                className={[
                  styles.priceChip,
                  isSelected ? styles.priceChipSelected : "",
                  (isRec && !isSelected) || (isBestSweep && !isSelected) ? styles.priceChipRec : "",
                  isDone ? styles.priceChipDone : "",
                ].join(" ")}
                onClick={() => {
                  if (!isDone) return;
                  onChipClick(isSelected ? null : r);
                }}
                disabled={!isDone && !isPending}
                aria-pressed={isSelected}
              >
                {(isRec || isBestSweep) && (
                  <span className={styles.recBadge}>
                    {isBestSweep ? "★ Best sweep" : "★ Best ROI"}
                  </span>
                )}

                <div className={styles.chipTop}>
                  <span className={styles.chipPctLabel}>{r.pctDelta}%</span>
                  <span className={styles.chipPriceLabel}>${r.price.toFixed(2)}</span>
                </div>

                {isPending && (
                  <div className={styles.chipLoadingWrap}>
                    <div className={styles.chipLoadingBar} />
                    <span className={styles.chipLoadingText}>Panel running…</span>
                  </div>
                )}

                {isDone && (
                  <>
                    <div className={styles.chipBar}>
                      <div
                        className={`${styles.chipBarFill} ${barColor}`}
                        style={{ width: `${r.score}%` }}
                      />
                    </div>
                    <div className={styles.chipScoreRow}>
                      <span className={`${styles.chipScoreNum} ${scoreColorCls}`}>
                        {r.score}
                      </span>
                      <span className={styles.chipScoreOf}>/100</span>
                    </div>
                    {chipScoreDelta !== null && (
                      <div
                        className={`${styles.chipDeltaRow} ${
                          chipScoreDelta > 0
                            ? styles.chipDeltaPos
                            : chipScoreDelta < 0
                              ? styles.chipDeltaNeg
                              : styles.chipDeltaFlat
                        }`}
                      >
                        {chipScoreDelta > 0 ? "▲" : chipScoreDelta < 0 ? "▼" : "—"}
                        {" "}
                        {chipScoreDelta > 0 ? `+${chipScoreDelta}` : chipScoreDelta} pts
                      </div>
                    )}
                    {isSelected && (
                      <div className={styles.chipViewingHint}>Viewing ↑</div>
                    )}
                  </>
                )}

                {isFailed && (
                  <div className={styles.chipFailed}>Failed</div>
                )}
              </button>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}

type Props = {
  simulationId: string;
  productUrl: string;
  baselineScore: number;
  baselinePhase1: AgentLogLite[];
  labPhase1: AgentLogLite[];
  baselinePhase2: AgentLogLite[];
  labPhase2: AgentLogLite[];
  priceDropoutPct: number;
  logisticsDropoutPct: number;
  trustDropoutPct: number;
  trustAudit: TrustAuditFriction;
  experimentCards: ExperimentCard[];
  isPro: boolean;
  basePrice: number;
  price: number;
  setPrice: (n: number) => void;
  shippingDays: number;
  setShippingDays: (n: number) => void;
  selectedCardId: string | null;
  toggleCard: (id: string) => void;
  selectExperimentCard: (id: string) => void;
  runLabel: string;
  isSubmitting: boolean;
  latestRunning: boolean;
  fetcher: FetcherWithComponents<SandboxActionData>;
  fetcherError?: string;
  labScore: number | null;
  latestCompletedInsight: string | null;
  latestCompletedId: string | null;
  latestDeltaPrice?: number | null;
  latestDeltaShipping?: number | null;
  experimentSetDeltas: DeltaRow[];
  allSetCompleted: boolean;
  priceBatchResults: PriceBatchResult[];
  batchRunning: boolean;
};

export function ComparisonLaboratory({
  simulationId,
  productUrl,
  baselineScore,
  baselinePhase1,
  labPhase1,
  baselinePhase2,
  labPhase2,
  priceDropoutPct,
  logisticsDropoutPct,
  trustDropoutPct,
  trustAudit,
  experimentCards,
  isPro,
  basePrice,
  price,
  setPrice,
  shippingDays,
  setShippingDays,
  selectedCardId,
  toggleCard,
  selectExperimentCard,
  runLabel,
  isSubmitting,
  latestRunning,
  fetcher,
  fetcherError,
  labScore,
  latestCompletedInsight,
  latestCompletedId,
  latestDeltaPrice,
  latestDeltaShipping,
  experimentSetDeltas,
  allSetCompleted,
  priceBatchResults,
  batchRunning,
}: Props) {
  const [mobileTab, setMobileTab] = useState<"baseline" | "simulation">("baseline");
  const [selectedBatchSim, setSelectedBatchSim] = useState<PriceBatchResult | null>(null);
  const [optimizerNavHint, setOptimizerNavHint] = useState<string | null>(null);

  const baselineMap = phase1ByArchetype(baselinePhase1);
  const labMap = phase1ByArchetype(labPhase1);

  // When a price batch chip is selected, it overrides the simulation pane data
  const activeBatchSim = selectedBatchSim;
  const activeLabScore = activeBatchSim?.score ?? labScore;
  const activeLabPhase1 = activeBatchSim?.phase1Logs.length ? activeBatchSim.phase1Logs : labPhase1;
  const activeLabPhase2 = activeBatchSim?.phase2Logs.length ? activeBatchSim.phase2Logs : labPhase2;
  const activeInsight = activeBatchSim?.comparisonInsight ?? latestCompletedInsight;
  const activeDeltaPrice = activeBatchSim?.price ?? latestDeltaPrice;
  const activeLabMap = phase1ByArchetype(activeLabPhase1);

  const hasLab = activeLabScore != null;
  const simulationHighlighted = hasLab || !!activeBatchSim;
  const debateItems = buildDebateItems(baselinePhase2.length ? baselinePhase2 : activeLabPhase2);

  const priceMax = Math.max(500, basePrice * 3);
  const showMeterShift = hasLab && activeLabScore !== baselineScore;

  const rec = getRecommendation(baselineScore);

  const batchFullyCompleteForBanner =
    isPro &&
    priceBatchResults.length === 3 &&
    priceBatchResults.every((r) => r.status === "COMPLETED" && r.score != null);
  const bestSweepForBanner =
    !batchRunning && batchFullyCompleteForBanner ? pickBestSweepRun(priceBatchResults) : null;

  const baselinePane = (
    <>
      <div className={styles.labPaneHeader}>
        <h3 className={styles.labPaneTitle}>Current PDP analysis</h3>
        <span className={styles.labBadge}>Baseline</span>
      </div>
      <div className={styles.gaugeWrap}>
        <ConfidenceGauge score={baselineScore} size={140} variant="light" />
      </div>
      <div className={`${styles.recommendationPill} ${rec.cls}`}>
        {rec.emoji} {rec.text}
      </div>
      <Meter label="Purchase intent (panel)" value={baselineScore} />
      <FrictionCards
        pricePct={priceDropoutPct}
        logisticsPct={logisticsDropoutPct}
        trustPct={trustDropoutPct}
        trustAudit={trustAudit}
      />
      <div style={{ marginTop: 16 }}>
        <p className={styles.panelSectionLabel}>First-scan panel votes — Phase 1</p>
        <PersonaRows baselineMap={baselineMap} labMap={new Map()} />
      </div>
    </>
  );

  const simulationPane = (
    <>
      {bestSweepForBanner && !activeBatchSim && (
        <div className={styles.simPaneBanner}>
          <Banner
            tone="success"
            title="Optimization complete"
            action={
              productUrl
                ? {
                    content: "Go to product page",
                    url: productUrl,
                    external: true,
                  }
                : undefined
            }
          >
            <Text as="p" variant="bodySm">
              Best sweep: ${bestSweepForBanner.price.toFixed(2)} ({bestSweepForBanner.pctDelta}% vs. list). Modeled
              purchase intent {baselineScore} → {bestSweepForBanner.score} (
              {bestSweepForBanner.score! - baselineScore >= 0 ? "+" : ""}
              {bestSweepForBanner.score! - baselineScore} pts).
            </Text>
          </Banner>
        </div>
      )}
      <div className={styles.labPaneHeader}>
        <h3 className={styles.labPaneTitle}>
          {activeBatchSim
            ? `Price ${activeBatchSim.pctDelta}% — $${activeBatchSim.price.toFixed(2)}`
            : "Simulation results"}
        </h3>
        <span className={`${styles.labBadge} ${hasLab ? styles.labBadgeLive : ""}`}>
          {activeBatchSim
            ? "Price Sweep"
            : hasLab
              ? "Latest What-If"
              : "Idle"}
        </span>
      </div>
      {hasLab ? (
        <>
          <Meter
            label="Modeled purchase intent (panel)"
            value={activeLabScore!}
            animate={showMeterShift}
          />
          <div className={styles.labCompareRow}>
            <span>
              <strong>Price:</strong>{" "}
              {activeDeltaPrice != null ? `$${Number(activeDeltaPrice).toFixed(2)}` : `~$${basePrice.toFixed(2)}`}
            </span>
            <span>
              <strong>Shipping:</strong>{" "}
              {!activeBatchSim && latestDeltaShipping != null ? `${latestDeltaShipping}d` : "unchanged"}
            </span>
          </div>
          <div style={{ marginTop: 14 }}>
            <p className={styles.panelSectionLabel}>Votes vs. baseline — Phase 1</p>
            <PersonaRows baselineMap={baselineMap} labMap={activeLabMap} />
          </div>
        </>
      ) : (
        <div className={styles.simIdleState}>
          <span className={styles.simIdleIcon}>🧪</span>
          <p className={styles.simIdleTitle}>No simulation yet</p>
          <p className={styles.simIdleText}>
            Run a What-If or use Price Optimizer to see results here with animated deltas vs. your baseline.
          </p>
        </div>
      )}
    </>
  );

  return (
    <div className={styles.labRoot}>
      <div className={styles.labSticky} id="experiment-dashboard" tabIndex={-1}>
        <p className={styles.labStickyTitle}>Experiment dashboard</p>
        {optimizerNavHint && (
          <div className={styles.optimizerNavHintWrap}>
            <Banner tone="info" onDismiss={() => setOptimizerNavHint(null)}>
              <Text as="p" variant="bodySm">
                {optimizerNavHint}
              </Text>
            </Banner>
          </div>
        )}
        {!isPro && (
          <Text as="p" variant="bodySm" tone="subdued">
            Upgrade to Pro to adjust price, shipping, and run simulations.
          </Text>
        )}

        {isPro && (
          <div className={styles.controlsRow} style={{ marginTop: 12 }}>
            <BlockStack gap="300">
              <div>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Price: ${price.toFixed(2)}
                </Text>
                <RangeSlider
                  label="Price"
                  labelHidden
                  min={1}
                  max={priceMax}
                  step={1}
                  value={price}
                  onChange={(v) => setPrice(v as number)}
                  output
                />
              </div>
              <div>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Shipping: {shippingDays} days
                </Text>
                <RangeSlider
                  label="Shipping"
                  labelHidden
                  min={1}
                  max={21}
                  step={1}
                  value={shippingDays}
                  onChange={(v) => setShippingDays(v as number)}
                  output
                />
              </div>
            </BlockStack>
          </div>
        )}

        {experimentCards.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            <Text as="p" variant="bodySm" fontWeight="semibold">
              Experiment cards
            </Text>
            <div className={styles.cardsGrid}>
              {experimentCards.map((card) => {
                const selected = selectedCardId === card.id;
                return (
                  <div key={card.id} className={styles.expCard} data-selected={selected}>
                    <h4 className={styles.expCardTitle}>{card.name}</h4>
                    <p className={styles.expCardHyp}>{card.hypothesis}</p>
                    {!isPro && (
                      <div className={styles.expCardLock}>
                        <span className={styles.expCardLockBadge}>Upgrade to unlock</span>
                      </div>
                    )}
                    {isPro && (
                      <div style={{ marginTop: 10 }}>
                        <button
                          type="button"
                          onClick={() => toggleCard(card.id)}
                          style={{
                            padding: "6px 12px",
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            cursor: "pointer",
                            borderRadius: 8,
                            border: "1px solid var(--lab-border)",
                            background: selected ? "var(--lab-accent-light)" : "var(--lab-elevated)",
                            color: selected ? "var(--lab-accent)" : "var(--lab-text)",
                          }}
                        >
                          {selected ? "Selected ✓" : "Test this"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {isPro && experimentCards.length >= 2 && (
              <div style={{ marginTop: 10 }}>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="simulate_all" />
                  <Button size="slim" submit loading={isSubmitting} disabled={!!latestRunning}>
                    Simulate all cards
                  </Button>
                </fetcher.Form>
              </div>
            )}
          </div>
        )}

        {fetcherError && (
          <div style={{ marginTop: 12 }}>
            <Banner tone="critical">
              <Text as="p" variant="bodyMd">
                {fetcherError}
              </Text>
            </Banner>
          </div>
        )}

        {isPro ? (
          <div className={styles.runBtnWrap}>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="run_whatif" />
              <input
                type="hidden"
                name="activeExperiment"
                value={experimentCards.find((c) => c.id === selectedCardId)?.hypothesis ?? ""}
              />
              <input type="hidden" name="price" value={price} />
              <input type="hidden" name="shippingDays" value={shippingDays} />
              <Button variant="primary" submit loading={isSubmitting} disabled={!!latestRunning}>
                {runLabel}
              </Button>
            </fetcher.Form>
            {latestRunning && (
              <Text as="p" variant="bodySm" tone="subdued">
                Panel running — this page refreshes every few seconds.
              </Text>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <CalloutCard
              title="Unlock the comparison lab"
              illustration="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be2a489e0be08b4f9d7a4e5ad25de5b84974268e8cbbd17af_small.png"
              primaryAction={{ content: "Upgrade to Pro", url: "/app/billing" }}
            >
              <Text as="p" variant="bodyMd">
                Pro runs What-If simulations, experiment cards, and full delta reports against this
                baseline.
              </Text>
            </CalloutCard>
          </div>
        )}
      </div>

      {/* ── Price Optimizer band ── */}
      {isPro && (
        <PriceOptimizerSection
          basePrice={basePrice}
          baselineScore={baselineScore}
          priceDropoutPct={priceDropoutPct}
          logisticsDropoutPct={logisticsDropoutPct}
          trustDropoutPct={trustDropoutPct}
          priceBatchResults={priceBatchResults}
          batchRunning={batchRunning}
          isSubmitting={isSubmitting}
          selectedChipId={selectedBatchSim?.id ?? null}
          onChipClick={setSelectedBatchSim}
          experimentCards={experimentCards}
          selectExperimentCard={selectExperimentCard}
          onOptimizerNavHint={setOptimizerNavHint}
          fetcher={fetcher}
        />
      )}

      <div className={styles.labMobileTabs}>
        <button
          type="button"
          className={styles.labTabBtn}
          data-active={mobileTab === "baseline"}
          onClick={() => setMobileTab("baseline")}
        >
          Baseline
        </button>
        <button
          type="button"
          className={styles.labTabBtn}
          data-active={mobileTab === "simulation"}
          onClick={() => setMobileTab("simulation")}
        >
          Simulation
        </button>
      </div>

      <div className={styles.labGrid}>
        <div className={`${styles.labPane} ${styles.labPaneBaseline}`}>{baselinePane}</div>
        <div
          className={`${styles.labPane} ${styles.labPaneSimulation} ${
            simulationHighlighted ? styles.labPaneSimulationActive : ""
          }`}
        >
          {simulationPane}
        </div>
      </div>

      <div
        className={`${styles.labMobilePane} ${styles.labPaneBaseline}`}
        data-visible={mobileTab === "baseline"}
      >
        {baselinePane}
      </div>
      <div
        className={`${styles.labMobilePane} ${styles.labPaneSimulation} ${
          simulationHighlighted ? styles.labPaneSimulationActive : ""
        }`}
        data-visible={mobileTab === "simulation"}
      >
        {simulationPane}
      </div>

      {activeInsight && (activeBatchSim ? activeBatchSim.id : latestCompletedId) && (
        <div className={styles.insightBox} style={{ margin: "0 1.25rem 1rem" }}>
          <strong>AI insight — </strong>
          {activeInsight}
          {!activeBatchSim && latestCompletedId && (
            <div style={{ marginTop: 10 }}>
              <Button url={`/app/results/${latestCompletedId}`} size="slim" variant="plain">
                Open full What-If report →
              </Button>
            </div>
          )}
        </div>
      )}

      {allSetCompleted && experimentSetDeltas.length > 0 && (
        <div className={styles.debateSection}>
          <Text as="h3" variant="headingSm">
            Experiment batch results
          </Text>
          <BlockStack gap="200">
            {[...experimentSetDeltas]
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
              .map((d) => {
                const dp = d.deltaParams as { experimentCardName?: string } | null;
                const diff = d.score != null ? d.score - baselineScore : null;
                return (
                  <InlineStack key={d.id} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodySm">
                      {dp?.experimentCardName ?? "Experiment"}
                    </Text>
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {d.score ?? "—"}/100
                        {diff != null && diff !== 0 && (
                          <span style={{ color: diff > 0 ? "#16A34A" : "#DC2626", marginLeft: 6 }}>
                            ({diff > 0 ? "+" : ""}{diff})
                          </span>
                        )}
                      </Text>
                      {d.status === "COMPLETED" && (
                        <Button url={`/app/results/${d.id}`} size="slim" variant="plain">
                          View
                        </Button>
                      )}
                    </InlineStack>
                  </InlineStack>
                );
              })}
          </BlockStack>
        </div>
      )}

      <div className={styles.debateSection}>
        <h3 className={styles.debateTitle}>Panel debrief</h3>
        <p className={styles.debateSub}>
          Each color is a different panelist — follow who challenged the listing and who defended it. From Phase 2
          (refreshes when the engine completes a phase; not a live stream).
        </p>
        <div className={styles.bubbleList}>
          {debateItems.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No debate transcript stored for this simulation yet.
            </Text>
          ) : (
            debateItems.map((item, idx) =>
              item.type === "challenge" ? (
                <div key={`c-${idx}`} className={styles.challengePill}>
                  VS — opposing votes
                </div>
              ) : (
                <div key={`${item.log.agentId}-${idx}`} className={styles.bubbleRow}>
                  <div
                    className={`${styles.debateAvatar} ${
                      AGENT_AVATAR[item.log.archetype] ?? styles.avatarDefault
                    }`}
                    aria-hidden
                  >
                    {initialsFromLog(item.log)}
                  </div>
                  <div
                    className={`${styles.bubble} ${
                      AGENT_BUBBLE[item.log.archetype] ?? styles.bubbleDefault
                    }`}
                  >
                    <div className={styles.bubbleHeader}>
                      <span>{item.log.personaName || item.log.archetypeName || item.log.archetype}</span>
                      <span className={`${styles.verdict} ${verdictClass(item.log.verdict)}`}>
                        {item.log.verdict}
                      </span>
                    </div>
                    <span className={styles.bubbleMeta}>
                      {(item.log.archetypeEmoji ? `${item.log.archetypeEmoji} ` : "")}
                      {ARCHETYPE_FALLBACK[item.log.archetype]?.name ?? item.log.archetype}
                    </span>
                    <p className={styles.bubbleQuote}>
                      &ldquo;{sanitizeAgentReasoning(item.log.reasoning)}&rdquo;
                    </p>
                  </div>
                </div>
              ),
            )
          )}
        </div>
      </div>

      <div style={{ padding: "0 1.25rem 1.25rem" }}>
        <Button url={`/app/results/${simulationId}`} variant="plain" size="slim">
          ← Back to full PDP report
        </Button>
      </div>
    </div>
  );
}
