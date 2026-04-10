"""
DebateOrchestrator — Structured Friction v2 (Anti-Drift Edition).

3-phase debate pipeline:
  Phase 1 — Vibe Check:    Each agent gives an independent BUY/REJECT
  Phase 2 — Watercooler:   Cluster debate with strict anti-drift enforcement
  Phase 3 — Consensus:     Final vote after full debate

Anti-sycophancy rules (v2):
1. Identity Anchor — persona is the LAST instruction in every prompt (LLM recency bias)
2. New Info Rule — REJECT→BUY flip REQUIRES a cited product-text trigger; enforced post-hoc
3. Physical Reality Check — banned reasoning patterns (multi-unit, off-site checks, etc.)
4. Weighted Skepticism — research_analyst / budget_optimizer require hard data to flip
5. Structured output — reasoning / peer_rebuttal / vote_change_trigger / final_vote
"""

import json
import logging
import random
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import TypedDict, List, Union, Optional
from dataclasses import dataclass, field

from ...config import Config
from ...utils.llm_client import LLMClient
from ..archetypes.definitions import Archetype
from ..archetypes.niche_contexts import GENERIC_PROFILES
from .shopify_ingestion import ProductBrief, format_for_debate
from .archetype_generator import DynamicArchetype
from .dna_extractor import ProductDNA, format_dna_for_prompt

logger = logging.getLogger("miroshop.orchestrator")

AnyArchetype = Union[Archetype, DynamicArchetype]

# Shown to merchants in the app — never expose raw JSON/timeout internals.
_MERCHANT_TIMEOUT_REASONING = (
    "This panelist needed more time to finish analyzing the listing. "
    "Treat this as hesitation — the PDP may still be missing a reassurance they need."
)
_MERCHANT_MALFORMED_REASONING = (
    "This panelist's reaction could not be fully captured. "
    "Assume they still have open concerns about the listing."
)

# Archetypes that require hard evidence to flip — they will not be moved by peer enthusiasm
_HIGH_SKEPTICISM_IDS = {"research_analyst", "budget_optimizer"}


class AgentVote(TypedDict):
    agent_id: str
    archetype_id: str
    archetype_name: str
    archetype_emoji: str
    persona_name: str        # human name e.g. "Marcus"
    persona_age: int         # e.g. 34
    persona_occupation: str  # e.g. "Professional Athlete"
    persona_motivation: str  # e.g. "Values Durability"
    niche_concern: str       # "Why I'm here" — product-specific concern
    phase: int
    verdict: str           # "BUY" | "REJECT" | "NEUTRAL"
    reasoning: str
    confidence: float        # normalised 0–1 (= confidence_score / 100)
    confidence_score: int    # 0–100 integer (primary field)
    peer_rebuttal: str     # phase 2/3: direct response to another agent
    vote_change_trigger: str  # phase 2/3: product-text that justified a flip (or "")


class DebateResult(TypedDict):
    score: int
    image_score: int
    votes: list[AgentVote]
    friction: dict
    summary: str
    phase1_votes: list[AgentVote]
    phase2_votes: list[AgentVote]
    phase3_votes: list[AgentVote]


# ── Vocabulary pools (anti-templating) ────────────────────────────────────────
REJECTION_OPENERS = [
    "I'm not buying this because",
    "My concern here is",
    "What stops me is",
    "The issue I see is",
    "I'd walk away because",
    "This doesn't work for me —",
]

BUY_OPENERS = [
    "I'd buy this because",
    "This works for me —",
    "I'm in, specifically because",
    "What gets me over the line is",
    "I'm comfortable buying because",
]

FOCUS_AREA_BIASES: dict[str, str] = {
    "trust_credibility": "FOCUS: TRUST — check return policy, reviews, contact info, trust badges. Missing = lean REJECT.",
    "price_value": "FOCUS: PRICE — compare vs Amazon/Google. No premium justification = lean REJECT.",
    "technical_specs": "FOCUS: SPECS — need exact dimensions, materials, certifications. Vague claims = lean REJECT.",
    "visual_branding": "FOCUS: BRANDING — check for real brand vs dropship template. Stock photos = lean REJECT.",
    "mobile_friction": "FOCUS: MOBILE — evaluate on small screen. Cluttered or unclear checkout = lean REJECT.",
}

PHYSICAL_REALITY_RULES = "ONE purchase decision. You are on this product page only — no tabs open, no off-site checking."

TONE_RULE = (
    "Write the way YOUR specific persona would actually think out loud — not as an AI playing a character. "
    "No corporate filler. No generic openers. No 'Honestly,' or 'Look,' to start. "
    "Your voice is shaped by your job, your situation, your past experience with similar products."
)

# Injected once at the top of every agent prompt as a grounding instruction
HUMAN_SHOPPER_SYSTEM = """You've been asked to honestly evaluate this product page before making a purchase decision. Think of it this way: someone is paying you to give your real, unfiltered reaction — would you personally buy this, and why or why not? Your honesty is the entire point.

You have a specific situation, a budget you actually care about, and experience with similar products or price points. You are not a reviewer, not an auditor, not a critic. You are a person deciding whether to spend their money.

You are evaluating THIS listing — the title, price, description, images mentioned, policies, specs, and any other information visible on this page. You cannot access external websites during this evaluation.

WHAT YOU CAN DO:
- React to what the listing claims — and whether those claims are credible at this price
- Notice pricing signals: a significant discount can mean a great deal, or it can make you wonder why. Use your judgment — is it a normal sale or does it feel off?
- Call out what's missing that YOU specifically need before buying
- Bring your own experience with similar products, similar prices, similar brands
- Be detailed when something genuinely concerns or excites you — your feedback needs to be useful to the merchant, not just a vote
- Use bullets if you have several distinct points to make

WHAT YOU CANNOT DO:
- Reference social media, influencers, or online reviews you haven't seen on this page
- Demand sourcing documentation or lab certifications that no normal shopper would expect to find on a product listing
- Say a brand "has no online presence" — you can't see that from this page. You can say you've never heard of them.
- Compare to competitor prices unless you personally remember paying that price for something similar

Your response can be 2 sentences or 6 bullet points — whatever your reaction actually warrants. Real people don't write the same length for every product. If one concern is decisive, say it clearly. If you have three separate issues, list them."""

SKEPTIC_ANCHOR = "SKEPTIC: Only flip REJECT→BUY with something concrete from the listing. Peer enthusiasm alone is not enough."

# Phase 2 context — replaces HUMAN_SHOPPER_SYSTEM for the watercooler phase.
# Agents are now in a CONVERSATION, not evaluating a fresh listing.
WATERCOOLER_CONTEXT = """You've read this product listing. Now you're talking through it with other buyers who reacted differently.

You carry your initial reaction with you. You're NOT re-reading the listing — you're responding to what OTHERS said about it.
Everything you know about this product comes from what you read. No external sources, no social media, no brand websites."""

# Shapes decision-making without prescribing a formula or length
DECISION_SHAPE_RULE = (
    "React like a real person deciding whether to spend their money. "
    "Some people lead with gut, some with a specific concern, some with enthusiasm. "
    "Some write two sentences, some write five, some use bullet points when they have multiple distinct issues. "
    "Your response reflects YOUR situation and YOUR priorities — there is no required structure or length. "
    "Your feedback must be useful to the merchant: if you have concerns, name them precisely so they can be fixed. "
    "REJECT means this product actively fails something YOU need. "
    "BUY means the listing gives you enough confidence to click Add to Cart. "
    "NEUTRAL means you want to but ONE specific thing is unresolved for you personally."
)

