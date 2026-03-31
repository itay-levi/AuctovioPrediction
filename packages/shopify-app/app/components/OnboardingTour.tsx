import { useEffect, useState } from "react";
import {
  Modal,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Box,
  ProgressBar,
} from "@shopify/polaris";

type TourStep = {
  title: string;
  body: string;
  badge?: string;
};

interface OnboardingTourProps {
  storageKey: string;
  steps: TourStep[];
  /** Optional small badge to show in the modal header, e.g. "New" */
  label?: string;
}

export function OnboardingTour({ storageKey, steps, label }: OnboardingTourProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem(storageKey);
    if (!seen) {
      setOpen(true);
    }
  }, [storageKey]);

  if (!steps.length) return null;

  const total = steps.length;
  const step = steps[Math.min(index, total - 1)];
  const isLast = index === total - 1;

  function close(permanent: boolean) {
    setOpen(false);
    if (typeof window !== "undefined" && permanent) {
      window.localStorage.setItem(storageKey, "seen");
    }
  }

  function handleNext() {
    if (isLast) {
      close(true);
    } else {
      setIndex((i) => Math.min(i + 1, total - 1));
    }
  }

  function handleBack() {
    setIndex((i) => Math.max(i - 1, 0));
  }

  return (
    <Modal
      open={open}
      onClose={() => close(true)}
      title={
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="headingMd">
            {step.title}
          </Text>
          {label && (
            <Badge tone="info" size="small">
              {label}
            </Badge>
          )}
        </InlineStack>
      }
      primaryAction={{
        content: isLast ? "Got it" : "Next",
        onAction: handleNext,
      }}
      secondaryActions={[
        ...(index > 0
          ? [
              {
                content: "Back",
                onAction: handleBack,
              },
            ]
          : []),
        {
          content: "Skip tour",
          onAction: () => close(true),
        },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Box paddingBlockEnd="200">
            <ProgressBar
              progress={((index + 1) / total) * 100}
              size="small"
            />
          </Box>
          <Text as="p" variant="bodyMd">
            {step.body}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {index + 1} of {total}
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

