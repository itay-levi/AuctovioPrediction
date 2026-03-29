import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  List,
  Divider,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { createSubscription } from "../services/billing.server";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStore(session.shop);
  return { currentTier: store?.planTier ?? "FREE" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan") as "PRO" | "ENTERPRISE";

  if (!["PRO", "ENTERPRISE"].includes(plan)) {
    return { error: "Invalid plan" };
  }

  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const returnUrl = `${appUrl}/app/billing/callback?plan=${plan}`;

  const confirmationUrl = await createSubscription(admin, plan, returnUrl);
  throw redirect(confirmationUrl);
};

export default function BillingPage() {
  const { currentTier } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";

  return (
    <Page>
      <TitleBar
        title="Upgrade Plan"
      />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {fetcher.data?.error && (
              <Banner tone="critical">
                <Text as="p" variant="bodyMd">{fetcher.data.error}</Text>
              </Banner>
            )}

            <InlineStack gap="400" align="start" wrap>
              {/* FREE */}
              <div style={{ flex: 1, minWidth: 240 }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingLg">Free</Text>
                      {currentTier === "FREE" && <Badge tone="success">Current</Badge>}
                    </InlineStack>
                    <Text as="p" variant="headingXl">$0<Text as="span" variant="bodySm" tone="subdued">/mo</Text></Text>
                    <Divider />
                    <List type="bullet">
                      <List.Item>1 analysis per run (5 agents)</List.Item>
                      <List.Item>3 analyses per month</List.Item>
                      <List.Item>30 MT budget</List.Item>
                      <List.Item>Basic friction report</List.Item>
                    </List>
                    <Button disabled={currentTier === "FREE"} variant="plain">
                      {currentTier === "FREE" ? "Current plan" : "Downgrade"}
                    </Button>
                  </BlockStack>
                </Card>
              </div>

              {/* PRO */}
              <div style={{ flex: 1, minWidth: 240 }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingLg">Pro</Text>
                      {currentTier === "PRO" && <Badge tone="success">Current</Badge>}
                    </InlineStack>
                    <Text as="p" variant="headingXl">$29.90<Text as="span" variant="bodySm" tone="subdued">/mo</Text></Text>
                    <Divider />
                    <List type="bullet">
                      <List.Item>25-agent deep swarm</List.Item>
                      <List.Item>10 analyses per month</List.Item>
                      <List.Item>500 MT budget</List.Item>
                      <List.Item>Full friction breakdown</List.Item>
                      <List.Item>What-If Sandbox</List.Item>
                      <List.Item>7-day free trial</List.Item>
                    </List>
                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value="PRO" />
                      <Button
                        variant="primary"
                        submit
                        loading={isSubmitting}
                        disabled={currentTier === "PRO" || currentTier === "ENTERPRISE"}
                      >
                        {currentTier === "PRO" ? "Current plan" : "Upgrade to Pro"}
                      </Button>
                    </fetcher.Form>
                  </BlockStack>
                </Card>
              </div>

              {/* ENTERPRISE */}
              <div style={{ flex: 1, minWidth: 240 }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingLg">Enterprise</Text>
                      {currentTier === "ENTERPRISE" && <Badge tone="success">Current</Badge>}
                    </InlineStack>
                    <Text as="p" variant="headingXl">$89.00<Text as="span" variant="bodySm" tone="subdued">/mo</Text></Text>
                    <Divider />
                    <List type="bullet">
                      <List.Item>Full 50-agent swarm</List.Item>
                      <List.Item>Unlimited analyses</List.Item>
                      <List.Item>2,000 MT budget</List.Item>
                      <List.Item>Competitor side-by-side</List.Item>
                      <List.Item>Weekly email digest</List.Item>
                      <List.Item>Priority queue</List.Item>
                      <List.Item>7-day free trial</List.Item>
                    </List>
                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value="ENTERPRISE" />
                      <Button
                        variant="primary"
                        submit
                        loading={isSubmitting}
                        disabled={currentTier === "ENTERPRISE"}
                      >
                        {currentTier === "ENTERPRISE" ? "Current plan" : "Upgrade to Enterprise"}
                      </Button>
                    </fetcher.Form>
                  </BlockStack>
                </Card>
              </div>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
