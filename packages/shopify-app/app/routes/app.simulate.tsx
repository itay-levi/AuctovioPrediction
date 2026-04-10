import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import db from "../db.server";
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
      reportJson: { not: null },
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

  const { allowed, reason } = await canRunSimulation(shopDomain, store.id);
  if (!allowed) {
    return { error: reason };
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
  const fetcher = useFetcher<typeof action>();
  const [selectedProduct, setSelectedProduct] = useState<string>("");

  const isSubmitting = fetcher.state !== "idle";
  const error = fetcher.data?.error;
  /** Single optional emphasis; empty = balanced general review (same as legacy `[]`). */
  const [focusEmphasis, setFocusEmphasis] = useState<string>("");
  const focusAreas = focusEmphasis ? [focusEmphasis] : [];
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expectDetailsOpen, setExpectDetailsOpen] = useState(false);

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
      tip: "Extra scrutiny on legitimacy, reviews, policies, and “would I get my order?”",
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

  return (
    <Page fullWidth>
      <OnboardingTour
        storageKey="miroshop:tour:simulate"
        label="New"
        steps={[
          {
            title: "Welcome to Customer Panel",
            body:
              "Pick any live product from your Shopify catalog and we will assemble 5 realistic customer personas to stress‑test the listing. No theme changes, no A/B setup required.",
          },
          {
            title: "Choose the right product",
            body:
              "Start with a hero product or a problem child. The panel will read the exact title, price, description, shipping and returns you have on the PDP today.",
          },
          {
            title: "Product + Scenario Lab",
            body:
              "Pick a product on the left (required). Scenario Lab sits beside it — that’s Pro parallel simulation. A short “what to expect” line stays at the top; open the sidebar for more detail.",
          },
        ]}
      />
      <TitleBar
        title="Run Customer Panel Analysis"
        breadcrumbs={[{ content: "Dashboard", url: "/app" }]}
      />
      <BlockStack gap="500">
        <div className={flowStyles.simIntro}>
          <h1 className={flowStyles.simIntroTitle}>Stress-test a live product page</h1>
          <p className={flowStyles.simIntroBody}>
            <strong>Choose a product</strong> from your catalog (required) — that’s what the panel
            reads. <strong>Scenario Lab</strong> sits beside it: optional <strong>Pro</strong> parallel
            simulation (baseline + custom scenario in one run). Then hit run.
          </p>
        </div>

        <div className={flowStyles.simExpectStrip}>
          <p className={flowStyles.simExpectStripText}>
            <strong>What to expect:</strong>{" "}
            {agentCount} simulated shoppers on your live PDP · first read ~30s · full report ~5–10 min
            {analysesQuota
              ? ` · ${analysesQuota.remaining} of ${analysesQuota.limit} analyses left this month`
              : ""}
            . Covers price, trust, shipping, imagery, and description.
          </p>
        </div>

        <div className={flowStyles.simStepper} aria-label="Setup flow">
          <div
            className={[
              flowStyles.simStep,
              stepSetupDone ? flowStyles.simStepDone : "",
              !stepSetupDone ? flowStyles.simStepCurrent : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className={flowStyles.simStepLabel}>
              {stepSetupDone ? "✓ Set up" : "1 · Set up"}
            </span>
            <span className={flowStyles.simStepSub}>
              Product (required) + Scenario Lab (Pro, optional)
            </span>
          </div>
          <div
            className={[
              flowStyles.simStep,
              stepRunReady
                ? flowStyles.simStepDone
                : stepSetupDone
                  ? flowStyles.simStepCurrent
                  : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className={flowStyles.simStepLabel}>
              {stepRunReady ? "✓ Ready to run" : "2 · Run"}
            </span>
            <span className={flowStyles.simStepSub}>
              {stepRunReady
                ? "Use the button below"
                : selectedProduct
                  ? analysesQuota && analysesQuota.remaining <= 0
                    ? "Monthly analyses used up"
                    : "Check plan limits"
                  : "Select a product first"}
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
          <div className={flowStyles.simPageGrid}>
            <div className={flowStyles.simPageMain}>
              <Card>
                <div className={flowStyles.simCardInner}>
                  <fetcher.Form method="post">
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

                    <BlockStack gap="500">
                      <div className={flowStyles.simSetupGrid}>
                        <div className={flowStyles.simSetupCol}>
                          <div className={flowStyles.simSetupColHead}>
                            <h2 className={flowStyles.simSetupColTitle}>Select a product</h2>
                            <Badge tone="critical">Required</Badge>
                          </div>
                          <p className={flowStyles.simSetupColHint}>
                            The panel reads this product’s live PDP — nothing to install or theme.
                          </p>
                          <Select
                            label="Catalog product"
                            options={productOptions}
                            value={selectedProduct}
                            onChange={setSelectedProduct}
                            helpText="Required — pick what to analyze before you can run."
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
                                    alt={
                                      selectedProductData.images[0].altText ?? selectedProductData.title
                                    }
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

                        <div className={[flowStyles.simSetupCol, flowStyles.simLabCol].join(" ")}>
                          <div className={flowStyles.simSetupColHead}>
                            <h2 className={flowStyles.simSetupColTitle}>Scenario Lab</h2>
                            <Badge tone="attention">Pro</Badge>
                          </div>
                          <p className={flowStyles.simSetupColHint}>
                            You’ll see this column on every run — optional parallel baseline + custom
                            scenario for the same product.
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

                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                          <Button
                            disclosure={advancedOpen ? "up" : "down"}
                            variant="plain"
                            onClick={() => setAdvancedOpen((o) => !o)}
                            aria-expanded={advancedOpen}
                            aria-controls="simulate-advanced-panel"
                          >
                            {advancedOpen
                              ? "Hide advanced options"
                              : advancedSummaryParts.length > 0
                                ? `Advanced options (${advancedSummaryParts.join(" · ")})`
                                : "Advanced options (optional)"}
                          </Button>
                          {!advancedOpen && advancedSummaryParts.length > 0 && (
                            <Badge tone="attention">Customized</Badge>
                          )}
                        </InlineStack>
                        <Collapsible
                          open={advancedOpen}
                          id="simulate-advanced-panel"
                          transition={{ duration: "200ms" }}
                        >
                          <Box
                            padding="400"
                            background="bg-surface-secondary"
                            borderRadius="200"
                            borderWidth="025"
                            borderColor="border"
                          >
                            <BlockStack gap="200">
                              <Text as="h3" variant="headingMd">
                                Extra emphasis (pick one or none)
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                Optional fine-tuning for any plan. Leave on balanced for a normal
                                review.
                              </Text>
                              <div className={flowStyles.simFocusSelectWrap}>
                                <Select
                                  label="Where should the panel push harder?"
                                  options={focusSelectOptions}
                                  value={focusEmphasis}
                                  onChange={setFocusEmphasis}
                                  helpText={focusHelpText}
                                />
                              </div>
                            </BlockStack>
                          </Box>
                        </Collapsible>
                      </BlockStack>

                      <div className={flowStyles.simCtaWrap}>
                        <p className={flowStyles.simCtaHint}>
                          {!selectedProduct
                            ? "Select a product to enable the run button."
                            : !canRun
                              ? analysesQuota && analysesQuota.remaining <= 0
                                ? "You've used all analyses included in your plan this month. Upgrade or try again next month."
                                : "Can't start a new analysis right now. Upgrade your plan or contact support if this persists."
                              : labEnabled
                                ? "Runs Scenario Lab: baseline audience plus your custom scenario in one analysis."
                              : focusEmphasis
                                ? `Runs a standard panel with extra weight on ${FOCUS_OPTIONS.find((o) => o.id === focusEmphasis)?.shortLabel ?? "one area"}.`
                                : "Runs a balanced five-person panel on the selected PDP — no extra tweaks."}
                        </p>
                        <Button
                          variant="primary"
                          size="large"
                          submit
                          fullWidth
                          loading={isSubmitting}
                          disabled={!canRun}
                        >
                          {isSubmitting
                            ? "Starting analysis…"
                            : labEnabled
                              ? "Run Customer Lab analysis"
                              : "Run customer panel analysis"}
                        </Button>
                      </div>
                    </BlockStack>
                  </fetcher.Form>
                </div>
              </Card>
            </div>

            <aside className={flowStyles.simPageAside}>
              <div className={flowStyles.simSidebarSticky}>
                <Card>
                  <div className={flowStyles.simSidebarInner}>
                    <BlockStack gap="400">
                      <BlockStack gap="150">
                        <Text as="h2" variant="headingMd">
                          Pro · Scenario Lab
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          The lab beside your product picker is how you run two scenarios at once.
                          Included on Pro and Enterprise.
                        </Text>
                      </BlockStack>
                      {planTier === "FREE" ? (
                        <Button url="/app/billing" variant="primary" fullWidth>
                          View plans & upgrade
                        </Button>
                      ) : (
                        <Banner tone="success">
                          <Text as="p" variant="bodySm">
                            Scenario Lab is on your plan — toggle <strong>Lab</strong> in the panel.
                          </Text>
                        </Banner>
                      )}

                      <BlockStack gap="200">
                        <Button
                          disclosure={expectDetailsOpen ? "up" : "down"}
                          variant="plain"
                          onClick={() => setExpectDetailsOpen((o) => !o)}
                          aria-expanded={expectDetailsOpen}
                          aria-controls="simulate-expect-details"
                        >
                          {expectDetailsOpen ? "Hide detail" : "What the panel checks (live PDP)"}
                        </Button>
                        <Collapsible
                          open={expectDetailsOpen}
                          id="simulate-expect-details"
                          transition={{ duration: "200ms" }}
                        >
                          <ul className={flowStyles.simCheckList}>
                            <li>
                              <span className={flowStyles.simCheckIcon} aria-hidden>
                                ✓
                              </span>
                              <span>Price vs. what buyers expect</span>
                            </li>
                            <li>
                              <span className={flowStyles.simCheckIcon} aria-hidden>
                                ✓
                              </span>
                              <span>Trust, reviews, and credibility</span>
                            </li>
                            <li>
                              <span className={flowStyles.simCheckIcon} aria-hidden>
                                ✓
                              </span>
                              <span>Shipping and returns clarity</span>
                            </li>
                            <li>
                              <span className={flowStyles.simCheckIcon} aria-hidden>
                                ✓
                              </span>
                              <span>Hero images and first impression</span>
                            </li>
                            <li>
                              <span className={flowStyles.simCheckIcon} aria-hidden>
                                ✓
                              </span>
                              <span>Description completeness</span>
                            </li>
                          </ul>
                        </Collapsible>
                      </BlockStack>
                    </BlockStack>
                  </div>
                </Card>
              </div>
            </aside>
          </div>
        )}
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
