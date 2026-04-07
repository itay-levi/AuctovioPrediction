import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import type { CSSProperties } from "react";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { getSimulation } from "../services/simulation.server";
import type { Recommendation } from "../types/simulation";
import { sanitizeAgentReasoning } from "../utils/sanitizeAgentReasoning";
import styles from "../styles/customer-panel-report.module.css";

const ROSTER_ORDER = [
  "budget_optimizer",
  "brand_loyalist",
  "research_analyst",
  "impulse_decider",
  "gift_seeker",
] as const;

type ReportFriction = {
  price?: { dropoutPct?: number; topObjections?: string[] };
  trust?: { dropoutPct?: number; topObjections?: string[] };
  logistics?: { dropoutPct?: number; topObjections?: string[] };
};

type FrictionRow = {
  key: "price" | "trust" | "logistics";
  label: string;
  pct: number;
  objections: string[];
};

function frictionFallback(key: FrictionRow["key"]): string {
  if (key === "price") {
    return "Buyers weighed perceived value against the listed price and alternatives.";
  }
  if (key === "trust") {
    return "Credibility, reviews, and policy signals drove hesitation in this bucket.";
  }
  return "Delivery timelines and return clarity surfaced as friction for the panel.";
}

/** Prefer distinct copy per row when the engine repeats the same objection across categories. */
function uniqueSnippetsInOrder(rows: FrictionRow[]): string[] {
  const used = new Set<string>();
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return rows.map((row) => {
    for (const o of row.objections) {
      const t = o.trim();
      if (!t) continue;
      const n = norm(t);
      if (!used.has(n)) {
        used.add(n);
        return t;
      }
    }
    return frictionFallback(row.key);
  });
}

function scoreVerdict(score: number): string {
  if (score >= 80) return "Strong";
  if (score >= 65) return "Good";
  if (score >= 45) return "Mixed";
  if (score >= 30) return "Needs improvement";
  return "Critical attention";
}

