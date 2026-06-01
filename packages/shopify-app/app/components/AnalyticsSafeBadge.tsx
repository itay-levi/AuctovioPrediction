import { useState } from "react";
import { InlineStack, Text, Tooltip } from "@shopify/polaris";

export function AnalyticsSafeBadge() {
  const [active, setActive] = useState(false);

  return (
    <Tooltip
      active={active}
      content="MiroShop agents evaluate your listing data — they never visit your storefront, fire any browser events, or create sessions. Your Google Analytics, Facebook Pixel, and all conversion tracking stay completely clean."
      dismissOnMouseOut
    >
      <button
        type="button"
        aria-label="Analytics-safe — your live traffic is never affected. Click for details."
        onClick={() => setActive((v) => !v)}
        onMouseEnter={() => setActive(true)}
        onMouseLeave={() => setActive(false)}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 6,
          background: "var(--p-color-bg-surface-success)",
          border: "1px solid var(--p-color-border-success)",
          cursor: "default",
          fontFamily: "inherit",
        }}
      >
        <InlineStack gap="100" align="center" blockAlign="center">
          <Text as="span" variant="bodySm" tone="success" fontWeight="semibold">
            ✅ Analytics-Safe
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            — your live traffic is never affected
          </Text>
        </InlineStack>
      </button>
    </Tooltip>
  );
}
