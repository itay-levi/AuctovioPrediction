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

CRITICAL RULES:
1. Make archetypes specific to this product — a snowboard gets snowboard buyers, dog food gets dog owners
2. Include at least one hard sceptic who challenges even when others are positive
3. Include diversity in price sensitivity, tech-savviness, and emotional investment
4. rejection_threshold must name specific, realistic failure modes for THIS product type
5. Each persona must feel like a genuinely different person with a different life situation
6. analytical_lens must be a UNIQUE professional/personal frame — no two agents can share the same lens
7. human_flaw must be a real psychological quirk that colours how they speak and what they fixate on

Analytical lens examples (pick different ones per agent):
- "Clinical Risk & Liability" (vet, doctor, safety engineer)
- "Daily Routine Impact" (busy parent, shift worker)
- "ROI & Total Cost of Ownership" (accountant, small business owner)
- "Brand Signal & Social Proof" (trend-conscious shopper, influencer)
- "Ingredient / Material Sourcing" (nutritionist, sustainability advocate)
- "Gifting Anxiety" (gift buyer worried about recipient reaction)
- "First-Time Buyer Overwhelm" (inexperienced in this category)
- "Expert Snob Standards" (hobbyist who knows too much)

Human flaw examples:
- "Fixates on one concern and can't let it go"
- "Speaks in hesitant half-sentences, always second-guessing"
- "Blunt to the point of being rude, no filter"
- "Over-researches and paralysis-by-analysis"
- "Easily swayed by social proof, fears missing out"
- "Catastrophises worst-case scenarios"
- "Very trusting, sometimes naively so"
- "Highly price-anchored, always comparing to alternatives"

Respond with ONLY valid JSON — no markdown, no explanation:
{{
  "archetypes": [
    {{
      "id": "snake_case_id",
      "name": "Short Display Name (2-4 words)",
      "emoji": "single relevant emoji",
      "persona": "2-3 sentences: who they are, their life situation, WHY they are looking at this product right now",
      "analytical_lens": "Their unique professional/personal frame for evaluating this product (e.g. 'Daily Routine Impact: how this fits into Sarah\\'s chaotic morning with two kids')",
      "human_flaw": "One psychological quirk that shapes how they argue (e.g. 'Fixates on ingredient sourcing and brings it up even when others have moved on')",
      "focus_areas": ["what they scrutinise most — product-specific, not generic"],
      "rejection_threshold": "Specific, realistic conditions that make them REJECT — name actual listing failure modes",
      "opening_voice": "One short sentence showing how THIS persona naturally opens a product reaction. Reflects their specific life situation and lens — completely different from any other panelist. Keep under 20 words. No quotes inside this string.",
      "debate_style": "1 sentence: their arguing style — blunt/hesitant/analytical/emotional and what angle they take",
      "temperature": 0.7
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
    analytical_lens: str = ""  # unique professional/personal frame for this agent
    human_flaw: str = ""       # psychological quirk that shapes tone and fixation
    opening_voice: str = ""    # example of how this persona opens a product reaction
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
        # 2000 tokens: 5 archetypes × ~350 tokens each (opening_voice adds ~60 tokens/archetype).
        raw = ""
        for attempt in range(2):
            raw = llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.4,   # lowered for panel consistency across re-runs
                max_tokens=2000,
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
                analytical_lens=a.get("analytical_lens", ""),
                human_flaw=a.get("human_flaw", ""),
                opening_voice=a.get("opening_voice", ""),
                focus_areas=a.get("focus_areas", []),
                temperature=float(a.get("temperature", 0.7)),
                sub_personas=[],
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
