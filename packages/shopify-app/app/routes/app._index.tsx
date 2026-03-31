import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  EmptyState,
  Banner,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStore, getMtBudgetStatus, MT_LIMITS, SIM_LIMITS } from "../services/store.server"; // server-only — only used in loader
import { getRecentSimulations } from "../services/simulation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [store, budget, recentSims] = await Promise.all([
    getStore(shopDomain),
    getMtBudgetStatus(shopDomain),
    getStore(shopDomain).then((s) =>
      s ? getRecentSimulations(s.id, 5) : []
    ),
  ]);

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

const ONBOARDING_STEPS = [
  {
    number: "1",
    title: "Pick a product",
    desc: "Select any live product from your Shopify catalog — no setup required.",
    icon: "🛍️",
  },
  {
    number: "2",
    title: "Run the panel",
    desc: "5 AI customer personas stress-test your listing. First results appear in ~30 seconds.",
    icon: "🧑‍🤝‍🧑",
  },
  {
    number: "3",
    title: "Fix what's blocking sales",
    desc: "Get a score, a friction breakdown, and one-click fixes for critical issues.",
    icon: "🎯",
  },
] as const;

export default function Dashboard() {
  const { store, budget, recentSims, mtLimit, simLimit, isDev } = useLoaderData<typeof loader>();

  const tierLabel = budget?.tier ?? "FREE";
  const mtUsed = budget?.used ?? 0;
  const mtPct = Math.round((mtUsed / mtLimit) * 100);
  const isFirstTime = recentSims.length === 0;

  return (
    <Page>
      <TitleBar title="CustomerPanel AI" />
      <BlockStack gap="500">

        {/* Budget warning — hidden in dev and when budget is fine */}
        {mtPct >= 80 && !isDev && (
          <Banner tone={mtPct >= 100 ? "critical" : "warning"}>
            <Text as="p" variant="bodyMd">
              {mtPct >= 100
                ? "Monthly analysis budget exhausted. Upgrade to continue running analyses."
                : `${100 - mtPct}% of your monthly budget remaining.`}
            </Text>
          </Banner>
        )}

        {/* ── First-time welcome screen ── */}
        {isFirstTime ? (
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h1" variant="headingXl">Welcome to CustomerPanel AI 👋</Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    Find out exactly why customers leave your store without buying — and what to fix first.
                  </Text>
                </BlockStack>

                {/* Step cards */}
                <InlineStack gap="400" wrap={false}>
                  {ONBOARDING_STEPS.map((step) => (
                    <Box
                      key={step.number}
                      padding="400"
                      borderWidth="025"
                      borderRadius="200"
                      borderColor="border"
                      background="bg-surface-secondary"
                    >
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="headingLg">{step.icon}</Text>
                          <Badge tone="info">{`Step ${step.number}`}</Badge>
                        </InlineStack>
                        <Text as="p" variant="headingSm">{step.title}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">{step.desc}</Text>
                      </BlockStack>
                    </Box>
                  ))}
                </InlineStack>

                <InlineStack gap="300" blockAlign="center">
                  <Button url="/app/simulate" variant="primary" size="large">
                    Run Your First Analysis →
                  </Button>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Free — no credit card needed. Takes under 10 minutes.
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Right sidebar for first-timers */}
            <Layout>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Your Free Plan Includes</Text>
                    <BlockStack gap="200">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span">✅</Text>
                        <Text as="p" variant="bodyMd">5-agent customer panel per analysis</Text>
                      </InlineStack>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span">✅</Text>
                        <Text as="p" variant="bodyMd">{simLimit} analyses per month</Text>
                      </InlineStack>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span">✅</Text>
                        <Text as="p" variant="bodyMd">Trust audit + friction report</Text>
                      </InlineStack>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span">✅</Text>
                        <Text as="p" variant="bodyMd">AI-generated policy fixes</Text>
                      </InlineStack>
                    </BlockStack>
                    <Button variant="plain" url="/app/billing">
                      See all plans →
                    </Button>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
          </BlockStack>
        ) : (

        /* ── Returning merchant dashboard ── */
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">Your Customer Panel</Text>
                    <Badge tone={tierLabel === "FREE" ? "info" : "success"}>{tierLabel}</Badge>
                  </InlineStack>

                  <Text as="p" variant="bodyMd" tone="subdued">
                    {store?.shopType
                      ? `Dedicated panel for ${store.shopType} customers`
                      : "General retail panel — run an analysis to calibrate"}
                  </Text>

                  <InlineStack gap="400">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">Monthly Budget</Text>
                      <Text as="p" variant="headingLg">{mtUsed} / {mtLimit} MT</Text>
                      <div style={{ height: 6, background: "#E0E0E0", borderRadius: 3 }}>
                        <div style={{
                          height: "100%",
                          width: `${Math.min(100, mtPct)}%`,
                          background: mtPct >= 80 ? "#C62828" : "#2E7D32",
                          borderRadius: 3,
                          transition: "width 0.3s",
                        }} />
                      </div>
                    </BlockStack>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">Analyses This Month</Text>
                      <Text as="p" variant="headingLg">{recentSims.length}</Text>
                    </BlockStack>
                  </InlineStack>

                  <Button url="/app/simulate" variant="primary">Run New Analysis</Button>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Recent Analyses</Text>
                    <Button url="/app/history" variant="plain" size="slim">View all →</Button>
                  </InlineStack>
                  <BlockStack gap="200">
                    {recentSims.map((s) => {
                      const title = (s as { productJson?: { title?: string } }).productJson?.title
                        ?? s.productUrl.split("/").pop()
                        ?? s.productUrl;
                      const canView = s.status === "COMPLETED" || s.status === "RUNNING" || s.status === "PENDING";
                      return (
                        <InlineStack key={s.id} align="space-between" blockAlign="center">
                          <BlockStack gap="0">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {title.length > 40 ? title.slice(0, 40) + "…" : title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {new Date(s.createdAt).toLocaleDateString()} · {s.score != null ? `${s.score}/100` : s.status}
                            </Text>
                          </BlockStack>
                          {canView && (
                            <Button url={`/app/results/${s.id}`} size="slim" variant="plain">
                              {s.status === "COMPLETED" ? "View" : "Watch Live"}
                            </Button>
                          )}
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Your Plan</Text>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">Panel size</Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {tierLabel === "FREE" ? "5 agents" : tierLabel === "PRO" ? "25 agents" : "50 agents"}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">Analyses / month</Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">{simLimit}</Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">Weekly auto-scan</Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {tierLabel === "FREE" ? "1 product" : "All products"}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">Competitor tracking</Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {tierLabel === "ENTERPRISE" ? "Yes" : "—"}
                      </Text>
                    </InlineStack>
                  </BlockStack>
                  {tierLabel !== "ENTERPRISE" && (
                    <Button variant="plain" url="/app/billing">Upgrade plan →</Button>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
        )}
      </BlockStack>
    </Page>
  );
}


export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
