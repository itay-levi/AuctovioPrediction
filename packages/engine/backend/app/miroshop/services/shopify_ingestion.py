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
    # Pricing signals
    compare_at_price_min: Optional[float]  # original price shown crossed-out; discount signal
    discount_pct: Optional[int]            # calculated % off vs compare-at (0-100), if applicable
    # Store-level pages — critical trust signals buyers see outside the product description
    store_return_policy: Optional[str]     # from shop.refundPolicy page
    store_shipping_policy: Optional[str]   # from shop.shippingPolicy page
    # Structured product data
    metafields_text: Optional[str]         # key product specs from Shopify metafields (formatted)
    purchase_options_text: Optional[str]   # special purchasing options (try before you buy, subscriptions, etc.)
    # Confirmed-present flags — set by audit_trust_signals and surfaced to agents
    # so they cannot hallucinate the absence of things that ARE in the listing.
    _confirmed_return_policy: bool
    _confirmed_contact: bool
    _confirmed_specific_return: bool   # e.g. "30 days", "30-day" — more than just "return accepted"
    _confirmed_specific_shipping: bool  # e.g. "3-5 business days", "48-hour" — concrete window


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


def ingest_product(product_json: dict, shop_domain: str, store_context: dict | None = None) -> ProductBrief:
    """
    Convert Shopify product JSON (from Admin GraphQL) into a ProductBrief
    that can be read and debated by the agent panel.

    store_context (optional): store-level data from the Shopify app —
      { "returnPolicy": "...", "shippingPolicy": "...", "contactEmail": "..." }
      These fields represent pages buyers can navigate to from any product page.
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

    # ── Compare-at / discount signal ──────────────────────────────────────────
    compare_at_prices = []
    for v in variants:
        try:
            cap = v.get("compareAtPrice") or v.get("compare_at_price")
            if cap:
                compare_at_prices.append(float(cap))
        except (ValueError, TypeError):
            pass
    compare_at_price_min = min(compare_at_prices) if compare_at_prices else None
    discount_pct = None
    if compare_at_price_min and price_min and compare_at_price_min > price_min:
        discount_pct = round((1 - price_min / compare_at_price_min) * 100)

    # ── Shipping mention from description (broad semantic scan) ───────────────
    # Intentionally broad — we want ANY mention, not just specific formats.
    # The trust audit (LLM-based) determines whether it's specific enough.
    import re as _re
    shipping_info = None
    _ship_re = _re.compile(
        r"[^\n]{0,120}\b(?:ship|deliver|dispatch|freight|express|collection|pickup|courier|postage)\b[^\n]{0,120}",
        _re.IGNORECASE,
    )
    for match in _ship_re.finditer(description_text):
        candidate = match.group(0).strip(" .,;")
        if len(candidate) > 10:
            shipping_info = candidate[:160]
            break

    # ── Metafields — structured product specs ────────────────────────────────
    metafields_text = None
    raw_metafields = product_json.get("metafields", [])
    if isinstance(raw_metafields, dict):
        raw_metafields = raw_metafields.get("edges", [])
    metafield_lines = []
    for mf in raw_metafields:
        node = mf.get("node", mf) if isinstance(mf, dict) else {}
        key = node.get("key", "")
        value = node.get("value", "")
        if key and value and str(value).strip():
            # Format key from snake_case to readable label
            label = key.replace("_", " ").replace("-", " ").title()
            metafield_lines.append(f"{label}: {str(value).strip()}")
    if metafield_lines:
        metafields_text = "\n".join(metafield_lines[:15])

    # ── Purchase options (try before you buy, subscriptions, etc.) ────────────
    purchase_options_text = None
    raw_options = product_json.get("purchaseOptions", [])
    if isinstance(raw_options, dict):
        raw_options = raw_options.get("edges", [])
    option_lines = []
    for opt in raw_options:
        node = opt.get("node", opt) if isinstance(opt, dict) else {}
        name = node.get("name", "")
        description_opt = node.get("description", "")
        if name:
            option_lines.append(f"{name}" + (f" — {description_opt}" if description_opt else ""))
    if option_lines:
        purchase_options_text = "\n".join(option_lines[:5])

    # ── Store-level context from Shopify policies ─────────────────────────────
    store_return_policy = None
    store_shipping_policy = None
    if store_context:
        rp = store_context.get("returnPolicy", "")
        if rp and len(str(rp).strip()) > 20:
            store_return_policy = _strip_html(str(rp))[:600]
        sp = store_context.get("shippingPolicy", "")
        if sp and len(str(sp).strip()) > 20:
            store_shipping_policy = _strip_html(str(sp))[:600]

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
        "compare_at_price_min": compare_at_price_min,
        "discount_pct": discount_pct,
        "store_return_policy": store_return_policy,
        "store_shipping_policy": store_shipping_policy,
        "metafields_text": metafields_text,
        "purchase_options_text": purchase_options_text,
        # Populated by audit_trust_signals after ingest; False until then
        "_confirmed_return_policy": False,
        "_confirmed_contact": False,
        "_confirmed_specific_return": False,
        "_confirmed_specific_shipping": False,
    }


def format_for_debate(brief: ProductBrief, *, compact: bool = False, medium: bool = False) -> str:
    """Format a ProductBrief for agent consumption.

    compact=False (Phase 1): full listing context — title, price, vendor,
        images, variants, availability, description (500 chars), shipping,
        reviews.  ~120-180 tokens.

    medium=True   (Phase 2): title + price + first 200 chars of description
        + confirmed trust signals. ~60 tokens. Gives agents concrete product
        claims to reference in debate without re-sending the full listing.

    compact=True  (Phase 3): minimal recall anchor — title + price only.
        ~15 tokens.  Agents already saw the full listing in Phase 1; re-sending
        it just burns input tokens for no quality gain.
    """
    price_str = (
        f"${brief['price_min']:.2f}"
        if brief["price_min"] == brief["price_max"]
        else f"${brief['price_min']:.2f}–${brief['price_max']:.2f}"
    )

    if medium:
        # Phase 2: title + price + key product claims + confirmed trust signals.
        # Agents need something concrete to reference in debate, and confirmed facts
        # prevent hallucinated-absence claims for things that ARE in the listing.
        desc = (brief["description_text"] or "").strip()
        # Take up to 200 chars at a word boundary
        key_claims = desc[:200].rsplit(" ", 1)[0] if len(desc) > 200 else desc
        confirmed = []
        if brief.get("_confirmed_specific_shipping") or brief.get("shipping_info"):
            shipping = brief.get("shipping_info", "")
            confirmed.append(f"shipping terms confirmed: \"{shipping[:70]}\"" if shipping else "shipping info present")
        if brief.get("_confirmed_specific_return"):
            confirmed.append("specific return window confirmed (e.g. 30-day)")
        elif brief.get("_confirmed_return_policy"):
            confirmed.append("return policy present")
        if brief.get("_confirmed_contact"):
            confirmed.append("contact info present")
        confirmed_line = ("\nCONFIRMED IN LISTING: " + " | ".join(confirmed)) if confirmed else ""
        claims_line = f"\nKey claims: {key_claims}…" if key_claims else ""
        return f"{brief['title']} — {price_str}{claims_line}{confirmed_line}"

    if compact:
        # Phase 3 recall anchor: title + price + any confirmed trust signals.
        confirmed = []
        if brief.get("shipping_info"):
            confirmed.append(f"shipping info present: \"{brief['shipping_info'][:80]}\"")
        if brief.get("_confirmed_return_policy"):
            confirmed.append("return policy present")
        if brief.get("_confirmed_contact"):
            confirmed.append("contact/about-us present")
        confirmed_line = (" | CONFIRMED IN LISTING: " + ", ".join(confirmed)) if confirmed else ""
        return f"{brief['title']} — {price_str}{confirmed_line}"

    # ── Full context (Phase 1) ────────────────────────────────────────────────
    desc = brief["description_text"] or "(No description)"
    reviews = (
        f"{brief['review_count']} reviews, avg {brief['review_rating']}/5"
        if brief["review_count"] is not None and brief["review_count"] > 0
        else None  # omit line entirely — avoid biasing agents against new listings
    )

    # Pricing line — show discount signal if present
    discount_pct = brief.get("discount_pct")
    compare_at = brief.get("compare_at_price_min")
    if compare_at and discount_pct:
        compare_str = f"${compare_at:.2f}"
        price_display = f"{price_str}  [was {compare_str} — {discount_pct}% off]"
    else:
        price_display = price_str

    lines = [
        f"PRODUCT: {brief['title']}",
        f"PRICE: {price_display} | VENDOR: {brief['vendor'] or 'Unknown'}",
        f"IMAGES: {brief['image_count']} | VARIANTS: {brief['variant_count']} | {'In stock' if brief['available'] else 'Out of stock'}",
    ]
    if reviews:
        lines.append(f"REVIEWS: {reviews}")

    if brief.get("purchase_options_text"):
        lines.append(f"PURCHASE OPTIONS: {brief['purchase_options_text']}")

    if brief.get("metafields_text"):
        lines.append(f"PRODUCT SPECS:\n{brief['metafields_text']}")

    if brief.get("shipping_info"):
        lines.append(f"SHIPPING (from description): {brief['shipping_info']}")

    if brief.get("store_shipping_policy"):
        lines.append(f"STORE SHIPPING POLICY:\n{brief['store_shipping_policy']}")

    if brief.get("store_return_policy"):
        lines.append(f"STORE RETURN POLICY:\n{brief['store_return_policy']}")

    lines += ["", desc]

    return "\n".join(lines)


# ── Trust Audit ────────────────────────────────────────────────────────────────

_TRUST_AUDIT_PROMPT = """You are auditing a product listing for trust signals that affect buyer confidence.
Read the listing carefully and answer each question based ONLY on what is explicitly stated.

