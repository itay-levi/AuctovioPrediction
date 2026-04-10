import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopifyProduct } from "./products.server";
import {
  extractCatalogMetadata,
  fetchProductById,
  fetchProducts,
  invalidateProductCache,
} from "./products.server";

function makeProductResponse(edges: unknown[]) {
  return {
    json: async () => ({
      data: {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null as string | null },
          edges,
        },
      },
    }),
  };
}

describe("products.server", () => {
  beforeEach(() => {
    invalidateProductCache("test-shop");
  });

  it("fetchProducts maps graphql response", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue(
        makeProductResponse([
          {
            node: {
              id: "1",
              title: "Soap",
              handle: "soap",
              descriptionHtml: "<p>x</p>",
              productType: "Beauty",
              vendor: "V",
              tags: ["a"],
              status: "ACTIVE",
              onlineStoreUrl: "https://x",
              images: { edges: [{ node: { url: "u", altText: null } }] },
              variants: { edges: [{ node: { id: "v1", price: "9", title: "Default" } }] },
            },
          },
        ]),
      ),
    };
    const list = await fetchProducts(admin, "test-shop", 50);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Soap");
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    const list2 = await fetchProducts(admin, "test-shop", 50);
    expect(list2).toEqual(list);
    expect(admin.graphql).toHaveBeenCalledTimes(1);
  });

  it("fetchProductById returns null when missing", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({ data: { product: null } }),
      }),
    };
    await expect(fetchProductById(admin, "gid://x")).resolves.toBeNull();
  });

  it("extractCatalogMetadata aggregates", () => {
    const products: ShopifyProduct[] = [
      {
        id: "1",
        title: "A",
        handle: "a",
        descriptionHtml: "",
        productType: "T1",
        vendor: "V1",
        tags: ["x"],
        status: "ACTIVE",
        images: [],
        variants: [],
        onlineStoreUrl: null,
        metafields: [],
        sellingPlanGroups: [],
      },
      {
        id: "2",
        title: "B",
        handle: "b",
        descriptionHtml: "",
        productType: "T1",
        vendor: "V2",
        tags: ["y"],
        status: "ACTIVE",
        images: [],
        variants: [],
        onlineStoreUrl: null,
        metafields: [],
        sellingPlanGroups: [],
      },
    ];
    const m = extractCatalogMetadata(products);
    expect(m.totalProducts).toBe(2);
    expect(m.topTypes).toContain("T1");
    expect(m.topTitles).toEqual(["A", "B"]);
  });
});
