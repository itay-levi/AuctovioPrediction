"""
ComparisonEngine — generates an AI insight explaining WHY a What-If score changed.

Runs once after a delta simulation completes.
Uses the LLM client (passed in) for quality output.

Returns a single insight string like:
  "Dropping the price increased suspicion because your Trust signals are still missing.
   Focus on adding reviews and a return policy before cutting the price further."
"""

import json
import logging
from typing import Optional

from ...utils.llm_client import LLMClient

logger = logging.getLogger("miroshop.comparison")

COMPARISON_PROMPT = """You are analyzing why a Shopify product's conversion score changed after a What-If adjustment.

Product: "{product_title}"

ORIGINAL LISTING — Score: {original_score}/100
- Price: ${original_price}
- Trust issues: {trust_killers_text}
- Price friction: {original_price_dropout}% of panel rejected on price
- Trust friction: {original_trust_dropout}% of panel rejected on trust
- Logistics friction: {original_logistics_dropout}% rejected on logistics

WHAT-IF SCENARIO — Score: {delta_score}/100
- Price changed: ${original_price} → ${delta_price}
- Shipping changed: {original_shipping} → {delta_shipping}
- Trust issues: same (trust signals don't change with price/shipping)
- Price friction after change: {delta_price_dropout}%
- Trust friction after change: {delta_trust_dropout}%
- Logistics friction after change: {delta_logistics_dropout}%

Score moved {score_delta:+d} points ({score_direction}).

In exactly 2 sentences, explain WHY the score changed (or didn't). Rules:
- Be specific: name the friction category that drove the change
- If score got worse despite a price cut, explain why trust dominates
- If score improved, name which buyer type converted
- Speak directly to the merchant ("your", "you")
- NO filler phrases like "It appears" or "It seems"
- Cite actual numbers from the data above

RESPOND WITH EXACTLY THIS JSON (no other text):
{{"insight": "Sentence 1. Sentence 2."}}"""


def generate_comparison_insight(
    llm: LLMClient,
    product_title: str,
    delta_params: dict,
    original_score: int,
    delta_score: int,
    original_friction: dict,
    delta_friction: dict,
    trust_killers: list[dict],
) -> str:
    """
    Generate a 2-sentence insight explaining the score delta.
    Returns a plain string. Falls back to a rule-based explanation if LLM fails.
    """
    orig_price = delta_params.get("originalPrice", 0)
    new_price = delta_params.get("price", orig_price)
    orig_shipping = delta_params.get("originalShippingDays")
    new_shipping = delta_params.get("shippingDays", orig_shipping)

    price_str = f"{new_price:.2f}" if isinstance(new_price, (int, float)) else str(new_price)
    orig_price_str = f"{orig_price:.2f}" if isinstance(orig_price, (int, float)) else str(orig_price)

    shipping_str = f"{new_shipping} days" if new_shipping else "unchanged"
    orig_shipping_str = f"{orig_shipping} days" if orig_shipping else "not specified"

    killers_text = (
        ", ".join(k["label"] for k in trust_killers[:3])
        if trust_killers
        else "none detected"
    )

    orig_f = original_friction or {}
    delta_f = delta_friction or {}
    score_delta = delta_score - original_score

    try:
        prompt = COMPARISON_PROMPT.format(
            product_title=product_title[:60],
            original_score=original_score,
            delta_score=delta_score,
            original_price=orig_price_str,
            delta_price=price_str,
            original_shipping=orig_shipping_str,
            delta_shipping=shipping_str,
            trust_killers_text=killers_text,
            original_price_dropout=orig_f.get("price", {}).get("dropoutPct", 0),
            original_trust_dropout=orig_f.get("trust", {}).get("dropoutPct", 0),
            original_logistics_dropout=orig_f.get("logistics", {}).get("dropoutPct", 0),
            delta_price_dropout=delta_f.get("price", {}).get("dropoutPct", 0),
            delta_trust_dropout=delta_f.get("trust", {}).get("dropoutPct", 0),
            delta_logistics_dropout=delta_f.get("logistics", {}).get("dropoutPct", 0),
            score_delta=score_delta,
            score_direction="improvement" if score_delta > 0 else "decline" if score_delta < 0 else "no change",
        )

        data = llm.chat_json(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=200,
        )
        insight = data.get("insight", "").strip()
        if insight and len(insight) > 20:
            logger.info(f"Generated comparison insight for '{product_title}'")
            return insight
    except Exception as e:
        logger.warning(f"Comparison insight LLM failed — using rule-based fallback: {e}")

    return _rule_based_insight(score_delta, delta_params, orig_f, delta_f, trust_killers)


def _rule_based_insight(
    score_delta: int,
    delta_params: dict,
    original_friction: dict,
    delta_friction: dict,
    trust_killers: list[dict],
) -> str:
    """Fallback insight from pure data when LLM is unavailable."""
    price_changed = delta_params.get("price") is not None
    shipping_changed = delta_params.get("shippingDays") is not None

    high_trust_issues = [k for k in trust_killers if k.get("severity") == "high"]
    trust_dropout = delta_friction.get("trust", {}).get("dropoutPct", 0)

    if score_delta < 0 and price_changed and high_trust_issues:
        killers = ", ".join(k["label"] for k in high_trust_issues[:2])
        return (
            f"Lowering the price did not improve your score because {trust_dropout}% of the panel "
            f"still rejected on trust — specifically: {killers}. "
            f"Fix your trust signals first; price cuts have little impact when buyers don't feel safe."
        )

    if score_delta > 0 and price_changed:
        return (
            f"The price reduction converted {abs(score_delta)} more points of confidence by moving "
            f"price-sensitive panelists from rejection to acceptance. "
            f"Continue monitoring trust signals to sustain this gain."
        )

    if score_delta == 0:
        return (
            "The panel score did not change because the dominant friction is not price or shipping. "
            "Your trust signals (reviews, return policy, contact info) are the primary conversion blocker."
        )

    return (
        f"The What-If scenario moved the score by {score_delta:+d} points. "
        "Review the friction breakdown above for the specific categories driving this change."
    )
