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

export default function Dashboard() {
  const { store, budget, recentSims, mtLimit, simLimit, isDev } = useLoaderData<typeof loader>();

  const tierLabel = budget?.tier ?? "FREE";
  const mtUsed = budget?.used ?? 0;
  const mtPct = Math.round((mtUsed / mtLimit) * 100);

  return (
    <Page>
      <TitleBar title="CustomerPanel AI" />
      <BlockStack gap="500">

        {/* Budget bar — hidden in development */}
        {mtPct >= 80 && !isDev && (
          <Banner tone={mtPct >= 100 ? "critical" : "warning"}>
            <Text as="p" variant="bodyMd">
              {mtPct >= 100
                ? "Monthly analysis budget exhausted. Upgrade to continue running analyses."
                : `${100 - mtPct}% of your monthly budget remaining.`}
            </Text>
          </Banner>
        )}

        <Layout>
          {/* Left: stats */}
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      Your Customer Panel
                    </Text>
                    <Badge tone={tierLabel === "FREE" ? "info" : "success"}>
                      {tierLabel}
                    </Badge>
                  </InlineStack>

                  <Text as="p" variant="bodyMd" tone="subdued">
                    {store?.shopType
                      ? `Dedicated panel for ${store.shopType} customers`
                      : "General retail panel (run your first analysis to calibrate)"}
                  </Text>

                  <InlineStack gap="400">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">Monthly Budget</Text>
                      <Text as="p" variant="headingLg">
                        {mtUsed} / {mtLimit} MT
                      </Text>
                      <div style={{ height: 6, background: "#E0E0E0", borderRadius: 3 }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.min(100, mtPct)}%`,
                            background: mtPct >= 80 ? "#C62828" : "#2E7D32",
                            borderRadius: 3,
                            transition: "width 0.3s",
                          }}
                        />
                      </div>
                    </BlockStack>

                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">Analyses Run</Text>
                      <Text as="p" variant="headingLg">{recentSims.length}</Text>
                    </BlockStack>
                  </InlineStack>

                  <Button url="/app/simulate" variant="primary">
                    Run New Analysis
                  </Button>
                </BlockStack>
              </Card>

              {/* Recent simulations */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Recent Analyses</Text>
                    {recentSims.length > 0 && (
                      <Button url="/app/history" variant="plain" size="slim">View all →</Button>
                    )}
                  </InlineStack>
                  {recentSims.length === 0 ? (
                    <EmptyState
                      heading="No analyses yet"
                      image=""
                      action={{ content: "Run your first analysis", url: "/app/simulate" }}
                    >
                      <Text as="p" variant="bodyMd">
                        Select a product and let your dedicated customer panel review it.
                      </Text>
                    </EmptyState>
                  ) : (
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
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          {/* Right: plan info */}
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
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {simLimit}
                      </Text>
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
                    <Button variant="plain" url="/app/billing">
                      Upgrade plan →
                    </Button>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">How It Works</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    1. Select a product from your catalog
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    2. Your dedicated customer panel reviews it honestly
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    3. Get a Customer Confidence Score + friction breakdown
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    4. Fix the issues, re-run, watch your score improve
                  </Text>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}


export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
