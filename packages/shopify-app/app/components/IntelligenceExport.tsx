import { useState, useCallback } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ButtonGroup,
  Banner,
  Spinner,
  Divider,
  Box,
} from "@shopify/polaris";

interface AgentLog {
  agentId: string;
  archetype: string;
  phase: number;
  verdict: string;
  reasoning: string;
}

interface IntelligenceExportProps {
  simulationId: string;
  productTitle: string;
  agentLogs: AgentLog[];
  isPro: boolean;
  isEnterprise: boolean;
  existingSynthesis: string | null;
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function generateCsv(logs: AgentLog[]): string {
  const header = "agent_id,archetype,phase,verdict,reasoning";
  const rows = logs.map((l) => {
    const reasoning = `"${l.reasoning.replace(/"/g, '""')}"`;
    return `${l.agentId},${l.archetype},${l.phase},${l.verdict},${reasoning}`;
  });
  return [header, ...rows].join("\n");
}

export function IntelligenceExport({
  simulationId,
  productTitle,
  agentLogs,
  isPro,
  isEnterprise,
  existingSynthesis,
}: IntelligenceExportProps) {
  const fetcher = useFetcher<{ synthesis?: string; error?: string }>();
  const [synthesis, setSynthesis] = useState<string | null>(existingSynthesis);
  const [copied, setCopied] = useState(false);

  const isGenerating = fetcher.state !== "idle";

  // When fetcher completes, capture the synthesis
  if (fetcher.data?.synthesis && synthesis !== fetcher.data.synthesis) {
    setSynthesis(fetcher.data.synthesis);
  }

  const handleCsvExport = useCallback(() => {
    const csv = generateCsv(agentLogs);
    const slug = productTitle.replace(/\s+/g, "-").toLowerCase().slice(0, 30);
    downloadFile(csv, `panel-${slug}-${simulationId.slice(0, 8)}.csv`, "text/csv");
  }, [agentLogs, productTitle, simulationId]);

  const handleJsonExport = useCallback(() => {
    const json = JSON.stringify(
      {
        simulationId,
        productTitle,
        exportedAt: new Date().toISOString(),
        agentLogs,
      },
      null,
      2
    );
    const slug = productTitle.replace(/\s+/g, "-").toLowerCase().slice(0, 30);
    downloadFile(json, `panel-${slug}-${simulationId.slice(0, 8)}.json`, "application/json");
  }, [agentLogs, productTitle, simulationId]);

  const handleCopy = useCallback(() => {
    if (!synthesis) return;
    navigator.clipboard.writeText(synthesis).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [synthesis]);

  const handlePrint = useCallback(() => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`
      <html><head><title>Intelligence Report — ${productTitle}</title>
      <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;line-height:1.6;font-size:16px}
      h1{font-size:24px}pre{white-space:pre-wrap;font-family:inherit}</style></head>
      <body><h1>CustomerPanel AI — Intelligence Report</h1>
      <p><strong>Product:</strong> ${productTitle}</p>
      <p><strong>Generated:</strong> ${new Date().toLocaleDateString()}</p>
      <hr/><pre>${synthesis}</pre></body></html>
    `);
    win.document.close();
    win.print();
  }, [synthesis, productTitle]);

  if (!isPro) {
    return (
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Intelligence Export</Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Export the full agent debate as CSV or JSON, and generate a Compressed Intelligence Report.
          </Text>
          <Button url="/app/billing" variant="primary">Upgrade to Pro to unlock exports</Button>
        </BlockStack>
      </Card>
    );
  }

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Intelligence Export</Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {agentLogs.length} agent entries — export raw data or generate a synthesized report.
        </Text>

        <ButtonGroup>
          <Button onClick={handleCsvExport} icon={undefined}>
            Download CSV
          </Button>
          <Button onClick={handleJsonExport}>
            Download JSON
          </Button>
          {!synthesis && (
            <fetcher.Form method="post" action={`/api/simulation/${simulationId}/synthesize`}>
              <Button
                variant="primary"
                submit
                loading={isGenerating}
                disabled={isGenerating}
              >
                {isGenerating ? "Writing report…" : "Generate Intelligence Report"}
              </Button>
            </fetcher.Form>
          )}
        </ButtonGroup>

        {isGenerating && (
          <InlineStack gap="200" align="start" blockAlign="center">
            <Spinner size="small" />
            <Text as="p" variant="bodySm" tone="subdued">
              Panel moderator is writing the summary…
            </Text>
          </InlineStack>
        )}

        {fetcher.data?.error && (
          <Banner tone="critical">
            <Text as="p" variant="bodyMd">{fetcher.data.error}</Text>
          </Banner>
        )}

        {synthesis && (
          <Box
            borderWidth="025"
            borderColor="border"
            borderRadius="200"
            padding="400"
            background="bg-surface-secondary"
          >
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h3" variant="headingSm">Compressed Intelligence Report</Text>
                <InlineStack gap="200">
                  <Button size="slim" onClick={handleCopy}>
                    {copied ? "Copied!" : "Copy"}
                  </Button>
                  {isEnterprise && (
                    <Button size="slim" onClick={handlePrint}>
                      Download PDF
                    </Button>
                  )}
                  <fetcher.Form method="post" action={`/api/simulation/${simulationId}/synthesize`}>
                    <input type="hidden" name="regenerate" value="1" />
                    <Button size="slim" submit loading={isGenerating}>
                      Regenerate
                    </Button>
                  </fetcher.Form>
                </InlineStack>
              </InlineStack>
              <Divider />
              <Text as="p" variant="bodyMd">
                {synthesis}
              </Text>
            </BlockStack>
          </Box>
        )}
      </BlockStack>
    </Card>
  );
}