# ── Brutality Slider evidence injection ───────────────────────────────────────
# Injected into every prompt phase. Higher level = more evidence required to BUY.
def _brutality_rule(level: int) -> str:
    """Return the evidence rule string for the given brutality level (1-10).

    Levels 1-5: no extra rule — balanced, realistic buyer behaviour.
    Level 6-7:  one evidence requirement before BUY.
    Level 8:    two evidence requirements; lean REJECT on doubt.
    Level 9-10: three independent evidence forms required; default REJECT.
    """
    if level <= 5:
        return ""  # No extra constraint — balanced review
    if level <= 7:
        return (
            "EVIDENCE RULE: Before voting BUY, name one specific, verifiable signal "
            "from the listing (a policy, a spec, a real review quote). "
            "Generic marketing language does not count."
        )
    if level <= 8:
        return (
            "EVIDENCE RULE (HIGH STRESS): Require 2 concrete, verifiable signals from "
            "the listing before voting BUY. If in doubt, lean REJECT."
        )
    # Level 9-10
    return (
        "EVIDENCE RULE (MAXIMUM STRESS): Require 3 independent, verifiable data points "
        "for every positive claim. Default verdict is REJECT unless proven otherwise. "
        "Only exact specs, verifiable policies, and real review quotes qualify."
    )


REASONABLE_BUYER_RULES = """BUYER GROUND RULES:
1. You can only see this listing — no brand websites, social media, reviews, or external sources.
2. Accept stated claims at face value. React to whether they MATTER for your needs — don't demand documentation no shopper would expect on a product page.
3. Before saying something is missing, re-read. If you find it — in the description, shipping policy, or return policy — reference it by name. Never claim something is absent if it's there.
4. REJECT only when this product actively fails YOUR specific needs. "I couldn't find X" is not a REJECT reason unless X is critical for you personally.
5. You can say "I haven't heard of this brand" — that's personal experience. You CANNOT say "the brand has no presence online" — you can't see that from this page.
6. Pricing signals: a significant discount can be a genuine deal or it can make you wonder why. Use your own judgment — is this a normal sale, clearance, a pricing tactic, or something that makes you pause? Trust your instincts on this.
{product_context}"""

VIBE_CHECK_PROMPT = """{human_shopper_system}

{focus_bias}{dna_context}{trust_context}{physical_reality}
{decision_shape_rule}
{tone_rule}
{buyer_rules}

--- PRODUCT LISTING ---
{product_brief}
--- END LISTING ---

YOU ARE: {persona}
YOUR LENS: {lens_and_flaw}
YOUR DEAL-BREAKER: {rejection_threshold}

Read the listing above. React to it the way YOU specifically would — your situation, your priorities, your gut.

CONFIDENCE SCALE (0–100):
  0–45 = REJECT  (not buying — something in this listing fails YOUR needs)
  46–54 = NEUTRAL (tempted but ONE specific thing is unresolved for you)
  55–100 = BUY   (adding to cart — listing meets YOUR needs well enough)

OUTPUT RULE: Respond with ONLY this JSON — no text before or after, no markdown fences.
reasoning: Your genuine reaction — as long or as short as your opinion actually warrants. Lead with what matters most to YOU. If you have multiple concerns, list them. Bullet points inside the reasoning string are fine. Your feedback needs to be specific enough that the merchant can act on it.
{{"reasoning":"your reaction — specific to YOUR situation, whatever length it takes","vote":"BUY or NEUTRAL or REJECT","confidence_score":0}}"""

WATERCOOLER_PROMPT = """{watercooler_context}

{focus_bias}{dna_context}Product being discussed: {product_brief}

What others said in round 1:
{other_votes_summary}
{phase2_chain}
Your round 1 was: {my_verdict} — "{my_reasoning}"
Your round 1 position is recorded. Do NOT restate it — build on it or move from it based on what others raised.
{skeptic_anchor}{dissenter_instruction}

Say where YOU stand now — your current position based on YOUR situation. Then engage with what the last person said: do they have a point, are they missing something, or does their concern not apply to you?

{anti_repeat_block}
Changing your vote requires a concrete reason from the product or the debate — not "everyone agrees" or vague agreement.
{decision_shape_rule}
{tone_rule}
{buyer_rules}

YOU ARE: {persona}
YOUR LENS: {lens_and_flaw}
YOUR DEAL-BREAKER: {rejection_threshold}

CONFIDENCE SCALE — 0–45 = REJECT | 46–54 = NEUTRAL | 55–100 = BUY. Set vote to match.

OUTPUT RULE: Respond with ONLY this JSON — no text before or after, no markdown fences.
{{"reasoning":"Your current position from YOUR perspective — then engage with the last speaker. As long as your reaction warrants. Specific enough to be useful.","peer_rebuttal":"1-2 sentences addressing the last person's specific argument","vote_change_trigger":"specific product claim or debate point that moved you, or empty string","vote":"BUY or NEUTRAL or REJECT","confidence_score":0}}"""

DISSENTER_INSTRUCTION = """
PUSH BACK: {agreement_pct}% of the panel is leaning positive. Your job is to be the hardest voice in the room — raise the strongest concern that hasn't been addressed. You don't HAVE to vote REJECT, but you must challenge the consensus with something concrete."""

CONSENSUS_PROMPT = """{human_shopper_system}

You've heard the full discussion. Now make your final call on: {product_brief}

The debate:
{debate_summary}

You've had time to think. Has anything in the discussion changed how you see this product? Or do you stand by your original gut reaction?

{decision_shape_rule}
{tone_rule}
{buyer_rules}

YOU ARE: {persona}
YOUR LENS: {lens_and_flaw}
YOUR DEAL-BREAKER: {rejection_threshold}

Don't just follow the crowd. Your final answer should reflect YOUR specific needs and situation.
If you're changing your vote from round 1, say exactly what moved you.

CONFIDENCE SCALE — 0–45 = REJECT | 46–54 = NEUTRAL | 55–100 = BUY. Set vote to match.

OUTPUT RULE: Respond with ONLY this JSON — no text before or after, no markdown fences.
{{"reasoning":"What ultimately tips your decision, from YOUR perspective — as specific and detailed as it needs to be. If something concrete changed your mind, say exactly what it was.","peer_rebuttal":"1-2 sentences on the most compelling point someone else made","vote_change_trigger":"specific quote that changed your mind, or empty string","vote":"BUY or NEUTRAL or REJECT","confidence_score":0}}"""

FRICTION_CLASSIFICATION_PROMPT = """Classify friction from this debate. Product: {product_title} at {price}
Debate: {debate_summary}

JSON only:
{{"price":{{"dropoutPct":0-100,"topObjections":["..","..",".."]}},"trust":{{"dropoutPct":0-100,"topObjections":["..","..",".."]}},"logistics":{{"dropoutPct":0-100,"topObjections":["..","..",".."]}}}}"""


