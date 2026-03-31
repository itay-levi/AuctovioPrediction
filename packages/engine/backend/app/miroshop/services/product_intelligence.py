"""
ProductIntelligence — dynamic category briefing for the evaluation panel.

Replaces hardcoded REASONABLE_BUYER_RULES category clauses with a single LLM call
that reasons about the specific product type. Output is cached alongside archetypes
and injected into every agent prompt as {product_context}.

This makes the panel self-calibrating for any product on Shopify without needing
category-specific rules for each of 150k+ product types.
"""

import json
import logging
import re
from dataclasses import dataclass
from typing import List

logger = logging.getLogger("miroshop.product_intelligence")


INTELLIGENCE_PROMPT = """You are a consumer psychology expert. A customer evaluation panel is about to review this product listing. Brief them with accurate category context so they behave like real buyers — not auditors.

Product:
- Title: {title}
- Price: {price}
- Type: {product_type}
- Description (excerpt): {description}

Answer these questions. Be specific to THIS product type. Be honest — a wrong answer here will make the evaluation panel look foolish.

1. CATEGORY — What is this product type in 2-4 words?

2. NO_RETURN_ACCEPTABLE — True or false: is it physically impossible, unhygienic, or legally standard to NOT accept returns for this product once used/opened/consumed?
   True examples: cigars (smoked), underwear (worn), dog food (opened bag), swimwear (tried on), piercing jewelry (used), digital downloads, custom engravings, fresh flowers.
   False examples: clothing (unworn), electronics, furniture, toys, books.
   Answer strictly true or false — no maybe.

3. CATEGORY_NORMS — In 1-2 sentences: what are the industry-standard expectations for buyers of this specific product type?
   Think: return norms, review counts at launch, shipping speed, price transparency.

4. REAL_CONCERNS — What are the 3 most important things a genuine buyer evaluates for THIS product type?
   Must be specific to the product — not generic ("good photos", "clear description").

5. NON_CONCERNS — What 2 things would a real buyer NEVER flag as a problem for this product type?
   Be direct — what objections would make the panel look out of touch with this market?

6. DIFFERENTIATORS — What 3 factors make a buyer choose one product over a competitor in this category?

7. CHECKLIST — List 5 questions a real buyer MUST be able to answer from the listing before purchasing.
   Be highly specific to this exact product type — not generic ("is price clear?").
   Examples for dog food: "What life stage is this formulated for (puppy/adult/senior)?", "What is the first protein ingredient and percentage?"
   Examples for running shoes: "What surface/terrain is this designed for?", "Does it come in wide widths?"

Respond with ONLY valid JSON, no markdown, no explanation:
{{
  "category": "2-4 word label",
  "no_return_acceptable": true or false,
  "category_norms": "1-2 sentences",
  "real_concerns": ["specific concern 1", "specific concern 2", "specific concern 3"],
  "non_concerns": ["unrealistic objection 1", "unrealistic objection 2"],
  "differentiators": ["driver 1", "driver 2", "driver 3"],
  "checklist": ["question 1", "question 2", "question 3", "question 4", "question 5"]
}}"""


@dataclass
class ProductIntelligence:
    category: str
    no_return_acceptable: bool        # True = returns impossible/unhygienic/non-standard for this product
    category_norms: str
    real_concerns: List[str]
    non_concerns: List[str]
    differentiators: List[str]
    checklist: List[str]              # 5 product-specific questions a buyer must answer before purchasing


def generate_product_intelligence(
    llm,
    product_json: dict,
) -> ProductIntelligence | None:
    """
    Run a single LLM call to generate category-specific evaluation context.
    Returns None on failure — caller should proceed without it (graceful degradation).

    Cached by the caller (routes.py) alongside archetypes to avoid repeated calls.
    """
    import os as _os
    if _os.environ.get("SKIP_ARCHETYPE_GEN") == "1":
        # Same env flag used to skip archetype gen on small local models
        return None

    title = product_json.get("title", "Unknown Product")
    vendor = product_json.get("vendor", "")
    product_type = product_json.get("productType") or product_json.get("product_type", "")
    tags = product_json.get("tags", [])
    tags_str = ", ".join(tags[:8]) if isinstance(tags, list) else str(tags)

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
    price_str = f"${min(prices):.2f}" if prices else "price not listed"

    desc_html = product_json.get("descriptionHtml", product_json.get("body_html", ""))
    desc_text = re.sub(r"<[^>]+>", " ", desc_html).strip()[:350]

    prompt = INTELLIGENCE_PROMPT.format(
        title=title,
        price=price_str,
        product_type=product_type or "not specified",
        tags=tags_str or "none",
        description=desc_text or "(no description provided)",
    )

    try:
        raw = llm.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,   # deterministic — same product should give same context
            max_tokens=500,
        )
        if not raw or not raw.strip():
            raise ValueError("Empty response")

        cleaned = raw.strip()
        cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'\n?```\s*$', '', cleaned)

        data = json.loads(cleaned.strip())

        # Parse no_return_acceptable — accept bool, "true"/"false" strings, 1/0
        raw_nra = data.get("no_return_acceptable", False)
        if isinstance(raw_nra, str):
            no_return_acceptable = raw_nra.lower() == "true"
        else:
            no_return_acceptable = bool(raw_nra)

        intelligence = ProductIntelligence(
            category=data.get("category", "General Retail"),
            no_return_acceptable=no_return_acceptable,
            category_norms=data.get("category_norms", ""),
            real_concerns=data.get("real_concerns", [])[:4],
            non_concerns=data.get("non_concerns", [])[:3],
            differentiators=data.get("differentiators", [])[:3],
            checklist=[str(q) for q in data.get("checklist", [])[:5]],
        )

        logger.info(
            f"Product intelligence for '{title}': category={intelligence.category}, "
            f"non_concerns={intelligence.non_concerns}"
        )
        return intelligence

    except Exception as e:
        logger.warning(f"Product intelligence generation failed for '{title}': {e}. Panel will use base rules.")
        return None


def format_product_context(intelligence: ProductIntelligence | None) -> str:
    """
    Format a ProductIntelligence into the {product_context} string injected into every
    agent prompt. Returns empty string if intelligence is None (graceful degradation).
    """
    if intelligence is None:
        return ""

    parts = [f"PRODUCT CONTEXT [{intelligence.category}]:"]

    if intelligence.category_norms:
        parts.append(f"Category norms: {intelligence.category_norms}")

    if intelligence.real_concerns:
        parts.append(f"What real buyers evaluate: {'; '.join(intelligence.real_concerns)}.")

    if intelligence.non_concerns:
        parts.append(
            f"NEVER flag as a problem for this product type: "
            f"{'; '.join(intelligence.non_concerns)}. "
            f"Raising these will make you look like you have never bought this type of product."
        )

    if intelligence.differentiators:
        parts.append(f"What drives the purchase decision: {'; '.join(intelligence.differentiators)}.")

    return "\n".join(parts)
