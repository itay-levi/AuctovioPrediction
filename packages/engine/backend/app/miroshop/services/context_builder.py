"""
context_builder — builds per-archetype context strings from shop type + product data.

Called once per simulation before the debate starts.
Output is the `archetype_contexts` dict injected into every agent prompt as niche expertise.
"""

from ..archetypes.niche_contexts import get_niche_contexts


def build_archetype_contexts(
    shop_type: str,
    product_json: dict,
) -> dict[str, str]:
    """
    Combines shop-type niche knowledge with product-specific signals.

    Args:
        shop_type:    Classified niche (e.g. "sporting_goods", "fashion")
        product_json: Raw Shopify product payload

    Returns:
        Dict mapping archetype_id → context string injected into the agent's persona
    """
    base_contexts = get_niche_contexts(shop_type)

    # Extract product signals for richer context
    title = product_json.get("title", "this product")
    vendor = product_json.get("vendor", "")
    product_type = product_json.get("productType") or product_json.get("product_type", "")
    tags = product_json.get("tags", [])
    if isinstance(tags, list):
        tags_str = ", ".join(tags[:8])
    else:
        tags_str = str(tags)

    # Extract price
    variants = product_json.get("variants", [])
    if isinstance(variants, dict):
        variants = variants.get("edges", [])
    prices = []
    for v in variants:
        node = v.get("node", v)
        try:
            prices.append(float(node.get("price", 0)))
        except (ValueError, TypeError):
            pass
    price_str = f"${min(prices):.2f}" if prices else "price unknown"

    # Build a short product signal appended to every archetype context
    product_signal_parts = [f"You are evaluating: '{title}'"]
    if vendor:
        product_signal_parts.append(f"by {vendor}")
    if product_type:
        product_signal_parts.append(f"(type: {product_type})")
    product_signal_parts.append(f"priced at {price_str}.")
    if tags_str:
        product_signal_parts.append(f"Product tags: {tags_str}.")

    product_signal = " ".join(product_signal_parts)

    # Combine: niche knowledge + product signal
    combined: dict[str, str] = {}
    for archetype_id, niche_ctx in base_contexts.items():
        combined[archetype_id] = f"{niche_ctx}\n\n{product_signal}"

    return combined
