import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, Form, useNavigation, useActionData } from "@remix-run/react";
import db from "../db.server";
import { Prisma } from "@prisma/client";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Select,
  Button,
  Banner,
  InlineStack,
  Badge,
  Thumbnail,
  Box,
  EmptyState,
  Collapsible,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { getStore, getMtBudgetStatus, AGENT_COUNTS } from "../services/store.server"; // server-only
import { fetchProducts, fetchStoreContext } from "../services/products.server";
import {
  canRunSimulation,
  createSimulation,
  estimateSimulationCost,
  getMonthlyAnalysesQuota,
} from "../services/simulation.server";
import { OnboardingTour } from "../components/OnboardingTour";
import {
  ScenarioLabPanel,
  LAB_PRESETS,
  type LabPresetId,
  type LabAudience,
} from "../components/scenario-lab/ScenarioLabPanel";
import flowStyles from "../styles/simulate-flow.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [store, products, budget] = await Promise.all([
    getStore(shopDomain),
    fetchProducts(admin, shopDomain, 50),
    getMtBudgetStatus(shopDomain),
  ]);

  const isDev = process.env.NODE_ENV === "development";
  let analysesQuota: { used: number; limit: number; remaining: number } | null = null;
  let mtSufficient = true;
  if (store && budget) {
    analysesQuota = await getMonthlyAnalysesQuota(store.id, budget.tier);
    const estimatedMt = await estimateSimulationCost(budget.tier);
    mtSufficient = isDev || budget.remaining >= estimatedMt;
  }

  const tier = (budget?.tier ?? "FREE") as keyof typeof AGENT_COUNTS;

  // Fetch latest friction per product (for Lab preset suggestion)
  const recentSims = store ? await db.simulation.findMany({
    where: {
      storeId: store.id,
      status: "COMPLETED",
      originalSimulationId: null,
      reportJson: { not: Prisma.JsonNull },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { productUrl: true, reportJson: true, createdAt: true },
  }) : [];

  // Build a map: productId → dominant friction category
  const productFrictionMap: Record<string, "price" | "trust" | "logistics"> = {};
  for (const sim of recentSims) {
    const matchingProduct = products.find(p => sim.productUrl.includes(p.handle));
    if (!matchingProduct || productFrictionMap[matchingProduct.id]) continue;
    const report = sim.reportJson as { friction?: { price?: { dropoutPct?: number }; trust?: { dropoutPct?: number }; logistics?: { dropoutPct?: number } } } | null;
    if (!report?.friction) continue;
    const price = report.friction.price?.dropoutPct ?? 0;
    const trust = report.friction.trust?.dropoutPct ?? 0;
    const logistics = report.friction.logistics?.dropoutPct ?? 0;
    const dominant = price >= trust && price >= logistics ? "price" : trust >= logistics ? "trust" : "logistics";
    productFrictionMap[matchingProduct.id] = dominant;
  }

  return {
    products,
    store,
    analysesQuota,
    mtSufficient,
    agentCount: AGENT_COUNTS[tier],
    planTier: tier,
    isDev,
    productFrictionMap,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const formData = await request.formData();
  const productId = formData.get("productId") as string;

  const [store, products, budget] = await Promise.all([
    getStore(shopDomain),
    fetchProducts(admin, shopDomain, 50),
    getMtBudgetStatus(shopDomain),
  ]);

  if (!store || !budget) {
    return { error: "Store not found. Please reinstall the app." };
  }

  const product = products.find((p) => p.id === productId);
  if (!product) {
    return { error: "Product not found." };
  }

  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const productUrl = product.onlineStoreUrl ?? `https://${shopDomain}/products/${product.handle}`;

  const rawFocus = formData.get("focusAreas") as string | null;
  let focusAreas: string[] = [];
  try {
    focusAreas = rawFocus ? JSON.parse(rawFocus) : [];
    if (!Array.isArray(focusAreas)) focusAreas = [];
  } catch {
    focusAreas = [];
  }

  const rawLab = formData.get("labConfig") as string | null;
  let labConfig: unknown;
  try {
    labConfig = rawLab ? JSON.parse(rawLab) : undefined;
  } catch {
    labConfig = undefined;
  }

  // Lab runs create 2 simulations (baseline + target). Validate quota for the
  // actual number of sims that will be created so users can't bypass MT/slot
  // limits by enabling Lab.
  const sims = labConfig ? 2 : 1;
  const { allowed, reason } = await canRunSimulation(shopDomain, store.id, sims);
  if (!allowed) {
    return { error: reason };
  }

  // Fetch store-level policies — visible to buyers on every product page.
  // Non-blocking: if this fails, simulation proceeds without policy context.
  const storeContext = await fetchStoreContext(admin).catch(() => null) ?? undefined;

  const simulation = await createSimulation(
    store.id,
    shopDomain,
    store.shopType ?? "general_retail",
    productUrl,
    product,
    budget.tier,
    appUrl,
    focusAreas,
    labConfig as Parameters<typeof createSimulation>[8],
    storeContext,
  );

  throw redirect(`/app/results/${simulation.id}`);
};

export default function SimulatePage() {
  const { products, analysesQuota, mtSufficient, agentCount, planTier, isDev, productFrictionMap } =
    useLoaderData<typeof loader>();
  // Use a real Form (not fetcher) so the action's `throw redirect(...)` actually
  // navigates the page to /app/results/:id. With useFetcher, redirects are
  // followed in the background and the URL never changes — the launch button
  // would spin forever from the user's perspective.
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const [selectedProduct, setSelectedProduct] = useState<string>("");

  const isSubmitting = navigation.state === "submitting" || navigation.state === "loading";
  const error = actionData?.error;
  /** Single optional emphasis; empty = balanced general review (same as legacy `[]`). */
  const [focusEmphasis, setFocusEmphasis] = useState<string>("");
  const focusAreas = focusEmphasis ? [focusEmphasis] : [];
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Customer Lab state
  const [labEnabled, setLabEnabled] = useState(false);
  const [labPreset, setLabPreset] = useState<LabPresetId>("");
  const [labAudience, setLabAudience] = useState<LabAudience>("general");
  const [labSkepticism, setLabSkepticism] = useState<1 | 5 | 9>(5);
  const [labConcern, setLabConcern] = useState("");
  const [labBrutality, setLabBrutality] = useState(5);

  // Derive suggested preset based on product's dominant friction category
  const suggestedPreset = labEnabled && selectedProduct
    ? (() => {
        const dom = productFrictionMap[selectedProduct];
        if (!dom) return null;
        if (dom === "trust") return "skeptic_audit" as const;
        if (dom === "logistics") return "holiday_rush" as const;
        return null; // price — no specific preset maps cleanly
      })()
    : null;

  function applyPreset(presetId: Exclude<LabPresetId, "">) {
    const preset = LAB_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setLabPreset(presetId);
    setLabAudience(preset.audience);
    setLabSkepticism(preset.skepticism);
    setLabConcern(preset.concern);
    setLabBrutality(preset.brutality);
  }

  function clearPreset() {
    setLabPreset("");
  }

  const FOCUS_OPTIONS = [
    {
      id: "trust_credibility",
      shortLabel: "Trust & credibility",
      selectLabel: "🛡️ Trust & credibility",
      tip: "Extra scrutiny on legitimacy, reviews, policies, and 'would I get my order?'",
    },
    {
      id: "price_value",
      shortLabel: "Price & value",
      selectLabel: "💰 Price & value",
      tip: "Extra scrutiny on whether the price feels fair vs. alternatives and perceived value.",
    },
    {
      id: "technical_specs",
      shortLabel: "Technical / expert buyer",
      selectLabel: "🛠️ Technical / expert buyer",
      tip: "Panelists act like spec-focused buyers (features, numbers, compatibility).",
    },
    {
      id: "visual_branding",
      shortLabel: "Visuals & brand feel",
      selectLabel: "🎨 Visuals & brand feel",
      tip: "Extra weight on first impression, imagery, and whether the brand feels credible.",
    },
    {
      id: "mobile_friction",
      shortLabel: "Mobile & checkout friction",
      selectLabel: "📱 Mobile & checkout friction",
      tip: "Extra weight on small-screen readability and ease of buying on a phone.",
    },
  ] as const;

  const focusSelectOptions = [
    { label: "Balanced — full PDP review (recommended)", value: "" },
    ...FOCUS_OPTIONS.map((o) => ({ label: o.selectLabel, value: o.id })),
  ];

  const focusHelpText =
    focusEmphasis === ""
      ? "Balanced covers trust, price, shipping, visuals, and description — same as checking nothing before."
      : (FOCUS_OPTIONS.find((o) => o.id === focusEmphasis)?.tip ?? "");

  const advancedSummaryParts = [
    focusEmphasis ? FOCUS_OPTIONS.find((o) => o.id === focusEmphasis)?.shortLabel : null,
  ].filter(Boolean) as string[];

  const productOptions = [
    { label: "Select a product…", value: "" },
    ...products.map((p) => ({ label: p.title, value: p.id })),
  ];

  const selectedProductData = products.find((p) => p.id === selectedProduct);
  const canRun =
    !!selectedProduct &&
    (isDev ||
      (analysesQuota !== null && analysesQuota.remaining > 0 && mtSufficient));

  const stepSetupDone = !!selectedProduct;
  const stepRunReady = canRun;

  // Progress bar: 0% → 50% (product picked) → 100% (ready to run)
  const progressPct = canRun ? 100 : stepSetupDone ? 50 : 0;
  const progressText = canRun ? "Ready to launch" : stepSetupDone ? "Almost there — check limits" : "Start by picking a product";

  // CTA hint text
  const ctaHint = !selectedProduct
    ? "Select a product above to enable the launch button."
    : !canRun
      ? analysesQuota && analysesQuota.remaining <= 0
        ? "You’ve used all analyses included in your plan this month. Upgrade or try again next month."
        : "Can’t start a new analysis right now. Upgrade your plan or contact support if this persists."
      : labEnabled
        ? "Runs Scenario Lab: baseline audience plus your custom scenario in one analysis."
        : focusEmphasis
          ? `Runs a standard panel with extra weight on ${FOCUS_OPTIONS.find((o) => o.id === focusEmphasis)?.shortLabel ?? "one area"}.`
          : "Runs a balanced five-person panel on the selected PDP — price, trust, shipping, imagery, and description.";

  const runLabel = isSubmitting
    ? "Starting analysis…"
    : labEnabled
      ? "▶ Run Customer Lab analysis"
      : "▶ Run customer panel analysis";

  return (
    <Page fullWidth>
      <OnboardingTour
        storageKey="miroshop:tour:simulate"
        label="New"
        steps={[
          {
            title: "Welcome to Customer Panel",
            body: "Pick any live product from your Shopify catalog and we will assemble 5 realistic customer personas to stress‑test the listing. No theme changes, no A/B setup required.",
          },
          {
            title: "Choose the right product",
            body: "Start with a hero product or a problem child. The panel will read the exact title, price, description, shipping and returns you have on the PDP today.",
          },
          {
            title: "Step-by-step setup",
            body: "Follow the four steps: pick a product, configure Scenario Lab (optional Pro feature), set a focus area (optional), then launch. Results stream in within 30 seconds.",
          },
        ]}
      />
      <TitleBar title="Run Customer Panel Analysis" />

      {/* Brand Studio "Instructions" banner */}
      <div className={flowStyles.runBanner}>
        <span className={flowStyles.runBannerEyebrow}>▶ RUN ANALYSIS</span>
        <h1 className={flowStyles.runBannerTitle}>Stress-test a live product page</h1>
        <p className={flowStyles.runBannerDesc}>
          {agentCount} AI customer personas read your live product page and surface the exact friction points blocking sales.
          {analysesQuota
            ? ` ${analysesQuota.remaining} of ${analysesQuota.limit} analyses remaining this month.`
            : " First results in ~30 seconds, full report in ~5–10 min."}
        </p>
        <div className={flowStyles.runBannerProgressWrap}>
          <div className={flowStyles.runBannerProgressTrack}>
            <div className={flowStyles.runBannerProgressFill} style={{ width: `${progressPct}%` }} />
          </div>
          <span className={flowStyles.runBannerProgressText}>{progressText}</span>
        </div>

        {/* Always-visible launch CTA — points to the form submit so the
            button is never hidden below the fold. */}
        <div className={flowStyles.runBannerCta}>
          <button
            type="submit"
            form="simulate-form"
            disabled={!canRun || isSubmitting}
            className={[
              flowStyles.runBannerCtaBtn,
              canRun ? flowStyles.runBannerCtaReady : flowStyles.runBannerCtaWaiting,
            ].join(" ")}
            aria-label={canRun ? "Run analysis now" : "Complete the steps below to run analysis"}
          >
            {isSubmitting ? "Starting analysis…" : canRun ? "▶ Run analysis now" : "Pick a product to enable"}
          </button>
          <span className={flowStyles.runBannerCtaHint}>
            {canRun
              ? "Results stream in under a minute. You can leave the tab open."
              : "Pick a product below to unlock — Lab and emphasis are optional."}
          </span>
        </div>
      </div>

      {error && (
        <Banner tone="critical">
          <Text as="p" variant="bodyMd">{error}</Text>
        </Banner>
      )}

      {products.length === 0 ? (
        <Card>
          <div className={flowStyles.simCardInner}>
            <EmptyState
              heading="No published products found"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <Text as="p" variant="bodyMd">
                Auctovio analyses live product pages. Add at least one published product to your
                Shopify catalog, then come back here to run your first panel.
              </Text>
              <Button
                url="https://admin.shopify.com/products/new"
                target="_blank"
                variant="primary"
              >
                Add a product in Shopify
              </Button>
            </EmptyState>
          </div>
        </Card>
      ) : (
        <div className={flowStyles.runLayout}>
          {/* ── Step cards (main area) ── */}
          <div className={flowStyles.runMain}>
            <Form method="post" id="simulate-form">
              <input type="hidden" name="productId" value={selectedProduct} />
              <input type="hidden" name="focusAreas" value={JSON.stringify(focusAreas)} />
              <input
                type="hidden"
                name="labConfig"
                value={labEnabled
                  ? JSON.stringify({
                      audience: labAudience,
                      skepticism: labSkepticism,
                      coreConcern: labConcern,
                      brutalityLevel: labBrutality,
                      preset: labPreset,
                    })
                  : ""}
              />

              {/* ── Step 1: Select product ── */}
              <div className={[
                flowStyles.runStepCard,
                stepSetupDone ? flowStyles.runStepCardDone : flowStyles.runStepCardActive,
              ].join(" ")}>
                <div className={flowStyles.runStepCircleWrap}>
                  <span className={flowStyles.runStepCircle}>{stepSetupDone ? "✓" : "1"}</span>
                </div>
                <div className={flowStyles.runStepBody}>
                  <div className={flowStyles.runStepHead}>
                    <span className={flowStyles.runStepTitle}>Select a product</span>
                    {stepSetupDone
                      ? <span className={flowStyles.doneBadge}>Done</span>
                      : <span className={flowStyles.requiredBadge}>Required</span>
                    }
                  </div>
                  <p className={flowStyles.runStepDesc}>
                    The panel reads this product’s live PDP exactly as shoppers see it — title, price, images, description, and policies.
                  </p>
                  <Select
                    label="Catalog product"
                    options={productOptions}
                    value={selectedProduct}
                    onChange={setSelectedProduct}
                    helpText="Pick what to analyze. Required before you can launch."
                  />
                  {selectedProductData && (
                    <Box
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                      borderWidth="025"
                      borderColor="border"
                    >
                      <InlineStack gap="400" align="start" blockAlign="start">
                        {selectedProductData.images[0] && (
                          <Thumbnail
                            source={selectedProductData.images[0].url}
                            alt={selectedProductData.images[0].altText ?? selectedProductData.title}
                            size="large"
                          />
                        )}
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {selectedProductData.title}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {selectedProductData.variants[0]?.price
                              ? `From $${selectedProductData.variants[0].price}`
                              : "Price not set"}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {selectedProductData.productType || "No product type"}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </Box>
                  )}
                </div>
              </div>

              {/* ── Step 2: Scenario Lab ── */}
              <div className={flowStyles.runStepCard}>
                <div className={flowStyles.runStepCircleWrap}>
                  <span className={`${flowStyles.runStepCircle} ${flowStyles.runStepCirclePurple}`}>2</span>
                </div>
                <div className={flowStyles.runStepBody}>
                  <div className={flowStyles.runStepHead}>
                    <span className={flowStyles.runStepTitle}>Scenario Lab</span>
                    <span className={flowStyles.proBadge}>Pro</span>
                    <span className={flowStyles.optionalBadge}>Optional</span>
                    {labEnabled && <span className={flowStyles.doneBadge}>Active</span>}
                  </div>
                  <p className={flowStyles.runStepDesc}>
                    Run two scenarios at once — baseline + a custom audience or concern. Included on Pro and Enterprise plans.
                  </p>
                  <div className={flowStyles.simProLabWrap}>
                    <ScenarioLabPanel
                      labEnabled={labEnabled}
                      onLabEnabledChange={setLabEnabled}
                      labPreset={labPreset}
                      onSelectPreset={applyPreset}
                      onClearPreset={clearPreset}
                      labAudience={labAudience}
                      onAudienceChange={setLabAudience}
                      labSkepticism={labSkepticism}
                      onSkepticismChange={setLabSkepticism}
                      labConcern={labConcern}
                      onConcernChange={setLabConcern}
                      labBrutality={labBrutality}
                      onBrutalityChange={setLabBrutality}
                      suggestedPreset={suggestedPreset}
                    />
                  </div>
                </div>
              </div>

              {/* ── Step 3: Focus emphasis ── */}
              <div className={flowStyles.runStepCard}>
                <div className={flowStyles.runStepCircleWrap}>
                  <span className={flowStyles.runStepCircle}>3</span>
                </div>
                <div className={flowStyles.runStepBody}>
                  <div className={flowStyles.runStepHead}>
                    <span className={flowStyles.runStepTitle}>Extra emphasis</span>
                    <span className={flowStyles.optionalBadge}>Optional</span>
                    {focusEmphasis && <span className={flowStyles.doneBadge}>Set</span>}
                  </div>
                  <p className={flowStyles.runStepDesc}>
                    Want the panel to focus harder on one area? Pick one — or leave balanced for a full-spectrum review across trust, price, shipping, visuals, and description.
                  </p>
                  <div className={flowStyles.simFocusSelectWrap}>
                    <Select
                      label="Where should the panel push harder?"
                      options={focusSelectOptions}
                      value={focusEmphasis}
                      onChange={setFocusEmphasis}
                      helpText={focusHelpText}
                    />
                  </div>
                </div>
              </div>

              {/* ── Step 4: Launch ── */}
              <div className={[
                flowStyles.runStepCard,
                canRun ? flowStyles.runLaunchCard : "",
              ].filter(Boolean).join(" ")}>
                <div className={flowStyles.runStepCircleWrap}>
                  <span className={[
                    flowStyles.runStepCircle,
                    canRun ? flowStyles.runStepCircleGreen : "",
                  ].filter(Boolean).join(" ")}>
                    {isSubmitting ? "…" : "▶"}
                  </span>
                </div>
                <div className={flowStyles.runStepBody}>
                  <div className={flowStyles.runStepHead}>
                    <span className={flowStyles.runStepTitle}>Launch analysis</span>
                  </div>
                  <p className={flowStyles.runStepDesc}>{ctaHint}</p>
                  <Button
                    variant="primary"
                    size="large"
                    submit
                    fullWidth
                    loading={isSubmitting}
                    disabled={!canRun}
                  >
                    {runLabel}
                  </Button>
                </div>
              </div>
            </Form>

            {/* Sticky bottom launch bar — guarantees the launch button is
                visible even when the form is scrolled past. Appears once the
                user can run; dimmed but visible while quota check pending. */}
            <div className={flowStyles.stickyLaunchBar}>
              <div className={flowStyles.stickyLaunchBarText}>
                <span className={flowStyles.stickyLaunchBarTitle}>
                  {canRun ? "Ready to launch" : !selectedProduct ? "Pick a product to launch" : progressText}
                </span>
                <span className={flowStyles.stickyLaunchBarSub}>
                  {canRun
                    ? `${agentCount} AI personas · live PDP · streams in under a minute`
                    : ctaHint}
                </span>
              </div>
              <button
                type="submit"
                form="simulate-form"
                disabled={!canRun || isSubmitting}
                className={flowStyles.stickyLaunchBarBtn}
              >
                {isSubmitting ? "Starting…" : canRun ? "▶ Run analysis" : "Locked"}
              </button>
            </div>
          </div>

          {/* ── Sidebar (sticky info panels) ── */}
          <aside className={flowStyles.runAside}>
            <div className={flowStyles.simSidebarSticky}>

              {/* What the panel checks */}
              <div className={flowStyles.simInfoPanel}>
                <div className={flowStyles.simInfoPanelHead}>
                  <span className={flowStyles.simInfoPanelIcon}>🔍</span>
                  <div>
                    <p className={flowStyles.simInfoPanelTitle}>What the panel checks</p>
                    <p className={flowStyles.simInfoPanelSub}>Reads your live product page</p>
                  </div>
                </div>
                <ul className={flowStyles.simCheckList}>
                  {([
                    "Price vs. what buyers expect",
                    "Trust, reviews, and credibility",
                    "Shipping and returns clarity",
                    "Hero images and first impression",
                    "Description completeness",
                  ] as const).map((item) => (
                    <li key={item}>
                      <span className={flowStyles.simCheckIcon} aria-hidden>✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Scenario Lab info */}
              <div className={flowStyles.simLabPanel}>
                <div className={flowStyles.simLabPanelHead}>
                  <span className={flowStyles.simLabPanelTitle}>Scenario Lab</span>
                  <span className={flowStyles.simLabPanelBadge}>Pro</span>
                </div>
                <p className={flowStyles.simLabPanelDesc}>
                  Run two scenarios at once — baseline + custom in a single analysis. Included on Pro and Enterprise.
                </p>
                {planTier === "FREE" ? (
                  <a href="/app/billing" className={flowStyles.simLabUpgradeBtn}>
                    ✦ View plans &amp; upgrade
                  </a>
                ) : (
                  <div className={flowStyles.simLabActiveNote}>
                    ✓ Lab is active — toggle <strong>Lab</strong> in Step 2 above.
                  </div>
                )}
              </div>

            </div>
          </aside>
        </div>
      )}
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