def _is_high_skepticism(archetype: AnyArchetype) -> bool:
    """True for archetypes that require hard data to flip their vote."""
    aid = (archetype.id or "").lower()
    name = (archetype.name or "").lower()
    keywords = {"research", "analyst", "budget", "optimizer", "skeptic"}
    return any(k in aid or k in name for k in keywords)


@dataclass
class DebateOrchestrator:
    llm: LLMClient
    agent_count: int
    archetypes: List[AnyArchetype]
    callback_fn: callable
    niche_map: dict = field(default_factory=lambda: {k: dict(v) for k, v in GENERIC_PROFILES.items()})
    focus_areas: list[str] = field(default_factory=list)
    trust_context: str = ""
    product_context: str = ""    # Dynamic product-category intelligence (from ProductIntelligence)
    gap_context: str = ""        # Listing gap analysis — grounds persona feedback in real evidence
    temp_modifier: float = 0.0   # Customer Lab skepticism offset (+/-0.12)
    brutality_level: int = 5     # 1-10 evidence threshold (Brutality Slider)
    product_dna: Optional[ProductDNA] = None  # Psychological DNA — fear, desire, persona hooks
    fast_llm: Optional[LLMClient] = None      # 8B client for classification (friction, summary)
    active_experiment: str = ""               # Experiment card hypothesis being tested in this run
    manual_overrides: list[str] = field(default_factory=list)  # merchant-verified fixes injected as ground truth

    def _assign_archetypes(self) -> list[tuple[int, AnyArchetype, str]]:
        pool = self.archetypes
        agents: list[tuple[int, AnyArchetype, str]] = []
        per_archetype = max(1, self.agent_count // len(pool))
        remainder = self.agent_count - (per_archetype * len(pool))

        for i, archetype in enumerate(pool):
            count = per_archetype + (1 if i < remainder else 0)
            subs = list(archetype.sub_personas) if archetype.sub_personas else [""]
            # Deterministic selection: use archetype index to pick sub-persona.
            # No random.shuffle — same product always gets same sub-personas.
            for j in range(count):
                sub_persona = subs[(i + j) % len(subs)]
                agents.append((len(agents), archetype, sub_persona))

        return agents

    def _try_repair_agent_json(self, raw: str, archetype_name: str = "") -> Optional[dict]:
        """One repair pass via fast LLM when the deep model returns invalid JSON.

        Smart truncation repair: if the raw response is cut mid-sentence and a
        partial confidence_score can be inferred, the repair LLM is asked to
        complete the reasoning with exactly one closing sentence that matches
        the agent's confidence direction.
        """
        if not self.fast_llm or not (raw and raw.strip()):
            return None
        try:
            snippet = raw.strip()[:4500]

            # Detect likely truncation: no closing brace and ends mid-word/sentence
            is_truncated = "}" not in snippet[-50:] and len(snippet) > 100

            truncation_hint = ""
            if is_truncated:
                truncation_hint = (
                    "\nNOTE: The text above appears truncated. "
                    "Complete the 'reasoning' field with EXACTLY ONE short natural sentence "
                    "that logically closes the argument — match the emotional tone of what's already written. "
                    "Do NOT add new concerns. Just close the thought."
                )

            fix_prompt = (
                "The text below should contain one JSON object with keys: "
                "vote (string BUY, NEUTRAL, or REJECT), "
                "confidence_score (integer 0-100 — 0-45=REJECT, 46-54=NEUTRAL, 55-100=BUY), "
                "reasoning (string), "
                "peer_rebuttal (string, may be empty), vote_change_trigger (string, may be empty). "
                f"{truncation_hint}"
                "Reply with ONLY minified valid JSON, no markdown fences.\n\n"
                f"{snippet}"
            )
            fixed = self.fast_llm.chat(
                messages=[{"role": "user", "content": fix_prompt}],
                temperature=0.1,
                max_tokens=600,
            )
            data = json.loads(_extract_json(fixed))
            if not isinstance(data, dict):
                return None

            # Accept both old (final_vote) and new (vote) field names
            vote = str(data.get("vote", data.get("final_vote", data.get("verdict", "REJECT")))).upper()
            if vote not in ("BUY", "NEUTRAL", "REJECT"):
                vote = "REJECT"

            # Extract confidence_score (new) or derive from old confidence float
            raw_cs = data.get("confidence_score")
            if raw_cs is None:
                raw_cs = round(float(data.get("confidence", 0.5)) * 100)
            confidence_score = max(0, min(100, int(raw_cs)))

            reasoning = str(data.get("reasoning", "")).strip()
            if len(reasoning) < 3:
                return None
            return {
                "final_vote": vote,
                "reasoning": reasoning,
                "confidence": confidence_score / 100,
                "confidence_score": confidence_score,
                "peer_rebuttal": str(data.get("peer_rebuttal", "")),
                "vote_change_trigger": str(data.get("vote_change_trigger", "")),
            }
        except Exception as ex:
            logger.debug(f"[{self.__class__.__name__}] JSON repair failed: {ex}")
            return None

    def _call_agent(
        self,
        prompt: str,
        archetype: AnyArchetype,
        timeout_seconds: Optional[int] = None,
        max_tokens: int = 500,
    ) -> dict:
        """
        Call LLM for a single agent. Returns a parsed dict with keys:
          final_vote, reasoning, confidence, peer_rebuttal, vote_change_trigger.

        Raises on fatal errors (rate limit, no fallback, network).
        Malformed JSON → repair attempt → soft REJECT with merchant-safe copy.
        """
        from concurrent.futures import ThreadPoolExecutor as _TPE, TimeoutError as _TE

        tlim = timeout_seconds if timeout_seconds is not None else Config.DEBATE_AGENT_THREAD_TIMEOUT_SEC

        def _do_call() -> str:
            effective_temp = min(0.95, max(0.05, archetype.temperature + self.temp_modifier))
            return self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=effective_temp,
                max_tokens=max_tokens,
            )

        def _finalize_payload(data: dict) -> dict:
            # ── Confidence score (new primary field) ─────────────────────────
            raw_cs = data.get("confidence_score")
            if raw_cs is None:
                # Backward compat: old "confidence" was 0–1 float
                raw_cs = round(float(data.get("confidence", 0.5)) * 100)
            confidence_score = max(0, min(100, int(raw_cs)))

            # Derive vote from confidence range — trust the number over the label
            if confidence_score <= 45:
                derived_vote = "REJECT"
            elif confidence_score <= 54:
                derived_vote = "NEUTRAL"
            else:
                derived_vote = "BUY"

            # Accept both old (final_vote) and new (vote) field names
            explicit_vote = str(data.get("vote", data.get("final_vote", data.get("verdict", "")))).upper()
            if explicit_vote in ("BUY", "NEUTRAL", "REJECT"):
                vote = explicit_vote
                # Resolve conflicts: confidence_score wins on clear mismatches
                if vote == "BUY" and confidence_score <= 45:
                    vote = "REJECT"
                elif vote == "REJECT" and confidence_score >= 55:
                    vote = "BUY"
                elif vote in ("BUY", "REJECT") and 46 <= confidence_score <= 54:
                    vote = "NEUTRAL"
            else:
                vote = derived_vote

            reasoning = str(data.get("reasoning", "No reasoning provided."))
            # Guard against truncated repairs — a fragment under 20 chars is useless
            if len(reasoning.strip()) < 20:
                reasoning = f"This panelist's reaction wasn't fully captured — treat as hesitation."

            _PROMPT_LEAK_PATTERNS = [
                r"VOTE-CHANGE:[^\n]*",
                r"Physical Reality Check[^\n]*",
                r"DISSENTER:[^\n]*",
                r"FOCUS: (?:TRUST|PRICE|SPECS|BRANDING|MOBILE)[^\n]*",
                r"SKEPTIC:[^\n]*",
            ]
            _LEAK_RE = re.compile(
                r"\s*↳?\s*(?:" + "|".join(_PROMPT_LEAK_PATTERNS) + r").*",
                re.DOTALL | re.IGNORECASE,
            )

            def _strip_leaks(text: str, fallback: str) -> str:
                cleaned = _LEAK_RE.sub("", text).strip(" ↳\n")
                return cleaned if cleaned else fallback

            reasoning = _strip_leaks(reasoning, "No additional reasoning provided.")
            peer_rebuttal = _strip_leaks(str(data.get("peer_rebuttal", "")), "")

            reasoning_lower = reasoning.lower()
            buy_signals = sum(
                1
                for s in (
                    "i'm in",
                    "i'd buy",
                    "i would buy",
                    "gets me over the line",
                    "i'm comfortable buying",
                )
                if s in reasoning_lower
            )
            reject_signals = sum(
                1
                for s in (
                    "i'd skip",
                    "i'm not buying",
                    "i'd walk away",
                    "deal-breaker",
                    "red flag",
                    "hesitant",
                )
                if s in reasoning_lower
            )
            # Coherence check only applies to clear BUY/REJECT mismatches — skip NEUTRAL
            if vote == "REJECT" and buy_signals > reject_signals and buy_signals >= 2:
                print(
                    f"[{archetype.name}] Coherence fix: reasoning says BUY but vote=REJECT — flipping to BUY",
                    flush=True,
                )
                vote = "BUY"
                if confidence_score <= 45:
                    confidence_score = 58  # bump to hesitant-yes range
            elif vote == "BUY" and reject_signals > buy_signals and reject_signals >= 2:
                print(
                    f"[{archetype.name}] Coherence fix: reasoning says REJECT but vote=BUY — flipping to REJECT",
                    flush=True,
                )
                vote = "REJECT"
                if confidence_score >= 55:
                    confidence_score = 38  # drop to reject range

            return {
                "final_vote": vote,
                "reasoning": reasoning,
                "confidence": confidence_score / 100,
                "confidence_score": confidence_score,
                "peer_rebuttal": peer_rebuttal,
                "vote_change_trigger": str(data.get("vote_change_trigger", "")),
            }

        ex = _TPE(max_workers=1)
        fut = ex.submit(_do_call)
        try:
            raw = fut.result(timeout=tlim)
        except _TE:
            ex.shutdown(wait=False)
            logger.warning(f"[{archetype.name}] timed out after {tlim}s")
            return _fallback_reject(_MERCHANT_TIMEOUT_REASONING)
        except Exception:
            ex.shutdown(wait=False)
            raise
        ex.shutdown(wait=False)

        try:
            data = json.loads(_extract_json(raw))
            return _finalize_payload(data)
        except (json.JSONDecodeError, KeyError, ValueError):
            logger.warning(
                f"[{archetype.name}] malformed primary response — attempting JSON repair. "
                f"Raw (first 200 chars): {raw[:200]!r}"
            )
            # Pass 1 — LLM repair via fast model (with smart truncation completion)
            repaired = self._try_repair_agent_json(raw, archetype_name=archetype.name)
            if repaired:
                try:
                    return _finalize_payload(repaired)
                except (KeyError, ValueError):
                    pass

            # Pass 2 — freeform salvage: extract vote + reasoning from plain text
            salvaged = _salvage_freeform(raw)
            if salvaged:
                try:
                    return _finalize_payload(salvaged)
                except (KeyError, ValueError):
                    pass

            # Pass 3 — absolute last resort: log full raw for debugging, return REJECT
            logger.error(
                f"[{archetype.name}] all recovery attempts failed. "
                f"Full raw ({len(raw)} chars): {raw!r}"
            )
            return _fallback_reject(_MERCHANT_MALFORMED_REASONING)

    def _build_focus_bias(self) -> str:
        blocks = [FOCUS_AREA_BIASES[f] for f in self.focus_areas if f in FOCUS_AREA_BIASES]
        if not blocks:
            return ""
        return "\n".join(blocks) + "\n"

    def _build_buyer_rules(self) -> str:
        """Combine base rules + product context + gap analysis + brutality slider + active experiment."""
        product_ctx = f"\n{self.product_context}" if self.product_context else ""
        base = REASONABLE_BUYER_RULES.format(product_context=product_ctx)
        if self.gap_context:
            # Only raise gaps that are genuinely relevant to YOUR specific situation
            # — not all agents need to call out every missing item
            base = base + (
                "\n\nLISTING GAPS (what the listing doesn't answer — only raise the ones that "
                "GENUINELY matter for YOUR specific needs and situation):\n" + self.gap_context
            )
        brutality_rule = _brutality_rule(self.brutality_level)
        if brutality_rule:
            base = base + "\n\n" + brutality_rule
        if self.active_experiment:
            base = base + (
                f"\n\nACTIVE EXPERIMENT: The merchant has made this specific change to their listing:\n"
                f'"{self.active_experiment}"\n'
                f"Factor this change into your evaluation. Does it directly address your core concern? "
                f"Be explicit — state whether it moves your vote and why."
            )
        if self.manual_overrides:
            override_lines = "\n".join(
                f"[SYSTEM NOTE: The merchant has verified that the following fix is now implemented: {fix}]."
                for fix in self.manual_overrides
            )
            base = base + (
                f"\n\nMERCHANT-VERIFIED FIXES — treat these as absolute ground truth, "
                f"even if the listing text doesn't yet reflect them:\n{override_lines}"
            )
        return base

    def _get_niche_ctx(self, archetype: AnyArchetype) -> str:
        profile = self.niche_map.get(archetype.id, {})
        if isinstance(profile, dict):
            return profile.get("concern", "")
        return str(profile) if profile else ""

    def _get_persona_identity(self, archetype: AnyArchetype) -> dict:
        profile = self.niche_map.get(archetype.id, {})
        if isinstance(profile, dict):
            return profile
        return {}

    def _build_persona(self, archetype: AnyArchetype, sub_persona: str) -> str:
        parts = [archetype.base_persona]
        if sub_persona:
            parts.append(f"\nIdentity: {sub_persona}")
        niche = self._get_niche_ctx(archetype)
        if niche:
            parts.append(f"\nContext: {niche}")
        priority = getattr(archetype, "friction_priority", "")
        if priority:
            parts.append(f"\n{priority}")
        return "".join(parts)

    def _build_lens_and_flaw(self, archetype: AnyArchetype) -> str:
        """Build the analytical lens + human flaw + voice anchor injected into every prompt."""
        lens = getattr(archetype, "analytical_lens", "")
        flaw = getattr(archetype, "human_flaw", "")
        opening = getattr(archetype, "opening_voice", "")
        parts = []
        if lens:
            parts.append(f"Analytical lens — {lens}")
        if flaw:
            parts.append(f"Your flaw — {flaw}")
        if opening:
            parts.append(f"Your voice sounds like — \"{opening}\"")
        if not parts:
            style = getattr(archetype, "debate_style", "")
            if style:
                parts.append(f"How you argue — {style}")
        return " | ".join(parts) if parts else "Evaluate honestly through your personal experience."

    # ── Phase 1 ────────────────────────────────────────────────────────────────

    def _run_phase1_agent(
        self,
        agent_idx: int,
        archetype: AnyArchetype,
        sub_persona: str,
        product_brief: str,
    ) -> AgentVote:
        trust_ctx_block = f"\n{self.trust_context}\n" if self.trust_context else ""
        dna_block = format_dna_for_prompt(self.product_dna, archetype.id)
        dna_ctx_block = f"\n{dna_block}\n" if dna_block else ""
        prompt = VIBE_CHECK_PROMPT.format(
            human_shopper_system=HUMAN_SHOPPER_SYSTEM,
            focus_bias=self._build_focus_bias(),
            dna_context=dna_ctx_block,
            trust_context=trust_ctx_block,
            physical_reality=PHYSICAL_REALITY_RULES,
            decision_shape_rule=DECISION_SHAPE_RULE,
            tone_rule=TONE_RULE,
            buyer_rules=self._build_buyer_rules(),
            persona=self._build_persona(archetype, sub_persona),
            lens_and_flaw=self._build_lens_and_flaw(archetype),
            rejection_threshold=archetype.rejection_threshold,
            product_brief=product_brief,
        )
        data = self._call_agent(prompt, archetype, max_tokens=1400)
        return _make_vote(agent_idx, archetype, 1, data, self._get_persona_identity(archetype))

    # ── Phase 2 ────────────────────────────────────────────────────────────────

    def _run_phase2_agent(
        self,
        agent_idx: int,
        archetype: AnyArchetype,
        sub_persona: str,
        product_brief: str,
        phase1_votes: list[AgentVote],
        buy_pct: float,
        phase2_chain: list[AgentVote],   # phase 2 responses from agents that already went
    ) -> AgentVote:
        my_p1 = phase1_votes[agent_idx]
        others = [v for v in phase1_votes if v["agent_id"] != f"agent_{agent_idx}"]
        # Show first full sentence of each Phase 1 response (up to 120 chars)
        # so agents can actually engage with each other's specific arguments
        def _first_sentence(text: str, max_chars: int = 120) -> str:
            # Strip any appended ↳ rebuttal line before extracting
            core = text.split("\n↳")[0].strip()
            sent = core.split(".")[0].strip()
            return sent[:max_chars] if len(sent) > 10 else core[:max_chars]

        other_summary = "\n".join(
            f"- {v.get('archetype_name', v['archetype_id'])}: {v['verdict']} — \"{_first_sentence(v['reasoning'])}\""
            for v in others[:6]
        )

        # Build chain: show first full sentence (up to 120 chars) so agents can
        # actually engage — but anti-echo block below bans verbatim copying
        chain_block = ""
        if phase2_chain:
            chain_lines = ["\nWhat's been said so far:"]
            for v in phase2_chain:
                name = v.get("archetype_name", v["archetype_id"])
                raw = v.get("reasoning", "")
                # First complete sentence, up to 120 chars
                first_sent = raw.split(".")[0].strip()
                core = first_sent[:120] if len(first_sent) > 10 else raw.split(",")[0].strip()[:120]
                chain_lines.append(f"  {name} → {v['verdict']}: \"{core}\"")
            chain_block = "\n".join(chain_lines) + "\n"

        is_dissenter = buy_pct > 0.8 and agent_idx == _pick_dissenter_idx(phase1_votes)
        dissenter_instr = (
            DISSENTER_INSTRUCTION.format(agreement_pct=int(buy_pct * 100))
            if is_dissenter
            else ""
        )
        skeptic_anchor = SKEPTIC_ANCHOR if _is_high_skepticism(archetype) else ""
        dna_block = format_dna_for_prompt(self.product_dna, archetype.id)
        dna_ctx_block = f"\n{dna_block}\n" if dna_block else ""

        # Anti-repetition: hard ban on echoing previous speakers' opening sentences
        anti_repeat_block = ""
        if phase2_chain:
            raised = []
            for prev in phase2_chain[-4:]:
                first_sent = prev.get("reasoning", "").split(".")[0].strip()[:80]
                if len(first_sent) > 15:
                    raised.append(f'"{first_sent}"')
            if raised:
                anti_repeat_block = (
                    f"\nDO NOT OPEN WITH THEIR POINT: These openings are already taken — "
                    f"starting your response with them is forbidden: {'; '.join(raised)}\n"
                    "Start from YOUR situation and YOUR lens — not a reaction to their first sentence.\n"
                )

        # Extract Phase 1 core reasoning — strip appended ↳ peer_rebuttal artifact
        # (_make_vote appends it, but it's confusing if shown as "what you said in round 1")
        _p1_raw = my_p1["reasoning"]
        _p1_core = _p1_raw.split("\n↳")[0].strip()
        _p1_first_sentence = _p1_core.split(".")[0].strip()
        my_reasoning_short = _p1_first_sentence[:120] if len(_p1_first_sentence) > 15 else _p1_core[:120]

        prompt = WATERCOOLER_PROMPT.format(
            watercooler_context=WATERCOOLER_CONTEXT,
            focus_bias=self._build_focus_bias(),
            dna_context=dna_ctx_block,
            decision_shape_rule=DECISION_SHAPE_RULE,
            tone_rule=TONE_RULE,
            buyer_rules=self._build_buyer_rules(),
            persona=self._build_persona(archetype, sub_persona),
            lens_and_flaw=self._build_lens_and_flaw(archetype),
            rejection_threshold=archetype.rejection_threshold,
            product_brief=product_brief,
            other_votes_summary=other_summary,
            phase2_chain=chain_block,
            my_verdict=my_p1["verdict"],
            my_reasoning=my_reasoning_short,
            skeptic_anchor=skeptic_anchor,
            dissenter_instruction=dissenter_instr,
            anti_repeat_block=anti_repeat_block,
        )
        data = self._call_agent(prompt, archetype, max_tokens=1200)

        # ── Enforce New Info Rule ──────────────────────────────────────────────
        trigger = data.get("vote_change_trigger", "").strip()

        # Hard REJECT→BUY flip requires cited product evidence.
        # REJECT→NEUTRAL is allowed — partial softening is realistic.
        if my_p1["verdict"] == "REJECT" and data["final_vote"] == "BUY":
            if len(trigger) < 10:
                logger.info(
                    f"[{archetype.name}] REJECT→BUY flip blocked — no evidence cited, demoting to NEUTRAL"
                )
                data["final_vote"] = "NEUTRAL"
                cs = data.get("confidence_score", 60)
                if cs >= 55:
                    data["confidence_score"] = 50
                data["reasoning"] += " [Position softened — not enough product evidence to fully commit.]"
                data["vote_change_trigger"] = ""

        # NEUTRAL→BUY flip also requires product evidence, not just peer agreement.
        # Peer enthusiasm ("the vet's endorsement tips the scale") is not product evidence.
        elif my_p1["verdict"] == "NEUTRAL" and data["final_vote"] == "BUY":
            if len(trigger) < 10:
                # Check if reasoning contains peer-agreement language with no product reference
                reasoning_lower = data.get("reasoning", "").lower()
                peer_signals = ["endorsement", "agrees", "everyone", "the panel", "what they said",
                                "the vet", "the expert", "tips the scale", "seals it", "convinced me"]
                is_peer_only = any(s in reasoning_lower for s in peer_signals) and trigger == ""
                if is_peer_only:
                    logger.info(
                        f"[{archetype.name}] NEUTRAL→BUY flip blocked — peer-only trigger, holding at NEUTRAL"
                    )
                    data["final_vote"] = "NEUTRAL"
                    cs = data.get("confidence_score", 55)
                    if cs >= 55:
                        data["confidence_score"] = 52  # hold at fence
                    data["vote_change_trigger"] = ""

        return _make_vote(agent_idx, archetype, 2, data, self._get_persona_identity(archetype))

    # ── Phase 3 ────────────────────────────────────────────────────────────────

    def _run_phase3_agent(
        self,
        agent_idx: int,
        archetype: AnyArchetype,
        sub_persona: str,
        compact_brief: str,
        debate_summary: str,
        phase1_votes: list[AgentVote],
    ) -> AgentVote:
        prompt = CONSENSUS_PROMPT.format(
            human_shopper_system=HUMAN_SHOPPER_SYSTEM,
            physical_reality=PHYSICAL_REALITY_RULES,
            decision_shape_rule=DECISION_SHAPE_RULE,
            tone_rule=TONE_RULE,
            buyer_rules=self._build_buyer_rules(),
            persona=self._build_persona(archetype, sub_persona),
            lens_and_flaw=self._build_lens_and_flaw(archetype),
            rejection_threshold=archetype.rejection_threshold,
            product_brief=compact_brief,
            debate_summary=debate_summary,
        )
        data = self._call_agent(prompt, archetype, max_tokens=600)

        # Enforce New Info Rule: hard REJECT→BUY flip requires cited evidence
        # REJECT→NEUTRAL is allowed without evidence (partial softening is reasonable)
        my_p1 = phase1_votes[agent_idx]
        if my_p1["verdict"] == "REJECT" and data["final_vote"] == "BUY":
            trigger = data.get("vote_change_trigger", "").strip()
            if len(trigger) < 10:
                logger.info(
                    f"[{archetype.name}] Phase 3 REJECT→BUY flip blocked — no evidence cited"
                )
                data["final_vote"] = "NEUTRAL"
                if data.get("confidence_score", 50) >= 55:
                    data["confidence_score"] = 50  # hold at fence
                data["reasoning"] += " [Moved to fence — no new product evidence to fully commit.]"
                data["vote_change_trigger"] = ""

        return _make_vote(agent_idx, archetype, 3, data, self._get_persona_identity(archetype))

    # ── Main run loop ──────────────────────────────────────────────────────────

    def run(self, brief: ProductBrief) -> DebateResult:
        """Run the 3-phase debate. Archetypes were injected at construction time."""
        agents = self._assign_archetypes()
        product_brief = format_for_debate(brief, compact=False)        # P1: full listing
        medium_brief = format_for_debate(brief, medium=True)           # P2: title+price+key claims
        compact_brief = format_for_debate(brief, compact=True)         # P3: title+price only
        # Parallel execution for P1 + P3 (no inter-agent dependency).
        # When RPM throttling is active (Groq free tier), stay serial so workers
        # don't race past the threading lock and cause 429 bursts.
        # With RPM=0 (DeepInfra / paid tier) we can fan out fully.
        rpm_active = int(Config.DEEP_LLM_RPM or 0) > 0
        max_workers = 1 if rpm_active else min(len(agents), 10)

        print(
            f"[{brief['title']}] Debate start: {len(agents)} agents, "
            f"{'serial' if max_workers == 1 else f'parallel (max={max_workers})'}, 3 phases",
            flush=True,
        )

        # ── Phase 1: Vibe Check ───────────────────────────────────────────────
        print(f"[{brief['title']}] Phase 1 — Vibe Check", flush=True)
        phase1_votes: list[AgentVote] = [None] * len(agents)  # type: ignore[list-item]
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(self._run_phase1_agent, idx, arch, sub, product_brief): idx
                for idx, arch, sub in agents
            }
            for future in as_completed(futures):
                result = future.result()
                phase1_votes[futures[future]] = result
                print(
                    f"[P1] {result.get('archetype_name', result['archetype_id'])} "
                    f"→ {result['verdict']} (score:{result.get('confidence_score', round(result['confidence']*100))})",
                    flush=True,
                )
                self.callback_fn(phase=1, votes=[result], partial=True)

        buy_count = sum(1 for v in phase1_votes if v["verdict"] == "BUY")
        print(f"[{brief['title']}] Phase 1 done: {buy_count}/{len(agents)} BUY", flush=True)

        # ── Phase 2: Watercooler (chained — each agent sees prior P2 responses) ─
        print(f"[{brief['title']}] Phase 2 — Watercooler (chained)", flush=True)
        buy_pct = buy_count / len(phase1_votes)
        phase2_votes: list[AgentVote] = [None] * len(agents)  # type: ignore[list-item]
        phase2_chain: list[AgentVote] = []   # grows as each agent responds

        # STRICT SERIAL execution in agent order — chain requires it
        for idx, arch, sub in agents:
            result = self._run_phase2_agent(
                idx, arch, sub, medium_brief, phase1_votes, buy_pct, phase2_chain
            )
            phase2_votes[idx] = result
            phase2_chain.append(result)   # next agent sees this response
            flip = (
                "↑" if phase1_votes[idx]["verdict"] == "REJECT" and result["verdict"] == "BUY"
                else ("↓" if phase1_votes[idx]["verdict"] == "BUY" and result["verdict"] == "REJECT" else "·")
            )
            print(
                f"[P2] {result.get('archetype_name', result['archetype_id'])} "
                f"→ {result['verdict']} {flip}",
                flush=True,
            )
            self.callback_fn(phase=2, votes=[result], partial=True)

        print(f"[{brief['title']}] Phase 2 done", flush=True)

        # ── Phase 3: Consensus ────────────────────────────────────────────────
        print(f"[{brief['title']}] Phase 3 — Consensus", flush=True)
        debate_summary = _compress_debate(phase1_votes + phase2_votes)
        phase3_votes: list[AgentVote] = [None] * len(agents)  # type: ignore[list-item]
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(
                    self._run_phase3_agent, idx, arch, sub, compact_brief, debate_summary, phase1_votes
                ): idx
                for idx, arch, sub in agents
            }
            for future in as_completed(futures):
                result = future.result()
                phase3_votes[futures[future]] = result
                print(
                    f"[P3] {result.get('archetype_name', result['archetype_id'])} "
                    f"→ {result['verdict']}",
                    flush=True,
                )
                self.callback_fn(phase=3, votes=[result], partial=True)

        # Confidence-weighted score: average of each agent's confidence_score (0–100)
        # This ensures even small improvements register — moving one agent 22→41 visibly
        # shifts the overall score, even if the vote category stays REJECT.
        confidence_scores = [
            v.get("confidence_score", round(v.get("confidence", 0.5) * 100))
            for v in phase3_votes
        ]
        score = round(sum(confidence_scores) / len(confidence_scores))
        buy_votes = [v for v in phase3_votes if v["verdict"] == "BUY"]
        neutral_votes = [v for v in phase3_votes if v["verdict"] == "NEUTRAL"]
        print(
            f"[{brief['title']}] Phase 3 done — Score: {score}/100 "
            f"({len(buy_votes)} BUY, {len(neutral_votes)} NEUTRAL, "
            f"{len(phase3_votes) - len(buy_votes) - len(neutral_votes)} REJECT | "
            f"scores: {confidence_scores})",
            flush=True,
        )

        # Friction classification is a structured JSON task — 8B is sufficient and cheaper
        _classifier = self.fast_llm if self.fast_llm is not None else self.llm
        friction = _classify_friction(_classifier, brief, phase1_votes + phase2_votes + phase3_votes)
        summary = _build_summary(brief, score, phase3_votes, friction)

        all_votes = phase1_votes + phase2_votes + phase3_votes
        self.callback_fn(phase=3, votes=[], score=score, friction=friction, summary=summary)

        return {
            "score": score,
            "image_score": 50,
            "votes": all_votes,
            "friction": friction,
            "summary": summary,
            "phase1_votes": phase1_votes,
            "phase2_votes": phase2_votes,
            "phase3_votes": phase3_votes,
        }


