"""
ProductDNA — Phase 0 extraction.

Single fast LLM call that identifies the psychological core of a product
before the debate begins. Output is:
  - core_fear          : the primary reason a buyer might NOT buy
  - core_desire        : the primary reason a buyer WOULD buy
  - archetype_axis     : product's psychological axis (Sensory/Experience | Intimacy/Privacy |
                         Efficacy/Result | Status/Identity) — determines experiment card types
  - experiment_cards   : 3 axis-aware, product-specific hypothesis cards for the What-If sandbox
  - persona_hooks      : per-archetype attack angle

DNA is cached alongside product intelligence and injected into:
  1. Every agent's system prompt so their attack is grounded in product psychology
  2. The recommendation engine so Golden Actions address the root fear/desire
  3. Delta (what-if) runs — skips this call entirely and reuses the cached DNA
  4. Experiment card activation — agents debate the specific hypothesis being tested
"""

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Optional, List

logger = logging.getLogger("miroshop.dna_extractor")

# ── Axis definitions injected into the prompt ──────────────────────────────────
_AXIS_DEFINITIONS = """Product Psychological Axes — pick the one that best fits:
- "Sensory/Experience": Buyer decides with feelings — taste, texture, smell, comfort, aesthetics.
  Trust signals: sensory language, lifestyle photography, origin story, creator narrative.
  Examples: wine, olive oil, candles, blankets, artisan food, skincare.

- "Intimacy/Privacy": Buyer has stigma, embarrassment, or privacy concerns about the purchase.
  Trust signals: discreet packaging, no-questions returns, professional/clinical endorsement, anonymity.
  Examples: supplements, adult products, medical devices, hair loss treatments, personal hygiene.

- "Efficacy/Result": Buyer needs proof of a measurable outcome before committing.
  Trust signals: clinical studies, spec comparison tables, before/after evidence, ROI calculations.
  Examples: massagers, fitness equipment, tools, skincare with claims, productivity tech.

- "Status/Identity": Buyer is purchasing an identity signal, not just a product.
  Trust signals: aspirational photography, social proof from peers, exclusivity, brand story.
  Examples: jewelry, watches, fashion, premium accessories, collectibles."""

DNA_PROMPT = """You are a consumer psychology expert. Read this product listing and extract its complete psychological profile.

Product:
- Title: {title}
- Price: {price}
- Type: {product_type}
- Description (excerpt): {description}

Answer all 5 sections. Wrong answers make the debate panel useless — be specific to THIS product.

1. CORE_FEAR — The single biggest psychological reason a buyer would NOT purchase this.
   The doubt, fear, or suspicion in the back of their mind.
   Examples: "Fear of receiving a counterfeit", "Anxiety about sizing — can't try before buying",
   "Skepticism that the discount price signals a quality problem"

2. CORE_DESIRE — The single most powerful psychological reason a buyer WOULD purchase.
   The emotional payoff they are buying, not the product feature.
   Examples: "Social status signal among peers", "Relief from a pain tolerated for months"

3. ARCHETYPE_AXIS — Classify this product using exactly one axis label:
{axis_definitions}
   Answer with EXACTLY one of: "Sensory/Experience", "Intimacy/Privacy", "Efficacy/Result", "Status/Identity"

4. EXPERIMENT_CARDS — Generate exactly 3 hypothesis cards for the What-If sandbox.
   Each card is a SPECIFIC listing change the merchant can test.
   Rules:
   - Must match the archetype_axis (e.g. Efficacy products get clinical proof experiments, not lifestyle photography)
   - Must be a concrete action, not generic advice ("add a 30-second texture video above the fold" not "improve photos")
   - Each card must target a DIFFERENT buyer concern
   - id must be snake_case, name must be 2-5 words

5. PERSONA_HOOKS — For each archetype, their most effective attack angle for THIS product (1 sentence max):
   Archetypes: budget_optimizer, brand_loyalist, research_analyst, impulse_decider, gift_seeker

Respond with ONLY valid JSON, no markdown:
{{
  "core_fear": "specific fear in 1 sentence",
  "core_desire": "specific desire in 1 sentence",
  "archetype_axis": "one of the four axis labels",
  "experiment_cards": [
    {{
      "id": "snake_case_id",
      "name": "2-5 Word Name",
      "hypothesis": "The exact listing change in 1-2 sentences. Specific, actionable, testable.",
      "target_agent": "archetype_id most likely moved by this (budget_optimizer|brand_loyalist|research_analyst|impulse_decider|gift_seeker)",
      "rationale": "Why this experiment fits the product's axis in 1 sentence."
    }}
  ],
  "persona_hooks": {{
    "budget_optimizer": "their specific attack angle",
    "brand_loyalist": "their specific attack angle",
    "research_analyst": "their specific attack angle",
    "impulse_decider": "their specific attack angle",
    "gift_seeker": "their specific attack angle"
  }}
}}"""

