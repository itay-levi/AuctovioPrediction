"""
ProductClassifier — LLM-based product category detection.

Classifies a product into a category that drives context-aware audit logic.
Uses a single fast LLM call — works for any store, language, or product type
without hardcoded keyword lists.

Categories:
  standard_retail  — default; normal return/shipping expectations apply
  hygienic         — personal care/intimate items; no-returns is industry-normal
  custom_made      — personalised, engraved, made-to-order; shipping = production lead time
  handmade         — artisan goods; slower shipping is expected
  perishable       — food, consumables, plants; returns physically impossible
  digital          — downloads, templates; instant delivery, no shipping applies

Falls back to standard_retail when:
  - No LLM is provided
  - SKIP_ARCHETYPE_GEN=1 env flag is set
  - LLM call fails for any reason
"""

import json
import logging
import os
import re
from dataclasses import dataclass

logger = logging.getLogger("miroshop.product_classifier")


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


_STANDARD_RETAIL = ProductCategory(
    category="standard_retail",
    label="Standard Retail",
    is_hygienic=False,
    is_custom_made=False,
    is_perishable=False,
    is_digital=False,
    no_return_acceptable=False,
    shipping_is_lead_time=False,
)

_CLASSIFIER_PROMPT = """You are classifying a product for an e-commerce audit system. Answer strictly based on what you know about this type of product.

Product:
- Title: {title}
- Type: {product_type}
- Tags: {tags}
- Description (excerpt): {description}

Answer these 5 questions with true or false only:

1. is_digital: Is this a digital/downloadable product that has no physical shipping? (software, ebooks, templates, presets, audio files, fonts, digital files of any kind)

2. is_hygienic: Is this a personal care or intimate item where accepting returns is physically impossible or unhygienic once used? (items worn against skin/body, personal care devices, cosmetics that touch skin, intimate items)

3. is_perishable: Is this a consumable, food, beverage, supplement, plant, or item that physically cannot be returned once opened or used?

4. is_custom_made: Is this made specifically to order for the buyer? (personalized, engraved with their name/text, custom printed, bespoke, commissioned)

5. is_handmade: Is this handmade, artisan-crafted, or produced in small batches by the seller themselves? (not factory-manufactured)

Respond with ONLY valid JSON, no markdown:
{{
  "is_digital": true or false,
  "is_hygienic": true or false,
  "is_perishable": true or false,
  "is_custom_made": true or false,
  "is_handmade": true or false
}}"""


def classify_product_category(
    brief: dict,
    product_json: dict,
    llm=None,
) -> ProductCategory:
    """
    Classify a product into a category using a single LLM call.
    Falls back to standard_retail if no LLM is provided or the call fails.

    The returned ProductCategory is passed to audit_trust_signals and
    generate_recommendations to enable context-aware logic.
    """
    if llm is None or os.environ.get("SKIP_ARCHETYPE_GEN") == "1":
        return _STANDARD_RETAIL

    title = (product_json.get("title") or "").strip()
    product_type = (
        product_json.get("productType") or product_json.get("product_type") or ""
    ).strip()
    tags = product_json.get("tags") or []
    tags_str = ", ".join(str(t) for t in tags[:10]) if isinstance(tags, list) else str(tags)

    desc_html = product_json.get("descriptionHtml", product_json.get("body_html", ""))
    desc_text = re.sub(r"<[^>]+>", " ", desc_html).strip()[:250]

    prompt = _CLASSIFIER_PROMPT.format(
        title=title or "Unknown Product",
        product_type=product_type or "not specified",
        tags=tags_str or "none",
        description=desc_text or "(no description provided)",
    )

    try:
        raw = llm.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=150,
        )
        if not raw or not raw.strip():
            raise ValueError("Empty response")

        cleaned = raw.strip()
        cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'\n?```\s*$', '', cleaned)

        data = json.loads(cleaned.strip())

        def _bool(key: str) -> bool:
            v = data.get(key, False)
            if isinstance(v, str):
                return v.lower() == "true"
            return bool(v)

        is_digital = _bool("is_digital")
        is_hygienic = _bool("is_hygienic")
        is_perishable = _bool("is_perishable")
        is_custom = _bool("is_custom_made")
        is_handmade = _bool("is_handmade")

        # Priority: digital > hygienic > perishable > handmade > custom > standard
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

        logger.info(f"Classified '{title}' as standard_retail")
        return _STANDARD_RETAIL

    except Exception as e:
        logger.warning(f"Product classification failed for '{title}': {e}. Defaulting to standard_retail.")
        return _STANDARD_RETAIL
