import type { FetcherWithComponents } from "@remix-run/react";

type SandboxActionData = { error?: string } | undefined;
import { useState } from "react";
import { Button, Banner, Text, BlockStack, InlineStack, RangeSlider, CalloutCard } from "@shopify/polaris";
import { ConfidenceGauge } from "../ConfidenceGauge";
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
const FRICTION_META: Record<"price" | "logistics" | "trust", {
  icon: string;
  label: string;
  bullets: [string, string];
  impact: string;
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
    impact: "Buyers won't commit without knowing what happens if it doesn't work out.",
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
        const snippet = base.reasoning.slice(0, 88);
        const hasMore = base.reasoning.length > 88;
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
            {base.reasoning && (
              <details className={styles.pcDetails}>
                <summary className={styles.pcSummary}>
                  <span className={styles.pcSnippet}>
                    &ldquo;{snippet}{hasMore ? "…" : ""}&rdquo;
                  </span>
                  <span className={styles.pcExpandHint}>Expand</span>
                </summary>
                <p className={styles.pcFull}>&ldquo;{base.reasoning}&rdquo;</p>
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
}: {
  pricePct: number;
  logisticsPct: number;
  trustPct: number;
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
              {meta.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
            <div className={styles.fcDivider} />
            <p className={styles.fcImpact}>
              <strong>Impact: </strong>{meta.impact}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ── Price Optimizer ───────────────────────────────────────────────────────────
function PriceOptimizerSection({
  basePrice,
  baselineScore,
  priceBatchResults,
  batchRunning,
  isSubmitting,
  selectedChipId,
  onChipClick,
  fetcher,
}: {
  basePrice: number;
  baselineScore: number;
  priceBatchResults: PriceBatchResult[];
  batchRunning: boolean;
  isSubmitting: boolean;
  selectedChipId: string | null;
  onChipClick: (r: PriceBatchResult | null) => void;
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

  return (
    <div className={styles.priceOptBand}>
      <div className={styles.priceOptHeader}>
        <div>
          <div className={styles.priceOptTitleRow}>
            <span className={styles.priceOptIcon}>⚗️</span>
            <span className={styles.priceOptLabel}>Price Optimizer</span>
            {hasBatch && (
              <span className={styles.priceOptTag}>
                {batchRunning ? "Running…" : "3 runs complete"}
              </span>
            )}
          </div>
          {!hasBatch && (
            <p className={styles.priceOptSubtitle}>
              Runs −5%, −10%, −15% in parallel · uses cached DNA · no re-extraction
            </p>
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

      {hasBatch && (
        <div className={styles.priceChipRow}>
          {sortedChips.map((r) => {
            const isPending = r.status === "PENDING" || r.status === "RUNNING";
            const isDone = r.status === "COMPLETED" && r.score != null;
            const isFailed = r.status === "FAILED";
            const isRec = recommended?.id === r.id;
            const scoreDelta = isDone ? r.score! - baselineScore : null;
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
                  isRec && !isSelected ? styles.priceChipRec : "",
                  isDone ? styles.priceChipDone : "",
                ].join(" ")}
                onClick={() => {
                  if (!isDone) return;
                  onChipClick(isSelected ? null : r);
                }}
                disabled={!isDone && !isPending}
                aria-pressed={isSelected}
              >
                {isRec && (
                  <span className={styles.recBadge}>★ Best ROI</span>
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
                    {scoreDelta !== null && (
                      <div
                        className={`${styles.chipDeltaRow} ${
                          scoreDelta > 0
                            ? styles.chipDeltaPos
                            : scoreDelta < 0
                              ? styles.chipDeltaNeg
                              : styles.chipDeltaFlat
                        }`}
                      >
                        {scoreDelta > 0 ? "▲" : scoreDelta < 0 ? "▼" : "—"}
                        {" "}
                        {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta} pts
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
      )}
    </div>
  );
}

type Props = {
  simulationId: string;
  baselineScore: number;
  baselinePhase1: AgentLogLite[];
  labPhase1: AgentLogLite[];
  baselinePhase2: AgentLogLite[];
  labPhase2: AgentLogLite[];
  priceDropoutPct: number;
  logisticsDropoutPct: number;
  trustDropoutPct: number;
  experimentCards: ExperimentCard[];
  isPro: boolean;
  basePrice: number;
  price: number;
  setPrice: (n: number) => void;
  shippingDays: number;
  setShippingDays: (n: number) => void;
  selectedCardId: string | null;
  toggleCard: (id: string) => void;
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
  baselineScore,
  baselinePhase1,
  labPhase1,
  baselinePhase2,
  labPhase2,
  priceDropoutPct,
  logisticsDropoutPct,
  trustDropoutPct,
  experimentCards,
  isPro,
  basePrice,
  price,
  setPrice,
  shippingDays,
  setShippingDays,
  selectedCardId,
  toggleCard,
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
      />
      <div style={{ marginTop: 16 }}>
        <p className={styles.panelSectionLabel}>First-scan panel votes — Phase 1</p>
        <PersonaRows baselineMap={baselineMap} labMap={new Map()} />
      </div>
    </>
  );

  const simulationPane = (
    <>
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
      <div className={styles.labSticky}>
        <p className={styles.labStickyTitle}>Experiment dashboard</p>
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
          priceBatchResults={priceBatchResults}
          batchRunning={batchRunning}
          isSubmitting={isSubmitting}
          selectedChipId={selectedBatchSim?.id ?? null}
          onChipClick={setSelectedBatchSim}
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
                    <p className={styles.bubbleQuote}>&ldquo;{item.log.reasoning}&rdquo;</p>
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
