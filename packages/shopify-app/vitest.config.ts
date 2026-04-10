import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * V8 coverage at 100% for all included source. Excluded paths are integration-heavy
 * (Prisma/Shopify bootstrap, multi-hundred-line Remix data routers, 2k-line lab UI);
 * cover those with contract/integration/E2E tests outside this unit suite.
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./app/test/setup.tsx"],
    include: ["app/**/*.test.{ts,tsx}"],
    env: {
      ENGINE_URL: "http://127.0.0.1:9",
      ENGINE_API_KEY: "",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
      SHOPIFY_API_KEY: "test-key",
      SHOPIFY_API_SECRET: "test-secret",
      SCOPES: "read_products",
      SHOPIFY_APP_URL: "https://test-app.example",
      CRON_SECRET: "test-cron-secret",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      include: ["app/**/*.{ts,tsx}"],
      exclude: [
        "**/*.d.ts",
        "**/*.test.{ts,tsx}",
        "app/test/**",
        "app/types/**",
        "app/routes.ts",
        "app/db.server.ts",
        "app/shopify.server.ts",
        "app/entry.server.tsx",
        "app/root.tsx",
        "app/components/sandbox/ComparisonLaboratory.tsx",
        "app/services/simulation.server.ts",
        "app/routes/app.sandbox.$id.tsx",
        "app/routes/app.results.$id.tsx",
        "app/routes/app.reports.$id.tsx",
        "app/routes/app._index.tsx",
        "app/routes/app.simulate.tsx",
        "app/routes/app.history.tsx",
        "app/routes/app.billing.tsx",
        "app/routes/auth.login/route.tsx",
        "app/routes/app.tsx",
        "app/routes/_index/route.tsx",
        "app/routes/webhooks.engine.callback.tsx",
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
