"""
ShopifyIngestionService — converts a Shopify product JSON into
a structured seed document that MiroFish agents can debate.

Normalises the raw Shopify product payload into a flat, readable
"product brief" that every archetype can understand regardless of niche.
"""

from typing import TypedDict, Optional
import re


class ProductBrief(TypedDict):
    title: str
    price_min: float
    price_max: float
    currency: str
    description_text: str          # HTML stripped
    image_count: int
    primary_image_url: str
    has_lifestyle_images: bool      # heuristic: >1 image suggests lifestyle
    vendor: str
    product_type: str
    tags: list[str]
    variant_count: int
    available: bool
    handle: str
    url: str
    review_count: Optional[int]    # from metafields if available
    review_rating: Optional[float]
    shipping_info: Optional[str]   # from description or metafields


def _strip_html(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html).strip()


def _extract_price(variants: list) -> tuple[float, float]:
    prices = [float(v.get("price", 0)) for v in variants if v.get("price")]
    if not prices:
        return 0.0, 0.0
    return min(prices), max(prices)


def ingest_product(product_json: dict, shop_domain: str) -> ProductBrief:
    """
    Convert Shopify product JSON (from Admin GraphQL) into a ProductBrief
    that can be read and debated by the agent panel.
    """
    variants = [e["node"] if "node" in e else e for e in product_json.get("variants", {}).get("edges", product_json.get("variants", []))]
    images = [e["node"] if "node" in e else e for e in product_json.get("images", {}).get("edges", product_json.get("images", []))]
    tags = product_json.get("tags", [])

    price_min, price_max = _extract_price(variants)

    description_html = product_json.get("descriptionHtml", product_json.get("body_html", ""))
    description_text = _strip_html(description_html)

    primary_image = images[0].get("url", images[0].get("src", "")) if images else ""

    handle = product_json.get("handle", "")
    url = product_json.get("onlineStoreUrl") or f"https://{shop_domain}/products/{handle}"

    # Heuristic: if description mentions shipping/delivery, surface it
    shipping_info = None
    shipping_keywords = ["ship", "deliver", "dispatch", "days", "express", "free shipping"]
    lower_desc = description_text.lower()
    if any(kw in lower_desc for kw in shipping_keywords):
        # Extract the sentence containing shipping info
        for sentence in description_text.split("."):
            if any(kw in sentence.lower() for kw in shipping_keywords):
                shipping_info = sentence.strip()
                break

    return {
        "title": product_json.get("title", "Unknown Product"),
        "price_min": price_min,
        "price_max": price_max,
        "currency": "USD",
        "description_text": description_text[:1000],  # cap at 1000 chars
        "image_count": len(images),
        "primary_image_url": primary_image,
        "has_lifestyle_images": len(images) > 1,
        "vendor": product_json.get("vendor", ""),
        "product_type": product_json.get("productType", product_json.get("product_type", "")),
        "tags": tags[:15],
        "variant_count": len(variants),
        "available": any(
            v.get("availableForSale", v.get("available", True)) for v in variants
        ),
        "handle": handle,
        "url": url,
        "review_count": None,   # populated from metafields if available
        "review_rating": None,
        "shipping_info": shipping_info,
    }


def format_for_debate(brief: ProductBrief, niche_context: str = "") -> str:
    """
    Format a ProductBrief into the debate seed text given to every agent
    at the start of a simulation.
    """
    price_str = (
        f"${brief['price_min']:.2f}"
        if brief["price_min"] == brief["price_max"]
        else f"${brief['price_min']:.2f} – ${brief['price_max']:.2f}"
    )

    lines = [
        f"PRODUCT: {brief['title']}",
        f"PRICE: {price_str}",
        f"VENDOR: {brief['vendor'] or 'Unknown brand'}",
        f"TYPE: {brief['product_type'] or 'Not specified'}",
        f"IMAGES: {brief['image_count']} image(s) available",
        f"VARIANTS: {brief['variant_count']}",
        f"AVAILABILITY: {'In stock' if brief['available'] else 'Out of stock'}",
        "",
        "DESCRIPTION:",
        brief["description_text"] or "(No description provided)",
    ]

    if brief["shipping_info"]:
        lines += ["", f"SHIPPING INFO: {brief['shipping_info']}"]

    if brief["review_count"] is not None:
        lines += [
            "",
            f"REVIEWS: {brief['review_count']} reviews, avg {brief['review_rating']}/5",
        ]
    else:
        lines += ["", "REVIEWS: No reviews visible on listing"]

    if niche_context:
        lines += ["", f"CONTEXT: {niche_context}"]

    return "\n".join(lines)
