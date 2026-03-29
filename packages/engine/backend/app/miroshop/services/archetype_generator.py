"""
ArchetypeGenerator — dynamically generates a product-specific customer panel using the LLM.

Instead of using a fixed list of 5 generic archetypes, this asks the LLM:
"Who are the real people who would actually consider buying this specific product?"

A snowboard listing gets: "The Weekend Warrior", "The Gear Snob",
  "The Parent Buying for Their Teenager", etc.
A dog food listing gets: "The Anxious First-Time Dog Owner",
  "The Multi-Dog Household on Budget", etc.

The static definitions.py archetypes remain as a fallback if generation fails.
"""

import json
import logging
from dataclasses import dataclass, field
from typing import List

logger = logging.getLogger("miroshop.archetype_generator")

# Schema returned by the LLM for each generated archetype
GENERATE_ARCHETYPES_PROMPT = """You are designing a customer focus group to evaluate a product listing.

Product details:
- Title: {title}
- Price: {price}
- Vendor: {vendor}
- Type: {product_type}
- Tags: {tags}
- Description (excerpt): {description}

Generate exactly {count} distinct customer archetypes who would realistically consider buying THIS specific product.
These must be real, specific people — not generic consumer types. Tailor them entirely to this product.

For each archetype, think:
- Who is this specific person? (age, life situation, WHY they are looking at this product right now)
- What will they scrutinise most for THIS product?
- What would make them immediately reject it?
- How do they argue in a group — are they emotional, analytical, sceptical, enthusiastic?

CRITICAL RULES:
1. Make archetypes specific to this product — a snowboard gets snowboard buyers, dog food gets dog owners
2. Include at least one sceptic/dissenter who will push back even if others are positive
3. Include diversity in price sensitivity, tech-savviness, and buying motivation
4. rejection_threshold must reference specific things that could be wrong about THIS listing
5. Each persona must feel like a genuinely different person, not a variation of the same type

Respond with ONLY valid JSON — no markdown, no explanation:
{{
  "archetypes": [
    {{
      "id": "snake_case_id",
      "name": "Short Display Name (2-4 words)",
      "emoji": "single relevant emoji",
      "persona": "2-3 sentences: who they are, their life context, why they're shopping for this product right now",
      "focus_areas": ["what they scrutinise most — product-specific"],
      "rejection_threshold": "Specific conditions that make them REJECT — reference realistic issues with this type of product",
      "debate_style": "1 sentence: how they argue — emotional/analytical/sceptical/enthusiastic, what angle they take",
      "temperature": 0.5
    }}
  ]
}}"""


@dataclass
class DynamicArchetype:
    """A dynamically generated archetype — same interface as the static Archetype dataclass."""
    id: str
    name: str
    emoji: str
    base_persona: str          # maps from "persona" in LLM output
    rejection_threshold: str
    debate_style: str
    focus_areas: List[str] = field(default_factory=list)
    temperature: float = 0.7
    sub_personas: List[str] = field(default_factory=list)  # empty for dynamic — persona IS the sub-persona


def generate_archetypes(
    llm,
    product_json: dict,
    count: int = 5,
) -> List[DynamicArchetype]:
    """
    Ask the LLM to generate `count` product-specific customer archetypes.
    Falls back to the static archetype list if generation fails.

    Set SKIP_ARCHETYPE_GEN=1 in the environment to always use static archetypes
    (recommended for local dev with small CPU-only models like llama3:8b that
    struggle with long structured-JSON generation prompts).

    Args:
        llm:          LLMClient instance
        product_json: Raw Shopify product payload
        count:        Number of archetypes to generate

    Returns:
        List of DynamicArchetype objects ready for use in DebateOrchestrator
    """
    import os as _os
    if _os.environ.get("SKIP_ARCHETYPE_GEN") == "1":
        title = product_json.get("title", "product")
        print(f"SKIP_ARCHETYPE_GEN=1 — using static archetypes for '{title}'", flush=True)
        return _fallback_archetypes()

    # Extract product signals for the prompt
    title = product_json.get("title", "Unknown Product")
    vendor = product_json.get("vendor", "Unknown Brand")
    product_type = product_json.get("productType") or product_json.get("product_type", "")
    tags = product_json.get("tags", [])
    tags_str = ", ".join(tags[:10]) if isinstance(tags, list) else str(tags)

    # Price
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

    # Description snippet
    import re
    desc_html = product_json.get("descriptionHtml", product_json.get("body_html", ""))
    desc_text = re.sub(r"<[^>]+>", " ", desc_html).strip()[:400]

    prompt = GENERATE_ARCHETYPES_PROMPT.format(
        title=title,
        price=price_str,
        vendor=vendor,
        product_type=product_type or "not specified",
        tags=tags_str or "none",
        description=desc_text or "(no description provided)",
        count=count,
    )

    try:
        # Try up to 2 times — local LLMs (llama3:8b via Ollama) sometimes return
        # empty content on the first attempt with long prompts.
        # max_tokens=1000 is enough for 5 archetypes (each ~150 tokens of JSON).
        raw = ""
        for attempt in range(2):
            raw = llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.8,   # high creativity for diverse personas
                max_tokens=1000,
            )
            if raw and raw.strip():
                break
            logger.warning(f"LLM returned empty response for archetype generation (attempt {attempt + 1})")

        if not raw or not raw.strip():
            raise ValueError("LLM returned empty response after retries")

        # Strip markdown code fences the model sometimes wraps JSON in
        cleaned = raw.strip()
        import re as _re
        cleaned = _re.sub(r'^```(?:json)?\s*\n?', '', cleaned, flags=_re.IGNORECASE)
        cleaned = _re.sub(r'\n?```\s*$', '', cleaned)
        cleaned = cleaned.strip()

        data = json.loads(cleaned)
        raw_archetypes = data.get("archetypes", [])

        if not raw_archetypes or len(raw_archetypes) < 2:
            raise ValueError(f"LLM returned too few archetypes: {len(raw_archetypes)}")

        archetypes: List[DynamicArchetype] = []
        for i, a in enumerate(raw_archetypes[:count]):
            archetype = DynamicArchetype(
                id=a.get("id", f"archetype_{i}"),
                name=a.get("name", f"Archetype {i + 1}"),
                emoji=a.get("emoji", "🧑"),
                base_persona=a.get("persona", "A typical customer evaluating this product."),
                rejection_threshold=a.get("rejection_threshold", "REJECT if the listing is incomplete or misleading."),
                debate_style=a.get("debate_style", "Raises concerns based on personal experience."),
                focus_areas=a.get("focus_areas", []),
                temperature=float(a.get("temperature", 0.7)),
                sub_personas=[],  # dynamic archetypes are already specific — no sub-personas needed
            )
            archetypes.append(archetype)

        logger.info(f"Generated {len(archetypes)} dynamic archetypes for '{title}': {[a.name for a in archetypes]}")
        return archetypes

    except Exception as e:
        logger.warning(f"Dynamic archetype generation failed for '{title}': {e}. Falling back to static archetypes.")
        return _fallback_archetypes()


def _fallback_archetypes() -> List[DynamicArchetype]:
    """Convert the static ARCHETYPES list to DynamicArchetype format as a fallback."""
    from ..archetypes.definitions import ARCHETYPES
    return [
        DynamicArchetype(
            id=a.id,
            name=a.name,
            emoji=a.emoji,
            base_persona=a.base_persona,
            rejection_threshold=a.rejection_threshold,
            debate_style=a.debate_style,
            focus_areas=a.focus_areas,
            temperature=a.temperature,
            sub_personas=a.sub_personas,
        )
        for a in ARCHETYPES
    ]
