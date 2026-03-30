"""
RecommendationEngine — maps agent objections to prioritized sales-increasing actions.

Single LLM call after the debate completes. Combines:
  - Agent vote data (which archetypes rejected, what they said)
  - Friction classification (price / trust / logistics dropout %)
  - Trust audit (rule-based trust killers from the product listing)
  - Focus areas (merchant-selected concern categories)

Output: recommendations[] — each with priority, title, impact, the_why.
"""

import json
import logging
from typing import Optional

from ...utils.llm_client import LLMClient
from .shopify_ingestion import ProductBrief

logger = logging.getLogger("miroshop.recommendations")

RECOMMENDATION_PROMPT = """You are a growth consultant analyzing a product listing panel debate. Generate prioritized, actionable recommendations for the merchant.

Product: "{product_title}" at ${price}
Panel score: {score}/100 ({reject_count} of {total} panelists rejected)

Trust audit — issues found in the listing:
{trust_killers_text}

Friction by category:
- Price: {price_dropout}% of panel rejected over price — "{price_objections}"
- Trust: {trust_dropout}% of panel rejected over trust — "{trust_objections}"
- Logistics: {logistics_dropout}% rejected over logistics — "{logistics_objections}"

Panelist objections from the debate (use these EXACT names and quotes in your the_why):
{key_objections}

Focus areas the merchant cares most about: {focus_areas_text}

Generate 3-6 prioritized recommendations. Rules:
- High priority = 3+ panelists cited it, OR a trust killer with severity "high"
- Medium = 1-2 panelists cited it, OR a medium-severity trust killer
- Low = nice-to-have improvements
- title must be specific and actionable (max 8 words, e.g. "Add a 30-Day Return Policy" not "Improve Trust")
- impact: name the specific metric that improves (e.g. "Reduces cart abandonment")
- the_why: MUST name the specific panelist(s) and quote their exact words — e.g. 'The Research Analyst noted "no return policy mentioned"' or 'Frugal Skeptic and Status Seeker both flagged "price too high for unknown brand"'

RESPOND WITH EXACTLY THIS JSON (no other text):
{{
  "recommendations": [
    {{
      "priority": "High",
      "title": "Short actionable title",
      "impact": "Specific metric that improves",
      "the_why": "Panelist name(s) + direct quote from the debate above"
    }}
  ]
}}"""


def generate_recommendations(
    llm: LLMClient,
    brief: ProductBrief,
    all_votes: list[dict],
    friction: dict,
    trust_audit: dict,
    focus_areas: list[str],
    score: int,
) -> list[dict]:
    """
    Generate growth recommendations from debate results.
    Returns a list of recommendation dicts. Falls back to rule-based recommendations
    if the LLM call fails (to guarantee the merchant always gets actionable output).
    """
    reject_votes = [v for v in all_votes if v.get("verdict") == "REJECT" and v.get("phase") == 3]
    total = len([v for v in all_votes if v.get("phase") == 3])
    reject_count = len(reject_votes)

    # Build trust killers text
    trust_killers = trust_audit.get("trustKillers", [])
    if trust_killers:
        trust_killers_text = "\n".join(
            f"- [{k['severity'].upper()}] {k['label']}: {k['fix']}"
            for k in trust_killers
        )
    else:
        trust_killers_text = "No major trust issues detected."

    # Extract top objections from reject votes — cap at 6 unique archetypes, 100 chars each
    key_objections_list = []
    seen_archetypes = set()
    for v in reject_votes:
        name = v.get("archetype_name") or v.get("archetype_id", "panelist")
        if name not in seen_archetypes:
            seen_archetypes.add(name)
            reasoning = v.get("reasoning", "")[:100]
            key_objections_list.append(f'- {name}: "{reasoning}"')
    key_objections = "\n".join(key_objections_list[:6]) or "No specific objections recorded."

    # Friction data
    price_f = friction.get("price", {})
    trust_f = friction.get("trust", {})
    logistics_f = friction.get("logistics", {})

    focus_area_labels = {
        "trust_credibility": "Trust & Credibility",
        "price_value": "Price & Value",
        "technical_specs": "Technical Specs",
        "visual_branding": "Visual Branding",
        "mobile_friction": "Mobile Friction",
    }
    focus_areas_text = (
        ", ".join(focus_area_labels.get(f, f) for f in focus_areas)
        if focus_areas
        else "General (all areas)"
    )

    prompt = RECOMMENDATION_PROMPT.format(
        product_title=brief["title"][:80],
        price=f"{brief['price_min']:.2f}",
        score=score,
        reject_count=reject_count,
        total=total or 1,
        trust_killers_text=trust_killers_text,
        price_dropout=price_f.get("dropoutPct", 0),
        price_objections=", ".join(price_f.get("topObjections", [])[:1]) or "none",
        trust_dropout=trust_f.get("dropoutPct", 0),
        trust_objections=", ".join(trust_f.get("topObjections", [])[:1]) or "none",
        logistics_dropout=logistics_f.get("dropoutPct", 0),
        logistics_objections=", ".join(logistics_f.get("topObjections", [])[:1]) or "none",
        key_objections=key_objections,
        focus_areas_text=focus_areas_text,
    )

    try:
        data = llm.chat_json(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=800,
        )
        recs = data.get("recommendations", [])
        if isinstance(recs, list) and recs:
            logger.info(f"Generated {len(recs)} recommendations for '{brief['title']}'")
            return recs
    except Exception as e:
        logger.warning(f"LLM recommendations failed — using rule-based fallback: {e}")

    # Rule-based fallback — always gives the merchant something actionable
    return _rule_based_fallback(trust_killers, friction, score)


def _rule_based_fallback(
    trust_killers: list[dict],
    friction: dict,
    score: int,
) -> list[dict]:
    """Fallback recommendations based purely on trust audit and friction data."""
    recs = []

    for killer in trust_killers:
        priority = "High" if killer["severity"] == "high" else "Medium"
        recs.append({
            "priority": priority,
            "title": killer["label"],
            "impact": "Builds buyer trust, reduces cart abandonment",
            "the_why": killer["fix"],
        })

    price_dropout = friction.get("price", {}).get("dropoutPct", 0)
    if price_dropout >= 40:
        recs.append({
            "priority": "High",
            "title": "Justify Your Price With Specs",
            "impact": "Converts price-sensitive buyers",
            "the_why": f"{price_dropout}% of the panel rejected due to price concerns — add a value comparison or spec breakdown.",
        })

    trust_dropout = friction.get("trust", {}).get("dropoutPct", 0)
    if trust_dropout >= 30:
        recs.append({
            "priority": "High",
            "title": "Add Visible Trust Signals",
            "impact": "Reduces trust-based cart abandonment",
            "the_why": f"{trust_dropout}% of the panel flagged trust concerns — guarantee badges and reviews near the buy button help.",
        })

    if score < 50 and not recs:
        recs.append({
            "priority": "High",
            "title": "Rewrite Product Description",
            "impact": "Increases conversion rate across all buyer types",
            "the_why": f"Score of {score}/100 indicates the listing isn't converting skeptical buyers — a clearer, more specific description is the highest-leverage fix.",
        })

    return recs[:6]
