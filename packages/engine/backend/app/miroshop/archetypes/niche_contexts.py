"""
Dynamic Niche Profiler — generates product-specific buyer personas with a single LLM call.

For each archetype, generates:
  - name: First name fitting the product's target demographic
  - age: Realistic age for someone who'd buy this product
  - occupation: Job/role that aligns with the buyer type
  - motivation: Short tag (e.g. "Values Durability", "Seeks Status")
  - niche_context: One-sentence product-specific concern

One LLM call, ~120 input tokens, ~200 output tokens, <1s on Groq.
Falls back to GENERIC_PROFILES on failure.
"""

import json
import re
import logging
from typing import Dict

logger = logging.getLogger("miroshop.niche_profiler")

ARCHETYPE_IDS = [
    "budget_optimizer",
    "brand_loyalist",
    "research_analyst",
    "impulse_decider",
    "gift_seeker",
]

NICHE_PROFILE_PROMPT = """Product: "{title}" at {price} by {vendor}.

For each buyer type, generate a realistic persona who would actually evaluate this specific product. Pick demographics that match the product's real audience (age, income, lifestyle). No generic personas.

Return ONLY valid JSON — no markdown, no explanation:
{{"budget_optimizer":{{"name":"...","age":##,"occupation":"...","motivation":"...","concern":"..."}},"brand_loyalist":{{"name":"...","age":##,"occupation":"...","motivation":"...","concern":"..."}},"research_analyst":{{"name":"...","age":##,"occupation":"...","motivation":"...","concern":"..."}},"impulse_decider":{{"name":"...","age":##,"occupation":"...","motivation":"...","concern":"..."}},"gift_seeker":{{"name":"...","age":##,"occupation":"...","motivation":"...","concern":"..."}}}}

Rules:
- name: First name only, culturally diverse
- age: Realistic for this product's price point and category
- occupation: Specific job, not generic
- motivation: 2-3 word tag (e.g. "Values Durability", "Time-Poor Parent")
- concern: ONE hyper-specific sentence about THIS product, not generic e-commerce"""

GENERIC_PROFILES: Dict[str, dict] = {
    "budget_optimizer": {
        "name": "Jordan",
        "age": 32,
        "occupation": "Accountant",
        "motivation": "Seeks Best Value",
        "concern": "Compares price across stores and needs premium pricing justified.",
    },
    "brand_loyalist": {
        "name": "Priya",
        "age": 38,
        "occupation": "Marketing Director",
        "motivation": "Trusts Reputation",
        "concern": "Needs social proof, reviews, and brand credibility before buying.",
    },
    "research_analyst": {
        "name": "David",
        "age": 45,
        "occupation": "Engineer",
        "motivation": "Needs Full Specs",
        "concern": "Reads every detail — missing specs and vague descriptions are dealbreakers.",
    },
    "impulse_decider": {
        "name": "Mia",
        "age": 26,
        "occupation": "Content Creator",
        "motivation": "Loves the Aesthetic",
        "concern": "Decides in 3 seconds from hero image and headline. Visuals over text.",
    },
    "gift_seeker": {
        "name": "Sam",
        "age": 41,
        "occupation": "HR Manager",
        "motivation": "Perfect Gift Hunter",
        "concern": "Buying for someone else — needs great packaging, easy returns, fast shipping.",
    },
}


def generate_niche_profiles(
    llm,
    product_json: dict,
) -> Dict[str, dict]:
    """Generate product-specific persona profiles for each archetype via a single LLM call.

    Returns dict mapping archetype_id → {name, age, occupation, motivation, concern}.
    Falls back to GENERIC_PROFILES on any failure.
    """
    title = product_json.get("title", "Unknown Product")
    vendor = product_json.get("vendor", "Unknown")

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

    prompt = NICHE_PROFILE_PROMPT.format(
        title=title[:100],
        price=price_str,
        vendor=vendor[:50],
    )

    try:
        raw = llm.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=400,
        )
        return _parse_profiles(raw)
    except Exception as e:
        print(f"[NicheProfiler] Generation failed for '{title}': {e} — using fallback", flush=True)
        return _deep_copy_generic()


def _parse_profiles(raw: str) -> Dict[str, dict]:
    """Parse the JSON response into validated profile dicts."""
    cleaned = _extract_json_obj(raw)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        print(f"[NicheProfiler] JSON parse failed. Raw (first 400 chars): {raw[:400]}", flush=True)
        return _deep_copy_generic()

    if not isinstance(data, dict):
        return _deep_copy_generic()

    result: Dict[str, dict] = {}
    for arch_id in ARCHETYPE_IDS:
        entry = data.get(arch_id)
        if isinstance(entry, dict) and entry.get("name") and entry.get("concern"):
            result[arch_id] = {
                "name": str(entry["name"])[:30],
                "age": _safe_age(entry.get("age", 30)),
                "occupation": str(entry.get("occupation", "Professional"))[:50],
                "motivation": str(entry.get("motivation", "Evaluating"))[:40],
                "concern": str(entry["concern"])[:200],
            }

    if len(result) < 3:
        print(f"[NicheProfiler] Only parsed {len(result)}/5 profiles — using fallback", flush=True)
        return _deep_copy_generic()

    for arch_id in ARCHETYPE_IDS:
        if arch_id not in result:
            result[arch_id] = dict(GENERIC_PROFILES[arch_id])

    return result


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)
_JSON_OBJ_RE = re.compile(r"\{[\s\S]*\}")


def _extract_json_obj(raw: str) -> str:
    raw = raw.strip()
    fence = _JSON_FENCE_RE.search(raw)
    if fence:
        return fence.group(1).strip()
    obj = _JSON_OBJ_RE.search(raw)
    if obj:
        return obj.group(0)
    return raw


def _safe_age(val) -> int:
    try:
        age = int(val)
        return max(18, min(80, age))
    except (ValueError, TypeError):
        return 30


def _deep_copy_generic() -> Dict[str, dict]:
    return {k: dict(v) for k, v in GENERIC_PROFILES.items()}
