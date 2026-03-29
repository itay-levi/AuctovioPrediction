// Friction Report — 3 cards: Price, Trust, Logistics
// Shows dropout % and top objections per category

import { Card, Text, BlockStack, InlineStack, Badge } from "@shopify/polaris";

interface FrictionCategory {
  dropoutPct: number; // % of agents who cited this as rejection reason
  topObjections: string[];
}

interface FrictionData {
  price: FrictionCategory;
  trust: FrictionCategory;
  logistics: FrictionCategory;
}

interface Props {
  friction: FrictionData;
  isPro: boolean; // Pro+ sees all 5 categories; Free sees 3 with blur on extra
}

function severityTone(pct: number): "critical" | "warning" | "success" {
  if (pct >= 40) return "critical";
  if (pct >= 20) return "warning";
  return "success";
}

function FrictionCard({
  title,
  emoji,
  data,
  isPro,
}: {
  title: string;
  emoji: string;
  data: FrictionCategory;
  isPro: boolean;
}) {
  const tone = severityTone(data.dropoutPct);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="h3" variant="headingMd">
            {emoji} {title}
          </Text>
          <Badge tone={tone}>{data.dropoutPct}% friction</Badge>
        </InlineStack>

        {isPro ? (
          <BlockStack gap="100">
            {data.topObjections.map((obj, i) => (
              <Text key={i} as="p" variant="bodySm" tone="subdued">
                • {obj}
              </Text>
            ))}
          </BlockStack>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            {data.topObjections[0] ?? "No objections"}
            {data.topObjections.length > 1 && (
              <span style={{ filter: "blur(4px)", userSelect: "none" }}>
                {" "}
                + {data.topObjections.length - 1} more (upgrade to Pro)
              </span>
            )}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}

export function FrictionReport({ friction, isPro }: Props) {
  return (
    <BlockStack gap="300">
      <FrictionCard
        title="Price Sensitivity"
        emoji="💰"
        data={friction.price}
        isPro={isPro}
      />
      <FrictionCard
        title="Trust & Social Proof"
        emoji="🛡️"
        data={friction.trust}
        isPro={isPro}
      />
      <FrictionCard
        title="Logistics & Delivery"
        emoji="📦"
        data={friction.logistics}
        isPro={isPro}
      />
    </BlockStack>
  );
}
