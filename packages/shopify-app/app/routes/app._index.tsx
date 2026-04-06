import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { Page } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStore, getMtBudgetStatus, MT_LIMITS, SIM_LIMITS } from "../services/store.server";
import { getRecentSimulations } from "../services/simulation.server";
import styles from "../styles/dashboard.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [store, budget] = await Promise.all([
    getStore(shopDomain),
    getMtBudgetStatus(shopDomain),
  ]);
  const recentSims = store ? await getRecentSimulations(store.id, 5) : [];

  const tier = (budget?.tier ?? "FREE") as keyof typeof MT_LIMITS;
  return {
    shopDomain,
    store,
    budget,
    recentSims,
    mtLimit: MT_LIMITS[tier],
    simLimit: SIM_LIMITS[tier],
    isDev: process.env.NODE_ENV === "development",
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

// ── Sub-components ─────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = pct >= 70 ? "#16A34A" : pct >= 45 ? "#D97706" : "#DC2626";
  return (
    <div className={styles.heroScoreRing}
      style={{ background: `conic-gradient(${color} 0% ${pct}%, #E2E8F0 ${pct}% 100%)` }}>
      <div className={styles.heroScoreRingInner}>
        <span className={styles.heroScoreNum}>{score}</span>
        <span className={styles.heroScoreSub}>{scoreLabel(score)}</span>
      </div>
    </div>
  );
}

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
  const { store, budget, recentSims, mtLimit, simLimit, isDev } = useLoaderData<typeof loader>();

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

  // Representative score for hero ring (avg or last completed)
  const heroScore = avgScore ?? completedSims[0]?.score ?? 68;

  return (
    <Page>
      <TitleBar title="CustomerPanel AI" />
      <div className={styles.root}>

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
              <Link to="/app/simulate" className={styles.btnPrimary}>
                ▶ Run New Analysis
              </Link>
              <Link to="/app/history" className={styles.btnSecondary}>
                ◎ View Past Analyses
              </Link>
            </div>
          </div>
          {!isFirstTime && (
            <div className={styles.heroIllustration}>
              <ScoreRing score={heroScore} />
            </div>
          )}
        </div>

        {/* ── Quick stats ── */}
        <div className={styles.statsRow}>
          {/* Analyses this month */}
          <div className={styles.statCard}>
            <div className={`${styles.statCardAccent} ${styles.accentBlue}`} />
            <span className={styles.statIcon}>📊</span>
            <div className={styles.statValue}>{recentSims.length}</div>
            <div className={styles.statLabel}>Analyses this month</div>
          </div>

          {/* Budget used */}
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

          {/* Average score */}
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

          {/* Success rate */}
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
          /* First-time experience */
          <div className={styles.mainGrid}>
            <div>
              <div className={styles.sectionCard}>
                <div className={styles.sectionHeader}>
                  <h2 className={styles.sectionTitle}>How it works</h2>
                </div>
                <div style={{ padding: "1.25rem 1.375rem" }}>
                  <div className={styles.stepsGrid}>
                    {([
                      { num: "1", icon: "🛍️", title: "Pick a product", desc: "Select any live product from your Shopify catalog — no setup required." },
                      { num: "2", icon: "🧑‍🤝‍🧑", title: "Run the panel", desc: "5 AI customer personas stress-test your listing. First results appear in ~30 seconds." },
                      { num: "3", icon: "🎯", title: "Fix what's blocking sales", desc: "Get a score, a friction breakdown, and one-click fixes for critical issues." },
                    ] as const).map((step) => (
                      <div key={step.num} className={styles.stepCard}>
                        <span className={styles.stepNum}>{step.num}</span>
                        <span className={styles.stepIcon}>{step.icon}</span>
                        <p className={styles.stepTitle}>{step.title}</p>
                        <p className={styles.stepDesc}>{step.desc}</p>
                      </div>
                    ))}
                  </div>
                  <Link to="/app/simulate" className={styles.btnPrimary} style={{ display: "inline-flex" }}>
                    ▶ Run Your First Analysis
                  </Link>
                </div>
              </div>
            </div>

            <div>
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
          /* Returning merchant */
          <div className={styles.mainGrid}>
            {/* Recent analyses */}
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

            {/* Plan card */}
            <div>
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
                      <span className={styles.planRowValue}
                        style={{ color: mtPct >= 80 ? "var(--red)" : "inherit" }}>
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
