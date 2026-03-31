import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Select,
  Button,
  Banner,
  InlineStack,
  Badge,
  Thumbnail,
  Checkbox,
  Box,
  Divider,
  ButtonGroup,
  Tooltip,
  Icon,
} from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { getStore, getMtBudgetStatus, AGENT_COUNTS } from "../services/store.server"; // server-only
import { fetchProducts } from "../services/products.server";
import {
  canRunSimulation,
  createSimulation,
  estimateSimulationCost,
} from "../services/simulation.server";
import { OnboardingTour } from "../components/OnboardingTour";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [store, products, budget] = await Promise.all([
    getStore(shopDomain),
    fetchProducts(admin, shopDomain, 50),
    getMtBudgetStatus(shopDomain),
  ]);

  const estimatedMt = budget ? await estimateSimulationCost(budget.tier) : 0;

  const tier = (budget?.tier ?? "FREE") as keyof typeof AGENT_COUNTS;
  return { products, store, budget, estimatedMt, agentCount: AGENT_COUNTS[tier], isDev: process.env.NODE_ENV === "development" };
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
  const focusAreas: string[] = rawFocus ? JSON.parse(rawFocus) : [];

  const rawLab = formData.get("labConfig") as string | null;
  const labConfig = rawLab ? JSON.parse(rawLab) : undefined;

  const simulation = await createSimulation(
    store.id,
    shopDomain,
    store.shopType ?? "general_retail",
    productUrl,
    product,
    budget.tier,
    appUrl,
    focusAreas,
    labConfig,
  );

  throw redirect(`/app/results/${simulation.id}`);
};