function sevLabel(pct: number): string {
  if (pct >= 40) return "Elevated";
  if (pct >= 15) return "Moderate";
  return "Contained";
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data || data.mode !== "ok") return [{ title: "Report — CustomerPanel AI" }];
  return [{ title: `PDF Report — ${data.productTitle} — CustomerPanel AI` }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStore(session.shop);
  const simulation = await getSimulation(params.id!);

  if (!simulation || simulation.storeId !== store?.id) {
    throw new Response("Not found", { status: 404 });
  }

  if (simulation.status !== "COMPLETED" || simulation.score == null) {
    return {
      mode: "not_ready" as const,
      simulationId: simulation.id,
      status: simulation.status,
    };
  }

  const productJson = simulation.productJson as { title?: string } | null;
  const productTitle = productJson?.title ?? "Product";
  const report = simulation.reportJson as {
    friction?: ReportFriction;
    summary?: string;
  } | null;
  const friction = report?.friction ?? {};

  const entries: FrictionRow[] = [
    {
      key: "price",
      label: "Price sensitivity",
      pct: Math.round(friction.price?.dropoutPct ?? 0),
      objections: friction.price?.topObjections ?? [],
    },
    {
      key: "trust",
      label: "Trust & social proof",
      pct: Math.round(friction.trust?.dropoutPct ?? 0),
      objections: friction.trust?.topObjections ?? [],
    },
    {
      key: "logistics",
      label: "Logistics & returns",
      pct: Math.round(friction.logistics?.dropoutPct ?? 0),
      objections: friction.logistics?.topObjections ?? [],
    },
  ];
  const topThreeSorted = [...entries].sort((a, b) => b.pct - a.pct).slice(0, 3);
  const topSnippets = uniqueSnippetsInOrder(topThreeSorted);
  const topThree = topThreeSorted.map((row, i) => ({
    ...row,
    displaySnippet: topSnippets[i]!,
  }));
  const cardSnippets = uniqueSnippetsInOrder(entries);
  const frictionCards = entries.map((row, i) => ({
    ...row,
    displayExpl: cardSnippets[i]!,
  }));

  const synthesisText = (simulation as { synthesisText?: string | null }).synthesisText;
  const topFrictionCat = entries.sort((a, b) => b.pct - a.pct)[0]?.key ?? null;
  const topFrictionLabel: Record<string, string> = {
    trust: "trust and credibility",
    price: "price and perceived value",
    logistics: "shipping and returns clarity",
  };
  const score = simulation.score;
  const keyInsight =
    report?.summary?.trim() ||
    synthesisText?.trim() ||
    (topFrictionCat
      ? `The panel’s hesitation clusters around ${topFrictionLabel[topFrictionCat] ?? "multiple areas"} — addressing it directly should lift modeled purchase intent.`
      : `Your listing scored ${score}/100 — use the friction breakdown and action plan below to prioritize fixes.`);

  const phase1 = simulation.agentLogs.filter((l) => l.phase === 1);
  const byArch = new Map(phase1.map((l) => [l.archetype, l]));
  const panel = ROSTER_ORDER.map((arch) => {
    const log = byArch.get(arch);
    if (!log) return null;
    return {
      archetype: arch,
      personaName: log.personaName || log.archetypeName || arch,
      role: log.archetypeName || arch.replace(/_/g, " "),
      verdict: log.verdict,
      quote: truncate(sanitizeAgentReasoning(log.reasoning), 240),
    };
  }).filter(Boolean) as {
    archetype: string;
    personaName: string;
    role: string;
    verdict: string;
    quote: string;
  }[];

  const detailPanel = ROSTER_ORDER.map((arch) => {
    const log = byArch.get(arch);
    if (!log) return null;
    return {
      headline: `${log.personaName || log.archetypeName || arch} · ${log.archetypeName || arch}`,
      verdict: log.verdict,
      body: truncate(sanitizeAgentReasoning(log.reasoning), 420),
    };
  }).filter(Boolean) as { headline: string; verdict: string; body: string }[];

  const rawRecs = simulation.recommendations;
  const recs = (Array.isArray(rawRecs) ? rawRecs : []) as Recommendation[];
  const priorityOrder = { High: 0, Medium: 1, Low: 2 };
  const recommendations = [...recs].sort(
    (a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9),
  );

  return {
    mode: "ok" as const,
    productTitle,
    score,
    scoreVerdict: scoreVerdict(score),
    gaugePct: Math.min(1, Math.max(0, score / 100)),
    analysisDate: simulation.createdAt.toISOString(),
    keyInsight,
    topThree,
    frictionCards,
    panel,
    detailPanel,
    recommendations,
    resultsUrl: `/app/results/${simulation.id}`,
    simulateUrl: "/app/simulate",
  };
};