VALID_AXES = frozenset(["Sensory/Experience", "Intimacy/Privacy", "Efficacy/Result", "Status/Identity"])


@dataclass
class ExperimentCard:
    id: str                # snake_case identifier
    name: str              # 2-5 word display name
    hypothesis: str        # exact listing change — passed to agents when activated
    target_agent: str      # archetype_id most likely moved by this
    rationale: str         # why this fits the axis


@dataclass
class ProductDNA:
    core_fear: str
    core_desire: str
    archetype_axis: str                      # "Sensory/Experience" | "Intimacy/Privacy" | "Efficacy/Result" | "Status/Identity"
    experiment_cards: List[ExperimentCard]   # 3 axis-aware what-if hypotheses
    persona_hooks: dict[str, str]            # archetype_id → attack angle


def extract_product_dna(
    llm,
    product_json: dict,
) -> Optional[ProductDNA]:
    """
    Run a single fast LLM call to extract the product's psychological DNA.
    Returns None on failure — caller proceeds without it (graceful degradation).
    Cached per product URL alongside product intelligence.
    """
    import os as _os
    if _os.environ.get("SKIP_ARCHETYPE_GEN") == "1":
        return None

    title = product_json.get("title", "Unknown Product")
    product_type = product_json.get("productType") or product_json.get("product_type", "")

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
    desc_text = re.sub(r"<[^>]+>", " ", desc_html).strip()[:300]

    prompt = DNA_PROMPT.format(
        title=title,
        price=price_str,
        product_type=product_type or "not specified",
        description=desc_text or "(no description provided)",
        axis_definitions=_AXIS_DEFINITIONS,
    )

    try:
        raw = llm.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=700,   # more tokens needed for experiment cards
        )
        if not raw or not raw.strip():
            raise ValueError("Empty response")

        cleaned = raw.strip()
        cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'\n?```\s*$', '', cleaned)

        data = json.loads(cleaned.strip())

        # Parse and validate axis
        axis = data.get("archetype_axis", "Efficacy/Result")
        if axis not in VALID_AXES:
            # Fuzzy match — LLM sometimes returns partial labels
            axis = next((a for a in VALID_AXES if a.split("/")[0].lower() in axis.lower()), "Efficacy/Result")

        # Parse experiment cards — gracefully accept partial data
        raw_cards = data.get("experiment_cards", [])
        experiment_cards = []
        for c in raw_cards[:3]:
            if not isinstance(c, dict):
                continue
            card = ExperimentCard(
                id=str(c.get("id", f"experiment_{len(experiment_cards)}")),
                name=str(c.get("name", "Experiment")),
                hypothesis=str(c.get("hypothesis", "")),
                target_agent=str(c.get("target_agent", "research_analyst")),
                rationale=str(c.get("rationale", "")),
            )
            if card.hypothesis:   # skip cards with empty hypothesis
                experiment_cards.append(card)

        dna = ProductDNA(
            core_fear=data.get("core_fear", ""),
            core_desire=data.get("core_desire", ""),
            archetype_axis=axis,
            experiment_cards=experiment_cards,
            persona_hooks=data.get("persona_hooks", {}),
        )
        logger.info(
            f"DNA extracted for '{title}': axis={dna.archetype_axis}, "
            f"fear='{dna.core_fear[:60]}', cards={len(dna.experiment_cards)}"
        )
        return dna

    except Exception as e:
        logger.warning(f"DNA extraction failed for '{title}': {e}. Panel runs without DNA context.")
        return None


def format_dna_for_prompt(dna: Optional[ProductDNA], archetype_id: str) -> str:
    """
    Format DNA context injected into each agent's system prompt.
    Gives the agent their specific attack angle + the product's core fear.
    Returns empty string if DNA is None (graceful degradation).
    """
    if not dna:
        return ""

    parts = []
    if dna.core_fear:
        parts.append(f"BUYER PSYCHOLOGY — Core fear blocking purchase: {dna.core_fear}")
    if dna.core_desire:
        parts.append(f"Core desire driving purchase: {dna.core_desire}")

    hook = dna.persona_hooks.get(archetype_id, "")
    if not hook:
        # Try fuzzy match: archetype_id might be dynamic (e.g. "weekend_warrior")
        for k, v in dna.persona_hooks.items():
            if k in archetype_id or archetype_id in k:
                hook = v
                break

    if hook:
        parts.append(
            f"YOUR ATTACK ANGLE for this product: {hook} "
            f"Open your first response by addressing this directly."
        )

    return "\n".join(parts)


