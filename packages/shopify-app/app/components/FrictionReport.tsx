import { Card, Text, BlockStack, InlineStack, Badge, Box, Divider } from "@shopify/polaris";

interface FrictionCategory {
  dropoutPct: number;
  topObjections: string[];
}

interface FrictionData {
  price: FrictionCategory;
  trust: FrictionCategory;
  logistics: FrictionCategory;
}

interface Props {
  friction: FrictionData;
  isPro: boolean;
}

type Severity = "critical" | "warning" | "growth";

interface ClassifiedItem {
  severity: Severity;
  category: string;
  emoji: string;
  dropoutPct: number;
  topObjections: string[];
}

function classifyFriction(friction: FrictionData): ClassifiedItem[] {
  const categories: { key: keyof FrictionData; label: string; emoji: string }[] = [
    { key: "price", label: "Price Sensitivity", emoji: "💰" },
    { key: "trust", label: "Trust & Social Proof", emoji: "🛡️" },
    { key: "logistics", label: "Logistics & Delivery", emoji: "📦" },
  ];

  const items: ClassifiedItem[] = categories.map(({ key, label, emoji }) => {
    const data = friction[key];
    let severity: Severity;
    if (data.dropoutPct >= 40) {
      severity = "critical";
    } else if (data.dropoutPct >= 15) {
      severity = "warning";
    } else {
      severity = "growth";
    }
    return { severity, category: label, emoji, dropoutPct: data.dropoutPct, topObjections: data.topObjections };
  });

  const order: Record<Severity, number> = { critical: 0, warning: 1, growth: 2 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);
  return items;
}

const SEVERITY_CONFIG: Record<Severity, {
  label: string;
  emoji: string;
  tone: "critical" | "warning" | "success";
  bg: "bg-surface-critical" | "bg-surface-caution" | "bg-surface-success";
  border: "border-critical" | "border-caution" | "border-success";
  description: string;
}> = {
  critical: {
    label: "Critical",
    emoji: "🔴",
    tone: "critical",
    bg: "bg-surface-critical",
    border: "border-critical",
    description: "Top reason customers would leave",
  },
  warning: {
    label: "Warning",
    emoji: "🟡",
    tone: "warning",
    bg: "bg-surface-caution",
    border: "border-caution",
    description: "Slows the sale but doesn't kill it",
  },
  growth: {
    label: "Strength",
    emoji: "🟢",
    tone: "success",
    bg: "bg-surface-success",
    border: "border-success",
    description: "Working well — double down on this",
  },
};

function FrictionItem({
  item,
  isPro,
}: {
  item: ClassifiedItem;
  isPro: boolean;
}) {
  const config = SEVERITY_CONFIG[item.severity];
  const hasObjections = item.topObjections.length > 0;

  return (
    <Box
      borderWidth="025"
      borderColor={config.border}
      borderRadius="200"
      padding="400"
      background={config.bg}
    >
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="headingSm">{item.emoji} {item.category}</Text>
          </InlineStack>
          <InlineStack gap="200">
            <Badge tone={config.tone}>{config.emoji} {config.label}</Badge>
            <Badge>{item.dropoutPct}% friction</Badge>
          </InlineStack>
        </InlineStack>

        <Text as="p" variant="bodySm" tone="subdued">{config.description}</Text>

        {hasObjections && <Divider />}

        {isPro ? (
          <BlockStack gap="100">
            {item.topObjections.map((obj, i) => (
              <Text key={i} as="p" variant="bodySm">
                • {obj}
              </Text>
            ))}
          </BlockStack>
        ) : (
          hasObjections && (
            <BlockStack gap="100">
              <Text as="p" variant="bodySm">
                • {item.topObjections[0]}
              </Text>
              {item.topObjections.length > 1 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  <span style={{ filter: "blur(4px)", userSelect: "none" }}>
                    + {item.topObjections.length - 1} more insights
                  </span>
                  {" "}(upgrade to Pro)
                </Text>
              )}
            </BlockStack>
          )
        )}
      </BlockStack>
    </Box>
  );
}

export function FrictionReport({ friction, isPro }: Props) {
  const classified = classifyFriction(friction);

  return (
    <BlockStack gap="300">
      {classified.map((item) => (
        <FrictionItem key={item.category} item={item} isPro={isPro} />
      ))}
    </BlockStack>
  );
}
