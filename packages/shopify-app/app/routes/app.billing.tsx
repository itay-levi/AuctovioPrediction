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
  Modal,
  CalloutCard,
} from "@shopify/polaris";
import { useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import { createSubscription, cancelSubscription } from "../services/billing.server";
import { FEATURE_LABELS } from "../services/gates.server";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStore(session.shop);
  const url = new URL(request.url);

  const paymentError  = url.searchParams.get("error") === "payment_not_confirmed";
  const justDowngraded = url.searchParams.get("downgraded") === "1";
  const feature = (url.searchParams.get("feature") ?? null) as keyof typeof FEATURE_LABELS | null;

  return {
    currentTier: store?.planTier ?? "FREE",
    paymentError,
    justDowngraded,
    featureMessage: feature ? FEATURE_LABELS[feature] ?? null : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "downgrade") {
    await cancelSubscription(session.shop);
    throw redirect("/app/billing?downgraded=1");
  }

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
  const { currentTier, paymentError, justDowngraded, featureMessage } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";
  const [showDowngradeModal, setShowDowngradeModal] = useState(false);

  return (
    <Page>
      <TitleBar
        title="Plans & Billing"
        breadcrumbs={[{ content: "Dashboard", url: "/app" }]}
      />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {/* ── Contextual upgrade prompt ── */}
            {featureMessage && currentTier === "FREE" && (
              <CalloutCard
                title="Unlock this feature"
                illustration="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                primaryAction={{ content: "Upgrade to Pro — $29.90 USD/mo", url: "#pro" }}
              >
                <Text as="p" variant="bodyMd">{featureMessage}</Text>
              </CalloutCard>
            )}

            {/* ── Status banners ── */}
            {paymentError && (
              <Banner tone="critical" title="Payment not confirmed">
                <Text as="p" variant="bodyMd">
                  Your subscription could not be verified with Shopify. Please try again or contact support.
                  Your account remains on the {currentTier === "FREE" ? "Free" : currentTier} plan.
                </Text>
              </Banner>
            )}
            {justDowngraded && (
              <Banner tone="success" title="Plan downgraded">
                <Text as="p" variant="bodyMd">
                  Your plan has been downgraded to Free. Changes take effect immediately.
                </Text>
              </Banner>
            )}
            {fetcher.data?.error && (
              <Banner tone="critical">
                <Text as="p" variant="bodyMd">{fetcher.data.error}</Text>
              </Banner>
            )}

            {/* ── Currency & cycle note ── */}
            <Text as="p" variant="bodySm" tone="subdued">
              All prices are in USD and billed monthly. Cancel any time from your Shopify Partner Dashboard.
              Each paid plan includes a 7-day free trial.
            </Text>

            {/* ── Plan cards ── */}
            <InlineStack gap="400" align="start" wrap>

              {/* FREE */}
              <div style={{ flex: 1, minWidth: 240 }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingLg">Free</Text>
                      {currentTier === "FREE" && <Badge tone="success">Current plan</Badge>}
                    </InlineStack>
                    <Text as="p" variant="headingXl">
                      $0
                      <Text as="span" variant="bodySm" tone="subdued"> USD / month</Text>
                    </Text>
                    <Divider />
                    <List type="bullet">
                      <List.Item>5-agent customer panel</List.Item>
                      <List.Item>3 analyses per month</List.Item>
                      <List.Item>30 MT budget</List.Item>
                      <List.Item>Basic friction report</List.Item>
                    </List>
                    {currentTier === "FREE" ? (
                      <Button disabled variant="plain">Current plan</Button>
                    ) : (
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => setShowDowngradeModal(true)}
                      >
                        Downgrade to Free
                      </Button>
                    )}
                  </BlockStack>
                </Card>
              </div>

              {/* PRO */}
              <div id="pro" style={{ flex: 1, minWidth: 240 }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingLg">Pro</Text>
                      <InlineStack gap="200">
                        {currentTier === "PRO" && <Badge tone="success">Current plan</Badge>}
                        {currentTier !== "PRO" && currentTier !== "ENTERPRISE" && (
                          <Badge tone="attention">7-day free trial</Badge>
                        )}
                      </InlineStack>
                    </InlineStack>
                    <Text as="p" variant="headingXl">
                      $29.90
                      <Text as="span" variant="bodySm" tone="subdued"> USD / month</Text>
                    </Text>
                    <Divider />
                    <List type="bullet">
                      <List.Item>25-agent deep swarm</List.Item>
                      <List.Item>10 analyses per month</List.Item>
                      <List.Item>500 MT budget</List.Item>
                      <List.Item>Full friction breakdown</List.Item>
                      <List.Item>What-If Sandbox</List.Item>
                      <List.Item>Price Optimizer</List.Item>
                    </List>
                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value="PRO" />
                      <Button
                        variant="primary"
                        submit
                        loading={isSubmitting}
                        disabled={currentTier === "PRO" || currentTier === "ENTERPRISE"}
                      >
                        {currentTier === "PRO"
                          ? "Current plan"
                          : currentTier === "ENTERPRISE"
                          ? "Already on higher plan"
                          : "Start 7-day free trial"}
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
                      <InlineStack gap="200">
                        {currentTier === "ENTERPRISE" && <Badge tone="success">Current plan</Badge>}
                        {currentTier !== "ENTERPRISE" && (
                          <Badge tone="attention">7-day free trial</Badge>
                        )}
                      </InlineStack>
                    </InlineStack>
                    <Text as="p" variant="headingXl">
                      $89.00
                      <Text as="span" variant="bodySm" tone="subdued"> USD / month</Text>
                    </Text>
                    <Divider />
                    <List type="bullet">
                      <List.Item>Full 50-agent swarm</List.Item>
                      <List.Item>Unlimited analyses</List.Item>
                      <List.Item>2,000 MT budget</List.Item>
                      <List.Item>Competitor side-by-side</List.Item>
                      <List.Item>Weekly email digest</List.Item>
                      <List.Item>Priority queue</List.Item>
                    </List>
                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value="ENTERPRISE" />
                      <Button
                        variant="primary"
                        submit
                        loading={isSubmitting}
                        disabled={currentTier === "ENTERPRISE"}
                      >
                        {currentTier === "ENTERPRISE"
                          ? "Current plan"
                          : "Start 7-day free trial"}
                      </Button>
                    </fetcher.Form>
                  </BlockStack>
                </Card>
              </div>

            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={showDowngradeModal}
        onClose={() => setShowDowngradeModal(false)}
        title="Downgrade to Free?"
        primaryAction={{
          content: "Yes, downgrade",
          destructive: true,
          onAction: () => {
            const form = new FormData();
            form.append("intent", "downgrade");
            fetcher.submit(form, { method: "POST" });
            setShowDowngradeModal(false);
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setShowDowngradeModal(false) },
        ]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            Downgrading to Free will immediately cancel your paid subscription. Your MT budget will reset
            to 30 MT and you will be limited to 3 analyses per month. This cannot be undone — you will
            need to start a new trial if you wish to re-subscribe.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