def dna_to_dict(dna: Optional[ProductDNA]) -> Optional[dict]:
    """Serialize DNA for storage in DB / callback payload."""
    if not dna:
        return None
    return {
        "coreFear": dna.core_fear,
        "coreDesire": dna.core_desire,
        "archetypeAxis": dna.archetype_axis,
        "experimentCards": [
            {
                "id": c.id,
                "name": c.name,
                "hypothesis": c.hypothesis,
                "targetAgent": c.target_agent,
                "rationale": c.rationale,
            }
            for c in dna.experiment_cards
        ],
        "personaHooks": dna.persona_hooks,
    }


_VISUAL_TRUST_PROMPT = """You are a visual merchandising analyst. Analyze these product images for an e-commerce store.

Product: {title}

Evaluate the images and respond with ONLY valid JSON:
{{
  "image_quality": "poor|acceptable|professional",
  "brand_story": "One sentence on what the images communicate about the brand.",
  "trust_signals": ["up to 3 visual elements that build buyer confidence"],
  "trust_gaps": ["up to 2 missing visual elements that could cause hesitation"],
  "agent_context": "Two sentences for a buyer panel summarising the visual credibility of this listing and any standout concerns."
}}"""


def extract_visual_trust(image_urls: list[str], product_title: str) -> Optional[str]:
    """
    Call Gemini Vision to get a visual trust assessment for the agent panel.
    Returns the `agent_context` string to be injected into trust_context, or None on failure.
    Only called for PRO-tier simulations. Uses Gemini directly (Groq has no vision support).
    """
    try:
        from ...config import Config
        if not Config.FALLBACK_LLM_API_KEY or not Config.FALLBACK_LLM_BASE_URL:
            logger.info("Vision analysis skipped — Gemini not configured")
            return None

        from openai import OpenAI
        vision_client = OpenAI(
            api_key=Config.FALLBACK_LLM_API_KEY,
            base_url=Config.FALLBACK_LLM_BASE_URL,
            timeout=40.0,
        )

        content: list = [
            {"type": "text", "text": _VISUAL_TRUST_PROMPT.format(title=product_title)},
        ]
        for url in image_urls[:3]:
            content.append({"type": "image_url", "image_url": {"url": url}})

        response = vision_client.chat.completions.create(
            model=Config.FALLBACK_LLM_MODEL_NAME,
            messages=[{"role": "user", "content": content}],
            temperature=0.2,
            max_tokens=400,
        )
        raw = (response.choices[0].message.content or "").strip()
        raw = re.sub(r'^```(?:json)?\s*\n?', '', raw, flags=re.IGNORECASE)
        raw = re.sub(r'\n?```\s*$', '', raw)
        data = json.loads(raw.strip())

        context = data.get("agent_context", "")
        gaps = data.get("trust_gaps", [])
        quality = data.get("image_quality", "")
        if quality == "poor":
            context += " Image quality is poor — agents should factor in low visual trust."
        if gaps:
            context += " Visual gaps: " + "; ".join(gaps) + "."

        logger.info(f"Visual trust extracted for '{product_title}': quality={quality}")
        return context.strip() or None

    except Exception as e:
        logger.warning(f"Visual trust extraction failed for '{product_title}': {e}")
        return None


def dna_from_dict(data: Optional[dict]) -> Optional[ProductDNA]:
    """Deserialize DNA from DB / delta request payload."""
    if not data:
        return None
    raw_cards = data.get("experimentCards", [])
    cards = []
    for c in raw_cards:
        if isinstance(c, dict) and c.get("hypothesis"):
            cards.append(ExperimentCard(
                id=c.get("id", ""),
                name=c.get("name", ""),
                hypothesis=c.get("hypothesis", ""),
                target_agent=c.get("targetAgent", "research_analyst"),
                rationale=c.get("rationale", ""),
            ))
    return ProductDNA(
        core_fear=data.get("coreFear", ""),
        core_desire=data.get("coreDesire", ""),
        archetype_axis=data.get("archetypeAxis", "Efficacy/Result"),
        experiment_cards=cards,
        persona_hooks=data.get("personaHooks", {}),
    )
