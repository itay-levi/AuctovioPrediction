import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { getStore, getMtBudgetStatus, AGENT_COUNTS } from "../services/store.server";
import { fetchProducts } from "../services/products.server";
import {
  canRunSimulation,
  createSimulation,
  estimateSimulationCost,
} from "../services/simulation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const [store, products, budget] = await Promise.all([
    getStore(shopDomain),
    fetchProducts(admin, shopDomain, 50),
    getMtBudgetStatus(shopDomain),
  ]);

  const estimatedMt = budget ? await estimateSimulationCost(budget.tier) : 0;

  return { products, store, budget, estimatedMt };
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

  const simulation = await createSimulation(
    store.id,
    shopDomain,
    store.shopType ?? "general_retail",
    productUrl,
    product,
    budget.tier,
    appUrl
  );

  throw redirect(`/app/results/${simulation.id}`);
};

export default function SimulatePage() {
  const { products, budget, estimatedMt } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selectedProduct, setSelectedProduct] = useState<string>("");

  const isSubmitting = fetcher.state !== "idle";
  const error = fetcher.data?.error;

  const productOptions = [
    { label: "Select a product…", value: "" },
    ...products.map((p) => ({ label: p.title, value: p.id })),
  ];

  const selectedProductData = products.find((p) => p.id === selectedProduct);
  const canRun = !!selectedProduct && (budget?.remaining ?? 0) >= estimatedMt;

  return (
    <Page>
      <TitleBar
        title="Run Customer Panel Analysis"
        breadcrumbs={[{ content: "Dashboard", url: "/app" }]}
      />
      <Layout>
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
                  Your customer panel will honestly critique this listing — price, visuals, description, and delivery.
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
                  <Button
                    variant="primary"
                    submit
                    loading={isSubmitting}
                    disabled={!canRun}
                  >
                    {isSubmitting ? "Starting analysis…" : "Run Customer Panel Analysis"}
                  </Button>
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
                  <Badge>{AGENT_COUNTS[budget?.tier ?? "FREE"]} agents</Badge>
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
