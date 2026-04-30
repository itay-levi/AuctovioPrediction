import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { Page, Banner, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStore, getMtBudgetStatus, MT_LIMITS, SIM_LIMITS } from "../services/store.server";
import { getRecentSimulations, expireStuckSimulations } from "../services/simulation.server";
import styles from "../styles/dashboard.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [store, budget] = await Promise.all([
    getStore(shopDomain),
    getMtBudgetStatus(shopDomain),
  ]);
  if (store) await expireStuckSimulations(store.id);
  const recentSims = store ? await getRecentSimulations(store.id, 5) : [];

  const tier = (budget?.tier ?? "FREE") as keyof typeof MT_LIMITS;
  const url = new URL(request.url);
  return {
    shopDomain,
    store,
    budget,
    recentSims,
    mtLimit: MT_LIMITS[tier],
    simLimit: SIM_LIMITS[tier],
    isDev: process.env.NODE_ENV === "development",
    justUpgraded: url.searchParams.get("upgraded") === "1",
  };
};

// ── Helpers ────────────────────────────────────────────────────────────────

function scoreLabel(score: number): string {
  if (score >= 70) return "Strong";
  if (score >= 45) return "Mixed";
  return "Needs Work";
}

function scorePillClass(score: number): string {
  if (score >= 70) return styles.scoreStrong;
  if (score >= 45) return styles.scoreMixed;
  return styles.scoreWeak;
}

function budgetProgressClass(pct: number): string {
  if (pct >= 80) return styles.progressRed;
  if (pct >= 60) return styles.progressAmber;
  return styles.progressBlue;
}

function formatDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── StoreHealth panel ──────────────────────────────────────────────────────

