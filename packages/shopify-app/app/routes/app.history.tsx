import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import { Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import db from "../db.server";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import styles from "../styles/history.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStore(session.shop);
  if (!store) throw new Response("Store not found", { status: 404 });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [simulations, mtAgg] = await Promise.all([
    db.simulation.findMany({
      where: { storeId: store.id, originalSimulationId: null },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: {
        id: true,
        productUrl: true,
        productJson: true,
        status: true,
        score: true,
        phase: true,
        mtCost: true,
        createdAt: true,
      },
    }),
    db.simulation.aggregate({
      where: {
        storeId: store.id,
        originalSimulationId: null,
        createdAt: { gte: monthStart },
      },
      _sum: { mtCost: true },
    }),
  ]);

  const mtUsedThisMonth = mtAgg._sum.mtCost ?? 0;

  const completedWithScore = simulations.filter((s) => s.status === "COMPLETED" && s.score != null);
  const avgScore =
    completedWithScore.length > 0
      ? Math.round(
          completedWithScore.reduce((acc, s) => acc + (s.score ?? 0), 0) / completedWithScore.length,
        )
      : null;

  const terminal = simulations.filter((s) => s.status === "COMPLETED" || s.status === "FAILED");
  const successRate =
    terminal.length > 0
      ? Math.round(
          (terminal.filter((s) => s.status === "COMPLETED").length / terminal.length) * 100,
        )
      : null;

  const byUrl: Record<string, Array<{ id: string; score: number | null }>> = {};
  for (const sim of simulations) {
    if (!byUrl[sim.productUrl]) byUrl[sim.productUrl] = [];
    byUrl[sim.productUrl].push({ id: sim.id, score: sim.score });
  }
  const scoreDeltaMap: Record<string, number | null> = {};
  for (const group of Object.values(byUrl)) {
    for (let i = 0; i < group.length; i++) {
      const prev = group[i + 1];
      scoreDeltaMap[group[i].id] =
        group[i].score != null && prev?.score != null ? group[i].score! - prev.score! : null;
    }
  }

  const productOptions = [
    ...new Set(simulations.map((s) => productLabel(s.productUrl, s.productJson))),
  ].sort((a, b) => a.localeCompare(b));

  return {
    simulations,
    scoreDeltaMap,
    stats: {
      total: simulations.length,
      avgScore,
      successRate,
      mtUsedThisMonth,
    },
    productOptions,
  };
};

type Sim = Awaited<ReturnType<typeof loader>>["simulations"][number];

function productLabel(url: string, productJson: unknown) {
  const title = (productJson as { title?: string } | null)?.title;
  if (title) return title;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    return parts[parts.length - 1] || u.hostname;
  } catch {
    return url.slice(0, 48);
  }
}

function productImageUrl(productJson: unknown): string | null {
  const j = productJson as {
    images?:
      | Array<{ src?: string; url?: string }>
      | { edges?: Array<{ node?: { url?: string } }> };
  } | null;
  if (!j?.images) return null;
  const im = j.images;
  if (Array.isArray(im) && im.length > 0) {
    const first = im[0];
    return first?.url || first?.src || null;
  }
  if (typeof im === "object" && im && "edges" in im && Array.isArray(im.edges)) {
    const u = im.edges[0]?.node?.url;
    return u ?? null;
  }
  return null;
}

function scoreTierLabel(score: number | null): string {
  if (score == null) return "—";
  if (score >= 80) return "Strong";
  if (score >= 65) return "Good";
  if (score >= 45) return "Mixed";
  if (score >= 30) return "Low";
  return "Critical";
}

function scoreClass(score: number | null): string {
  if (score == null) return styles.scoreMuted;
  if (score >= 80) return styles.scoreStrong;
  if (score >= 65) return styles.scoreGood;
  if (score >= 45) return styles.scoreMixed;
  if (score >= 30) return styles.scoreLow;
  return styles.scoreCritical;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "COMPLETED":
      return `${styles.statusBadge} ${styles.statusCompleted}`;
    case "FAILED":
      return `${styles.statusBadge} ${styles.statusFailed}`;
    case "RUNNING":
      return `${styles.statusBadge} ${styles.statusRunning}`;
    case "PENDING":
      return `${styles.statusBadge} ${styles.statusPending}`;
    default:
      return styles.statusBadge;
  }
}

