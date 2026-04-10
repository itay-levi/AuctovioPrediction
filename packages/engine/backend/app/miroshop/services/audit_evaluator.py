"""
AuditEvaluator — grades whether a merchant actually fixed their listing.

Single LLM call after a retake simulation completes.

Takes:
  - original 3 recommendations (lens, title, the_why)
  - original score + friction
  - new score + friction + debate votes from the retake

Returns per-rec verdict (Pass / Improving / Fail) + one final Polishing Touch.
"""

import json
import logging
from typing import Optional

from ...utils.llm_client import LLMClient

logger = logging.getLogger("miroshop.audit_evaluator")

EVALUATE_PROMPT = """\
You are a strict conversion audit mentor. A Shopify merchant received 3 Golden Actions and
re-ran their panel after making changes. Grade whether they actually fixed the issues.

Product: "{product_title}"
Score before: {original_score}/100 → Score after: {new_score}/100 ({score_delta:+d} pts)

--- ORIGINAL FRICTION (before changes) ---
Price dropout:     {orig_price_pct}%
Trust dropout:     {orig_trust_pct}%
Logistics dropout: {orig_logistics_pct}%

--- NEW FRICTION (after changes) ---
Price dropout:     {new_price_pct}%
Trust dropout:     {new_trust_pct}%
Logistics dropout: {new_logistics_pct}%

--- THE 3 GOLDEN ACTIONS THEY WERE GIVEN ---
{recs_text}

--- WHAT THE NEW PANEL SAID (direct quotes) ---
{new_reasoning_text}

---

GRADING RULES:
- "Pass"      — this area clearly improved: friction dropped or new panel stopped objecting here
- "Improving" — partial fix: friction reduced but objections still present
- "Fail"      — no meaningful change, regression, or the merchant just reworded without fixing the root cause

For each recommendation:
- verdict: "Pass" | "Improving" | "Fail"
- delta: ONE sentence — exactly what changed (or didn't). Use "Before vs After" framing.
- polishingTouch: ONE specific next action (leave blank string "" if verdict is "Pass")

Then give:
- overallVerdict: "Pass" | "Improving" | "Fail" based on majority of the three verdicts
- overallPolishingTouch: the single highest-leverage action left. Must name the exact element, location, and change.

RESPOND WITH EXACTLY THIS JSON (no other text):
{{
  "verdicts": [
    {{"lens": "Pricing Strategist", "verdict": "Pass|Improving|Fail", "delta": "...", "polishingTouch": "..."}},
    {{"lens": "CRO Specialist", "verdict": "Pass|Improving|Fail", "delta": "...", "polishingTouch": "..."}},
    {{"lens": "Product Marketing Manager", "verdict": "Pass|Improving|Fail", "delta": "...", "polishingTouch": "..."}}
  ],
  "overallVerdict": "Pass|Improving|Fail",
  "overallPolishingTouch": "..."
}}"""


def evaluate_retake(
    llm: LLMClient,
    product_title: str,
    original_recommendations: list[dict],
    original_score: int,
    new_score: int,
    original_friction: dict,
    new_friction: dict,
    new_votes: list[dict],
) -> dict:
    """
    Grade the merchant's changes against the original Golden Actions.

    Returns a dict with verdicts[], overallVerdict, overallPolishingTouch.
    Falls back to a neutral "Improving" verdict on LLM failure so the UI
    always gets something useful.
    """
    orig_price = original_friction.get("price", {}).get("dropoutPct", 0)
    orig_trust = original_friction.get("trust", {}).get("dropoutPct", 0)
    orig_logistics = original_friction.get("logistics", {}).get("dropoutPct", 0)
    new_price = new_friction.get("price", {}).get("dropoutPct", 0)
    new_trust = new_friction.get("trust", {}).get("dropoutPct", 0)
    new_logistics = new_friction.get("logistics", {}).get("dropoutPct", 0)

    # Build recs text
    recs_lines = []
    for i, rec in enumerate(original_recommendations[:3], 1):
        lens = rec.get("lens", f"Specialist {i}")
        title = rec.get("title", "")
        why = rec.get("the_why", "")
        recs_lines.append(f"{i}. [{lens}] {title}\n   Why it mattered: {why}")
    recs_text = "\n\n".join(recs_lines) or "No recommendations recorded."

    # Pull phase-3 reject votes from retake for context
    phase3_votes = [v for v in new_votes if v.get("phase") == 3]
    reasoning_lines = []
    seen = set()
    for v in phase3_votes[:8]:
        name = v.get("archetype_name") or v.get("archetype_id", "panelist")
        if name in seen:
            continue
        seen.add(name)
        verdict = v.get("verdict", "")
        reasoning = v.get("reasoning", "")[:120]
        reasoning_lines.append(f'- {name} ({verdict}): "{reasoning}"')
    new_reasoning_text = "\n".join(reasoning_lines) or "No panelist reasoning recorded."

    prompt = EVALUATE_PROMPT.format(
        product_title=product_title[:80],
        original_score=original_score,
        new_score=new_score,
        score_delta=new_score - original_score,
        orig_price_pct=orig_price,
        orig_trust_pct=orig_trust,
        orig_logistics_pct=orig_logistics,
        new_price_pct=new_price,
        new_trust_pct=new_trust,
        new_logistics_pct=new_logistics,
        recs_text=recs_text,
        new_reasoning_text=new_reasoning_text,
    )

    try:
        data = llm.chat_json(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=1000,
        )
        verdicts = data.get("verdicts", [])
        if isinstance(verdicts, list) and verdicts:
            logger.info(f"Retake evaluation complete for '{product_title}': {data.get('overallVerdict')}")
            return {
                "verdicts": verdicts[:3],
                "overallVerdict": data.get("overallVerdict", "Improving"),
                "overallPolishingTouch": data.get("overallPolishingTouch", ""),
            }
    except Exception as e:
        logger.warning(f"Retake evaluation LLM call failed — using fallback: {e}")

    return _fallback_evaluation(original_recommendations, original_score, new_score)


def _fallback_evaluation(
    original_recommendations: list[dict],
    original_score: int,
    new_score: int,
) -> dict:
    """Neutral fallback so the UI always renders something."""
    delta = new_score - original_score
    overall = "Pass" if delta >= 10 else ("Improving" if delta > 0 else "Fail")

    verdicts = []
    for rec in original_recommendations[:3]:
        lens = rec.get("lens", "Specialist")
        verdicts.append({
            "lens": lens,
            "verdict": overall,
            "delta": f"Score moved {delta:+d} points overall — individual lens data unavailable.",
            "polishingTouch": "" if overall == "Pass" else rec.get("title", ""),
        })

    return {
        "verdicts": verdicts,
        "overallVerdict": overall,
        "overallPolishingTouch": "" if overall == "Pass" else (
            original_recommendations[0].get("title", "") if original_recommendations else ""
        ),
    }