export default function SimulatePage() {
  const { products, budget, estimatedMt, agentCount, isDev } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selectedProduct, setSelectedProduct] = useState<string>("");

  const isSubmitting = fetcher.state !== "idle";
  const error = fetcher.data?.error;
  const [focusAreas, setFocusAreas] = useState<string[]>([]);

  // Customer Lab state
  const [labEnabled, setLabEnabled] = useState(false);
  const [labPreset, setLabPreset] = useState<"" | "soft_launch" | "skeptic_audit" | "holiday_rush">("");
  const [labAudience, setLabAudience] = useState<"general" | "professional" | "gen_z" | "luxury">("general");
  const [labSkepticism, setLabSkepticism] = useState<1 | 5 | 9>(5);
  const [labConcern, setLabConcern] = useState("");
  const [labBrutality, setLabBrutality] = useState(5);
  const [leftRailCollapsed, setLeftRailCollapsed] = useState(false);

  const PRESETS = [
    {
      id: "soft_launch" as const,
      label: "🌱 Soft Launch",
      desc: "Friendly audience, low stress. Best for new listings.",
      audience: "general" as const,
      skepticism: 2 as 1 | 5 | 9,
      concern: "",
      brutality: 2,
    },
    {
      id: "skeptic_audit" as const,
      label: "🔍 Skeptic Audit",
      desc: "Hardened professional buyers demanding evidence.",
      audience: "professional" as const,
      skepticism: 9 as 1 | 5 | 9,
      concern: "trust",
      brutality: 9,
    },
    {
      id: "holiday_rush" as const,
      label: "🎄 Holiday Rush",
      desc: "Gift buyers focused on shipping and delivery.",
      audience: "general" as const,
      skepticism: 5 as 1 | 5 | 9,
      concern: "shipping",
      brutality: 5,
    },
  ] as const;

  function applyPreset(presetId: typeof labPreset) {
    const preset = PRESETS.find((p) => p.id === presetId);
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
    { id: "trust_credibility", label: "🛡️ Trust & Credibility", desc: "\"Will I actually get my order? Is this store legit?\"" },
    { id: "price_value",       label: "💰 Price & Value",        desc: "\"Is this significantly better than the Amazon version?\"" },
    { id: "technical_specs",   label: "🛠️ Technical Specs",      desc: "\"I'm an expert — does this have the features I need?\"" },
    { id: "visual_branding",   label: "🎨 Visual Branding",      desc: "\"Does this brand look real or like a template?\"" },
    { id: "mobile_friction",   label: "📱 Mobile Friction",      desc: "\"Can I buy this easily with one thumb?\"" },
  ] as const;

  function toggleFocus(id: string) {
    setFocusAreas((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    );
  }

  const productOptions = [
    { label: "Select a product…", value: "" },
    ...products.map((p) => ({ label: p.title, value: p.id })),
  ];

  const selectedProductData = products.find((p) => p.id === selectedProduct);
  const canRun = !!selectedProduct && (isDev || (budget?.remaining ?? 0) >= estimatedMt);

  return (
    <Page>
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
            title: "Optionally focus the panel",
            body:
              "Use Focus Areas and the Scenario Lab to tell the panel where to push harder — price, trust, shipping, or specs. You can always leave them blank for a balanced general review.",
          },
        ]}
      />
      <TitleBar
        title="Run Customer Panel Analysis"
        breadcrumbs={[{ content: "Dashboard", url: "/app" }]}
      />
      <Layout>
        <Layout.Section variant="oneThird">
          <Box padding="200">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Steps</Text>
                <Button
                  size="slim"
                  variant="tertiary"
                  onClick={() => setLeftRailCollapsed((v) => !v)}
                  accessibilityLabel={leftRailCollapsed ? "Expand steps" : "Collapse steps"}
                >
                  {leftRailCollapsed ? "Show" : "Hide"}
                </Button>
              </InlineStack>
              {!leftRailCollapsed && (
                <BlockStack gap="200">
                  {[
                    { n: 1, label: "Select product", desc: "Pick a live product from your catalog." },
                    { n: 2, label: "Tune focus", desc: "Optionally choose areas to scrutinize." },
                    { n: 3, label: "Scenario Lab", desc: "Turn on advanced scenarios if needed." },
                    { n: 4, label: "Review results", desc: "Read score, personas and fixes." },
                  ].map((step) => {
                    const active =
                      (step.n === 1 && !selectedProduct) ||
                      (step.n === 2 && !!selectedProduct) ||
                      (step.n >= 3 && !!selectedProduct);
                    return (
                      <Box
                        key={step.n}
                        borderWidth="025"
                        borderRadius="200"
                        padding="200"
                        background={active ? "bg-surface-magic" : "bg-surface"}
                        borderColor={active ? "border-magic" : "border"}
                      >
                        <BlockStack gap="050">
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={active ? "attention" : "info"}>{`${step.n}`}</Badge>
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {step.label}
                            </Text>
                          </InlineStack>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {step.desc}
                          </Text>
                        </BlockStack>
                      </Box>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>
          </Box>
        </Layout.Section>
        <Layout.Section>
          <BlockStack gap="500">
            {error && (
              <Banner tone="critical">
                <Text as="p" variant="bodyMd">{error}</Text>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Select a Product</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Choose any product from your catalog — no theme configuration, no A/B setup, no control group needed. Pick a product and run your panel check right now.
                </Text>

                <Select
                  label="Product"
                  options={productOptions}
                  value={selectedProduct}
                  onChange={setSelectedProduct}
                />

                {selectedProductData && (
                  <InlineStack gap="400" align="start">
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
                )}

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

                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">Focus Areas (optional)</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Select areas to investigate. Panelists apply heightened scrutiny to checked areas. Leave all unchecked for a balanced general review.
                    </Text>
                    {FOCUS_OPTIONS.map((opt) => (
                      <Box key={opt.id}>
                        <Checkbox
                          label={
                            <BlockStack gap="0">
                              <Text as="span" variant="bodyMd">{opt.label}</Text>
                              <Text as="span" variant="bodySm" tone="subdued">{opt.desc}</Text>
                            </BlockStack>
                          }
                          checked={focusAreas.includes(opt.id)}
                          onChange={() => toggleFocus(opt.id)}
                        />
                      </Box>
                    ))}
                  </BlockStack>

                  {/* ── Customer Lab ── */}
                  <Box paddingBlockStart="200">
                    <Divider />
                  </Box>
                  <Box paddingBlockStart="200">
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="050">
                          <Text as="h3" variant="headingSm">🔬 Scenario Comparison Lab <Badge tone="info">PRO</Badge></Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Run a side-by-side comparison: General Public vs. your chosen scenario.
                          </Text>
                        </BlockStack>
                        <Button
                          variant={labEnabled ? "primary" : "secondary"}
                          size="slim"
                          onClick={() => setLabEnabled((v) => !v)}
                        >
                          {labEnabled ? "Lab On" : "Enable Lab"}
                        </Button>
                      </InlineStack>

                      {labEnabled && (
                        <BlockStack gap="400">
                          {/* Presets */}
                          <BlockStack gap="150">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">Quick Scenarios</Text>
                            <InlineStack gap="200">
                              {PRESETS.map((p) => (
                                <Button
                                  key={p.id}
                                  variant={labPreset === p.id ? "primary" : "secondary"}
                                  size="slim"
                                  onClick={() => labPreset === p.id ? clearPreset() : applyPreset(p.id)}
                                >
                                  {p.label}
                                </Button>
                              ))}
                            </InlineStack>
                            {labPreset && (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {PRESETS.find((p) => p.id === labPreset)?.desc}
                              </Text>
                            )}
                          </BlockStack>

                          <Divider />

                          {/* Manual overrides */}
                          <Text as="p" variant="bodyMd" fontWeight="semibold">Manual Overrides</Text>

                          <BlockStack gap="050">
                            <InlineStack gap="100" blockAlign="center">
                              <Text as="p" variant="bodyMd">Target Audience</Text>
                              <Tooltip content="Configures the mindset and priorities of your simulated panel. 'Professional Buyers' care about specs and ROI. 'Gen-Z' decide in seconds based on visuals. 'Luxury' shoppers won't tolerate cheap-looking presentation.">
                                <Icon source={QuestionCircleIcon} />
                              </Tooltip>
                            </InlineStack>
                            <Select
                              label=""
                              labelHidden
                              options={[
                                { label: "🌍 General Public", value: "general" },
                                { label: "💼 Professional Buyers", value: "professional" },
                                { label: "⚡ Gen-Z Shoppers", value: "gen_z" },
                                { label: "💎 Luxury Shoppers", value: "luxury" },
                              ]}
                              value={labAudience}
                              onChange={(v) => { clearPreset(); setLabAudience(v as typeof labAudience); }}
                            />
                          </BlockStack>

                          <BlockStack gap="150">
                            <InlineStack gap="100" blockAlign="center">
                              <Text as="p" variant="bodyMd">Skepticism Level</Text>
                              <Tooltip content="Controls how hard your panel pushes back. 'The Fan' panel gives you the benefit of the doubt. 'The Auditor' actively looks for reasons to reject. Most real shoppers are somewhere in between.">
                                <Icon source={QuestionCircleIcon} />
                              </Tooltip>
                            </InlineStack>
                            <ButtonGroup variant="segmented">
                              <Button
                                pressed={labSkepticism === 1}
                                onClick={() => { clearPreset(); setLabSkepticism(1); }}
                              >
                                😊 The Fan
                              </Button>
                              <Button
                                pressed={labSkepticism === 5}
                                onClick={() => { clearPreset(); setLabSkepticism(5); }}
                              >
                                🤔 Average Buyer
                              </Button>
                              <Button
                                pressed={labSkepticism === 9}
                                onClick={() => { clearPreset(); setLabSkepticism(9); }}
                              >
                                🔍 The Auditor
                              </Button>
                            </ButtonGroup>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {labSkepticism === 1 && "Enthusiast panel — focuses on strengths, forgiving of minor gaps."}
                              {labSkepticism === 5 && "Balanced panel — weighs pros and cons equally."}
                              {labSkepticism === 9 && "Skeptical panel — actively looking for reasons to reject."}
                            </Text>
                          </BlockStack>

                          <Select
                            label="Core Concern (forces panel focus)"
                            options={[
                              { label: "Balanced — no forced focus", value: "" },
                              { label: "💰 Price & Value", value: "price" },
                              { label: "🛡️ Trust & Credibility", value: "trust" },
                              { label: "📦 Shipping & Delivery", value: "shipping" },
                              { label: "🛠️ Product Quality & Specs", value: "quality" },
                            ]}
                            value={labConcern}
                            onChange={(v) => { clearPreset(); setLabConcern(v); }}
                          />

                          {/* Brutality Slider */}
                          <BlockStack gap="150">
                            <InlineStack align="space-between">
                              <InlineStack gap="100" blockAlign="center">
                                <Text as="p" variant="bodyMd">Brutality Level</Text>
                                <Tooltip content="How much evidence your panel demands before voting BUY. Level 1 is lenient — agents give benefit of the doubt. Level 10 is maximum scrutiny — every positive claim must be backed by hard data in the listing.">
                                  <Icon source={QuestionCircleIcon} />
                                </Tooltip>
                              </InlineStack>
                              <Badge tone={labBrutality <= 3 ? "success" : labBrutality <= 6 ? "warning" : "critical"}>
                                {labBrutality <= 3 ? "Lenient" : labBrutality <= 6 ? "Standard" : labBrutality <= 8 ? "Hard" : "Maximum"}
                              </Badge>
                            </InlineStack>
                            <input
                              type="range"
                              min={1}
                              max={10}
                              step={1}
                              value={labBrutality}
                              onChange={(e) => { clearPreset(); setLabBrutality(Number(e.target.value)); }}
                              style={{ width: "100%", accentColor: labBrutality >= 9 ? "#d82c0d" : labBrutality >= 7 ? "#ffd700" : "#008060" }}
                            />
                            <InlineStack align="space-between">
                              <Text as="span" variant="bodySm" tone="subdued">1 — Forgiving</Text>
                              <Text as="span" variant="bodySm" tone="subdued">10 — Maximum Scrutiny</Text>
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {labBrutality <= 3 && "Balanced review — no extra evidence requirements."}
                              {labBrutality >= 4 && labBrutality <= 6 && "Agents must name one specific weakness before voting BUY."}
                              {labBrutality >= 7 && labBrutality <= 8 && "Requires 2 concrete listing signals to vote BUY. Unverified claims = soft REJECT."}
                              {labBrutality >= 9 && "Maximum stress. Agents require 3 forms of evidence per positive claim. Default verdict: REJECT."}
                            </Text>
                          </BlockStack>
                        </BlockStack>
                      )}
                    </BlockStack>
                  </Box>

                  <Box paddingBlockStart="400">
                    <Button
                      variant="primary"
                      submit
                      loading={isSubmitting}
                      disabled={!canRun}
                    >
                      {isSubmitting
                        ? "Starting analysis…"
                        : labEnabled
                        ? "Run Customer Lab Analysis"
                        : "Run Customer Panel Analysis"}
                    </Button>
                  </Box>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Analysis Details</Text>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">Panel size</Text>
                  <Badge>{`${agentCount} agents`}</Badge>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">Budget cost</Text>
                  <Text as="span" variant="bodyMd">{estimatedMt} MT</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">Remaining budget</Text>
                  <Text
                    as="span"
                    variant="bodyMd"
                    tone={(budget?.remaining ?? 0) < estimatedMt ? "critical" : "success"}
                  >
                    {budget?.remaining ?? 0} MT
                  </Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">First results</Text>
                  <Text as="span" variant="bodyMd">~30 seconds</Text>
                </InlineStack>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodyMd">Full report</Text>
                  <Text as="span" variant="bodyMd">5-10 minutes</Text>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">What Your Panel Checks</Text>
                <Text as="p" variant="bodySm" tone="subdued">💰 Price vs. market expectations</Text>
                <Text as="p" variant="bodySm" tone="subdued">🛡️ Trust signals & social proof</Text>
                <Text as="p" variant="bodySm" tone="subdued">📦 Shipping speed & logistics</Text>
                <Text as="p" variant="bodySm" tone="subdued">🖼️ Image quality & first impression</Text>
                <Text as="p" variant="bodySm" tone="subdued">📝 Description clarity & completeness</Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
