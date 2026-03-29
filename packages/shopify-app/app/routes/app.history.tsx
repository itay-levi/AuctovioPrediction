import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
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
  IndexTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStore } from "../services/store.server";
import db from "../db.server";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await getStore(session.shop);
  if (!store) throw new Response("Store not found", { status: 404 });

  const simulations = await db.simulation.findMany({
    where: { storeId: store.id }, // TODO: add originalSimulationId: null once Prisma client regenerates
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      productUrl: true,
      status: true,
      score: true,
      phase: true,
      mtCost: true,
      createdAt: true,
    },
  });

  return { simulations };
};

const STATUS_TONE: Record<string, "success" | "critical" | "warning" | "info"> = {
  COMPLETED: "success",
  FAILED: "critical",
  RUNNING: "info",
  PENDING: "warning",
};

function productLabel(url: string) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    return parts[parts.length - 1] || u.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

export default function HistoryPage() {
  const { simulations } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar
        title="Analysis History"
      />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Past Simulations</Text>

              {simulations.length === 0 ? (
                <EmptyState
                  heading="No simulations yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <Button url="/app/simulate" variant="primary">
                    Run your first analysis
                  </Button>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={{ singular: "simulation", plural: "simulations" }}
                  itemCount={simulations.length}
                  headings={[
                    { title: "Product" },
                    { title: "Status" },
                    { title: "Score" },
                    { title: "MT Cost" },
                    { title: "Date" },
                    { title: "" },
                  ]}
                  selectable={false}
                >
                  {simulations.map((sim, i) => (
                    <IndexTable.Row key={sim.id} id={sim.id} position={i}>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {productLabel(sim.productUrl)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={STATUS_TONE[sim.status] ?? "info"}>
                          {sim.status}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {sim.score != null ? (
                          <Text as="span" variant="bodyMd">
                            {sim.score}/100
                          </Text>
                        ) : (
                          <Text as="span" variant="bodySm" tone="subdued">—</Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm">{sim.mtCost} MT</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {new Date(sim.createdAt).toLocaleDateString()}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200">
                          {sim.status === "COMPLETED" && (
                            <Button url={`/app/results/${sim.id}`} size="slim">
                              View
                            </Button>
                          )}
                          {sim.status === "COMPLETED" && (
                            <Button url={`/app/sandbox/${sim.id}`} size="slim">
                              What-If
                            </Button>
                          )}
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}