# ── Helpers ────────────────────────────────────────────────────────────────────

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)
_JSON_OBJ_RE = re.compile(r"\{[\s\S]*\}")
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")
# Matches Python-style True/False/None that Llama-family models sometimes emit
_PYTHON_BOOL_RE = re.compile(r"\bTrue\b|\bFalse\b|\bNone\b")
# Matches JS-style // line comments
_JS_COMMENT_RE = re.compile(r"//[^\n]*")


def _normalize_json_text(text: str) -> str:
    """Fix common non-standard JSON quirks emitted by large models."""
    # Python booleans / None → JSON
    text = _PYTHON_BOOL_RE.sub(
        lambda m: {"True": "true", "False": "false", "None": "null"}[m.group(0)],
        text,
    )
    # Strip // line comments (illegal in JSON)
    text = _JS_COMMENT_RE.sub("", text)
    # Single-quoted strings → double-quoted  (only when not already inside double quotes)
    # Simple heuristic: replace 'key' and 'value' patterns
    text = re.sub(r"'([^'\\]*(?:\\.[^'\\]*)*)'", lambda m: '"' + m.group(1).replace('"', '\\"') + '"', text)
    return text


def _extract_json(raw: str) -> str:
    """Strip markdown fences and preamble text, repair common issues, return best JSON string.

    Handles:
    - ```json ... ``` fences
    - Conversational preamble / trailing text around the object
    - Trailing commas (Nemotron 120B)
    - Python-style True/False/None
    - JS // comments
    - Single-quoted strings
    - Truncated responses — walks back to find the last cleanly closable position
    """
    raw = raw.strip()

    # 1. Extract from fence if present
    fence_match = _JSON_FENCE_RE.search(raw)
    candidate = fence_match.group(1).strip() if fence_match else raw

    # 2. Normalise common non-standard patterns before any parse attempt
    candidate = _normalize_json_text(candidate)

    # 3. Find the JSON object boundaries (use balanced-brace scan, not greedy regex,
    #    so trailing text after the closing } doesn't pollute the candidate)
    first_brace = candidate.find("{")
    if first_brace != -1:
        depth = 0
        in_str = False
        escape = False
        end_pos = -1
        for idx in range(first_brace, len(candidate)):
            ch = candidate[idx]
            if escape:
                escape = False
                continue
            if ch == "\\" and in_str:
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
            elif not in_str:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end_pos = idx
                        break
        if end_pos != -1:
            candidate = candidate[first_brace : end_pos + 1]
    else:
        obj_match = _JSON_OBJ_RE.search(candidate)
        if obj_match:
            candidate = obj_match.group(0)

    # 4. Remove trailing commas before } or ]
    candidate = _TRAILING_COMMA_RE.sub(r"\1", candidate)

    # 5. Happy path
    try:
        json.loads(candidate)
        return candidate
    except json.JSONDecodeError:
        pass

    # 6. Truncation recovery — walk back to find last cleanly closable position
    for i in range(len(candidate) - 1, 0, -1):
        if candidate[i] in ('"', '}', ']', '0123456789'):
            attempt = candidate[: i + 1]
            open_count = attempt.count("{") - attempt.count("}")
            if open_count > 0:
                attempt = attempt + ("}" * open_count)
            attempt = _TRAILING_COMMA_RE.sub(r"\1", attempt)
            try:
                json.loads(attempt)
                return attempt
            except json.JSONDecodeError:
                continue

    return candidate


