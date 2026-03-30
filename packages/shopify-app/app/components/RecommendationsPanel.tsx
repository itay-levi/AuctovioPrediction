import {
  BlockStack,
  Card,
  Text,
  Badge,
  Box,
  InlineStack,
  Divider,
  Banner,
} from "@shopify/polaris";

import type { Recommendation, TrustKiller, TrustAudit } from "../types/simulation";
export type { Recommendation, TrustKiller, TrustAudit };

interface Props {
  recommendations: Recommendation[];
  trustAudit: TrustAudit | null;
  score: number;
  productTitle: string;
  /** Score difference vs. previous run for the same product URL (positive = improvement). */
  scoreDelta?: number | null;
  /** Trust killers from the previous run that are no longer present — shown as resolved. */
  resolvedKillers?: TrustKiller[];
}

function priorityTone(p: string): "critical" | "warning" | "info" {
  if (p === "High") return "critical";
  if (p === "Medium") return "warning";
  return "info";
}

function priorityIcon(p: string) {
  if (p === "High") return "🔴";
  if (p === "Medium") return "🟡";
  return "🟢";
}

function deltaText(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

export function RecommendationsPanel({
  recommendations,
  trustAudit,
  score,
  productTitle,
  scoreDelta,
  resolvedKillers = [],
}: Props) {
  if (!recommendations?.length && !trustAudit?.trustKillers?.length && !resolvedKillers.length) {
    return null;
  }

  const hasProgress = scoreDelta != null && scoreDelta !== 0;
  const hasResolvedKillers = resolvedKillers.length > 0;

  // Progress banner — shown when there's a previous run to compare against
  const progressBannerTone = scoreDelta != null && scoreDelta > 0 ? "success" : "warning";
  const progressMessage = hasProgress
    ? scoreDelta! > 0
      ? `Your score improved by ${deltaText(scoreDelta!)} points since your last run — keep going.`
      : `Your score dropped by ${Math.abs(scoreDelta!)} points vs your last run. Check what changed.`
    : null;

  // Main hook line
  const hook = score < 50
    ? `Your "${productTitle}" panel check scored ${score}/100. You are currently losing ${100 - score}% of potential sales due to the issues below.`
    : score < 75
    ? `Your "${productTitle}" scored ${score}/100 — there's room to push past 80 with targeted fixes.`
    : `Your "${productTitle}" scored ${score}/100. A few refinements could push it into the top tier.`;

  return (
    <BlockStack gap="400">

      {/* Progress banner — only shown on re-runs */}
      {progressMessage && (
        <Banner tone={progressBannerTone}>
          <InlineStack gap="300" blockAlign="center">
            <Text as="span" variant="headingLg">
              {scoreDelta! > 0 ? "📈" : "📉"}
            </Text>
            <BlockStack gap="050">
              <Text as="p" variant="bodyMd" fontWeight="semibold">{progressMessage}</Text>
              {hasResolvedKillers && (
                <Text as="p" variant="bodySm">
                  {resolvedKillers.length} trust issue{resolvedKillers.length > 1 ? "s" : ""} resolved since your last check.
                </Text>
              )}
            </BlockStack>
          </InlineStack>
        </Banner>
      )}

      {/* Score hook */}
      <Banner tone={score < 50 ? "critical" : score < 75 ? "warning" : "success"}>
        <Text as="p" variant="bodyMd">{hook}</Text>
        {score < 80 && (
          <Text as="p" variant="bodySm" tone="subdued">
            Once you implement these fixes, click "Run Another Panel Check" to see if your score improves.
          </Text>
        )}
      </Banner>

      {/* Trust Audit card */}
      {(trustAudit?.trustKillers?.length || hasResolvedKillers) ? (
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">🛡️ Trust Audit</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Rule-based scan of your product listing for trust killers that cause cart abandonment.
                </Text>
              </BlockStack>
              {trustAudit && (
                <Badge tone={trustAudit.trustScore >= 80 ? "success" : trustAudit.trustScore >= 50 ? "warning" : "critical"}>
                  {`Trust score: ${trustAudit.trustScore}/100`}
                </Badge>
              )}
            </InlineStack>

            {/* ✅ Resolved killers — issues that were present in the last run but are now fixed */}
            {hasResolvedKillers && (
              <BlockStack gap="200">
                <Text as="p" variant="headingSm">✅ Fixed Since Last Run</Text>
                <BlockStack gap="200">
                  {resolvedKillers.map((killer) => (
                    <Box
                      key={`resolved-${killer.signal}`}
                      padding="300"
                      borderWidth="025"
                      borderRadius="200"
                      borderColor="border-success"
                      background="bg-surface-success"
                    >
                      <InlineStack gap="300" blockAlign="center">
                        <Text as="span" variant="bodyMd">✅</Text>
                        <BlockStack gap="050">
                          <Text as="p" variant="headingSm">{killer.label}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            This issue was flagged in your previous run — it's no longer detected.
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </BlockStack>
            )}

            {/* Current open killers — split into "Fix Now" and "Grows Over Time" */}
            {trustAudit && trustAudit.trustKillers.length > 0 && (() => {
              const fixNow = trustAudit.trustKillers.filter(k => k.category !== "grows_over_time");
              const growsOverTime = trustAudit.trustKillers.filter(k => k.category === "grows_over_time");
              return (
                <BlockStack gap="400">
                  {hasResolvedKillers && <Divider />}

                  {fixNow.length > 0 && (
                    <BlockStack gap="200">
                      <Text as="p" variant="headingSm">🔧 Fix Now</Text>
                      {fixNow.map((killer) => (
                        <Box
                          key={killer.signal}
                          padding="300"
                          borderWidth="025"
                          borderRadius="200"
                          borderColor={killer.severity === "high" ? "border-critical" : "border-caution"}
                          background={killer.severity === "high" ? "bg-surface-critical" : "bg-surface-caution"}
                        >
                          <InlineStack gap="300" blockAlign="start">
                            <Text as="span" variant="bodyMd">{killer.severity === "high" ? "🔴" : "🟡"}</Text>
                            <BlockStack gap="100">
                              <Text as="p" variant="headingSm">{killer.label}</Text>
                              <Text as="p" variant="bodySm">{killer.fix}</Text>
                            </BlockStack>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}

                  {growsOverTime.length > 0 && (
                    <BlockStack gap="200">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="p" variant="headingSm">🌱 Grows Over Time</Text>
                        <Badge tone="info">No action needed now</Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        These signals build automatically as your store makes sales. Focus on "Fix Now" items first.
                      </Text>
                      {growsOverTime.map((killer) => (
                        <Box
                          key={killer.signal}
                          padding="300"
                          borderWidth="025"
                          borderRadius="200"
                          borderColor="border"
                          background="bg-surface-secondary"
                        >
                          <InlineStack gap="300" blockAlign="start">
                            <Text as="span" variant="bodyMd">🌱</Text>
                            <BlockStack gap="100">
                              <Text as="p" variant="headingSm">{killer.label}</Text>
                              <Text as="p" variant="bodySm" tone="subdued">{killer.fix}</Text>
                            </BlockStack>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              );
            })()}
          </BlockStack>
        </Card>
      ) : null}

      {/* AI Recommendations */}
      {recommendations.length > 0 && (
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">🎯 Growth Recommendations</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Prioritized actions based on your panel debate. High = impacts 3+ panelists. Implement top items first.
              </Text>
            </BlockStack>
            <Divider />
            <BlockStack gap="300">
              {recommendations.map((rec, i) => (
                <Box
                  key={i}
                  padding="400"
                  borderWidth="025"
                  borderRadius="200"
                  borderColor={rec.priority === "High" ? "border-critical" : rec.priority === "Medium" ? "border-caution" : "border"}
                  background="bg-surface"
                >
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd">{priorityIcon(rec.priority)}</Text>
                        <Text as="p" variant="headingSm">{rec.title}</Text>
                      </InlineStack>
                      <Badge tone={priorityTone(rec.priority)}>{`${rec.priority} Priority`}</Badge>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="start">
                      <Text as="span" variant="bodySm" tone="subdued">Impact:</Text>
                      <Text as="span" variant="bodySm">{rec.impact}</Text>
                    </InlineStack>
                    <Box
                      padding="200"
                      borderRadius="150"
                      background="bg-surface-secondary"
                    >
                      <Text as="p" variant="bodySm" tone="subdued">
                        Why: {rec.the_why}
                      </Text>
                    </Box>
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