Product listing:
{listing_text}

Answer every field. If something is not present, use false / empty string. Be precise — wrong answers here will mislead merchants.

Return ONLY valid JSON, no markdown:
{{
  "return_policy": {{
    "present": true_or_false,
    "is_specific": true_or_false,
    "specificity_note": "what makes it specific (timeframe, conditions, process) or empty string",
    "quote": "shortest direct quote that shows this, max 80 chars, or empty string"
  }},
  "shipping": {{
    "present": true_or_false,
    "is_specific": true_or_false,
    "is_lead_time": true_or_false,
    "specificity_note": "what makes it specific (delivery window, cost, free threshold) or empty string",
    "quote": "shortest direct quote, max 80 chars, or empty string"
  }},
  "contact": {{
    "present": true_or_false,
    "quote": "how they can be reached, max 40 chars, or empty string"
  }},
  "trust_badges": {{
    "present": true_or_false,
    "quote": "certification/badge name, max 40 chars, or empty string"
  }},
  "hygiene_guarantee": {{
    "present": true_or_false
  }},
  "reviews": {{
    "embedded_in_listing": true_or_false,
    "approximate_count": 0
  }}
}}

Rules:
- return_policy.is_specific = true if it names a timeframe (any duration), process, or conditions
- shipping.is_specific = true if it names a delivery window (any phrasing), cost structure, or free threshold
- shipping.is_lead_time = true only if this is clearly a made-to-order/handmade product with production time
- Do NOT infer. Only report what is explicitly written."""


def audit_trust_signals(
    product_json: dict,
    brief: ProductBrief,
    product_category=None,
    no_return_override: bool | None = None,
    llm=None,  # fast LLM (8B) — makes audit adaptive to any store's phrasing
) -> dict:
    """
    LLM-based trust signal extraction — reads and interprets the actual listing text.
    Works for any store, language, or phrasing convention (UK, EU, US, etc.).

    Falls back to a minimal keyword scan only if llm is None.

    Returns a dict with:
      trustScore (0-100), individual signal flags, trustKillers list, productCategory.
    Each killer: {signal, label, severity ("high"|"medium"), fix}.
    """
    import json as _json
    import logging as _logging
    _log = _logging.getLogger("miroshop.trust_audit")

    # Category context — LLM intelligence override takes precedence
    if no_return_override is not None:
        no_return_acceptable = no_return_override
    else:
        no_return_acceptable = getattr(product_category, "no_return_acceptable", False)
    shipping_is_lead_time_override = getattr(product_category, "shipping_is_lead_time", False)
    is_hygienic = getattr(product_category, "is_hygienic", False)
    is_perishable = getattr(product_category, "is_perishable", False)
    is_digital = getattr(product_category, "is_digital", False)
    category_label = getattr(product_category, "label", "Standard Retail")

    # Social proof — from product JSON (not extractable by text reading)
    review_count_raw = brief.get("review_count")
    review_count = review_count_raw or 0
    has_reviews = review_count > 0
    has_strong_social_proof = review_count >= 10

    # ── LLM extraction ────────────────────────────────────────────────────────
    extracted = None
    if llm is not None:
        listing_text = (brief.get("description_text") or "").strip()
        # Append store policies — they are visible to buyers even if not in the product description
        _policy_supplement = []
        if brief.get("store_return_policy"):
            _policy_supplement.append(f"[STORE RETURN POLICY PAGE]:\n{brief['store_return_policy']}")
        if brief.get("store_shipping_policy"):
            _policy_supplement.append(f"[STORE SHIPPING POLICY PAGE]:\n{brief['store_shipping_policy']}")
        if _policy_supplement:
            listing_text = listing_text + "\n\n" + "\n\n".join(_policy_supplement)
        if listing_text:
            try:
                prompt = _TRUST_AUDIT_PROMPT.format(listing_text=listing_text[:3000])
                raw = llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.1,
                    max_tokens=400,
                )
                if raw and raw.strip():
                    import re as _re
                    cleaned = _re.sub(r'^```(?:json)?\s*\n?', '', raw.strip(), flags=_re.IGNORECASE)
                    cleaned = _re.sub(r'\n?```\s*$', '', cleaned).strip()
                    extracted = _json.loads(cleaned)
                    _log.info(f"Trust audit LLM extraction succeeded for '{brief.get('title', '?')}'")
            except Exception as _e:
                _log.warning(f"Trust audit LLM extraction failed: {_e} — falling back to keyword scan")
                extracted = None

    # ── Read extracted signals ─────────────────────────────────────────────────
    if extracted:
        ret = extracted.get("return_policy", {})
        ship = extracted.get("shipping", {})
        contact = extracted.get("contact", {})
        badges = extracted.get("trust_badges", {})
        hygiene = extracted.get("hygiene_guarantee", {})

        has_return_policy = bool(ret.get("present", False))
        has_specific_return = bool(ret.get("is_specific", False))
        return_quote = ret.get("quote", "")

        has_shipping_info = bool(ship.get("present", False))
        has_specific_shipping = bool(ship.get("is_specific", False))
        shipping_is_lead_time = shipping_is_lead_time_override or bool(ship.get("is_lead_time", False))
        shipping_quote = ship.get("quote", "") or brief.get("shipping_info", "") or ""

        has_contact = bool(contact.get("present", False))
        has_trust_badges = bool(badges.get("present", False))
        has_hygiene_badge = bool(hygiene.get("present", False))
        has_lead_time_stated = shipping_is_lead_time

    else:
        # ── Minimal keyword fallback (broad signals only, no specific-pattern matching) ──
        # Only used when LLM is unavailable. Uses very broad terms that work across
        # languages and phrasing conventions — does NOT try to detect specificity.
        desc = (brief.get("description_text") or "").lower()
        full_text = (desc + " " + _json.dumps(product_json)).lower()

        has_return_policy = any(k in full_text for k in ["return", "refund", "exchange", "money back"])
        has_specific_return = False   # Cannot reliably detect specificity without LLM
        return_quote = ""
        has_shipping_info = brief.get("shipping_info") is not None or any(
            k in full_text for k in ["ship", "deliver", "dispatch", "delivery"]
        )
        has_specific_shipping = False  # Cannot reliably detect specificity without LLM
        shipping_is_lead_time = shipping_is_lead_time_override
        shipping_quote = brief.get("shipping_info", "") or ""
        has_contact = any(k in full_text for k in ["contact", "email", "support", "about us", "phone"])
        has_trust_badges = any(k in full_text for k in ["certified", "guarantee", "verified", "ssl", "secure"])
        has_hygiene_badge = any(k in full_text for k in ["sealed", "hygiene", "inspected"])
        has_lead_time_stated = any(k in full_text for k in ["made to order", "handcrafted", "production time", "lead time"])

    # Write confirmed-present flags onto the brief for Phase 2/3 agent context
    brief["_confirmed_return_policy"] = has_return_policy
    brief["_confirmed_contact"] = has_contact
    brief["_confirmed_specific_return"] = has_specific_return
    brief["_confirmed_specific_shipping"] = has_specific_shipping

    # ── Build trust killers ────────────────────────────────────────────────────
    trust_killers = []

    # Return policy
    if no_return_acceptable:
        if is_hygienic and not has_hygiene_badge:
            trust_killers.append({
                "signal": "hygiene_guarantee_missing",
                "label": "Add a Hygiene Guarantee Badge",
                "severity": "medium",
                "fix": (
                    f"For {category_label} items, customers expect sealed packaging and a "
                    "quality inspection promise rather than returns. Add a hygiene guarantee "
                    "badge near your Add-to-Cart button (e.g., 'Every item ships sealed & inspected')."
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
                    "we'll replace it free.'"
                ),
            })
        elif is_digital and not has_return_policy:
            trust_killers.append({
                "signal": "digital_no_refund_policy",
                "label": "State Your No-Refund Policy Clearly",
                "severity": "medium",
                "fix": (
                    "Digital products typically have no returns, but state this explicitly. "
                    "Ambiguity causes disputes; a clear no-refund policy prevents them."
                ),
            })
    else:
        if not has_return_policy:
            trust_killers.append({
                "signal": "return_policy",
                "label": "No Return Policy",
                "severity": "high",
                "fix": "Add a return policy to the listing — state the window and conditions. Shoppers abandon carts when they can't find it.",
            })
        elif not has_specific_return:
            trust_killers.append({
                "signal": "vague_return_policy",
                "label": "Vague Return Policy",
                "severity": "medium",
                "fix": "Specify the return window and process. A named timeframe and clear conditions outperform vague 'returns accepted' language.",
            })

    # Shipping
    if shipping_is_lead_time:
        if not has_shipping_info and not has_lead_time_stated:
            trust_killers.append({
                "signal": "no_production_timeline",
                "label": "No Production Timeline Stated",
                "severity": "high",
                "fix": (
                    f"For {category_label} products, customers don't mind waiting — "
                    "they mind not knowing. State exactly how long your craftsmanship takes."
                ),
            })
        elif has_shipping_info and not has_lead_time_stated:
            trust_killers.append({
                "signal": "lead_time_not_explained",
                "label": "Crafting Lead Time Not Explained",
                "severity": "medium",
                "fix": "You mention shipping, but not the production time. Separate them clearly so buyers understand what they're waiting for.",
            })
    else:
        if not has_shipping_info:
            trust_killers.append({
                "signal": "no_shipping_info",
                "label": "No Shipping Information",
                "severity": "high",
                "fix": "Add delivery timeframes and cost to the listing. Shipping ambiguity is the #1 cart abandonment trigger.",
            })
        elif not has_specific_shipping:
            trust_killers.append({
                "signal": "vague_shipping",
                "label": "Vague Shipping Info",
                "severity": "medium",
                "fix": "Add a concrete delivery window and cost or free-shipping threshold.",
            })

    # Social proof
    if not has_reviews:
        if review_count_raw is not None:
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

    # Contact
    if not has_contact:
        trust_killers.append({
            "signal": "no_contact_info",
            "label": "No Contact / About Us",
            "severity": "high",
            "fix": "Add an 'About Us' page link, support email, or chat widget. Buyers need to know a real person is reachable.",
        })

    # Trust badges
    if not has_trust_badges:
        trust_killers.append({
            "signal": "no_trust_badges",
            "label": "No Trust Badges",
            "severity": "medium",
            "fix": "Add a certification badge, payment icons, or a security guarantee near the Add-to-Cart button.",
        })

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