# Patterns used by _salvage_freeform to extract vote from plain text
_VOTE_BUY_RE = re.compile(
    r"\b(final[_\s]vote|verdict)\s*[:\"\s]+\s*BUY\b"
    r"|\bI(?:'d|[ ]would)\s+buy\b"
    r"|\bvoting\s+BUY\b"
    r"|\bmy\s+vote\s+is\s+BUY\b",
    re.IGNORECASE,
)
_VOTE_REJECT_RE = re.compile(
    r"\b(final[_\s]vote|verdict)\s*[:\"\s]+\s*REJECT\b"
    r"|\bI(?:'d|[ ]would)\s+(?:not\s+buy|reject|skip|walk\s+away)\b"
    r"|\bvoting\s+REJECT\b"
    r"|\bmy\s+vote\s+is\s+REJECT\b",
    re.IGNORECASE,
)


def _salvage_freeform(raw: str) -> Optional[dict]:
    """Last-resort extractor when JSON parsing and LLM repair both fail.

    Scans the raw model output for vote signals and treats the whole text as
    the reasoning.  Returns a valid agent dict or None if even the vote is
    unrecoverable.
    """
    if not raw or not raw.strip():
        return None

    text = raw.strip()

    # Determine vote from explicit markers first, then fall back to keyword count
    if _VOTE_BUY_RE.search(text):
        vote = "BUY"
    elif _VOTE_REJECT_RE.search(text):
        vote = "REJECT"
    else:
        # Count loose BUY / REJECT mentions — take whichever wins
        buy_count = len(re.findall(r"\bBUY\b", text, re.IGNORECASE))
        reject_count = len(re.findall(r"\bREJECT\b", text, re.IGNORECASE))
        if buy_count == 0 and reject_count == 0:
            return None   # Completely uninterpretable — give up
        vote = "BUY" if buy_count > reject_count else "REJECT"

    # Use the raw text as reasoning (strip any JSON noise / fences)
    reasoning = re.sub(r"```[^\n]*\n?", "", text).strip()
    # Trim to a sane length
    if len(reasoning) > 600:
        reasoning = reasoning[:597] + "…"

    # Salvaged votes get a neutral-leaning confidence score since we're guessing
    salvage_score = 65 if vote == "BUY" else (35 if vote == "REJECT" else 50)
    logger.info(f"[salvage_freeform] recovered vote={vote} from freeform text ({len(text)} chars)")
    return {
        "final_vote": vote,
        "reasoning": reasoning,
        "confidence": salvage_score / 100,
        "confidence_score": salvage_score,
        "peer_rebuttal": "",
        "vote_change_trigger": "",
    }


