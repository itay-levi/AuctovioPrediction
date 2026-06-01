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

// Mirror of UNLOCK_REPORT.price from billing.server.ts. We can't import the
// constant directly because billing.server.ts is server-only and this page
// renders client-side too.
const UNLOCK_REPORT_PRICE = "4.99";

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
      <TitleBar title="Plans & Billing" />
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
                  {currentTier === "PRO" || currentTier === "ENTERPRISE"
                    ? ` Your ${currentTier} subscription is still active.`
                    : " Your account is unchanged — you can keep running pay-per-report analyses."}
                </Text>
              </Banner>
            )}
            {justDowngraded && (
              <Banner tone="success" title="Subscription cancelled">
                <Text as="p" variant="bodyMd">
                  Your subscription was cancelled. You can keep running analyses — unlocking the full
                  report goes back to <strong>${UNLOCK_REPORT_PRICE} per report</strong>.
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
              Prices are in USD. Subscriptions are billed monthly with a 7-day free trial and can be
              cancelled any time from your Shopify Partner Dashboard. The single-scan unlock is a
              one-time purchase and never auto-renews.
            </Text>

            {/* ── How pricing works (replaces the Free plan card) ── */}
            {currentTier !== "PRO" && currentTier !== "ENTERPRISE" && (
              <Banner tone="info" title="How CustomerPanel AI is priced">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    Running an analysis is included with installing the app — you always see the
                    score and a top-line preview. You only pay when you want the <strong>full report</strong>
                    (friction breakdown, every panelist&apos;s verdict, ranked action plan, printable PDF).
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Pick whichever fits how often you use it:
                  </Text>
                </BlockStack>
              </Banner>
            )}

            {/* ── Plan cards ── */}
            <InlineStack gap="400" align="start" wrap>

              {/* SINGLE SCAN UNLOCK — pay-per-report */}
              <div style={{ flex: 1, minWidth: 240 }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h2" variant="headingLg">Single Report</Text>
                      <Badge tone="attention">One-time</Badge>
                    </InlineStack>
                    <Text as="p" variant="headingXl">
                      {`$${UNLOCK_REPORT_PRICE}`}
                      <Text as="span" variant="bodySm" tone="subdued"> USD / report</Text>
                    </Text>
                    <Divider />
                    <List type="bullet">
                      <List.Item>Pay only when you want the full report</List.Item>
                      <List.Item>Full friction breakdown with % per category</List.Item>
                      <List.Item>All 5 panelist verdicts &amp; reasoning</List.Item>
                      <List.Item>Prioritised action plan + printable PDF</List.Item>
                      <List.Item>No subscription · no auto-renew</List.Item>
                    </List>
                    <Button
                      variant="primary"
                      url="/app/history"
                      disabled={currentTier === "PRO" || currentTier === "ENTERPRISE"}
                    >
                      {currentTier === "PRO" || currentTier === "ENTERPRISE"
                        ? "Included in your plan"
                        : "Go to a report to unlock"}
                    </Button>
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
                    {currentTier === "PRO" && (
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => setShowDowngradeModal(true)}
                      >
                        Cancel subscription
                      </Button>
                    )}
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
                    {currentTier === "ENTERPRISE" && (
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => setShowDowngradeModal(true)}
                      >
                        Cancel subscription
                      </Button>
                    )}
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
        title="Cancel subscription?"
        primaryAction={{
          content: "Yes, cancel subscription",
          destructive: true,
          onAction: () => {
            const form = new FormData();
            form.append("intent", "downgrade");
            fetcher.submit(form, { method: "POST" });
            setShowDowngradeModal(false);
          },
        }}
        secondaryActions={[
          { content: "Keep subscription", onAction: () => setShowDowngradeModal(false) },
        ]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            Cancelling will immediately end your paid plan. You&apos;ll still be able to run analyses
            and see the score on each one, but unlocking the full report will go back to{" "}
            <strong>${UNLOCK_REPORT_PRICE} per report</strong>. You can re-subscribe at any time —
            though the 7-day free trial only applies once per store.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
