import type { FetcherWithComponents } from "@remix-run/react";
import { Form, useNavigation } from "@remix-run/react";

type SandboxActionData = { error?: string } | undefined;
import { useState, useEffect, useRef } from "react";
import {
  Button,
  Banner,
  Text,
  BlockStack,
  InlineStack,
  Box,
  RangeSlider,
  CalloutCard,
  SkeletonBodyText,
  Spinner,
  ProgressBar,
  Tooltip,
  Collapsible,
  Badge,
  TextField,
} from "@shopify/polaris";
import { ConfidenceGauge } from "../ConfidenceGauge";
import { sanitizeAgentReasoning } from "../../utils/sanitizeAgentReasoning";
import styles from "./ComparisonLaboratory.module.css";

/** Default shipping used when no override — keep in sync with sandbox initial state. */
const DEFAULT_BASELINE_SHIPPING_DAYS = 7;

const TRUST_LAB_DEFAULT_HYPOTHESIS =
  "Trust test: Surface reviews, guarantees, and lifestyle or in-use photos above the fold so hesitant buyers feel confident sooner.";

type LabPdpPreviewProps = {
  productTitle: string;
  productImageUrl?: string | null;
  basePrice: number;
  displayPrice: number;
  shippingDays: number;
  baselineShippingDays: number;
  descriptionSnippet: string;
};

function LabPdpPreview({
  productTitle,
  productImageUrl: _productImageUrl,
  basePrice,
  displayPrice,
  shippingDays,
  baselineShippingDays,
  descriptionSnippet,
  compact = false,
}: LabPdpPreviewProps & { compact?: boolean }) {
  void _productImageUrl;
  const showStrike = displayPrice < basePrice - 0.009;
  const pctOff = showStrike && basePrice > 0 ? Math.round(((basePrice - displayPrice) / basePrice) * 100) : 0;
  const letter = (productTitle || "P").trim().charAt(0).toUpperCase() || "P";
  return (
    <div className={compact ? `${styles.labPdpShell} ${styles.labPdpShellCompact}` : styles.labPdpShell}>
      <div className={styles.labPdpChrome}>
        <span className={styles.labPdpDot} />
        <span className={styles.labPdpDot} />
        <span className={styles.labPdpDot} />
        <span className={styles.labPdpUrl}>Preview · not published</span>
      </div>
      <div className={styles.labPdpBody}>
        <div className={styles.labPdpAbstract} aria-hidden>
          <span className={styles.labPdpAbstractLetter}>{letter}</span>
        </div>
        <h3 className={styles.labPdpTitle}>{productTitle || "Your product"}</h3>
        <div className={styles.labPdpPriceRow}>
          {showStrike ? <span className={styles.labPdpPriceOld}>${basePrice.toFixed(2)}</span> : null}
          <span className={styles.labPdpPrice}>${displayPrice.toFixed(2)}</span>
          {pctOff > 0 ? <span className={styles.labPdpSaveBadge}>−{pctOff}%</span> : null}
        </div>
        <p className={styles.labPdpShip}>
          Arrives in <strong>{shippingDays} days</strong>
          {shippingDays !== baselineShippingDays ? <span className={styles.labPdpShipHint}> · test</span> : null}
        </p>
        {descriptionSnippet.trim() ? (
          <p className={styles.labPdpDesc}>{descriptionSnippet.trim()}</p>
        ) : (
          <p className={styles.labPdpDescMuted}>
            Abstract preview — no store photos used. Your live PDP is unchanged.
          </p>
        )}
      </div>
      <p className={styles.labPdpDisclaimer}>Safe lab preview only.</p>
    </div>
  );
}

function composeActiveExperiment(
  selectedHypothesis: string | undefined,
  descriptionDraft: string,
  trustAddon: string,
): string {
  const parts: string[] = [];
  if (selectedHypothesis?.trim()) parts.push(selectedHypothesis.trim());
  if (descriptionDraft.trim()) {
    parts.push(`Additional PDP copy shoppers would see: ${descriptionDraft.trim()}`);
  }
  if (trustAddon.trim()) parts.push(trustAddon.trim());
  return parts.join("\n\n");
}

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

