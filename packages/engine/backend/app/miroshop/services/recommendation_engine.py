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

RECOMMENDATION_PROMPT = """You are a senior e-commerce growth team reviewing a customer panel debate. Three specialists are each delivering one Golden Action — their highest-conviction recommendation for this specific product.

Product: "{product_title}" at ${price}
Panel score: {score}/100 ({reject_count} of {total} panelists rejected)
{dna_section}
Trust audit — issues found in the listing:
{trust_killers_text}

Listing gaps — buyer questions not answered:
{gap_analysis_text}

Panel friction:
- Price friction: {price_dropout}% of panel rejected over price — "{price_objections}"
- Trust friction: {trust_dropout}% of panel rejected over trust — "{trust_objections}"
- Logistics friction: {logistics_dropout}% rejected over logistics — "{logistics_objections}"

What panelists actually said (direct quotes):
{key_objections}

Merchant focus areas: {focus_areas_text}

---

SPECIALIST 1 — PRICING STRATEGIST
Focus: margin, perceived value, price anchoring, cost justification.
Delivers: One specific change to how the price is presented, positioned, or justified — not "lower the price".
Example output: "Add a per-unit cost breakdown beneath the bulk price to show the 40% savings vs. single-unit competitors"

SPECIALIST 2 — CRO SPECIALIST
Focus: trust signals, visual hierarchy, friction points in the buying journey.
Delivers: One specific on-page element to add, move, or reword to remove a conversion blocker.
Example output: "Move the 30-day guarantee from the footer to directly beneath the Add to Cart button — {trust_dropout}% of the panel flagged trust uncertainty at the decision moment"

SPECIALIST 3 — PRODUCT MARKETING MANAGER
Focus: the 'Why' — unique value proposition, DNA hooks, emotional narrative.
Delivers: One specific copy or story change that connects the product's core desire to what the listing currently says.
Example output: "Rewrite the first sentence of the description to lead with the core desire ('{core_desire_short}') instead of the ingredient list — panelists skipped past the features to ask 'but what does it DO for me?'"

---

DOMINANT FRICTION ROTATION — mandatory lens assignment:
{dominant_friction_rule}

---

SPECIFICITY RULES — non-negotiable:
- title: name the EXACT element being changed and WHERE (max 10 words). Include position, metric, or visual anchor.
  BAD: "Improve trust signals" | GOOD: "Pin money-back badge directly under the Add to Cart button"
  BAD: "Better description" | GOOD: "Lead with '{core_desire_short}' in the first 10 words of description"
- the_why: must reference either (a) a panelist by name + their quote, or (b) a specific trust audit finding, or (c) a specific gap item. No vague statements.
- Each recommendation must come from a different specialist perspective — no two can address the same friction category.

RESPOND WITH EXACTLY THIS JSON (no other text):
{{
  "recommendations": [
    {{
      "priority": "High",
      "lens": "Pricing Strategist",
      "title": "Exact action naming the element and location",
      "impact": "Which friction category this kills and approximately what % of rejectors it addresses",
      "the_why": "Panelist name + MAX 12-word quote, OR one trust audit finding, OR one gap item. No full sentences."
    }},
    {{
      "priority": "High",
      "lens": "CRO Specialist",
      "title": "Exact action naming the element and location",
      "impact": "Which friction category this kills and approximately what % of rejectors it addresses",
      "the_why": "Panelist name + MAX 12-word quote, OR one trust audit finding, OR one gap item. No full sentences."
    }},
    {{
      "priority": "Medium",
      "lens": "Product Marketing Manager",
      "title": "Exact action naming the copy or story change",
      "impact": "Which emotional barrier this removes — connect to core fear or desire",
      "the_why": "Panelist name + MAX 12-word quote, OR core fear/desire in under 15 words. No full sentences."
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
    gap_analysis: Optional[dict] = None,   # serialized GapAnalysis items list
    product_dna: Optional[dict] = None,    # {"coreFear": str, "coreDesire": str, "personaHooks": dict}
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

    # Format DNA context for the prompt
    dna_section = ""
    core_desire_short = "solve the buyer's core need"
    if product_dna:
        core_fear = product_dna.get("coreFear", "")
        core_desire = product_dna.get("coreDesire", "")
        if core_desire:
            # Truncate to ~60 chars for inline use in the prompt
            core_desire_short = core_desire[:60].rstrip(",. ") + ("…" if len(core_desire) > 60 else "")
        if core_fear or core_desire:
            dna_section = "Product psychology:\n"
            if core_fear:
                dna_section += f"- Core fear blocking purchase: {core_fear}\n"
            if core_desire:
                dna_section += f"- Core desire driving purchase: {core_desire}\n"
            dna_section += "\n"

    # Format gap analysis items for the prompt
    gap_analysis_text = "No gap analysis available."
    if gap_analysis:
        gap_lines = []
        for item in gap_analysis:
            status = item.get("status", "")
            question = item.get("question", "")
            evidence = item.get("evidence", "(not found)")
            if status == "MISSING":
                gap_lines.append(f"  ✗ MISSING: {question}")
            elif status == "PARTIAL":
                gap_lines.append(f"  ~ PARTIAL: {question} (found: \"{evidence}\")")
        if gap_lines:
            gap_analysis_text = "\n".join(gap_lines)
        else:
            gap_analysis_text = "All key buyer questions answered in listing."

    # Rotation rule — prevents two specialists landing on the same friction category
    price_pct = price_f.get("dropoutPct", 0)
    trust_pct = trust_f.get("dropoutPct", 0)
    logistics_pct = logistics_f.get("dropoutPct", 0)
    _dominant = max(
        ("price", price_pct),
        ("trust", trust_pct),
        ("logistics", logistics_pct),
        key=lambda x: x[1],
    )[0]
    _rotation_map = {
        "price": (
            f"Price friction is the #1 dropout driver ({price_pct}%). "
            "Specialist 1 (Pricing Strategist) MUST lead with price framing or anchoring. "
            "Specialists 2 and 3 are FORBIDDEN from also recommending price changes — "
            "they must cover trust signals and product narrative respectively."
        ),
        "trust": (
            f"Trust friction is the #1 dropout driver ({trust_pct}%). "
            "Specialist 2 (CRO Specialist) MUST lead with trust signals and on-page credibility. "
            "Specialist 1 must add value justification (not price cuts). "
            "Specialist 3 covers the emotional hook and product promise."
        ),
        "logistics": (
            f"Logistics friction is the #1 dropout driver ({logistics_pct}%). "
            "Specialist 2 (CRO Specialist) must address shipping/returns placement and clarity. "
            "Specialist 1 covers price-value framing to make delivery feel worth it. "
            "Specialist 3 covers the product narrative."
        ),
    }
    dominant_friction_rule = _rotation_map[_dominant]

    prompt = RECOMMENDATION_PROMPT.format(
        product_title=brief["title"][:80],
        price=f"{brief['price_min']:.2f}",
        score=score,
        reject_count=reject_count,
        total=total or 1,
        dna_section=dna_section,
        core_desire_short=core_desire_short,
        trust_killers_text=trust_killers_text,
        gap_analysis_text=gap_analysis_text,
        dominant_friction_rule=dominant_friction_rule,
        price_dropout=price_pct,
        price_objections=", ".join(price_f.get("topObjections", [])[:2]) or "none",
        trust_dropout=trust_pct,
        trust_objections=", ".join(trust_f.get("topObjections", [])[:2]) or "none",
        logistics_dropout=logistics_pct,
        logistics_objections=", ".join(logistics_f.get("topObjections", [])[:2]) or "none",
        key_objections=key_objections,
        focus_areas_text=focus_areas_text,
    )

    try:
        data = llm.chat_json(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=900,   # 3 recs × ~250 tokens each; short the_why keeps this well under limit
        )
        recs = data.get("recommendations", [])
        if isinstance(recs, list) and recs:
            recs = recs[:3]
            logger.info(f"Generated {len(recs)} Golden Actions for '{brief['title']}'")
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