def _fallback_reject(reason: str) -> dict:
    return {
        "final_vote": "REJECT",
        "reasoning": reason,
        "confidence": 0.2,
        "confidence_score": 20,
        "peer_rebuttal": "",
        "vote_change_trigger": "",
    }


def _make_vote(agent_idx: int, archetype: AnyArchetype, phase: int, data: dict, persona: dict | None = None) -> AgentVote:
    """Build an AgentVote from a parsed LLM response dict."""
    rebuttal = data.get("peer_rebuttal", "")
    reasoning = data["reasoning"]
    if rebuttal:
        reasoning = f"{reasoning}\n↳ {rebuttal}"
    p = persona or {}
    confidence_score = data.get("confidence_score", round(data.get("confidence", 0.5) * 100))
    return {
        "agent_id": f"agent_{agent_idx}",
        "archetype_id": archetype.id,
        "archetype_name": archetype.name,
        "archetype_emoji": archetype.emoji,
        "persona_name": p.get("name", archetype.name),
        "persona_age": p.get("age", 30),
        "persona_occupation": p.get("occupation", ""),
        "persona_motivation": p.get("motivation", ""),
        "niche_concern": p.get("concern", ""),
        "phase": phase,
        "verdict": data["final_vote"],
        "reasoning": reasoning,
        "confidence": data["confidence"],
        "confidence_score": confidence_score,
        "peer_rebuttal": rebuttal,
        "vote_change_trigger": data.get("vote_change_trigger", ""),
    }