export default function CustomerPanelReportPage() {
  const data = useLoaderData<typeof loader>();

  if (data.mode === "not_ready") {
    return (
      <div className={styles.reportWrap}>
        <div className={styles.notReady}>
          <h1>Report not ready yet</h1>
          <p>
            PDF reports are available when the analysis status is <strong>Completed</strong> and a score
            is present. Current status: <strong>{data.status}</strong>.
          </p>
          <Link to={`/app/results/${data.simulationId}`} className={styles.btnPrint}>
            Back to results
          </Link>
        </div>
      </div>
    );
  }

  const {
    productTitle,
    score,
    scoreVerdict,
    gaugePct,
    analysisDate,
    keyInsight,
    topThree,
    frictionCards,
    panel,
    detailPanel,
    recommendations,
    resultsUrl,
    simulateUrl,
  } = data;

  const formattedDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
  }).format(new Date(analysisDate));

  return (
    <div className={styles.reportWrap}>
      <div className={styles.noPrint}>
        <div className={styles.toolbarInner}>
          <div>
            <div className={styles.toolbarTitle}>Customer Panel — PDF report</div>
            <ol className={styles.toolbarSteps}>
              <li>
                <strong>Download as PDF:</strong> click the blue button (or press{" "}
                <kbd>Ctrl</kbd> + <kbd>P</kbd> / <kbd>⌘</kbd> + <kbd>P</kbd>).
              </li>
              <li>
                <strong>In the print dialog,</strong> set <strong>Destination</strong> to{" "}
                <strong>Save as PDF</strong> (Chrome / Edge) or <strong>PDF</strong> → Save (Safari).
              </li>
              <li>
                <strong>Turn off headers/footers</strong> if your browser adds page URLs — optional for a
                cleaner look.
              </li>
            </ol>
          </div>
          <div className={styles.toolbarActions}>
            <Link to={resultsUrl} className={styles.btnBack}>
              ← Back to results
            </Link>
            <button type="button" className={styles.btnPrint} onClick={() => window.print()}>
              Print / Save as PDF
            </button>
          </div>
        </div>
      </div>

      {/* Cover */}
      <div className={styles.sheet}>
        <div className={styles.pageInner}>
          <div className={styles.coverTop}>
            <div className={styles.logoRow}>
              <div className={styles.logoMark}>CP</div>
              <div>
                <div className={styles.brand}>CustomerPanel AI</div>
                <div className={styles.muted} style={{ marginTop: 2 }}>
                  Shopper simulation intelligence
                </div>
              </div>
            </div>
            <div className={styles.muted} style={{ textAlign: "right" }}>
              Confidential · Client deliverable
            </div>
          </div>
          <div className={styles.coverBody}>
            <h1 className={styles.docTitle}>
              Customer Panel
              <br />
              Analysis Report
            </h1>
            <p className={styles.productName}>{productTitle}</p>
            <div className={styles.gaugeWrap}>
              <div className={styles.gauge} style={{ "--gauge-pct": gaugePct } as CSSProperties}>
                <div className={styles.gaugeBg} />
                <div className={styles.gaugeFill} />
                <div className={styles.gaugeValue}>{score}</div>
              </div>
              <div className={styles.gaugeLabel}>Customer Confidence Score</div>
              <p className={styles.muted} style={{ marginTop: "0.5rem" }}>
                Scale: 0–100 · Modeled purchase intent from simulated first-scan panel
              </p>
            </div>
          </div>
          <div className={styles.coverFooter}>
            <div>
              <strong style={{ color: "#334155" }}>Analysis date</strong>
              <br />
              {formattedDate}
            </div>
            <div style={{ textAlign: "right" }}>
              Generated by <strong style={{ color: "#2563eb" }}>CustomerPanel AI</strong>
              <br />
              <span className={styles.muted}>Automated panel synthesis · Not a human focus group</span>
            </div>
          </div>
        </div>
      </div>

      {/* Executive summary */}
      <div className={styles.sheet}>
        <div className={styles.pageInner}>
          <p className={styles.sectionKicker}>Section 01</p>
          <h2 className={styles.sectionTitle}>Executive Summary</h2>
          <div className={styles.execBar}>
            <div className={styles.scorePill}>
              <div className={styles.scorePillBig}>{score}</div>
              <div className={styles.scorePillVerdict}>Overall: {scoreVerdict}</div>
              <p className={styles.muted} style={{ margin: "0.5rem 0 0", fontSize: "8.5pt" }}>
                Verdict reflects panel balance and listing quality signals in the simulation.
              </p>
            </div>
            <div className={styles.insightBox}>
              <p>{keyInsight}</p>
            </div>
          </div>
          <h3 className={styles.frictionDriversHeading}>Top friction drivers</h3>
          <ul className={styles.frictionList}>
            {topThree.map((row) => (
              <li key={row.key}>
                <div className={styles.pct}>{row.pct}%</div>
                <div className={styles.frictionListBody}>
                  <strong>{row.label}</strong>
                  <span className={styles.muted}>{row.displaySnippet}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Friction breakdown */}
      <div className={styles.sheet}>
        <div className={styles.pageInner}>
          <p className={styles.sectionKicker}>Section 02</p>
          <h2 className={styles.sectionTitle}>Key Friction Breakdown</h2>
          <p className={styles.muted} style={{ marginBottom: "1rem" }}>
            Estimated share of modeled dropout by theme (indicative; categories are not strictly additive).
          </p>
          <div className={styles.cards3}>
            {frictionCards.map((row) => {
              const high = row.pct >= 40;
              const mid = row.pct >= 15 && row.pct < 40;
              const cardClass = `${styles.fCard} ${high ? styles.fCardHigh : mid ? styles.fCardMid : ""}`;
              const labelMap = {
                price: "Price Sensitivity",
                trust: "Trust & Social Proof",
                logistics: "Logistics & Returns",
              };
              return (
                <div key={row.key} className={cardClass}>
                  <h3>{labelMap[row.key]}</h3>
                  <div className={styles.fPct}>{row.pct}%</div>
                  <span className={styles.sevTag}>{sevLabel(row.pct)}</span>
                  <p>
                    <strong>Impact:</strong> {row.displayExpl}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Panel consensus */}
      <div className={styles.sheet}>
        <div className={styles.pageInner}>
          <p className={styles.sectionKicker}>Section 03</p>
          <h2 className={styles.sectionTitle}>Panel Consensus</h2>
          <p className={styles.muted} style={{ marginBottom: "1rem" }}>
            Five archetype-calibrated personas — first-scan verdicts and highlight quotes.
          </p>
          <div className={styles.agentGrid}>
            {panel.map((p) => (
              <div key={p.archetype} className={styles.agent}>
                <div className={styles.agentHead}>
                  <div>
                    <div className={styles.agentName}>{p.personaName}</div>
                    <div className={styles.agentRole}>{p.role}</div>
                  </div>
                  <span
                    className={`${styles.badge} ${
                      p.verdict === "BUY" ? styles.badgeBuy : styles.badgeReject
                    }`}
                  >
                    {p.verdict}
                  </span>
                </div>
                <p className={styles.quote}>&ldquo;{p.quote}&rdquo;</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Action plan */}
      <div className={styles.sheet}>
        <div className={styles.pageInner}>
          <p className={styles.sectionKicker}>Section 04</p>
          <h2 className={styles.sectionTitle}>Action Plan</h2>
          <p
            style={{
              margin: "0 0 1rem",
              fontSize: "11pt",
              lineHeight: 1.5,
              color: "#1e293b",
              fontWeight: 500,
            }}
          >
            Prioritized recommendations from the panel synthesis. Expected impacts are directional, not
            guarantees.
          </p>
          <div className={styles.actions}>
            {recommendations.length === 0 ? (
              <p className={styles.muted}>No structured recommendations were attached to this run.</p>
            ) : (
              recommendations.map((r, i) => (
                <div key={i} className={styles.actionItem}>
                  <div className={styles.actionWhat}>{r.title}</div>
                  <div className={styles.actionWhy}>{r.the_why}</div>
                  <span className={styles.actionImpact}>Expected impact: {r.impact}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Detailed insights */}
      <div className={styles.sheet}>
        <div className={styles.pageInner}>
          <p className={styles.sectionKicker}>Section 05</p>
          <h2 className={styles.sectionTitle}>Detailed Panel Insights</h2>
          <p className={styles.muted} style={{ marginBottom: "1rem" }}>
            Abbreviated synthesis per persona — open the app for full transcripts and debate.
          </p>
          {detailPanel.map((d, i) => (
            <div key={i} className={styles.detailAgent}>
              <h3>{d.headline}</h3>
              <p className={styles.muted} style={{ marginBottom: "0.35rem" }}>
                <span
                  className={`${styles.badge} ${
                    d.verdict === "BUY" ? styles.badgeBuy : styles.badgeReject
                  }`}
                >
                  {d.verdict}
                </span>
              </p>
              <p style={{ margin: 0, fontSize: "9.5pt", color: "#334155", lineHeight: 1.5 }}>
                {d.body}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Final */}
      <div className={`${styles.sheet} ${styles.final}`}>
        <div className={styles.pageInner}>
          <p className={styles.brand} style={{ marginBottom: "1rem" }}>
            CustomerPanel AI
          </p>
          <h2 className={styles.finalTitle}>Thank you</h2>
          <p className={styles.finalLead}>
            This report distills simulated shopper reactions into clear priorities. Use it to align
            merchandising, copy, and policy updates with how your panel responded in this run.
          </p>
          <p className={styles.muted} style={{ marginTop: "1rem" }}>
            This report was generated by <strong style={{ color: "#2563eb" }}>CustomerPanel AI</strong>.
          </p>
          <Link to={simulateUrl} className={styles.cta}>
            Ready to run another analysis?
          </Link>
          <p className={styles.fine}>
            CustomerPanel AI provides modeled insights for decision support; results are not guarantees of
            future sales.
          </p>
        </div>
      </div>
    </div>
  );
}
