import { useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { Banner, BlockStack, Button, Text } from "@shopify/polaris";

export function RouteErrorBoundary() {
  const error = useRouteError();

  let title = "Something went wrong";
  let message = "An unexpected error occurred. Please try again.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Not found";
      message = "This page doesn't exist.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = "You don't have permission to view this page.";
    } else {
      title = `Error ${error.status}`;
      message = error.data || message;
    }
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <BlockStack gap="400">
      <Banner tone="critical" title={title}>
        <BlockStack gap="200">
          <Text as="p" variant="bodyMd">{message}</Text>
          <Button onClick={() => window.location.reload()}>Try again</Button>
        </BlockStack>
      </Banner>
    </BlockStack>
  );
}