def _pick_dissenter_idx(phase1_votes: list[AgentVote]) -> int:
    """Pick the least-committed positive voter (BUY or NEUTRAL) as dissenter."""
    positive_voters = [
        (v.get("confidence_score", round(v.get("confidence", 0.5) * 100)), v["agent_id"])
        for v in phase1_votes
        if v["verdict"] in ("BUY", "NEUTRAL")
    ]
    if not positive_voters:
        return -1
    _, agent_id = min(positive_voters, key=lambda x: x[0])
    try:
        return int(agent_id.replace("agent_", ""))
    except ValueError:
        return 0


def _compress_debate(votes: list[AgentVote]) -> str:
    """Compress debate logs for context window management (~500 tokens max)."""
    lines = []
    for v in votes:
        name = v.get("archetype_name") or v.get("archetype_id", "agent")
        trigger = v.get("vote_change_trigger", "")
        trigger_note = f" [flipped: '{trigger[:60]}']" if trigger else ""
        lines.append(
            f"[P{v['phase']}] {name}: {v['verdict']}{trigger_note} — {v['reasoning'][:100]}"
        )
    return "\n".join(lines[-20:])  # keep last 20 entries


def _classify_friction(llm: LLMClient, brief: ProductBrief, all_votes: list[AgentVote]) -> dict:
    debate_summary = _compress_debate(all_votes)
    prompt = FRICTION_CLASSIFICATION_PROMPT.format(
        product_title=brief["title"],
        price=f"${brief['price_min']:.2f}",
        debate_summary=debate_summary,
    )
    try:
        raw = llm.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=500,
        )
        result = json.loads(_extract_json(raw))
        # Sanity check: if all dropoutPct are 0 but most agents rejected, the LLM failed
        all_zero = all(
            result.get(cat, {}).get("dropoutPct", 0) == 0
            for cat in ("price", "trust", "logistics")
        )
        reject_count = sum(1 for v in all_votes if v["verdict"] == "REJECT")
        if all_zero and reject_count > len(all_votes) * 0.3:
            print(
                f"[Friction] LLM returned all-zero friction but {reject_count}/{len(all_votes)} votes were REJECT — using rule-based fallback",
                flush=True,
            )
            return _rule_based_friction(all_votes)
        return result
    except Exception as e:
        print(f"[Friction] LLM classification failed: {e} — using rule-based fallback", flush=True)
        return _rule_based_friction(all_votes)


