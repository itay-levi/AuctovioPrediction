"""
ProductClassifier — rule-based product category detection.

Classifies a product into a category that drives context-aware audit logic.
No LLM call — keyword matching only, runs in <1ms.

Categories:
  standard_retail  — default; normal return/shipping expectations apply
  hygienic         — earrings, underwear, cosmetics; no-returns is industry-normal
  custom_made      — personalised, engraved, made-to-order; shipping = production lead time
  handmade         — artisan goods; slow shipping is a feature not a bug
  perishable       — food, plants, flowers; returns physically impossible
  digital          — downloads, templates; instant delivery, no shipping applies
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ProductCategory:
    category: str            # snake_case id
    label: str               # Human-readable for recommendations e.g. "Handmade Jewelry"
    is_hygienic: bool
    is_custom_made: bool     # includes handmade
    is_perishable: bool
    is_digital: bool
    no_return_acceptable: bool   # True = "no returns" is industry-normal, don't flag it
    shipping_is_lead_time: bool  # True = shipping time = production time, audit accordingly


_HYGIENIC_KEYWORDS = {
    "earring", "piercing", "nose ring", "belly ring", "septum",
    "underwear", "lingerie", "swimwear", "bikini", "swimsuit",
    "thong", "bra", "panty", "panties", "intimate",
    "cosmetic", "makeup", "mascara", "foundation", "lipstick", "lip balm",
    "eyeliner", "eyeshadow", "concealer", "blush",
    "skincare", "serum", "face mask", "face wash", "moisturizer", "toner",
    "exfoliant", "scrub", "cleanser", "sunscreen",
    "tattoo needle", "tattoo ink", "personal care", "hygiene",
    "deodorant", "razor", "shaver", "contact lens",
    "insole", "orthotic", "mouth guard", "retainer",
}

_CUSTOM_MADE_KEYWORDS = {
    "custom", "personalized", "personalised", "engraved", "engraving",
    "made to order", "made-to-order", "bespoke", "commissioned",
    "custom-made", "custom made", "your name", "your text", "your photo",
    "monogram", "monogrammed", "embroidered", "print on demand",
    "custom order", "custom print",
}

_HANDMADE_KEYWORDS = {
    "handmade", "hand-made", "hand made", "handcrafted", "hand-crafted",
    "hand crafted", "artisan", "artisanal", "hand-poured", "hand poured",
    "small batch", "made in my", "made in our", "one-of-a-kind",
    "one of a kind", "limited edition", "hand-sewn", "hand sewn",
    "hand-knit", "hand knit", "hand-woven", "hand woven",
    "hand-painted", "hand painted", "handbuilt", "hand-built",
    "hand built", "studio", "workshop made",
}

_PERISHABLE_KEYWORDS = {
    "food", "organic", "fresh", "edible", "candy", "chocolate", "cake",
    "cookie", "bakery", "jam", "honey", "spice", "herb", "tea", "coffee",
    "plant", "seeds", "flower", "bouquet", "succulent",
    "fruit", "vegetable", "supplement", "vitamin", "protein powder", "snack",
}

_DIGITAL_KEYWORDS = {
    "digital download", "instant download", "printable", "ebook", "e-book",
    "template", "font", "svg file", "vector", "preset", "lightroom preset",
    "plugin", "software license", "mp3", "audio file", "pdf download",
    "digital product", "digital file",
}


def classify_product_category(brief: dict, product_json: dict) -> ProductCategory:
    """
    Classify a product into a category using rule-based keyword matching.
    Checks title, product_type, tags, and description (brief).

    The returned ProductCategory is passed to audit_trust_signals and
    generate_recommendations to enable context-aware logic.
    """
    title = (product_json.get("title") or "").lower()
    product_type = (
        product_json.get("productType") or product_json.get("product_type") or ""
    ).lower()
    tags = " ".join(str(t) for t in (product_json.get("tags") or [])).lower()
    description = (brief.get("description_text") or "").lower()
    merchant_notes = (product_json.get("__merchant_notes__") or "").lower()

    combined = f"{title} {product_type} {tags} {description} {merchant_notes}"

    def _matches(keyword_set: set) -> bool:
        return any(kw in combined for kw in keyword_set)

    is_digital = _matches(_DIGITAL_KEYWORDS)
    is_hygienic = _matches(_HYGIENIC_KEYWORDS)
    is_custom = _matches(_CUSTOM_MADE_KEYWORDS)
    is_handmade = _matches(_HANDMADE_KEYWORDS)
    is_perishable = _matches(_PERISHABLE_KEYWORDS)

    # Also treat merchant notes about garage/workshop production as handmade
    handmade_signals = ["garage", "workshop", "studio", "i make", "i build", "i craft",
                        "we make", "we build", "we craft", "hand made", "handmade"]
    if any(sig in merchant_notes for sig in handmade_signals):
        is_handmade = True

    # Priority order: digital > hygienic > perishable > handmade > custom > standard
    if is_digital:
        return ProductCategory(
            category="digital",
            label="Digital Product",
            is_hygienic=False,
            is_custom_made=False,
            is_perishable=False,
            is_digital=True,
            no_return_acceptable=True,
            shipping_is_lead_time=False,
        )

    if is_hygienic:
        return ProductCategory(
            category="hygienic",
            label="Personal / Hygienic Product",
            is_hygienic=True,
            is_custom_made=is_custom or is_handmade,
            is_perishable=False,
            is_digital=False,
            no_return_acceptable=True,
            shipping_is_lead_time=is_custom or is_handmade,
        )

    if is_perishable:
        return ProductCategory(
            category="perishable",
            label="Perishable / Consumable",
            is_hygienic=False,
            is_custom_made=is_custom or is_handmade,
            is_perishable=True,
            is_digital=False,
            no_return_acceptable=True,
            shipping_is_lead_time=False,
        )

    if is_handmade and not is_custom:
        return ProductCategory(
            category="handmade",
            label="Handmade / Artisan",
            is_hygienic=False,
            is_custom_made=True,
            is_perishable=False,
            is_digital=False,
            no_return_acceptable=False,
            shipping_is_lead_time=True,
        )

    if is_custom or is_handmade:
        return ProductCategory(
            category="custom_made",
            label="Custom / Personalized",
            is_hygienic=False,
            is_custom_made=True,
            is_perishable=False,
            is_digital=False,
            no_return_acceptable=False,
            shipping_is_lead_time=True,
        )

    return ProductCategory(
        category="standard_retail",
        label="Standard Retail",
        is_hygienic=False,
        is_custom_made=False,
        is_perishable=False,
        is_digital=False,
        no_return_acceptable=False,
        shipping_is_lead_time=False,
    )