function StoreHealth({
  avgScore,
  totalAnalyses,
  mtPct,
  tierLabel,
}: {
  avgScore: number | null;
  totalAnalyses: number;
  mtPct: number;
  tierLabel: string;
}) {
  const score = avgScore ?? 0;
  const color = avgScore == null ? "#E2E8F0"
    : score >= 70 ? "#16A34A"
    : score >= 45 ? "#D97706"
    : "#DC2626";
  const ringBg = avgScore != null
    ? `conic-gradient(${color} 0% ${score}%, #E2E8F0 ${score}% 100%)`
    : "conic-gradient(#E2E8F0 0% 100%)";

  const healthLabel = avgScore == null ? "Getting started"
    : score >= 70 ? "Excellent"
    : score >= 45 ? "Good"
    : "Needs Work";

  const items: { label: string; done: boolean; value?: string }[] = [
    { label: "Store connected", done: true },
    { label: "Analyses run", done: totalAnalyses > 0, value: String(totalAnalyses) },
    { label: "Budget available", done: mtPct < 80, value: `${Math.max(0, 100 - mtPct)}%` },
    { label: "Avg score", done: avgScore != null && avgScore >= 45, value: avgScore != null ? `${avgScore}/100` : "—" },
    { label: "Plan", done: true, value: tierLabel },
  ];

  return (
    <div className={styles.healthCard}>
      <div className={styles.healthTop}>
        <div className={styles.healthRing} style={{ background: ringBg }}>
          <div className={styles.healthRingInner}>
            <span className={styles.healthRingNum}>{avgScore ?? "—"}</span>
            {avgScore != null && <span className={styles.healthRingLabel}>/ 100</span>}
          </div>
        </div>
        <div className={styles.healthMeta}>
          <p className={styles.healthTitle}>Store Health</p>
          <p className={styles.healthSubLabel}>{healthLabel}</p>
        </div>
      </div>
      <div className={styles.healthList}>
        {items.map((item) => (
          <div key={item.label} className={styles.healthRow}>
            <span className={item.done ? styles.healthDone : styles.healthTodo}>
              {item.done ? "✓" : ""}
            </span>
            <span className={styles.healthRowLabel}>{item.label}</span>
            {item.value !== undefined && (
              <span className={styles.healthRowValue}>{item.value}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Score ring (hero) ──────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = pct >= 70 ? "#16A34A" : pct >= 45 ? "#D97706" : "#DC2626";
  return (
    <div
      className={styles.heroScoreRing}
      style={{ background: `conic-gradient(${color} 0% ${pct}%, rgba(255,255,255,0.15) ${pct}% 100%)` }}
    >
      <div className={styles.heroScoreRingInner}>
        <span className={styles.heroScoreNum}>{score}</span>
        <span className={styles.heroScoreSub}>{scoreLabel(score)}</span>
      </div>
    </div>
  );
}

// ── Analysis row (returning users) ─────────────────────────────────────────

function AnalysisRow({ sim }: {
  sim: {
    id: string;
    status: string;
    score: number | null;
    createdAt: Date | string;
    productUrl: string;
    productJson: unknown;
  };
}) {
  const productJson = sim.productJson as {
    title?: string;
    images?: { src?: string }[];
  } | null;
  const title = productJson?.title ?? sim.productUrl.split("/").pop() ?? sim.productUrl;
  const imgSrc = productJson?.images?.[0]?.src;
  const truncTitle = title.length > 44 ? title.slice(0, 44) + "…" : title;
  const isFailed  = sim.status === "FAILED";
  const isDone    = sim.status === "COMPLETED";
  const isLive    = sim.status === "RUNNING" || sim.status === "PENDING";

  let scorePill: React.ReactNode;
  if (isFailed) {
    scorePill = <span className={`${styles.scorePill} ${styles.scoreFailed}`}>Failed</span>;
  } else if (isDone && sim.score != null) {
    scorePill = (
      <span className={`${styles.scorePill} ${scorePillClass(sim.score)}`}>
        {sim.score}/100 · {scoreLabel(sim.score)}
      </span>
    );
  } else if (isLive) {
    scorePill = <span className={`${styles.scorePill} ${styles.scorePending}`}>● Live</span>;
  } else {
    scorePill = <span className={`${styles.scorePill} ${styles.scoreFailed}`}>{sim.status}</span>;
  }

  return (
    <div className={styles.analysisItem}>
      <div className={styles.productThumbWrap}>
        {imgSrc ? (
          <img src={imgSrc} alt="" className={styles.productThumb} />
        ) : (
          <div className={`${styles.productThumbPlaceholder} ${isFailed ? styles.productThumbFailed : ""}`}>
            {isFailed ? "✕" : title.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      <div className={styles.analysisInfo}>
        <p className={styles.analysisTitle}>{truncTitle}</p>
        <div className={styles.analysisMeta}>
          <span>{formatDate(sim.createdAt)}</span>
          <span className={styles.metaDot} />
          <span>{sim.status.charAt(0) + sim.status.slice(1).toLowerCase()}</span>
        </div>
      </div>

      <div className={styles.analysisRight}>
        {scorePill}
        {(isDone || isLive) && (
          <Link to={`/app/results/${sim.id}`} className={styles.btnView}>
            {isDone ? "View Report" : "Watch Live"}
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function Dashboard() {
  const { store, budget, recentSims, mtLimit, simLimit, isDev, justUpgraded } = useLoaderData<typeof loader>();

  const tierLabel = budget?.tier ?? "FREE";
  const mtUsed    = budget?.used ?? 0;
  const mtPct     = Math.min(100, Math.round((mtUsed / mtLimit) * 100));
  const isFirstTime = recentSims.length === 0;

  const completedSims = recentSims.filter((s) => s.status === "COMPLETED" && s.score != null);
  const avgScore = completedSims.length > 0
    ? Math.round(completedSims.reduce((sum, s) => sum + (s.score ?? 0), 0) / completedSims.length)
    : null;
  const successRate = recentSims.length > 0
    ? Math.round((completedSims.length / recentSims.length) * 100)
    : null;

  const tierBadgeClass = tierLabel === "ENTERPRISE" ? styles.tierEnterprise
    : tierLabel === "PRO" ? styles.tierPro : styles.tierFree;
  const agentCount = tierLabel === "ENTERPRISE" ? "50 agents" : tierLabel === "PRO" ? "25 agents" : "5 agents";
  const weeklyScan = tierLabel === "FREE" ? "1 product" : "All products";

  const heroScore = avgScore ?? completedSims[0]?.score ?? 68;

  // Step card states for first-time users
  const step1Done = true; // store is always connected by definition
  const step2Done = recentSims.length > 0;
  const step3Done = completedSims.length > 0;

  return (
    <Page>
      <TitleBar title="CustomerPanel AI" />
      <div className={styles.root}>

        {/* ── Upgrade success ── */}
        {justUpgraded && (
          <Banner tone="success" title="You're on the new plan!">
            <Text as="p" variant="bodyMd">
              Your subscription is active. All Pro features are now unlocked — run your first advanced analysis below.
            </Text>
          </Banner>
        )}

        {/* ── Budget warning ── */}
        {mtPct >= 80 && !isDev && (
          <div className={`${styles.budgetWarning} ${mtPct >= 100 ? styles.budgetWarningCritical : ""}`}>
            <span className={styles.budgetWarningIcon}>{mtPct >= 100 ? "🚨" : "⚠️"}</span>
            <span>
              {mtPct >= 100
                ? "Monthly analysis budget exhausted. Upgrade your plan to continue running analyses."
                : `You've used ${mtPct}% of your monthly budget. ${100 - mtPct}% remaining.`}
            </span>
          </div>
        )}

        {/* ── Hero ── */}
        {isFirstTime ? (
          /* First-time: full hero */
          <div className={styles.hero}>
            <div className={styles.heroContent}>
              <span className={styles.heroEyebrow}>🤖 AI Customer Panel</span>
              <h1 className={styles.heroHeadline}>
                Understand Why Customers<br />Buy or Leave
              </h1>
              <p className={styles.heroSub}>
                Run instant 5-agent AI customer panels that reveal real friction points
                and clear actions to improve your Shopify product pages.
              </p>
              <div className={styles.heroActions}>
                <Link to="/app/simulate" className={styles.btnHeroPrimary}>
                  ▶ Run Your First Analysis
                </Link>
              </div>
            </div>
          </div>
        ) : (
          /* Returning: compact hero with score ring */
          <div className={styles.heroCompact}>
            <div className={styles.heroCompactContent}>
              <h1 className={styles.heroCompactTitle}>Your Store Intelligence Dashboard</h1>
              <p className={styles.heroCompactSub}>
                Track analysis results, spot friction patterns, and keep improving your product pages.
              </p>
              <div className={styles.heroCompactActions}>
                <Link to="/app/simulate" className={styles.btnHeroPrimary}>
                  ▶ Run New Analysis
                </Link>
                <Link to="/app/history" className={styles.btnHeroSecondary}>
                  ◎ View All History
                </Link>
              </div>
            </div>
            <div className={styles.heroIllustration}>
              <ScoreRing score={heroScore} />
            </div>
          </div>
        )}

        {/* ── Quick stats ── */}
        <div className={styles.statsRow}>
          <div className={styles.statCard}>
            <div className={`${styles.statCardAccent} ${styles.accentBlue}`} />
            <span className={styles.statIcon}>📊</span>
            <div className={styles.statValue}>{recentSims.length}</div>
            <div className={styles.statLabel}>Analyses this month</div>
          </div>

          <div className={styles.statCard}>
            <div className={`${styles.statCardAccent} ${mtPct >= 80 ? styles.accentAmber : styles.accentBlue}`} />
            <span className={styles.statIcon}>⚡</span>
            <div className={styles.statValue}>{mtUsed}</div>
            <div className={styles.statLabel}>MT used this month</div>
            <div className={styles.statProgressWrap}>
              <div
                className={`${styles.statProgressFill} ${budgetProgressClass(mtPct)}`}
                style={{ width: `${mtPct}%` }}
              />
            </div>
            <div className={styles.statSub}>{mtUsed} / {mtLimit} MT · {mtPct}% used</div>
          </div>

          <div className={styles.statCard}>
            <div className={`${styles.statCardAccent} ${styles.accentGreen}`} />
            <span className={styles.statIcon}>🎯</span>
            <div className={styles.statValue}>
              {avgScore != null ? `${avgScore}/100` : "—"}
            </div>
            <div className={styles.statLabel}>Average score</div>
            {avgScore != null && (
              <div className={styles.statSub}>{scoreLabel(avgScore)} across {completedSims.length} completed</div>
            )}
          </div>

          <div className={styles.statCard}>
            <div className={`${styles.statCardAccent} ${styles.accentPurple}`} />
            <span className={styles.statIcon}>✅</span>
            <div className={styles.statValue}>
              {successRate != null ? `${successRate}%` : "—"}
            </div>
            <div className={styles.statLabel}>Success rate</div>
            {successRate != null && (
              <div className={styles.statSub}>{completedSims.length} of {recentSims.length} completed</div>
            )}
          </div>
        </div>

        {/* ── Main grid ── */}
        {isFirstTime ? (
          /* ── First-time: Brand Studio step cards ── */
          <div className={styles.mainGrid}>
            <div>
              <div className={styles.getStartedHead}>
                <h2 className={styles.getStartedTitle}>Get started in 3 steps</h2>
                <p className={styles.getStartedSub}>Follow these steps to run your first AI customer panel and start uncovering what's blocking sales.</p>
              </div>

              <div className={styles.stepsV2}>
                {/* Step 1: Store connected */}
                <div className={`${styles.stepCardV2} ${step1Done ? styles.stepCardV2Done : styles.stepCardV2Active}`}>
                  <div className={styles.stepCircleV2}>{step1Done ? "✓" : "1"}</div>
                  <div className={styles.stepCardBodyV2}>
                    <div className={styles.stepCardTitleRow}>
                      <span className={styles.stepCardTitleV2}>Store connected</span>
                      {step1Done && <span className={styles.doneBadge}>Done</span>}
                    </div>
                    <p className={styles.stepCardDescV2}>
                      Your Shopify store is linked and ready. The panel reads your live product pages directly — no theme changes, no A/B setup required.
                    </p>
                  </div>
                </div>

                {/* Step 2: Run first analysis */}
                <div className={`${styles.stepCardV2} ${step2Done ? styles.stepCardV2Done : styles.stepCardV2Active}`}>
                  <div className={styles.stepCircleV2}>{step2Done ? "✓" : "2"}</div>
                  <div className={styles.stepCardBodyV2}>
                    <div className={styles.stepCardTitleRow}>
                      <span className={styles.stepCardTitleV2}>Run your first analysis</span>
                      {step2Done && <span className={styles.doneBadge}>Done</span>}
                    </div>
                    <p className={styles.stepCardDescV2}>
                      Pick any live product from your catalog and 5 AI customer personas stress-test the listing. First results appear in ~30 seconds, full report in ~5–10 minutes.
                    </p>
                    {!step2Done && (
                      <Link to="/app/simulate" className={styles.stepCtaBtn}>
                        ▶ Run Analysis
                      </Link>
                    )}
                  </div>
                </div>

                {/* Step 3: Fix what's blocking sales */}
                <div className={`${styles.stepCardV2} ${step3Done ? styles.stepCardV2Done : step2Done ? styles.stepCardV2Active : styles.stepCardV2Dim}`}>
                  <div className={styles.stepCircleV2}>{step3Done ? "✓" : "3"}</div>
                  <div className={styles.stepCardBodyV2}>
                    <div className={styles.stepCardTitleRow}>
                      <span className={styles.stepCardTitleV2}>Fix what's blocking sales</span>
                      {step3Done && <span className={styles.doneBadge}>Done</span>}
                    </div>
                    <p className={styles.stepCardDescV2}>
                      Get your product's score, a friction breakdown across price, trust, and logistics, plus one-click AI-generated fixes for critical issues.
                    </p>
                    {step3Done && completedSims[0] && (
                      <Link to={`/app/results/${completedSims[0].id}`} className={`${styles.stepCtaBtn} ${styles.stepCtaBtnGreen}`}>
                        View Your Report →
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Health + Plan */}
            <div>
              <StoreHealth
                avgScore={avgScore}
                totalAnalyses={recentSims.length}
                mtPct={mtPct}
                tierLabel={tierLabel}
              />
              <div className={styles.sectionCard}>
                <div className={styles.sectionHeader}>
                  <h2 className={styles.sectionTitle}>Your free plan includes</h2>
                </div>
                <div className={styles.planCardBody}>
                  <div className={styles.includesList}>
                    {([
                      "5-agent customer panel per analysis",
                      `${simLimit} analyses per month`,
                      "Trust audit + friction report",
                      "AI-generated policy fixes",
                    ] as const).map((item) => (
                      <div key={item} className={styles.includesItem}>
                        <span className={styles.includesCheck}>✓</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                  <div className={styles.planDivider} />
                  <Link to="/app/billing" className={styles.btnUpgrade}>
                    ✦ Upgrade for more →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Returning users: analyses list + health panel ── */
          <div className={styles.mainGrid}>
            <div className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Recent Analyses</h2>
                <Link to="/app/history" className={styles.sectionLink}>View all →</Link>
              </div>
              <div className={styles.analysisList}>
                {recentSims.length === 0 ? (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyStateIcon}>📭</div>
                    <p className={styles.emptyStateTitle}>No analyses yet</p>
                    <p className={styles.emptyStateText}>Run your first analysis to see results here.</p>
                    <Link to="/app/simulate" className={styles.btnPrimary} style={{ display: "inline-flex" }}>
                      ▶ Run New Analysis
                    </Link>
                  </div>
                ) : (
                  recentSims.map((s) => (
                    <AnalysisRow key={s.id} sim={s} />
                  ))
                )}
              </div>
            </div>

            <div>
              <StoreHealth
                avgScore={avgScore}
                totalAnalyses={recentSims.length}
                mtPct={mtPct}
                tierLabel={tierLabel}
              />
              <div className={styles.sectionCard}>
                <div className={styles.sectionHeader}>
                  <h2 className={styles.sectionTitle}>Your Plan</h2>
                  <span className={`${styles.planTierBadge} ${tierBadgeClass}`}>
                    {tierLabel}
                  </span>
                </div>
                <div className={styles.planCardBody}>
                  <div className={styles.planRows}>
                    <div className={styles.planRow}>
                      <span className={styles.planRowLabel}>Panel size</span>
                      <span className={styles.planRowValue}>{agentCount}</span>
                    </div>
                    <div className={styles.planRow}>
                      <span className={styles.planRowLabel}>Analyses / month</span>
                      <span className={styles.planRowValue}>{simLimit}</span>
                    </div>
                    <div className={styles.planRow}>
                      <span className={styles.planRowLabel}>Weekly auto-scan</span>
                      <span className={styles.planRowValue}>{weeklyScan}</span>
                    </div>
                    <div className={styles.planRow}>
                      <span className={styles.planRowLabel}>Competitor tracking</span>
                      <span className={styles.planRowValue}>{tierLabel === "ENTERPRISE" ? "Yes" : "—"}</span>
                    </div>
                    <div className={styles.planRow}>
                      <span className={styles.planRowLabel}>Budget remaining</span>
                      <span
                        className={styles.planRowValue}
                        style={{ color: mtPct >= 80 ? "var(--red)" : "inherit" }}
                      >
                        {mtLimit - mtUsed} MT
                      </span>
                    </div>
                  </div>
                  {tierLabel !== "ENTERPRISE" && (
                    <>
                      <div className={styles.planDivider} />
                      <Link to="/app/billing" className={styles.btnUpgrade}>
                        ✦ Upgrade Plan
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