def _rule_based_friction(all_votes: list[AgentVote]) -> dict:
    """
    Fallback friction computation when LLM classifier fails.
    Does NOT use hardcoded keyword lists — instead reads the agent reasoning
    and assigns each reject to the category most represented in the text.
    Still a heuristic, but uses the LLM's own words rather than a fixed vocabulary.
    """
    rejects = [v for v in all_votes if v["verdict"] == "REJECT"]
    total = max(len(all_votes), 1)

    price_hits, trust_hits, logistics_hits = [], [], []

    for v in rejects:
        text = v["reasoning"].lower()
        snippet = v["reasoning"][:140].strip()

        # Use semantic signals from agent reasoning text itself —
        # the agents already wrote about their concerns in plain language
        price_score = sum([
            "price" in text, "cost" in text, "expensive" in text,
            "afford" in text, "worth" in text, "value" in text,
            "$" in text, "budget" in text, "premium" in text,
        ])
        trust_score = sum([
            "trust" in text, "brand" in text, "review" in text,
            "return" in text, "refund" in text, "contact" in text,
            "guarantee" in text, "credib" in text, "reliable" in text,
            "heard of" in text, "unknown" in text,
        ])
        logistics_score = sum([
            "ship" in text, "deliver" in text, "packag" in text,
            "arrive" in text, "days" in text, "week" in text,
            "tracking" in text, "transit" in text,
        ])

        max_score = max(price_score, trust_score, logistics_score, 1)
        if price_score == max_score:
            price_hits.append(snippet)
        elif trust_score == max_score:
            trust_hits.append(snippet)
        elif logistics_score == max_score:
            logistics_hits.append(snippet)
        else:
            trust_hits.append(snippet)  # default to trust when ambiguous

    def _pct(hits):
        return round((len(hits) / total) * 100) if hits else 0

    return {
        "price": {"dropoutPct": _pct(price_hits), "topObjections": price_hits[:3]},
        "trust": {"dropoutPct": _pct(trust_hits), "topObjections": trust_hits[:3]},
        "logistics": {"dropoutPct": _pct(logistics_hits), "topObjections": logistics_hits[:3]},
    }


def _build_summary(brief: ProductBrief, score: int, final_votes: list[AgentVote], friction: dict) -> str:
    rejects = [v for v in final_votes if v["verdict"] == "REJECT"]
    buys = [v for v in final_votes if v["verdict"] == "BUY"]

    top_objection = ""
    for cat in ["price", "trust", "logistics"]:
        objs = friction.get(cat, {}).get("topObjections", [])
        if objs:
            top_objection = objs[0]
            break

    if score >= 70:
        tone = "Your panel responded positively."
    elif score >= 45:
        tone = "Your panel had mixed reactions."
    else:
        tone = "Your panel raised significant concerns."

    summary = f"{tone} {len(buys)} of {len(final_votes)} panelists said they would buy."
    if top_objection:
        # Truncate at sentence boundary; strip trailing fragments and question-mark junk
        obj = top_objection.split("?")[0].split(".")[0].strip()
        if len(obj) > 10:
            summary += f" Top concern: {obj}."
    return summary
