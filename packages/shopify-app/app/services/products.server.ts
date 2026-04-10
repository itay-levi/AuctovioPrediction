// Shopify Admin GraphQL — product fetching with 15-min in-memory cache

interface ProductVariant {
  id: string;
  price: string;
  compareAtPrice: string | null;
  title: string;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: string;
  images: { url: string; altText: string | null }[];
  variants: ProductVariant[];
  onlineStoreUrl: string | null;
  metafields: { key: string; namespace: string; value: string; type: string }[];         // may be [] if shop has no metafields
  sellingPlanGroups: { name: string; sellingPlans: { name: string; description: string | null }[] }[];  // may be [] if no selling plans
}

export interface StoreContext {
  returnPolicy?: string;
  shippingPolicy?: string;
  contactEmail?: string;
}

interface CacheEntry {
  data: ShopifyProduct[];
  expiresAt: number;
}

// Simple in-memory cache (per-process, 15-min TTL)
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000;

const PRODUCT_FIELDS = `
  id
  title
  handle
  descriptionHtml
  productType
  vendor
  tags
  status
  onlineStoreUrl
  images(first: 5) {
    edges { node { url altText } }
  }
  variants(first: 10) {
    edges { node { id price compareAtPrice title } }
  }
  metafields(first: 10) {
    edges { node { key namespace value type } }
  }
  sellingPlanGroups(first: 3) {
    edges {
      node {
        name
        sellingPlans(first: 2) {
          edges { node { name description } }
        }
      }
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges { node { ${PRODUCT_FIELDS} } }
    }
  }
`;

const STORE_CONTEXT_QUERY = `#graphql
  query StoreContext {
    shop {
      contactEmail
      refundPolicy { body }
      shippingPolicy { body }
    }
  }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = { graphql: (query: string, opts?: any) => Promise<Response> };

export async function fetchProducts(
  admin: AdminClient,
  shopDomain: string,
  limit = 50
): Promise<ShopifyProduct[]> {
  const cacheKey = `products:${shopDomain}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const products: ShopifyProduct[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore && products.length < limit) {
    const res = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: Math.min(25, limit - products.length), after: cursor },
    });
    const json = (await res.json()) as {
      data: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: Record<string, unknown> }[];
        };
      };
    };

    const page = json.data.products;
    for (const edge of page.edges) {
      const node = edge.node as {
        id: string;
        title: string;
        handle: string;
        descriptionHtml: string;
        productType: string;
        vendor: string;
        tags: string[];
        status: string;
        onlineStoreUrl: string | null;
        images: { edges: { node: { url: string; altText: string | null } }[] };
        variants: { edges: { node: { id: string; price: string; compareAtPrice: string | null; title: string } }[] };
        metafields?: { edges: { node: { key: string; namespace: string; value: string; type: string } }[] };
        sellingPlanGroups?: { edges: { node: { name: string; sellingPlans: { edges: { node: { name: string; description: string | null } }[] } } }[] };
      };
      products.push({
        id: node.id,
        title: node.title,
        handle: node.handle,
        descriptionHtml: node.descriptionHtml,
        productType: node.productType,
        vendor: node.vendor,
        tags: node.tags,
        status: node.status,
        onlineStoreUrl: node.onlineStoreUrl,
        images: node.images.edges.map((e) => e.node),
        variants: node.variants.edges.map((e) => e.node),
        metafields: (node.metafields?.edges ?? []).map((e) => e.node),
        sellingPlanGroups: (node.sellingPlanGroups?.edges ?? []).map((e) => ({
          name: e.node.name,
          sellingPlans: e.node.sellingPlans.edges.map((s) => s.node),
        })),
      });
    }

    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  cache.set(cacheKey, { data: products, expiresAt: Date.now() + CACHE_TTL_MS });
  return products;
}

export function invalidateProductCache(shopDomain: string) {
  cache.delete(`products:${shopDomain}`);
}

const PRODUCT_BY_ID_QUERY = `#graphql
  query GetProductById($id: ID!) {
    product(id: $id) { ${PRODUCT_FIELDS} }
  }
`;

/**
 * Fetch a single product by its Shopify GID, bypassing the cache.
 * Used for retake tests so the merchant's latest listing changes are captured.
 */
export async function fetchProductById(
  admin: AdminClient,
  productId: string
): Promise<ShopifyProduct | null> {
  const res = await admin.graphql(PRODUCT_BY_ID_QUERY, {
    variables: { id: productId },
  });
  const json = (await res.json()) as {
    data: { product: Record<string, unknown> | null };
  };

  const node = json.data?.product;
  if (!node) return null;

  const images = node.images as { edges: { node: { url: string; altText: string | null } }[] };
  const variants = node.variants as { edges: { node: { id: string; price: string; compareAtPrice: string | null; title: string } }[] };
  const metafieldsRaw = node.metafields as { edges: { node: { key: string; namespace: string; value: string; type: string } }[] } | undefined;
  const sellingPlanGroupsRaw = node.sellingPlanGroups as { edges: { node: { name: string; sellingPlans: { edges: { node: { name: string; description: string | null } }[] } } }[] } | undefined;

  return {
    id: node.id as string,
    title: node.title as string,
    handle: node.handle as string,
    descriptionHtml: node.descriptionHtml as string,
    productType: node.productType as string,
    vendor: node.vendor as string,
    tags: node.tags as string[],
    status: node.status as string,
    onlineStoreUrl: node.onlineStoreUrl as string | null,
    images: images.edges.map((e) => e.node),
    variants: variants.edges.map((e) => e.node),
    metafields: (metafieldsRaw?.edges ?? []).map((e) => e.node),
    sellingPlanGroups: (sellingPlanGroupsRaw?.edges ?? []).map((e) => ({
      name: e.node.name,
      sellingPlans: e.node.sellingPlans.edges.map((s) => s.node),
    })),
  };
}

/**
 * Fetch store-level context: return policy, shipping policy, contact email.
 * These are visible to buyers on every product page and critical for trust evaluation.
 * Returns null on failure — callers should degrade gracefully.
 */
export async function fetchStoreContext(
  admin: AdminClient
): Promise<StoreContext | null> {
  try {
    const res = await admin.graphql(STORE_CONTEXT_QUERY);
    const json = (await res.json()) as {
      data?: {
        shop?: {
          contactEmail?: string;
          refundPolicy?: { body?: string } | null;
          shippingPolicy?: { body?: string } | null;
        };
      };
    };
    const shop = json.data?.shop;
    if (!shop) return null;
    return {
      returnPolicy: shop.refundPolicy?.body || undefined,
      shippingPolicy: shop.shippingPolicy?.body || undefined,
      contactEmail: shop.contactEmail || undefined,
    };
  } catch {
    return null;
  }
}

// Extract catalog metadata for store classification
export function extractCatalogMetadata(products: ShopifyProduct[]) {
  const productTypes = products
    .map((p) => p.productType)
    .filter(Boolean)
    .reduce<Record<string, number>>((acc, t) => {
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});

  const topTypes = Object.entries(productTypes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([t]) => t);

  const vendors = [...new Set(products.map((p) => p.vendor).filter(Boolean))].slice(0, 5);
  const topTitles = products.slice(0, 10).map((p) => p.title);
  const allTags = [...new Set(products.flatMap((p) => p.tags))].slice(0, 20);

  return { topTypes, vendors, topTitles, allTags, totalProducts: products.length };
}
