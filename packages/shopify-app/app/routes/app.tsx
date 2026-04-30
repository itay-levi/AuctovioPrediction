import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError, useLocation } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { upsertStore, setShopType } from "../services/store.server";
import { classifyStoreNiche } from "../services/engine.server";
import { fetchProducts } from "../services/products.server";
import shellStyles from "../styles/app-shell.module.css";

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

const NAV_ITEMS: Array<{ to: string; label: string; icon: string; exact?: boolean }> = [
  { to: "/app", label: "Home", icon: "⊞", exact: true },
  { to: "/app/simulate", label: "Run", icon: "▶" },
  { to: "/app/history", label: "History", icon: "◎" },
  { to: "/app/billing", label: "Plans", icon: "◆" },
];

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const location = useLocation();

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
      <div className={shellStyles.shell}>
        <nav className={shellStyles.sidebar} aria-label="App navigation">
          <div className={shellStyles.sidebarLogo} aria-hidden>🤖</div>
          <div className={shellStyles.sidebarDivider} />
          {NAV_ITEMS.map((item) => {
            const isActive = item.exact
              ? location.pathname === item.to
              : location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={[
                  shellStyles.navItem,
                  isActive ? shellStyles.navItemActive : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-current={isActive ? "page" : undefined}
              >
                <span className={shellStyles.navIcon}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className={shellStyles.main}>
          <Outlet />
        </div>
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
