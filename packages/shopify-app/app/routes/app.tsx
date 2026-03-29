import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { upsertStore, setShopType } from "../services/store.server";
import { classifyStoreNiche } from "../services/engine.server";
import { fetchProducts } from "../services/products.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Upsert store record on every auth (keeps access token fresh)
  const store = await upsertStore(session.shop, session.accessToken ?? "");

  // Fire-and-forget niche classification on first install
  if (!store.shopType) {
    // Use a direct GraphQL call to avoid poisoning the product list cache
    Promise.resolve()
      .then(() => fetchProducts(admin as Parameters<typeof fetchProducts>[0], session.shop, 50))
      .then((products) => {
        const titles = products.slice(0, 10).map((p) => p.title);
        return classifyStoreNiche(session.shop, titles);
      })
      .then((niche) => setShopType(session.shop, niche))
      .catch(() => {}); // non-blocking
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/simulate">Run Analysis</Link>
        <Link to="/app/history">History</Link>
        <Link to="/app/billing">Upgrade</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