/** Pre-filtered rows for the lab footer (excludes batch/setGroup runs). */
export type ScenarioHistoryRow = {
  id: string;
  status: string;
  score: number | null;
  createdAt: string;
  price: number | null;
  shippingDays: number | null;
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
  hasSpecificReturn?: boolean;
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

// ── Raw vote helpers (floor-bypass) ──────────────────────────────────────────
// The engine applies a trust floor (min 60) to all sims. For delta comparisons
// we derive buy-vote percentage directly from agent logs so the signal is real.

function rawBuyCount(logs: AgentLogLite[]): number {
  return logs.filter((l) => l.phase === 1 && l.verdict === "BUY").length;
}
function rawAgentTotal(logs: AgentLogLite[]): number {
  return logs.filter((l) => l.phase === 1).length;
}
function rawVotePct(logs: AgentLogLite[]): number | null {
  const total = rawAgentTotal(logs);
  if (total === 0) return null;
  return Math.round((rawBuyCount(logs) / total) * 100);
}

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

const FRICTION_TOOLTIPS: Record<"price" | "logistics" | "trust", string> = {
  price:
    "Estimated share of modeled hesitation tied to price vs. value (not your checkout funnel).",
  logistics:
    "Estimated share tied to shipping, delivery, and returns clarity.",
  trust: "Estimated share tied to reviews, credibility, and policy trust signals.",
};

function topFrictionIssueRows(
  pricePct: number,
  logisticsPct: number,
  trustPct: number,
): { key: string; label: string; pct: number; sev: FrictionSev; hint: string }[] {
  const rows = [
    {
      key: "price",
      label: "Price sensitivity",
      pct: pricePct,
      sev: (pricePct >= 40 ? "critical" : pricePct >= 15 ? "warning" : "growth") as FrictionSev,
      hint: "Justify value or test a clearer offer.",
    },
    {
      key: "trust",
      label: "Trust & social proof",
      pct: trustPct,
      sev: (trustPct >= 40 ? "critical" : trustPct >= 15 ? "warning" : "growth") as FrictionSev,
      hint: "Add proof buyers can see before they commit.",
    },
    {
      key: "logistics",
      label: "Logistics & returns",
      pct: logisticsPct,
      sev: (logisticsPct >= 40 ? "critical" : logisticsPct >= 15 ? "warning" : "growth") as FrictionSev,
      hint: "Spell out delivery and what happens if it is not a fit.",
    },
  ];
  return [...rows].sort((a, b) => b.pct - a.pct).slice(0, 3);
}

function topRejectSnippetsFromLogs(logs: AgentLogLite[], max = 3): string[] {
  const out: string[] = [];
  for (const log of logs) {
    if (log.verdict !== "REJECT") continue;
    const s = sanitizeAgentReasoning(log.reasoning).trim();
    if (!s) continue;
    out.push(s.length > 200 ? `${s.slice(0, 197)}…` : s);
    if (out.length >= max) break;
  }
  return out;
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
    // Scores tied (likely both floored) — use raw vote pct as tiebreaker
    const rRaw = rawVotePct(r.phase1Logs);
    const bRaw = rawVotePct(best.phase1Logs);
    if (rRaw !== null && bRaw !== null && rRaw !== bRaw) return rRaw > bRaw ? r : best;
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
  floorMasking?: boolean,
): string {
  if (floorMasking) {
    return `Score floor (min 60) is masking the real signal. Check vote counts per chip to see which price point moved the panel. ${blockerPhrase.charAt(0).toUpperCase()}${blockerPhrase.slice(1)}`;
  }
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
  baselinePhase1,
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
  onNavigateToExperiments,
  fetcher,
}: {
  basePrice: number;
  baselineScore: number;
  baselinePhase1: AgentLogLite[];
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
  onNavigateToExperiments?: () => void;
  fetcher: FetcherWithComponents<SandboxActionData>;
}) {
  const hasBatch = priceBatchResults.length > 0;
  const isBusy = isSubmitting || batchRunning;

  // Detect floor masking: all completed chips scored the same as baseline
  const baseRawBuy = rawBuyCount(baselinePhase1);
  const baseRawTotal = rawAgentTotal(baselinePhase1);
  const completedChips = priceBatchResults.filter((r) => r.status === "COMPLETED" && r.score != null);
  const sweepFloorMasking =
    completedChips.length > 0 &&
    completedChips.every((r) => r.score === baselineScore) &&
    completedChips.some((r) => rawVotePct(r.phase1Logs) !== rawVotePct(baselinePhase1));

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
    onNavigateToExperiments?.();
    requestAnimationFrame(() => {
      document.getElementById("experiment-dashboard")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
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
  const bestSweepRawBuy = bestSweep ? rawBuyCount(bestSweep.phase1Logs) : null;
  const bestSweepRawTotal = bestSweep ? rawAgentTotal(bestSweep.phase1Logs) : null;

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
            {isBusy ? "Running…" : hasBatch ? "↺ Re-run price scan" : "⚗️ Compare 3 price points"}
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
            {buildPriceSweepTakeaway(baselineScore, bestScore, blockerPhrase, sweepFloorMasking)}
          </p>

          <div className={styles.poImpactGrid}>
            <div className={styles.poImpactCard}>
              <span className={styles.poImpactLabel}>Overall score</span>
              {sweepFloorMasking ? (
                <>
                  <span className={styles.poImpactValue}>
                    {baseRawBuy}/{baseRawTotal} → {bestSweepRawBuy}/{bestSweepRawTotal} BUY
                  </span>
                  <span className={`${styles.poImpactDelta} ${styles.poDeltaFlat}`}>
                    Score floored at {baselineScore} — vote signal used
                  </span>
                </>
              ) : (
                <>
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
                </>
              )}
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
                    Open in Pick a change →
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
            // Floor-bypass: show raw vote delta when score is tied at floor
            const chipRawBuy = rawBuyCount(r.phase1Logs);
            const chipRawTotal = rawAgentTotal(r.phase1Logs);
            const chipVoteDelta = chipRawTotal > 0 ? chipRawBuy - baseRawBuy : null;
            const chipFloorMasking = isDone && chipScoreDelta === 0 && chipVoteDelta !== null && chipVoteDelta !== 0;

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
                      chipFloorMasking ? (
                        <div className={`${styles.chipDeltaRow} ${chipVoteDelta! > 0 ? styles.chipDeltaPos : styles.chipDeltaNeg}`}>
                          {chipVoteDelta! > 0 ? "▲" : "▼"} {chipRawBuy}/{chipRawTotal} BUY
                        </div>
                      ) : (
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
                      )
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

// ── Live What-If progress pane ────────────────────────────────────────────────
const PANEL_SIZE = 5; // expected agents per phase

function WhatIfRunningPane({
  labPhase1,
  baselinePhase1,
  elapsed,
  stale,
}: {
  labPhase1: AgentLogLite[];
  baselinePhase1: AgentLogLite[];
  elapsed: number;
  stale: boolean;
}) {
  const votedCount = labPhase1.length;
  const totalAgents = Math.max(PANEL_SIZE, baselinePhase1.length);
  const progressPct = Math.min(100, Math.round((votedCount / totalAgents) * 100));

  const elapsedStr = elapsed < 60
    ? `${elapsed}s`
    : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

  // Build a roster: voted agents first, then placeholders for remaining
  const votedIds = new Set(labPhase1.map((l) => l.archetype));
  const allArchetypes = baselinePhase1.length > 0
    ? baselinePhase1.map((l) => l.archetype)
    : ROSTER_ORDER as unknown as string[];

  // Agents not yet voted
  const pending = allArchetypes.filter((a) => !votedIds.has(a));

  return (
    <BlockStack gap="300">
      {/* Status header */}
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <BlockStack gap="050">
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {votedCount === 0
                ? "Preparing panel…"
                : `Phase 1 — ${votedCount} of ${totalAgents} panelists voted`}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {stale
                ? "Still running — large panels can take a few minutes"
                : "Votes appear as they come in"}
            </Text>
          </BlockStack>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">{elapsedStr}</Text>
      </InlineStack>

      {/* Progress bar */}
      <ProgressBar progress={votedCount === 0 ? 5 : progressPct} size="small" tone="highlight" />

      {/* Live votes */}
      {labPhase1.length > 0 && (
        <BlockStack gap="200">
          {labPhase1.map((log) => {
            const fallback = ARCHETYPE_FALLBACK[log.archetype] ?? { emoji: "🧑", name: log.archetypeName ?? log.archetype };
            const isBuy = log.verdict === "BUY";
            return (
              <div
                key={log.agentId}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${isBuy ? "#d1fae5" : "#fee2e2"}`,
                  background: isBuy ? "#f0fdf4" : "#fff5f5",
                }}
              >
                <span style={{ fontSize: "1.2rem", lineHeight: 1 }}>
                  {log.archetypeEmoji ?? fallback.emoji}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {log.personaName ? `${log.personaName} · ` : ""}{log.archetypeName ?? fallback.name}
                    </Text>
                    <span style={{
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      padding: "2px 7px",
                      borderRadius: 12,
                      background: isBuy ? "#dcfce7" : "#fee2e2",
                      color: isBuy ? "#15803d" : "#dc2626",
                    }}>
                      {isBuy ? "✓ BUY" : "✗ REJECT"}
                    </span>
                  </div>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {sanitizeAgentReasoning(log.reasoning)}
                  </Text>
                </div>
              </div>
            );
          })}
        </BlockStack>
      )}

      {/* Skeleton placeholders for agents still thinking */}
      {pending.map((archetype) => {
        const fallback = ARCHETYPE_FALLBACK[archetype] ?? { emoji: "🧑", name: archetype };
        return (
          <div
            key={archetype}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              background: "#f9fafb",
            }}
          >
            <span style={{ fontSize: "1.2rem", lineHeight: 1, opacity: 0.4 }}>{fallback.emoji}</span>
            <div style={{ flex: 1 }}>
              <Text as="span" variant="bodySm" tone="subdued">{fallback.name}</Text>
            </div>
            <Spinner size="small" />
          </div>
        );
      })}
    </BlockStack>
  );
}

type Props = {
  simulationId: string;
  productUrl: string;
  productTitle: string;
  productImageUrl?: string | null;
  /** Baseline shipping days (matches live listing assumption). Defaults to 7. */
  baselineShippingDays?: number;
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
  /** Clear selected experiment card (e.g. when switching test type). */
  clearExperimentSelection: () => void;
  isSubmitting: boolean;
  latestRunning: boolean;
  deltaElapsed?: number;
  deltaStale?: boolean;
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
  scenarioHistory: ScenarioHistoryRow[];
};

export function ComparisonLaboratory({
  simulationId,
  productUrl,
  productTitle,
  productImageUrl = null,
  baselineShippingDays = DEFAULT_BASELINE_SHIPPING_DAYS,
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
  clearExperimentSelection,
  isSubmitting,
  latestRunning,
  deltaElapsed = 0,
  deltaStale = false,
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
  scenarioHistory,
}: Props) {
  const [mobileTab, setMobileTab] = useState<"baseline" | "simulation">("baseline");
  const [selectedBatchSim, setSelectedBatchSim] = useState<PriceBatchResult | null>(null);
  const [optimizerNavHint, setOptimizerNavHint] = useState<string | null>(null);
  // Run simulation uses regular <Form> so the redirect navigates; track both
  // navigation state and any fetcher state so other buttons in the lab still
  // get accurate "submitting" feedback.
  const navigation = useNavigation();
  const isNavSubmitting = navigation.state === "submitting" || navigation.state === "loading";
  const isSubmittingAny = isSubmitting || isNavSubmitting;
  const [wizardStep, setWizardStep] = useState<0 | 1 | 2>(() =>
    labScore != null || latestRunning ? 2 : 0,
  );
  const [debateFullOpen, setDebateFullOpen] = useState(false);
  // Price Optimizer is a primary selling point — start expanded so users see it immediately.
  const [priceOptimizerOpen, setPriceOptimizerOpen] = useState(true);
  const [frictionDetailOpen, setFrictionDetailOpen] = useState(false);
  const [scenarioHistoryOpen, setScenarioHistoryOpen] = useState(
    () => scenarioHistory.length === 1,
  );
  type BuildFocus = "price" | "shipping" | "discount" | "description" | "trust" | "suggestion" | null;
  const [buildFocus, setBuildFocus] = useState<BuildFocus>("price");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [trustAddon, setTrustAddon] = useState("");
  const [customDiscountPct, setCustomDiscountPct] = useState("");
  const prevHadLabScore = useRef(labScore != null);

  useEffect(() => {
    if (latestRunning) setWizardStep(2);
  }, [latestRunning]);

  useEffect(() => {
    const now = labScore != null;
    if (!prevHadLabScore.current && now) setWizardStep(2);
    prevHadLabScore.current = now;
  }, [labScore]);

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

  const selectedExperimentCard = experimentCards.find((c) => c.id === selectedCardId) ?? null;

  const applyDiscountPct = (pct: number) => {
    const next = Math.round(basePrice * (1 - pct / 100) * 100) / 100;
    setPrice(Math.max(0.01, next));
  };

  const applyCustomDiscountFromInput = () => {
    const n = parseFloat(customDiscountPct.replace(/%/g, "").trim());
    if (Number.isFinite(n) && n > 0 && n < 95) applyDiscountPct(n);
  };

  const hasBuildChange =
    isPro &&
    (Math.abs(price - basePrice) > 0.009 ||
      shippingDays !== baselineShippingDays ||
      descriptionDraft.trim().length > 0 ||
      selectedExperimentCard != null ||
      (buildFocus === "trust" && trustAddon.trim().length > 0));

  const activeExperimentPayload = composeActiveExperiment(
    selectedExperimentCard?.hypothesis,
    descriptionDraft,
    buildFocus === "trust" ? trustAddon : "",
  );

  // Floor-bypass: detect when engine's min-60 floor masks real panel signal
  const baselineRawPct = rawVotePct(baselinePhase1);
  const activeLabRawPct = rawVotePct(activeLabPhase1);
  const floorMasking =
    hasLab &&
    activeLabScore === baselineScore &&
    baselineRawPct !== null &&
    activeLabRawPct !== null &&
    baselineRawPct !== activeLabRawPct;

  // When floor is masking, use raw vote pct for meter so signal is visible
  const meterDisplayValue = floorMasking ? activeLabRawPct! : (activeLabScore ?? 0);
  const showMeterShift = hasLab && (activeLabScore !== baselineScore || floorMasking);

  const rec = getRecommendation(baselineScore);
  const insightRows = topFrictionIssueRows(priceDropoutPct, logisticsDropoutPct, trustDropoutPct);
  const debateSourceLogs = baselinePhase2.length ? baselinePhase2 : activeLabPhase2;
  const topRejectSnippets = topRejectSnippetsFromLogs(debateSourceLogs, 3);

  const batchFullyCompleteForBanner =
    isPro &&
    priceBatchResults.length === 3 &&
    priceBatchResults.every((r) => r.status === "COMPLETED" && r.score != null);
  const bestSweepForBanner =
    !batchRunning && batchFullyCompleteForBanner ? pickBestSweepRun(priceBatchResults) : null;
  const bannerFloorMasking =
    bestSweepForBanner != null &&
    bestSweepForBanner.score === baselineScore &&
    rawVotePct(bestSweepForBanner.phase1Logs) !== baselineRawPct;

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
      <Tooltip content="Modeled purchase intent from the baseline panel (0–100). May include listing bonuses or a trust floor — see Simulation tab for raw votes when scores tie.">
        <div>
          <Meter label="Purchase intent (panel)" value={baselineScore} />
        </div>
      </Tooltip>
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
            tone={bannerFloorMasking ? "warning" : "success"}
            title={bannerFloorMasking ? "Optimization complete — score floor active" : "Optimization complete"}
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
              {bannerFloorMasking
                ? `Best sweep: $${bestSweepForBanner.price.toFixed(2)} (${bestSweepForBanner.pctDelta}% vs. list). Score floored at ${baselineScore} — raw panel: ${rawBuyCount(bestSweepForBanner.phase1Logs)}/${rawAgentTotal(bestSweepForBanner.phase1Logs)} BUY vs. ${rawBuyCount(baselinePhase1)}/${rawAgentTotal(baselinePhase1)} baseline. Use the chip vote counts to compare scenarios.`
                : `Best sweep: $${bestSweepForBanner.price.toFixed(2)} (${bestSweepForBanner.pctDelta}% vs. list). Modeled purchase intent ${baselineScore} → ${bestSweepForBanner.score} (${bestSweepForBanner.score! - baselineScore >= 0 ? "+" : ""}${bestSweepForBanner.score! - baselineScore} pts).`}
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
      {hasLab && activeLabScore != null && !activeBatchSim && (
        <div className={styles.arenaLiftStrip}>
          <div className={styles.arenaLiftStripInner}>
            <span className={styles.arenaLiftStripLabel}>Modeled lift vs. live PDP</span>
            <span
              className={styles.arenaLiftStripValue}
              data-up={activeLabScore > baselineScore ? "true" : undefined}
              data-down={activeLabScore < baselineScore ? "true" : undefined}
            >
              {activeLabScore > baselineScore ? "+" : ""}
              {activeLabScore - baselineScore} pts
            </span>
            <span className={styles.arenaLiftStripHint}>
              {floorMasking ? "Scores may be floored — check raw votes below." : "Confidence index (0–100) on the same shopper panel."}
            </span>
          </div>
        </div>
      )}
      {hasLab && topRejectSnippets.length > 0 && !latestRunning && (
        <div className={styles.arenaObjectionsTeaser}>
          <p className={styles.arenaObjectionsTitle}>Top shopper objections</p>
          <ul className={styles.arenaObjectionsUl}>
            {topRejectSnippets.map((s, i) => (
              <li key={i} className={styles.arenaObjectionsLi}>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
      {latestRunning && !activeBatchSim ? (
        <WhatIfRunningPane
          labPhase1={labPhase1}
          baselinePhase1={baselinePhase1}
          elapsed={deltaElapsed}
          stale={deltaStale}
        />
      ) : hasLab ? (
        <>
          {floorMasking && !activeBatchSim && (
            <div style={{ marginBottom: 12 }}>
              <Banner tone="warning" title="Score floor active — raw votes shown">
                <Text as="p" variant="bodySm">
                  Engine applies a min score of 60. Raw panel: {rawBuyCount(activeLabPhase1)}/{rawAgentTotal(activeLabPhase1)} BUY vs. {rawBuyCount(baselinePhase1)}/{rawAgentTotal(baselinePhase1)} BUY baseline. The meter shows vote % — run more What-Ifs or use Price Optimizer to find the best configuration.
                </Text>
              </Banner>
            </div>
          )}
          <Meter
            label={floorMasking && !activeBatchSim ? "Raw buy-vote % (score floored)" : "Modeled purchase intent (panel)"}
            value={meterDisplayValue}
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
          <p className={styles.simIdleTitle}>Nothing to compare yet</p>
          <p className={styles.simIdleText}>
            Go to <strong>Build Test</strong>, make one change, then tap <strong>Run simulation in lab</strong> — results
            land here next to your live PDP readout.
          </p>
        </div>
      )}
    </>
  );

  const goPickChangeStep = () => {
    setWizardStep(1);
    requestAnimationFrame(() => {
      document.getElementById("experiment-dashboard")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const WIZARD_STEPS = [
    { id: "understand", title: "Discover", sub: "Friction on your PDP", stepNum: "1" },
    { id: "change", title: "Build test", sub: "Pick one change", stepNum: "2" },
    { id: "compare", title: "Run sim", sub: "Compare results", stepNum: "3" },
  ] as const;

  let overviewPrimary: string;
  if (activeInsight?.trim()) {
    overviewPrimary = activeInsight.trim();
  } else if (bestSweepForBanner && !activeBatchSim) {
    overviewPrimary = bannerFloorMasking
      ? `Price scan finished — best chip $${bestSweepForBanner.price.toFixed(2)}. Headline scores may sit on a trust floor; open Simulation to compare raw BUY votes.`
      : `Price scan finished — best modeled score ${bestSweepForBanner.score}/100 at $${bestSweepForBanner.price.toFixed(2)}.`;
  } else {
    overviewPrimary = `${rec.emoji} ${rec.text}`;
  }

  const overviewSecondary =
    hasLab && activeLabScore != null
      ? `Baseline ${baselineScore}/100 · Latest scenario ${activeLabScore}/100${
          activeLabScore !== baselineScore && !floorMasking
            ? ` (${activeLabScore - baselineScore > 0 ? "+" : ""}${activeLabScore - baselineScore} pts)`
            : floorMasking && activeLabRawPct != null && baselineRawPct != null
              ? ` · Raw buy-votes ${baselineRawPct}% → ${activeLabRawPct}%`
              : ""
        }`
      : `Baseline ${baselineScore}/100. Next: model one change and compare.`;

  return (
    <div className={styles.labRoot}>
      <div className={styles.novaFrame}>
        <nav className={styles.novaRail} aria-label="What-If workspace">
          <div className={styles.novaRailBrand}>
            <div className={styles.novaRailMark} aria-hidden />
            <div className={styles.novaRailTitles}>
              <p className={styles.novaRailTitle}>What-If</p>
              <p className={styles.novaRailSubtitle}>Lab</p>
            </div>
          </div>
          {WIZARD_STEPS.map((step, i) => (
            <button
              key={step.id}
              type="button"
              className={styles.novaNavBtn}
              aria-current={wizardStep === i ? "step" : undefined}
              data-state={wizardStep === i ? "current" : wizardStep > i ? "done" : "todo"}
              onClick={() => setWizardStep(i as 0 | 1 | 2)}
            >
              <span className={styles.novaNavGlyph} aria-hidden>
                {wizardStep > i ? "✓" : step.stepNum}
              </span>
              <span className={styles.novaNavText}>
                <span className={styles.novaNavLabel}>{step.title}</span>
                <span className={styles.novaNavHint}>{step.sub}</span>
              </span>
            </button>
          ))}
          <div className={styles.novaRailFoot}>
            <p>One lever per run keeps the story honest — same panel, cleaner deltas.</p>
          </div>
        </nav>

        <main className={styles.novaMain}>
      {wizardStep === 0 && (
        <section className={styles.dashDiscover} aria-labelledby="dash-signals-title">
          <div className={styles.dashPageHead}>
            <div>
              <p className={styles.dashEyebrow}>Listing analytics snapshot</p>
              <h1 id="dash-signals-title" className={styles.dashPageTitle}>
                How shoppers read this PDP right now
              </h1>
            </div>
            <p className={styles.dashPageSub}>
              Same synthetic panel for every simulation — when metrics move, it reflects your test, not a new audience.
            </p>
          </div>

          <div className={styles.dashKpiBoard} role="list">
            <Tooltip content="Customer confidence from your baseline scan (0–100).">
              <div className={styles.dashKpiCard} role="listitem">
                <span className={`${styles.dashKpiIcon} ${styles.dashKpiIconBlue}`} aria-hidden>
                  ◎
                </span>
                <span className={styles.dashKpiLabel}>Confidence index</span>
                <span className={styles.dashKpiValue}>{baselineScore}</span>
                <span className={styles.dashKpiTrend}>Baseline scan</span>
              </div>
            </Tooltip>
            {(
              [
                {
                  key: "price" as const,
                  label: "Price pressure",
                  pct: priceDropoutPct,
                  icon: "◇",
                  iconMod: styles.dashKpiIconAmber,
                },
                {
                  key: "logistics" as const,
                  label: "Shipping / returns",
                  pct: logisticsDropoutPct,
                  icon: "◇",
                  iconMod: styles.dashKpiIconViolet,
                },
                {
                  key: "trust" as const,
                  label: "Trust gap",
                  pct: trustDropoutPct,
                  icon: "◇",
                  iconMod: styles.dashKpiIconRose,
                },
              ] as const
            ).map(({ key, label, pct, icon, iconMod }) => (
              <Tooltip key={key} content={FRICTION_TOOLTIPS[key]}>
                <div className={styles.dashKpiCard} role="listitem">
                  <span className={`${styles.dashKpiIcon} ${iconMod}`} aria-hidden>
                    {icon}
                  </span>
                  <span className={styles.dashKpiLabel}>{label}</span>
                  <span className={styles.dashKpiValue}>{Math.round(pct)}%</span>
                  <span
                    className={styles.dashKpiTrend}
                    data-negative={pct >= 35 ? "true" : undefined}
                    data-positive={pct < 15 ? "true" : undefined}
                  >
                    {pct >= 35 ? "High friction" : pct >= 15 ? "Worth watching" : "Lower pressure"}
                  </span>
                  <div className={styles.dashKpiBar} aria-hidden>
                    <div className={styles.dashKpiBarFill} style={{ width: `${Math.min(100, Math.round(pct))}%` }} />
                  </div>
                </div>
              </Tooltip>
            ))}
          </div>

          <div className={styles.dashInsightCard}>
            <p className={styles.dashInsightTitle}>Summary</p>
            <p className={styles.dashInsightLead}>{overviewPrimary}</p>
            <p className={styles.dashInsightMeta}>{overviewSecondary}</p>
          </div>

          <p className={styles.dashSectionLabel}>Priority queue · fix highest first</p>
          <ol className={styles.novaQueue}>
            {insightRows.map((row, idx) => (
              <li key={row.key} className={styles.novaQueueItem}>
                <div className={styles.novaQueueStripe} data-sev={row.sev} aria-hidden />
                <div className={styles.novaQueueBody}>
                  <span className={styles.novaQueueRank}>{idx + 1}</span>
                  <div className={styles.novaQueueMid}>
                    <span className={`${styles.sevBadge} ${SEV_BADGE_CLS[row.sev]}`}>{SEV_LABEL[row.sev]}</span>
                    <span className={styles.insightsPriorityLabel}>{row.label}</span>
                  </div>
                  <span className={styles.novaQueuePct}>{Math.round(row.pct)}%</span>
                </div>
              </li>
            ))}
          </ol>

          <div className={styles.novaDeepDive}>
            <Button
              disclosure={frictionDetailOpen ? "up" : "down"}
              variant="plain"
              onClick={() => setFrictionDetailOpen((o) => !o)}
              aria-expanded={frictionDetailOpen}
              aria-controls="lab-friction-full"
            >
              {frictionDetailOpen ? "Hide analyst notes" : "Analyst notes · friction deep-dive"}
            </Button>
            <Collapsible
              open={frictionDetailOpen}
              id="lab-friction-full"
              transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
            >
              <Box paddingBlockStart="400">
                <BlockStack gap="400">
                  <FrictionCards
                    pricePct={priceDropoutPct}
                    logisticsPct={logisticsDropoutPct}
                    trustPct={trustDropoutPct}
                    trustAudit={trustAudit}
                  />
                  <div className={styles.listingSignalsBox}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      Listing signals
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Shipping: {trustAudit?.hasShippingInfo ? "Detected" : "Unclear"} · Returns:{" "}
                      {trustAudit?.hasReturnPolicy ? "Present" : "Weak"} · Contact:{" "}
                      {trustAudit?.hasContact ? "Present" : "Missing"}
                    </Text>
                  </div>
                </BlockStack>
              </Box>
            </Collapsible>
          </div>

          <div className={styles.novaActions}>
            {isPro ? (
              <Button variant="primary" size="large" fullWidth onClick={() => setWizardStep(1)}>
                Continue to Build test
              </Button>
            ) : (
              <Button variant="primary" size="large" fullWidth url="/app/billing">
                Unlock Build test
              </Button>
            )}
            <div className={styles.novaActionsRow}>
              {isPro && (hasLab || activeBatchSim) && (
                <Button variant="plain" onClick={() => setWizardStep(2)}>
                  Skip to arena
                </Button>
              )}
              {isPro && latestCompletedId && hasLab && !latestRunning && !activeBatchSim && (
                <Button variant="plain" url={`/app/results/${latestCompletedId}`}>
                  Export report
                </Button>
              )}
            </div>
          </div>
        </section>
      )}

      {wizardStep === 1 && (
        <div className={`${styles.labTabPanelExperiments} ${styles.novaStudio}`}>
          <div className={styles.labBuildShell} id="experiment-dashboard" tabIndex={-1}>
            <div className={styles.refineSplit}>
              <div className={styles.refineContext}>
                <p className={styles.refineKicker}>What-If Lab</p>
                <h2 className={styles.refineHeadline}>Test one PDP change — safely.</h2>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Tune a single variable in the workspace. We simulate panel response; your storefront stays untouched
                  until you publish.
                </Text>
                <div className={styles.refineProductRow}>
                  <div className={styles.refineProductBadge} aria-hidden>
                    {(productTitle || "P").trim().charAt(0).toUpperCase() || "P"}
                  </div>
                  <div className={styles.refineProductCopy}>
                    <span className={styles.refineProductName}>{productTitle}</span>
                    <span className={styles.refineProductMeta}>
                      List ${basePrice.toFixed(2)} · Today ~{baselineShippingDays}d delivery
                    </span>
                  </div>
                </div>
              </div>

              <div className={styles.refineSimulatorCol}>
                <div className={styles.refineSimCard}>
                  {!isPro ? (
                    <CalloutCard
                      title="Unlock the simulator"
                      illustration="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be2a489e0be08b4f9d7a4e5ad25de5b84974268e8cbbd17af_small.png"
                      primaryAction={{ content: "Upgrade to Pro", url: "/app/billing" }}
                    >
                      <Text as="p" variant="bodyMd">
                        Pro runs price, shipping, copy, and trust scenarios with side-by-side results.
                      </Text>
                    </CalloutCard>
                  ) : (
                    <>
                      <p className={styles.refineSimKicker}>Simulation workspace</p>
                      <h3 className={styles.refineSimTitle}>Adjust your test</h3>
                      <p className={styles.refineSimSub}>
                        One lever at a time — the preview below updates as you go. No listing photos required.
                      </p>
                      {optimizerNavHint && (
                        <div className={styles.optimizerNavHintWrap}>
                          <Banner tone="info" onDismiss={() => setOptimizerNavHint(null)}>
                            <Text as="p" variant="bodySm">
                              {optimizerNavHint}
                            </Text>
                          </Banner>
                        </div>
                      )}

                      {/* "What to do" guide — replaces the silent disabled state on the Run button.
                          Always tells the merchant exactly what action enables the simulation. */}
                      {(() => {
                        if (latestRunning) {
                          return (
                            <div className={`${styles.labGuide} ${styles.labGuideRunning}`}>
                              <span className={styles.labGuideIcon} aria-hidden>⏳</span>
                              <span className={styles.labGuideBody}>
                                <span className={styles.labGuideTitle}>Simulation running…</span>
                                <span className={styles.labGuideSub}>Open <strong>Run sim</strong> on the right to watch live votes as panelists vote.</span>
                              </span>
                            </div>
                          );
                        }
                        if (hasBuildChange) {
                          return (
                            <div className={`${styles.labGuide} ${styles.labGuideReady}`}>
                              <span className={styles.labGuideIcon} aria-hidden>✓</span>
                              <span className={styles.labGuideBody}>
                                <span className={styles.labGuideTitle}>Ready to run</span>
                                <span className={styles.labGuideSub}>
                                  Click <strong>▶ Run simulation</strong> below — your panel will compare this test to your baseline.
                                </span>
                              </span>
                            </div>
                          );
                        }
                        return (
                          <div className={`${styles.labGuide} ${styles.labGuideWaiting}`}>
                            <span className={styles.labGuideIcon} aria-hidden>1</span>
                            <span className={styles.labGuideBody}>
                              <span className={styles.labGuideTitle}>Pick what you want to test, then change one value</span>
                              <span className={styles.labGuideSub}>
                                Use the tabs below (Price · Shipping · % Off · Copy · Trust · Ideas) and adjust at least one input. The Run button will light up the moment you do.
                              </span>
                            </span>
                          </div>
                        );
                      })()}

                      <div className={styles.refineMetricStrip}>
                        <div className={styles.refineMetricCell}>
                          <span className={styles.refineMetricLabel}>List price</span>
                          <span className={styles.refineMetricVal}>${basePrice.toFixed(2)}</span>
                        </div>
                        <div className={`${styles.refineMetricCell} ${styles.refineMetricCellHero}`}>
                          <span className={styles.refineMetricLabel}>Test price</span>
                          <span className={styles.refineMetricHero}>${price.toFixed(2)}</span>
                        </div>
                        <div className={styles.refineMetricCell}>
                          <span className={styles.refineMetricLabel}>Ship (test)</span>
                          <span className={styles.refineMetricVal}>{shippingDays}d</span>
                        </div>
                      </div>

                      <div className={styles.refineSegWrap} role="tablist" aria-label="Test type">
                        {(
                          [
                            { id: "price" as const, label: "Price" },
                            { id: "shipping" as const, label: "Shipping" },
                            { id: "discount" as const, label: "% Off" },
                            { id: "description" as const, label: "Copy" },
                            { id: "trust" as const, label: "Trust" },
                            ...(experimentCards.length ? [{ id: "suggestion" as const, label: "Ideas" }] : []),
                          ] as const
                        ).map((seg) => (
                          <button
                            key={seg.id}
                            type="button"
                            role="tab"
                            aria-selected={buildFocus === seg.id}
                            className={styles.refineSegBtn}
                            data-active={buildFocus === seg.id ? "true" : undefined}
                            onClick={() => {
                              setBuildFocus(seg.id);
                              if (seg.id !== "suggestion") {
                                clearExperimentSelection();
                              }
                              if (seg.id === "trust") {
                                setTrustAddon((t) => t || TRUST_LAB_DEFAULT_HYPOTHESIS);
                              }
                            }}
                          >
                            {seg.label}
                          </button>
                        ))}
                      </div>

                    {buildFocus === "price" && (
                      <div className={styles.labControlSurface}>
                        <h3 className={styles.labControlHeading}>Price</h3>
                        <p className={styles.labControlHint}>
                          Lower prices often lift purchases but squeeze margin — pair with trust tests before you commit.
                        </p>
                        <div className={styles.labPresetRow}>
                          {([5, 10, 15, 20] as const).map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              className={styles.labPresetChip}
                              onClick={() => applyDiscountPct(pct)}
                            >
                              −{pct}%
                            </button>
                          ))}
                          <button type="button" className={styles.labPresetChip} onClick={() => setPrice(basePrice)}>
                            List price
                          </button>
                        </div>
                        <div className={styles.labSliderBlock}>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            ${price.toFixed(2)} <span className={styles.labLiveTag}>live preview updates →</span>
                          </Text>
                          <div className={styles.refineSliderWrap}>
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
                        </div>
                      </div>
                    )}

                    {buildFocus === "shipping" && (
                      <div className={styles.labControlSurface}>
                        <h3 className={styles.labControlHeading}>Shipping time</h3>
                        <p className={styles.labControlHint}>
                          Shoppers weigh speed against trust — if you can&apos;t ship this fast, don&apos;t over-promise in
                          real life.
                        </p>
                        <div className={styles.labPresetRow}>
                          {(
                            [
                              { d: 2, label: "2d express" },
                              { d: 5, label: "5d standard" },
                              { d: 7, label: "7d" },
                              { d: 10, label: "10d" },
                              { d: 14, label: "14d" },
                            ] as const
                          ).map(({ d, label }) => (
                            <button
                              key={d}
                              type="button"
                              className={styles.labPresetChip}
                              data-active={shippingDays === d ? "true" : undefined}
                              onClick={() => setShippingDays(d)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className={styles.labSliderBlock}>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            {shippingDays} days to door
                          </Text>
                          <div className={styles.refineSliderWrap}>
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
                        </div>
                      </div>
                    )}

                    {buildFocus === "discount" && (
                      <div className={styles.labControlSurface}>
                        <h3 className={styles.labControlHeading}>Discount %</h3>
                        <p className={styles.labControlHint}>
                          We translate this into a test price from your list price (${basePrice.toFixed(2)}).
                        </p>
                        <div className={styles.labPresetRowLarge}>
                          {([5, 10, 15, 20] as const).map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              className={styles.labPresetTile}
                              onClick={() => applyDiscountPct(pct)}
                            >
                              {pct}%
                              <span>off</span>
                            </button>
                          ))}
                        </div>
                        <div className={styles.labCustomRow}>
                          <InlineStack gap="200" blockAlign="end" wrap={false}>
                            <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                              <TextField
                                label="Custom % off"
                                type="text"
                                value={customDiscountPct}
                                onChange={(v) => setCustomDiscountPct(v)}
                                autoComplete="off"
                                placeholder="e.g. 12"
                              />
                            </div>
                            <Button onClick={applyCustomDiscountFromInput} variant="primary">
                              Apply
                            </Button>
                          </InlineStack>
                        </div>
                        <p className={styles.labControlMeta}>Test price right now: ${price.toFixed(2)}</p>
                      </div>
                    )}

                    {buildFocus === "description" && (
                      <div className={styles.labControlSurface}>
                        <h3 className={styles.labControlHeading}>Description text</h3>
                        <p className={styles.labControlHint}>
                          This is sent to the panel as copy they would see — it does not edit your real product body in
                          Shopify.
                        </p>
                        <TextField
                          label="Copy to test"
                          multiline={4}
                          value={descriptionDraft}
                          onChange={(v) => setDescriptionDraft(v)}
                          autoComplete="off"
                          placeholder="e.g. Free returns within 30 days · 2-year warranty · Ships carbon-neutral"
                          helpText="Try short bullets shoppers can scan in a few seconds."
                        />
                        <div className={styles.labChipSuggestions}>
                          {[
                            "Free returns within 30 days",
                            "2-year warranty included",
                            "Made with recycled materials",
                          ].map((s) => (
                            <button
                              key={s}
                              type="button"
                              className={styles.labTinyChip}
                              onClick={() =>
                                setDescriptionDraft((prev) => (prev ? `${prev} · ${s}` : s))
                              }
                            >
                              + {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {buildFocus === "trust" && (
                      <div className={styles.labControlSurface}>
                        <h3 className={styles.labControlHeading}>Trust & proof</h3>
                        <p className={styles.labControlHint}>
                          Describe what stronger proof would look like on the page — we stress-test that story with the
                          same shopper panel.
                        </p>
                        <TextField
                          label="Trust hypothesis"
                          multiline={5}
                          value={trustAddon}
                          onChange={(v) => setTrustAddon(v)}
                          autoComplete="off"
                          helpText="Edit freely — this is only used for the simulation."
                        />
                      </div>
                    )}

                    {buildFocus === "suggestion" && experimentCards.length > 0 && (
                      <div className={styles.labControlSurface}>
                        <h3 className={styles.labControlHeading}>Team suggestions</h3>
                        <p className={styles.labControlHint}>Pick one card — we&apos;ll attach its hypothesis to your run.</p>
                        <div className={styles.cardsGrid}>
                          {experimentCards.map((card) => {
                            const selected = selectedCardId === card.id;
                            return (
                              <div key={card.id} className={styles.expCard} data-selected={selected}>
                                <h4 className={styles.expCardTitle}>{card.name}</h4>
                                <p className={styles.expCardHyp}>{card.hypothesis}</p>
                                <div style={{ marginTop: 10 }}>
                                  <button
                                    type="button"
                                    className={styles.labCardSelectBtn}
                                    data-selected={selected ? "true" : undefined}
                                    onClick={() => toggleCard(card.id)}
                                  >
                                    {selected ? "Selected" : "Use this test"}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {experimentCards.length >= 2 && (
                          <div style={{ marginTop: 12 }}>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="simulate_all" />
                              <Button variant="plain" size="slim" submit loading={isSubmitting} disabled={!!latestRunning}>
                                Run all suggestion cards (batch)
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

                      <div className={styles.refinePreviewBlock}>
                        <p className={styles.refinePreviewLabel}>Outcome preview</p>
                        <LabPdpPreview
                          compact
                          productTitle={productTitle}
                          productImageUrl={productImageUrl}
                          basePrice={basePrice}
                          displayPrice={price}
                          shippingDays={shippingDays}
                          baselineShippingDays={baselineShippingDays}
                          descriptionSnippet={descriptionDraft}
                        />
                      </div>

                      {/* Sticky Brand Studio dock — always visible at the bottom of
                          the simulator column so the Run button never gets buried by
                          the form's vertical sprawl. */}
                      <div className={styles.labStickyDock}>
                        <div className={styles.labStickyDockText}>
                          <span className={styles.labStickyDockTitle}>
                            {latestRunning
                              ? "Simulation in progress"
                              : hasBuildChange
                                ? "Ready — your test is set"
                                : "Change a value to enable"}
                          </span>
                          <span className={styles.labStickyDockSub}>
                            {latestRunning
                              ? "Watch your panel vote in real time on the Run sim tab."
                              : hasBuildChange
                                ? "5 panelists will compare this test against your baseline."
                                : "Pick a tab above and move the slider, type into a field, or tap a chip."}
                          </span>
                        </div>
                        <button
                          type="button"
                          className={styles.labStickyDockGhost}
                          onClick={() => setWizardStep(2)}
                        >
                          Open comparison view
                        </button>
                        {/* Use regular <Form> (not fetcher) so the action's
                            `throw redirect()` actually navigates the page. With
                            fetcher.Form the redirect is followed silently in
                            the background and the user perceives nothing
                            happening, even though the loader revalidates. */}
                        <Form method="post">
                          <input type="hidden" name="intent" value="run_whatif" />
                          <input type="hidden" name="activeExperiment" value={activeExperimentPayload} />
                          <input type="hidden" name="price" value={price} />
                          <input type="hidden" name="shippingDays" value={shippingDays} />
                          <button
                            type="submit"
                            className={styles.labStickyDockBtn}
                            disabled={!hasBuildChange || !!latestRunning || isSubmittingAny}
                            aria-label={
                              latestRunning
                                ? "Simulation already running"
                                : hasBuildChange
                                  ? "Run the simulation"
                                  : "Change a value first to enable the simulation"
                            }
                          >
                            {isSubmittingAny
                              ? "Starting…"
                              : latestRunning
                                ? "Running…"
                                : hasBuildChange
                                  ? "▶ Run simulation"
                                  : "Locked"}
                          </button>
                        </Form>
                      </div>
                    </>
                  )}

                  <Box paddingBlockStart="300">
                    <Button variant="plain" onClick={() => setWizardStep(0)}>
                      ← Back to Discover
                    </Button>
                  </Box>
                </div>
              </div>
            </div>
          </div>

      {/* Price Optimizer — primary feature, surfaced prominently with a
          Brand Studio dark feature header so it's never missed. */}
      {isPro && (
        <div className={styles.optimizerDisclosureWrap}>
          <div className={styles.priceOptHeroBanner}>
            <div className={styles.priceOptHeroBannerLeft}>
              <span className={styles.priceOptHeroEyebrow}>
                💰 Price Optimizer · Pro feature
              </span>
              <h3 className={styles.priceOptHeroTitle}>
                Find the price your panel actually buys at
              </h3>
              <p className={styles.priceOptHeroDesc}>
                Run three price points at once (-5%, -10%, -15%) and see which beats your baseline
                score. Each scenario uses your live PDP — nothing goes to your storefront.
              </p>
            </div>
            <button
              type="button"
              className={styles.priceOptHeroToggle}
              onClick={() => setPriceOptimizerOpen((o) => !o)}
              aria-expanded={priceOptimizerOpen}
              aria-controls="lab-price-optimizer-panel"
            >
              {priceOptimizerOpen ? "▴ Collapse" : "▾ Expand"}
            </button>
          </div>
          <Collapsible
            open={priceOptimizerOpen}
            id="lab-price-optimizer-panel"
            transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
          >
            <Box paddingBlockStart="300">
              <PriceOptimizerSection
                basePrice={basePrice}
                baselineScore={baselineScore}
                baselinePhase1={baselinePhase1}
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
                onNavigateToExperiments={goPickChangeStep}
                fetcher={fetcher}
              />
            </Box>
          </Collapsible>
        </div>
      )}

      {allSetCompleted && experimentSetDeltas.length > 0 && (
        <div className={`${styles.debateSection} ${styles.labExperimentsBatchInset}`}>
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
                            ({diff > 0 ? "+" : ""}
                            {diff})
                          </span>
                        )}
                      </Text>
                      {d.status === "COMPLETED" && (
                        <Button url={`/app/results/${d.id}`} size="slim" variant="plain">
                          Open report
                        </Button>
                      )}
                    </InlineStack>
                  </InlineStack>
                );
              })}
          </BlockStack>
        </div>
      )}
        </div>
      )}

      {wizardStep === 2 && (
        <div className={styles.novaArena}>
          <div className={styles.novaArenaTop}>
            <div className={styles.novaArenaTitles}>
              <h2 className={styles.novaArenaTitle}>Run simulation</h2>
              <p className={styles.novaArenaLead}>
                Live PDP on the left, your simulated version on the right. Check the lift strip, then skim objections
                before opening the full panel debrief.
              </p>
            </div>
            <Button variant="secondary" onClick={() => setWizardStep(1)}>
              Tweak scenario
            </Button>
          </div>
          <div className={styles.novaAbLegend}>
            <span className={styles.novaAbPill} data-lane="a">
              <strong>A</strong> Control · live PDP
            </span>
            <span className={styles.novaAbPill} data-lane="b">
              <strong>B</strong> Variant · your What-If
            </span>
          </div>
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

          {activeInsight?.trim() && (
              <div className={styles.insightBox} style={{ margin: "0 0 1rem" }}>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Scenario insight
                </Text>
                <Text as="p" variant="bodySm">
                  {activeInsight}
                </Text>
                {!activeBatchSim && latestCompletedId && (
                  <div style={{ marginTop: 10 }}>
                    <Button url={`/app/results/${latestCompletedId}`} size="slim" variant="primary">
                      Open full What-If report
                    </Button>
                  </div>
                )}
              </div>
            )}

      <div className={styles.debateSection}>
        <h3 className={styles.debateTitle}>Panel debrief</h3>
        <p className={styles.debateSub}>
          Phase 2 — how the panel argued. Skim top objections first; open the transcript when you need detail.
        </p>
        {debateItems.length === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            No debate transcript stored for this simulation yet.
          </Text>
        ) : (
          <BlockStack gap="300">
            {topRejectSnippets.length > 0 && (
              <div className={styles.panelGlanceBox}>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Top objections (REJECT)
                </Text>
                <ul className={styles.panelGlanceUl}>
                  {topRejectSnippets.map((s, i) => (
                    <li key={i} className={styles.panelGlanceLi}>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {s}
                      </Text>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Button
              variant="plain"
              disclosure={debateFullOpen ? "up" : "down"}
              onClick={() => setDebateFullOpen((o) => !o)}
            >
              {debateFullOpen ? "Hide full transcript" : "Show full transcript"}
            </Button>
            <Collapsible
              open={debateFullOpen}
              id="lab-debate-collapsible"
              transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
            >
              <div className={styles.bubbleList}>
                {debateItems.map((item, idx) =>
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
                )}
              </div>
            </Collapsible>
          </BlockStack>
        )}
      </div>

      {scenarioHistory.length > 0 && (
        <div className={styles.scenarioHistoryDisclosure}>
          <Button
            disclosure={scenarioHistoryOpen ? "up" : "down"}
            variant="plain"
            onClick={() => setScenarioHistoryOpen((o) => !o)}
            aria-expanded={scenarioHistoryOpen}
            aria-controls="lab-scenario-history-panel"
          >
            {scenarioHistoryOpen
              ? "Hide past What-If runs"
              : `Past What-If runs (${scenarioHistory.length})`}
          </Button>
          <Collapsible
            open={scenarioHistoryOpen}
            id="lab-scenario-history-panel"
            transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
          >
            <section className={styles.labScenarioHistory} aria-label="Scenario history">
              <div className={styles.labScenarioHistoryHead}>
                <h2 className={styles.labScenarioHistoryTitle}>History</h2>
                <p className={styles.labScenarioHistorySub}>
                  Single runs from this baseline. Batch card sets stay in Studio.
                </p>
              </div>
              <ul className={styles.labScenarioHistoryList}>
            {scenarioHistory.map((row) => {
              const created = new Date(row.createdAt);
              const when = new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(created);
              const stalePending =
                row.status === "PENDING" &&
                Date.now() - created.getTime() > 25 * 60 * 1000;
              const scoreCls =
                row.score == null
                  ? ""
                  : row.score >= 70
                    ? styles.shScoreStrong
                    : row.score >= 45
                      ? styles.shScoreMixed
                      : styles.shScoreLow;
              return (
                <li key={row.id} className={styles.labScenarioHistoryRow}>
                  <div className={styles.labScenarioHistoryMain}>
                    <span className={styles.labScenarioHistoryLine}>
                      {row.price != null ? `$${Number(row.price).toFixed(2)}` : "Original price"}
                      {row.shippingDays != null ? ` · ${row.shippingDays}d shipping` : ""}
                    </span>
                    <span className={styles.labScenarioHistoryMeta}>
                      {when}
                      {stalePending
                        ? " · Still pending — refresh or re-run from Studio."
                        : ""}
                    </span>
                  </div>
                  <div className={styles.labScenarioHistoryActions}>
                    <Badge
                      tone={
                        row.status === "COMPLETED"
                          ? "success"
                          : row.status === "FAILED"
                            ? "critical"
                            : "info"
                      }
                    >
                      {row.status}
                    </Badge>
                    {row.score != null && (
                      <span className={`${styles.labScenarioHistoryScore} ${scoreCls}`}>
                        {row.score}/100
                      </span>
                    )}
                    {row.status === "COMPLETED" && (
                      <Button url={`/app/results/${row.id}`} size="slim" variant="plain">
                        Open report
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
              </ul>
            </section>
          </Collapsible>
        </div>
      )}

        </div>
      )}

        </main>
      </div>

      <div className={styles.labFooterBar}>
        <Button url={`/app/results/${simulationId}`} variant="plain" size="slim">
          ← Back to main results for this product
        </Button>
      </div>
    </div>
  );
}
