// Shopify Admin GraphQL — product fetching with 15-min in-memory cache

interface ProductVariant {
  id: string;
  price: string;
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
}

interface CacheEntry {
  data: ShopifyProduct[];
  expiresAt: number;
}

// Simple in-memory cache (per-process, 15-min TTL)
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000;

const PRODUCTS_QUERY = `#graphql
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
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
          variants(first: 5) {
            edges { node { id price title } }
          }
        }
      }
    }
  }
`;

export async function fetchProducts(
  admin: { graphql: (query: string, opts?: unknown) => Promise<Response> },
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
        variants: { edges: { node: ProductVariant }[] };
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
