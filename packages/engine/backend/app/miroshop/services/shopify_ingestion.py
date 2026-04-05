"""
ShopifyIngestionService — converts a Shopify product JSON into
a structured seed document that Auctovio agents can debate.

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
    # Confirmed-present flags — set by audit_trust_signals and surfaced to agents
    # so they cannot hallucinate the absence of things that ARE in the listing.
    _confirmed_return_policy: bool
    _confirmed_contact: bool


def _strip_html(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"[ \t]+", " ", text)       # collapse runs of spaces/tabs
    text = re.sub(r"\n{3,}", "\n\n", text)    # collapse excess blank lines
    return text.strip()


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
    raw_variants = product_json.get("variants", [])
    if isinstance(raw_variants, dict):
        raw_variants = raw_variants.get("edges", [])
    variants = [e["node"] if isinstance(e, dict) and "node" in e else e for e in raw_variants]

    raw_images = product_json.get("images", [])
    if isinstance(raw_images, dict):
        raw_images = raw_images.get("edges", [])
    images = [e["node"] if isinstance(e, dict) and "node" in e else e for e in raw_images]
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
        "description_text": description_text[:3000],
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
        # Populated by audit_trust_signals after ingest; False until then
        "_confirmed_return_policy": False,
        "_confirmed_contact": False,
    }


def format_for_debate(brief: ProductBrief, *, compact: bool = False) -> str:
    """Format a ProductBrief for agent consumption.

    compact=False (Phase 1): full listing context — title, price, vendor,
        images, variants, availability, description (500 chars), shipping,
        reviews.  ~120-180 tokens.

    compact=True  (Phase 2/3): minimal recall anchor — title + price only.
        ~15 tokens.  Agents already saw the full listing in Phase 1; re-sending
        it just burns input tokens for no quality gain.
    """
    price_str = (
        f"${brief['price_min']:.2f}"
        if brief["price_min"] == brief["price_max"]
        else f"${brief['price_min']:.2f}–${brief['price_max']:.2f}"
    )

    if compact:
        # Phase 2/3 recall anchor: title + price + any confirmed trust signals.
        # Agents carry Phase 1 beliefs into the debate — including wrong ones.
        # Appending confirmed facts here prevents them from hallucinating absence
        # of things that are actually present in the listing.
        confirmed = []
        if brief.get("shipping_info"):
            confirmed.append(f"shipping info present: \"{brief['shipping_info'][:80]}\"")
        if brief.get("_confirmed_return_policy"):
            confirmed.append("return policy present")
        if brief.get("_confirmed_contact"):
            confirmed.append("contact/about-us present")
        confirmed_line = (" | CONFIRMED IN LISTING: " + ", ".join(confirmed)) if confirmed else ""
        return f"{brief['title']} — {price_str}{confirmed_line}"

    desc = brief["description_text"] or "(No description)"
    reviews = (
        f"{brief['review_count']} reviews, avg {brief['review_rating']}/5"
        if brief["review_count"] is not None and brief["review_count"] > 0
        else None  # omit line entirely — avoid biasing agents against new listings
    )

    lines = [
        f"PRODUCT: {brief['title']}",
        f"PRICE: {price_str} | VENDOR: {brief['vendor'] or 'Unknown'}",
        f"IMAGES: {brief['image_count']} | VARIANTS: {brief['variant_count']} | {'In stock' if brief['available'] else 'Out of stock'}",
    ]
    if reviews:
        lines.append(f"REVIEWS: {reviews}")

    if brief["shipping_info"]:
        lines.append(f"SHIPPING: {brief['shipping_info']}")

    lines += ["", desc]

    return "\n".join(lines)


# ── Trust Audit ────────────────────────────────────────────────────────────────

def audit_trust_signals(
    product_json: dict,
    brief: ProductBrief,
    product_category=None,  # ProductCategory dataclass from product_classifier
    no_return_override: bool | None = None,  # LLM-determined override (takes precedence)
) -> dict:
    """
    Rule-based analysis of trust signals present (or missing) in the product listing.
    No LLM call — runs purely from data we already have.

    Returns a dict with:
      trustScore (0-100), individual signal flags, trustKillers list, and productCategory.
    Each killer has: signal, label, severity ("high"|"medium"), fix (actionable copy).

    When product_category is provided the audit applies context-aware rules:
      - hygienic/perishable/digital: "No Return Policy" is industry-normal — replaced with
        a badge opportunity rather than a negative flag.
      - custom_made/handmade: Shipping critique shifts from speed → transparency
        (tell the customer exactly how long production takes, not "add faster shipping").
    """
    import json as _json

    # Extract category context — LLM override takes precedence over keyword classifier
    if no_return_override is not None:
        no_return_acceptable = no_return_override
    else:
        no_return_acceptable = getattr(product_category, "no_return_acceptable", False)
    shipping_is_lead_time = getattr(product_category, "shipping_is_lead_time", False)
    is_hygienic = getattr(product_category, "is_hygienic", False)
    is_perishable = getattr(product_category, "is_perishable", False)
    is_digital = getattr(product_category, "is_digital", False)
    category_label = getattr(product_category, "label", "Standard Retail")

    desc = (brief.get("description_text") or "").lower()
    full_text = (desc + " " + _json.dumps(product_json)).lower()

    # 1 — Return / refund policy
    return_kws = ["return", "refund", "money back", "satisfaction guaranteed", "exchange policy"]
    specific_return_kws = ["30-day", "60-day", "day return", "day refund", "hassle-free return"]
    hygiene_badge_kws = ["hygiene guarantee", "sealed", "quality inspection", "health safety",
                         "hygiene policy", "inspected before", "sealed packaging"]
    has_return_policy = any(k in full_text for k in return_kws)
    has_specific_return = any(k in full_text for k in specific_return_kws)
    has_hygiene_badge = any(k in full_text for k in hygiene_badge_kws)

    # 2 — Shipping / production timeline
    shipping_kws = ["ship", "deliver", "dispatch", "free shipping", "express", "days"]
    specific_shipping_kws = ["3-5 day", "7-10 day", "same day", "next day",
                             "free shipping on", "arrives in"]
    lead_time_kws = ["lead time", "production time", "processing time", "handcraft",
                     "made within", "ready in", "takes approximately", "allow",
                     "weeks to make", "days to make", "crafting time", "build time",
                     "make time", "created to order", "crafted to order"]
    has_shipping_info = brief.get("shipping_info") is not None or any(k in full_text for k in shipping_kws)
    has_specific_shipping = any(k in full_text for k in specific_shipping_kws)
    has_lead_time_stated = any(k in full_text for k in lead_time_kws)

    # 3 — Social proof
    review_count_raw = brief.get("review_count")  # None = not fetched, 0 = confirmed empty
    review_count = review_count_raw or 0
    has_reviews = review_count > 0
    has_strong_social_proof = review_count >= 10

    # 4 — Contact clarity
    contact_kws = ["contact us", "email us", "phone", "address", "about us",
                   "support", "live chat", "call us"]
    has_contact = any(k in full_text for k in contact_kws)

    # 5 — Technical trust badges
    trust_badge_kws = ["secure", "ssl", "encrypted", "visa", "mastercard", "paypal",
                       "amex", "guaranteed", "certified", "verified"]
    has_trust_badges = any(k in full_text for k in trust_badge_kws)

    # Write confirmed-present flags back onto the brief so format_for_debate(compact=True)
    # can surface them to Phase 2/3 agents and prevent hallucinated-absence claims.
    brief["_confirmed_return_policy"] = has_return_policy
    brief["_confirmed_contact"] = has_contact

    trust_killers = []

    # ── Return policy (context-aware) ──────────────────────────────────────────
    if no_return_acceptable:
        # For hygienic, perishable, digital products a missing return policy is NORMAL.
        # Suggest a category-appropriate trust badge instead of flagging it negatively.
        if is_hygienic and not has_hygiene_badge:
            trust_killers.append({
                "signal": "hygiene_guarantee_missing",
                "label": "Add a Hygiene Guarantee Badge",
                "severity": "medium",
                "fix": (
                    f"For {category_label} items, customers expect sealed packaging and a "
                    "quality inspection promise rather than returns. Add a 'Hygiene Guarantee' "
                    "badge near your Add-to-Cart button (e.g., 'Every item ships sealed & "
                    "inspected'). This replaces the trust gap that a return policy normally fills."
                ),
            })
        elif is_perishable and not has_return_policy:
            trust_killers.append({
                "signal": "freshness_guarantee_missing",
                "label": "Add a Freshness / Quality Guarantee",
                "severity": "medium",
                "fix": (
                    "Perishable items can't be returned, but buyers need reassurance. "
                    "Add a Freshness Guarantee: 'If it doesn't arrive in perfect condition, "
                    "we'll replace it free.' This turns the trust gap into a brand strength."
                ),
            })
        elif is_digital and not has_return_policy:
            trust_killers.append({
                "signal": "digital_no_refund_policy",
                "label": "State Your No-Refund Policy Clearly",
                "severity": "medium",
                "fix": (
                    "Digital products typically have no returns, but state this explicitly: "
                    "'Due to the digital nature of this product, all sales are final. "
                    "Contact us if you experience any issues.' Ambiguity causes disputes; "
                    "clear policy prevents them."
                ),
            })
    else:
        # Standard retail — flag missing or vague return policy as usual
        if not has_return_policy:
            trust_killers.append({
                "signal": "return_policy",
                "label": "No Return Policy",
                "severity": "high",
                "fix": "Add a specific return policy to the description (e.g., '30-day hassle-free returns'). Shoppers abandon carts when they can't find it.",
            })
        elif not has_specific_return:
            trust_killers.append({
                "signal": "vague_return_policy",
                "label": "Vague Return Policy",
                "severity": "medium",
                "fix": "Specify the exact return window and process. '30-day returns, no questions asked' outperforms 'returns accepted'.",
            })

    # ── Shipping / production timeline (context-aware) ─────────────────────────
    if shipping_is_lead_time:
        # Custom/handmade: critique is TRANSPARENCY, not speed.
        # Customers accept long lead times when they understand why.
        if not has_shipping_info and not has_lead_time_stated:
            trust_killers.append({
                "signal": "no_production_timeline",
                "label": "No Production Timeline Stated",
                "severity": "high",
                "fix": (
                    f"For {category_label} products, customers don't mind waiting — "
                    "they mind not knowing. State exactly how long your craftsmanship takes: "
                    "'Each piece is handcrafted to order and ships within 10–14 business days.' "
                    "This turns a potential objection into a badge of quality."
                ),
            })
        elif has_shipping_info and not has_lead_time_stated:
            trust_killers.append({
                "signal": "lead_time_not_explained",
                "label": "Crafting Lead Time Not Explained",
                "severity": "medium",
                "fix": (
                    "You mention shipping, but not the production time. Separate them clearly: "
                    "'Made to order: 7–10 days crafting + 3–5 days shipping.' "
                    "Buyers who understand why it takes longer convert at higher rates."
                ),
            })
    else:
        # Standard shipping critique — speed and specificity
        if not has_shipping_info:
            trust_killers.append({
                "signal": "no_shipping_info",
                "label": "No Shipping Information",
                "severity": "high",
                "fix": "Add delivery timeframes and cost to the description. Shipping ambiguity is the #1 cart abandonment trigger.",
            })
        elif not has_specific_shipping:
            trust_killers.append({
                "signal": "vague_shipping",
                "label": "Vague Shipping Info",
                "severity": "medium",
                "fix": "Add specific delivery windows (e.g., 'Ships in 3-5 business days, free over $50').",
            })

    # ── Social proof ───────────────────────────────────────────────────────────
    if not has_reviews:
        if review_count_raw is None:
            # Review count not in product JSON (common for new stores / external review apps).
            # We cannot confirm zero reviews, so we don't penalise — the agent will evaluate
            # listing quality directly without a social-proof handicap.
            pass
        else:
            # Explicitly 0 reviews — medium severity (time-based, not a listing flaw)
            trust_killers.append({
                "signal": "no_reviews",
                "label": "No Customer Reviews Yet",
                "severity": "medium",
                "category": "grows_over_time",
                "fix": "Send a post-purchase review request to your first buyers. Even 3 genuine reviews significantly improve conversion.",
            })
    elif not has_strong_social_proof:
        trust_killers.append({
            "signal": "few_reviews",
            "label": f"Only {review_count} Review(s)",
            "severity": "medium",
            "category": "grows_over_time",
            "fix": f"You have {review_count} review(s). Aim for 10+ — send a follow-up email to recent buyers.",
        })

    # ── Contact clarity ────────────────────────────────────────────────────────
    if not has_contact:
        trust_killers.append({
            "signal": "no_contact_info",
            "label": "No Contact / About Us",
            "severity": "high",
            "fix": "Add an 'About Us' page link, support email, or chat widget. Buyers need to know a real person is reachable.",
        })

    # ── Trust badges ───────────────────────────────────────────────────────────
    if not has_trust_badges:
        trust_killers.append({
            "signal": "no_trust_badges",
            "label": "No Trust Badges",
            "severity": "medium",
            "fix": "Add SSL badge, accepted payment icons (Visa/PayPal), or a security guarantee near the Add-to-Cart button.",
        })

    # Score: start at 100, deduct 20 per high killer and 10 per medium
    penalty = sum(20 if k["severity"] == "high" else 10 for k in trust_killers)
    trust_score = max(0, 100 - penalty)

    return {
        "trustScore": trust_score,
        "productCategory": getattr(product_category, "category", "standard_retail"),
        "productCategoryLabel": category_label,
        "hasReturnPolicy": has_return_policy,
        "hasSpecificReturn": has_specific_return,
        "hasShippingInfo": has_shipping_info,
        "hasSpecificShipping": has_specific_shipping,
        "hasLeadTimeStated": has_lead_time_stated,
        "hasReviews": has_reviews,
        "hasStrongSocialProof": has_strong_social_proof,
        "hasContact": has_contact,
        "hasTrustBadges": has_trust_badges,
        "trustKillers": trust_killers,
    }