function formatWhen(d: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export default function HistoryPage() {
  const { simulations, scoreDeltaMap, stats, productOptions } = useLoaderData<typeof loader>();

  const [search, setSearch] = useState("");
  const [productFilter, setProductFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"newest" | "score" | "cost">("newest");
  const [view, setView] = useState<"grid" | "table">("grid");

  const filteredSorted = useMemo(() => {
    let list = [...simulations];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((s) => {
        const label = productLabel(s.productUrl, s.productJson).toLowerCase();
        return label.includes(q) || s.productUrl.toLowerCase().includes(q);
      });
    }
    if (productFilter !== "all") {
      list = list.filter((s) => productLabel(s.productUrl, s.productJson) === productFilter);
    }
    if (statusFilter !== "all") {
      list = list.filter((s) => s.status === statusFilter);
    }
    if (sortBy === "newest") {
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } else if (sortBy === "score") {
      list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    } else {
      list.sort((a, b) => b.mtCost - a.mtCost);
    }
    return list;
  }, [simulations, search, productFilter, statusFilter, sortBy]);

  const grouped = useMemo(() => {
    const map = new Map<string, Sim[]>();
    for (const s of filteredSorted) {
      const label = productLabel(s.productUrl, s.productJson);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(s);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ta = map.get(a)![0].createdAt;
      const tb = map.get(b)![0].createdAt;
      return new Date(tb).getTime() - new Date(ta).getTime();
    });
    return keys.map((title) => ({ title, items: map.get(title)! }));
  }, [filteredSorted]);

  return (
    <Page fullWidth>
      <TitleBar
        title="Analysis History"
        breadcrumbs={[{ content: "Dashboard", url: "/app" }]}
        primaryAction={{ content: "Run New Analysis", url: "/app/simulate" }}
      />

      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <h1 className={styles.title}>Analysis History</h1>
            <p className={styles.subtitle}>
              Every run is a snapshot of how shoppers react to your PDP. Review scores, open reports,
              and iterate with What-If simulations.
            </p>
            <div className={styles.statsRow}>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Total analyses</span>
                <span className={styles.statValue}>{stats.total}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Average score</span>
                <span className={styles.statValue}>
                  {stats.avgScore != null ? `${stats.avgScore}/100` : "—"}
                </span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Success rate</span>
                <span className={styles.statValue}>
                  {stats.successRate != null ? `${stats.successRate}%` : "—"}
                </span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>MT this month</span>
                <span className={styles.statValue}>{stats.mtUsedThisMonth}</span>
              </div>
            </div>
          </div>
          <Link to="/app/simulate" className={styles.btnPrimary}>
            Run New Analysis
          </Link>
        </header>

        {simulations.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon} aria-hidden>
              📊
            </div>
            <h2 className={styles.emptyTitle}>No analyses yet</h2>
            <p className={styles.emptyText}>
              Run your first product analysis to see scores, friction breakdowns, and panel insights
              here.
            </p>
            <Link to="/app/simulate" className={styles.btnPrimary}>
              Run your first analysis
            </Link>
          </div>
        ) : (
          <>
            <div className={styles.toolbar}>
              <div className={styles.filters}>
                <div className={`${styles.field} ${styles.fieldGrow}`}>
                  <label className={styles.label} htmlFor="hist-search">
                    Search
                  </label>
                  <input
                    id="hist-search"
                    className={styles.input}
                    type="search"
                    placeholder="Product name or URL…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="hist-product">
                    Product
                  </label>
                  <select
                    id="hist-product"
                    className={styles.select}
                    value={productFilter}
                    onChange={(e) => setProductFilter(e.target.value)}
                  >
                    <option value="all">All products</option>
                    {productOptions.map((p) => (
                      <option key={p} value={p}>
                        {p.length > 42 ? `${p.slice(0, 40)}…` : p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="hist-status">
                    Status
                  </label>
                  <select
                    id="hist-status"
                    className={styles.select}
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="all">All statuses</option>
                    <option value="COMPLETED">Completed</option>
                    <option value="RUNNING">Running</option>
                    <option value="PENDING">Pending</option>
                    <option value="FAILED">Failed</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="hist-sort">
                    Sort by
                  </label>
                  <select
                    id="hist-sort"
                    className={styles.select}
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  >
                    <option value="newest">Newest</option>
                    <option value="score">Score (high → low)</option>
                    <option value="cost">Cost (MT)</option>
                  </select>
                </div>
              </div>
              <div className={styles.viewToggle} role="group" aria-label="View mode">
                <button
                  type="button"
                  className={`${styles.toggleBtn} ${view === "grid" ? styles.toggleBtnActive : ""}`}
                  onClick={() => setView("grid")}
                >
                  Grid view
                </button>
                <button
                  type="button"
                  className={`${styles.toggleBtn} ${view === "table" ? styles.toggleBtnActive : ""}`}
                  onClick={() => setView("table")}
                >
                  Table view
                </button>
              </div>
            </div>

            {filteredSorted.length === 0 ? (
              <div className={styles.noResults}>
                <Text as="p" variant="bodyMd" tone="subdued">
                  No analyses match your filters. Try clearing search or changing status.
                </Text>
              </div>
            ) : view === "grid" ? (
              grouped.map((group) => (
                <section key={group.title} className={styles.group}>
                  <div className={styles.groupHeader}>
                    <h2 className={styles.groupTitle}>{group.title}</h2>
                    <span className={styles.groupCount}>{group.items.length}</span>
                  </div>
                  <div className={styles.grid}>
                    {group.items.map((sim) => (
                      <article
                        key={sim.id}
                        className={`${styles.card} ${sim.status === "COMPLETED" ? styles.cardCompleted : ""}`}
                      >
                        <div className={styles.cardTop}>
                          <div className={styles.thumb}>
                            {productImageUrl(sim.productJson) ? (
                              <img
                                src={productImageUrl(sim.productJson)!}
                                alt=""
                                loading="lazy"
                              />
                            ) : (
                              <span className={styles.thumbPlaceholder} aria-hidden>
                                ◆
                              </span>
                            )}
                          </div>
                          <div className={styles.cardMeta}>
                            <h3 className={styles.productName}>
                              {productLabel(sim.productUrl, sim.productJson)}
                            </h3>
                            <div className={styles.badgeRow}>
                              <span className={statusBadgeClass(sim.status)}>{sim.status}</span>
                            </div>
                          </div>
                        </div>
                        <div className={styles.scoreBlock}>
                          {sim.score != null ? (
                            <>
                              <span className={`${styles.scoreBig} ${scoreClass(sim.score)}`}>
                                {sim.score}
                                <span className={styles.scoreMuted} style={{ fontSize: "0.45em", fontWeight: 700 }}>
                                  /100
                                </span>
                              </span>
                              <span className={styles.scoreLabel}>{scoreTierLabel(sim.score)}</span>
                              {scoreDeltaMap[sim.id] != null && scoreDeltaMap[sim.id] !== 0 && (
                                <span
                                  className={`${styles.trend} ${
                                    (scoreDeltaMap[sim.id] ?? 0) > 0 ? styles.trendUp : styles.trendDown
                                  }`}
                                >
                                  {(scoreDeltaMap[sim.id] ?? 0) > 0 ? "↑" : "↓"}{" "}
                                  {Math.abs(scoreDeltaMap[sim.id] ?? 0)} vs last
                                </span>
                              )}
                            </>
                          ) : (
                            <span className={`${styles.scoreBig} ${styles.scoreMuted}`}>—</span>
                          )}
                        </div>
                        <div className={styles.metaRow}>
                          <span>{formatWhen(new Date(sim.createdAt))}</span>
                          <span>{sim.mtCost} MT</span>
                        </div>
                        <div className={styles.actions}>
                          {(sim.status === "COMPLETED" ||
                            sim.status === "RUNNING" ||
                            sim.status === "PENDING") && (
                            <Link
                              to={`/app/results/${sim.id}`}
                              className={styles.btnSecondary}
                            >
                              {sim.status === "COMPLETED" ? "View report" : "Watch live"}
                            </Link>
                          )}
                          {sim.status === "COMPLETED" && (
                            <Link to={`/app/sandbox/${sim.id}`} className={`${styles.btnSecondary} ${styles.btnGhost}`}>
                              What-If
                            </Link>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Status</th>
                      <th>Score</th>
                      <th>Trend</th>
                      <th>MT</th>
                      <th>Date</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSorted.map((sim) => {
                      const d = scoreDeltaMap[sim.id];
                      return (
                        <tr key={sim.id}>
                          <td>
                            <div className={styles.tableProduct}>
                              <div className={styles.tableThumb}>
                                {productImageUrl(sim.productJson) ? (
                                  <img
                                    src={productImageUrl(sim.productJson)!}
                                    alt=""
                                    loading="lazy"
                                  />
                                ) : (
                                  <span aria-hidden>◆</span>
                                )}
                              </div>
                              <span>{productLabel(sim.productUrl, sim.productJson)}</span>
                            </div>
                          </td>
                          <td>
                            <span className={statusBadgeClass(sim.status)}>{sim.status}</span>
                          </td>
                          <td>
                            {sim.score != null ? (
                              <span className={scoreClass(sim.score)}>
                                <strong>{sim.score}</strong>/100 · {scoreTierLabel(sim.score)}
                              </span>
                            ) : (
                              <span className={styles.scoreMuted}>—</span>
                            )}
                          </td>
                          <td>
                            {d != null && d !== 0 ? (
                              <span className={d > 0 ? styles.trendUp : styles.trendDown}>
                                {d > 0 ? "↑" : "↓"} {Math.abs(d)}
                              </span>
                            ) : (
                              <span className={styles.scoreMuted}>—</span>
                            )}
                          </td>
                          <td>{sim.mtCost}</td>
                          <td>{formatWhen(new Date(sim.createdAt))}</td>
                          <td>
                            <div className={styles.actions}>
                              {(sim.status === "COMPLETED" ||
                                sim.status === "RUNNING" ||
                                sim.status === "PENDING") && (
                                <Link to={`/app/results/${sim.id}`} className={styles.btnSecondary}>
                                  {sim.status === "COMPLETED" ? "View" : "Live"}
                                </Link>
                              )}
                              {sim.status === "COMPLETED" && (
                                <Link
                                  to={`/app/sandbox/${sim.id}`}
                                  className={`${styles.btnSecondary} ${styles.btnGhost}`}
                                >
                                  What-If
                                </Link>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
