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
    verdict: str           # "BUY" | "REJECT"
    reasoning: str
    confidence: float
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

PHYSICAL_REALITY_RULES = "Rules: ONE purchase, no multi-unit, no off-site checks. Firm BUY or REJECT."

TONE_RULE = "Tone: Write like a real person. Raw, direct gut reactions. No corporate filler (no 'furthermore', 'additionally', 'in conclusion'). Say 'Honestly, I'd skip this because...' not 'The product presents several considerations.'"

SKEPTIC_ANCHOR = "SKEPTIC: Only flip REJECT→BUY with hard data from the listing. Peer enthusiasm ≠ evidence."

# Anti-sycophancy rule — prevents empty praise but does NOT bias toward REJECT.
# Agents must give a concrete, persona-specific reason for whichever way they vote.
ATTACK_FIRST_RULE = (
    "HONESTY RULE: Do not give vague praise or empty reassurance. "
    "Whatever you decide — BUY or REJECT — your FIRST sentence must give the single most important "
    "concrete reason for that decision, specific to this listing and your persona. "
    "Generic statements like 'looks good' or 'seems fine' are not allowed."
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


REASONABLE_BUYER_RULES = """Universal Buyer Rules (apply to ALL products — these override your defaults):
1. YOU ARE A HUMAN SHOPPER. Do not demand information that a normal buyer would never look for.
2. IMAGE RULE: You CANNOT see the images — you only know the image COUNT. Never describe or judge image quality.
   Only flag if there are ZERO images.
3. SEARCH BEFORE YOU COMPLAIN: Before claiming something is missing, re-read the listing carefully.
   If you find a return window, delivery estimate, or contact detail — quote it; do not say it's absent.
4. CREDIT WHAT'S THERE: A well-prepared listing with minor gaps should lean BUY unless the gap is
   genuinely deal-breaking for your specific persona.
{product_context}"""

VIBE_CHECK_PROMPT = """{focus_bias}{dna_context}{trust_context}{physical_reality}
{attack_first_rule}
{tone_rule}
{buyer_rules}

{product_brief}

You are: {persona}
Threshold: {rejection_threshold}

Gut reaction — 3 seconds. Vote honestly as your persona. Consider both what would make you buy AND what would stop you.
Name 1 specific thing from the listing that most drives your decision, either way.

OUTPUT RULE: Your entire response must be the JSON object below — no intro, no explanation, no markdown.
{{"reasoning":"1-2 sentences referencing the listing","final_vote":"BUY or REJECT","confidence":0.1-1.0}}"""

WATERCOOLER_PROMPT = """{focus_bias}{dna_context}Panel discussion. Product: {product_brief}

Round 1 verdicts:
{other_votes_summary}
{phase2_chain}
Your Round 1: {my_verdict} — "{my_reasoning}"
{skeptic_anchor}{dissenter_instruction}

CHAIN RULE: You are responding to the debate above. Directly address the LAST person who spoke — agree, challenge, or build on their point in 1 sentence. Then pivot to YOUR unique concern.
UNIQUE ANGLE REQUIRED: Do NOT repeat a concern already raised. Bring your persona's specific perspective.

VOTE-CHANGE: If you flip your vote either direction, cite the specific point from the debate or listing that changed your mind. Peer enthusiasm or peer pressure alone is not enough — you need a concrete reason grounded in the listing.
{attack_first_rule}
{physical_reality}
{tone_rule}
{buyer_rules}

You are: {persona}
Threshold: {rejection_threshold}

If leaning BUY, name at least 2 specific strengths from the listing before any caveats.

OUTPUT RULE: Your entire response must be the JSON object below — no intro, no explanation, no markdown.
{{"reasoning":"2-3 sentences","peer_rebuttal":"1 sentence directly responding to the last speaker","vote_change_trigger":"exact quote or empty","final_vote":"BUY or REJECT","confidence":0.1-1.0}}"""

DISSENTER_INSTRUCTION = """
DISSENTER: Panel is {agreement_pct}% positive. You MUST vote REJECT with the strongest counter-argument."""

CONSENSUS_PROMPT = """FINAL verdict. Product: {product_brief}

Full debate:
{debate_summary}

VOTE-CHANGE: If you flip your vote, cite the specific point from the debate or listing that changed your mind.
{attack_first_rule}
{physical_reality}
{tone_rule}
{buyer_rules}

You are: {persona}
Threshold: {rejection_threshold}

If leaning BUY, explicitly name 2 strengths from the listing in your reasoning.

OUTPUT RULE: Your entire response must be the JSON object below — no intro, no explanation, no markdown.
{{"reasoning":"2-3 sentences referencing debate points","peer_rebuttal":"1 sentence on strongest counter-argument","vote_change_trigger":"exact quote or empty","final_vote":"BUY or REJECT","confidence":0.1-1.0}}"""

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

    def _try_repair_agent_json(self, raw: str) -> Optional[dict]:
        """One repair pass via fast LLM when the deep model returns invalid JSON."""
        if not self.fast_llm or not (raw and raw.strip()):
            return None
        try:
            snippet = raw.strip()[:4500]
            fix_prompt = (
                "The text below should contain one JSON object with keys: "
                "final_vote (string BUY or REJECT), reasoning (string), confidence (number 0-1), "
                "peer_rebuttal (string, may be empty), vote_change_trigger (string, may be empty). "
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
            vote = str(data.get("final_vote", data.get("verdict", "REJECT"))).upper()
            if vote not in ("BUY", "REJECT"):
                return None
            reasoning = str(data.get("reasoning", "")).strip()
            if len(reasoning) < 3:
                return None
            return {
                "final_vote": vote,
                "reasoning": reasoning,
                "confidence": float(data.get("confidence", 0.5)),
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
                max_tokens=800,
            )

        def _finalize_payload(data: dict) -> dict:
            vote = str(data.get("final_vote", data.get("verdict", "REJECT"))).upper()
            if vote not in ("BUY", "REJECT"):
                vote = "REJECT"
            reasoning = str(data.get("reasoning", "No reasoning provided."))

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
            if vote == "REJECT" and buy_signals > reject_signals and buy_signals >= 2:
                print(
                    f"[{archetype.name}] Coherence fix: reasoning says BUY but vote=REJECT — flipping to BUY",
                    flush=True,
                )
                vote = "BUY"
            elif vote == "BUY" and reject_signals > buy_signals and reject_signals >= 2:
                print(
                    f"[{archetype.name}] Coherence fix: reasoning says REJECT but vote=BUY — flipping to REJECT",
                    flush=True,
                )
                vote = "REJECT"

            return {
                "final_vote": vote,
                "reasoning": reasoning,
                "confidence": float(data.get("confidence", 0.5)),
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
            # Pass 1 — LLM repair via fast model
            repaired = self._try_repair_agent_json(raw)
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
            base = base + "\n\n" + self.gap_context
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
            parts.append(f"\nNiche: {niche}")
        priority = getattr(archetype, "friction_priority", "")
        if priority:
            parts.append(f"\n{priority}")
        return "".join(parts)

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
            focus_bias=self._build_focus_bias(),
            dna_context=dna_ctx_block,
            trust_context=trust_ctx_block,
            physical_reality=PHYSICAL_REALITY_RULES,
            attack_first_rule=ATTACK_FIRST_RULE,
            tone_rule=TONE_RULE,
            buyer_rules=self._build_buyer_rules(),
            persona=self._build_persona(archetype, sub_persona),
            rejection_threshold=archetype.rejection_threshold,
            product_brief=product_brief,
        )
        data = self._call_agent(prompt, archetype)
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
        other_summary = "\n".join(
            f"- {v.get('archetype_name', v['archetype_id'])}: {v['verdict']} — {v['reasoning'][:80]}"
            for v in others[:6]
        )

        # Build the growing chain of Phase 2 responses so far (the "room" effect)
        chain_block = ""
        if phase2_chain:
            chain_lines = ["\nDebate so far (respond to the last speaker):"]
            for v in phase2_chain:
                name = v.get("archetype_name", v["archetype_id"])
                chain_lines.append(
                    f"  {name}: {v['verdict']} — {v['reasoning'][:120]}"
                )
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

        prompt = WATERCOOLER_PROMPT.format(
            focus_bias=self._build_focus_bias(),
            dna_context=dna_ctx_block,
            physical_reality=PHYSICAL_REALITY_RULES,
            attack_first_rule=ATTACK_FIRST_RULE,
            tone_rule=TONE_RULE,
            buyer_rules=self._build_buyer_rules(),
            persona=self._build_persona(archetype, sub_persona),
            rejection_threshold=archetype.rejection_threshold,
            product_brief=product_brief,
            other_votes_summary=other_summary,
            phase2_chain=chain_block,
            my_verdict=my_p1["verdict"],
            my_reasoning=my_p1["reasoning"],
            skeptic_anchor=skeptic_anchor,
            dissenter_instruction=dissenter_instr,
        )
        data = self._call_agent(prompt, archetype)

        # ── Enforce New Info Rule ──────────────────────────────────────────────
        # A REJECT→BUY flip is only valid if a product-text trigger is cited.
        if my_p1["verdict"] == "REJECT" and data["final_vote"] == "BUY":
            trigger = data.get("vote_change_trigger", "").strip()
            if len(trigger) < 10:
                logger.info(
                    f"[{archetype.name}] REJECT→BUY flip blocked — no evidence cited"
                )
                data["final_vote"] = "REJECT"
                data["reasoning"] += " [Position held: insufficient product evidence cited to justify reversal.]"
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
            physical_reality=PHYSICAL_REALITY_RULES,
            attack_first_rule=ATTACK_FIRST_RULE,
            tone_rule=TONE_RULE,
            buyer_rules=self._build_buyer_rules(),
            persona=self._build_persona(archetype, sub_persona),
            rejection_threshold=archetype.rejection_threshold,
            product_brief=compact_brief,
            debate_summary=debate_summary,
        )
        data = self._call_agent(prompt, archetype)

        # Enforce New Info Rule in Phase 3 too
        my_p1 = phase1_votes[agent_idx]
        if my_p1["verdict"] == "REJECT" and data["final_vote"] == "BUY":
            trigger = data.get("vote_change_trigger", "").strip()
            if len(trigger) < 10:
                logger.info(
                    f"[{archetype.name}] Phase 3 REJECT→BUY flip blocked — no evidence cited"
                )
                data["final_vote"] = "REJECT"
                data["reasoning"] += " [Final position held: no new product evidence.]"
                data["vote_change_trigger"] = ""

        return _make_vote(agent_idx, archetype, 3, data, self._get_persona_identity(archetype))

    # ── Main run loop ──────────────────────────────────────────────────────────

    def run(self, brief: ProductBrief) -> DebateResult:
        """Run the 3-phase debate. Archetypes were injected at construction time."""
        agents = self._assign_archetypes()
        product_brief = format_for_debate(brief, compact=False)        # P1: full listing
        compact_brief = format_for_debate(brief, compact=True)         # P2/P3: title+price
        # Serial execution (max_workers=1) ensures the rate limiter actually works.
        # Parallel workers race past the threading lock and cause 429 bursts.
        max_workers = 1

        print(
            f"[{brief['title']}] Debate start: {len(agents)} agents, serial, 3 phases",
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
                    f"→ {result['verdict']} ({result['confidence']:.1f})",
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
                idx, arch, sub, compact_brief, phase1_votes, buy_pct, phase2_chain
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

        buy_votes = [v for v in phase3_votes if v["verdict"] == "BUY"]
        score = round((len(buy_votes) / len(phase3_votes)) * 100)
        print(
            f"[{brief['title']}] Phase 3 done — Score: {score}/100 "
            f"({len(buy_votes)}/{len(phase3_votes)} BUY)",
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

    logger.info(f"[salvage_freeform] recovered vote={vote} from freeform text ({len(text)} chars)")
    return {
        "final_vote": vote,
        "reasoning": reasoning,
        "confidence": 0.5,
        "peer_rebuttal": "",
        "vote_change_trigger": "",
    }


def _fallback_reject(reason: str) -> dict:
    return {
        "final_vote": "REJECT",
        "reasoning": reason,
        "confidence": 0.2,
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
        "peer_rebuttal": rebuttal,
        "vote_change_trigger": data.get("vote_change_trigger", ""),
    }


def _pick_dissenter_idx(phase1_votes: list[AgentVote]) -> int:
    """Pick the lowest-confidence BUY voter as dissenter."""
    buy_voters = [(v["confidence"], v["agent_id"]) for v in phase1_votes if v["verdict"] == "BUY"]
    if not buy_voters:
        return -1
    _, agent_id = min(buy_voters, key=lambda x: x[0])
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
            max_tokens=400,
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


# Keywords that signal each friction category in agent reasoning
_PRICE_KEYWORDS = {"price", "cost", "expensive", "cheap", "value", "budget", "afford", "$", "shipping cost", "overpriced"}
_TRUST_KEYWORDS = {"review", "trust", "brand", "reputation", "return policy", "returns", "refund", "contact", "about us", "social proof", "credibility"}
_LOGISTICS_KEYWORDS = {"shipping", "delivery", "packaging", "arrive", "tracking", "gift wrap", "days"}


def _rule_based_friction(all_votes: list[AgentVote]) -> dict:
    """Compute friction from vote reasoning when LLM classifier fails."""
    rejects = [v for v in all_votes if v["verdict"] == "REJECT"]
    total = max(len(all_votes), 1)

    def _scan(keywords: set[str], votes: list[AgentVote]) -> tuple[int, list[str]]:
        hits: list[str] = []
        for v in votes:
            text = v["reasoning"].lower()
            if any(k in text for k in keywords):
                snippet = v["reasoning"][:120].strip()
                if snippet not in hits:
                    hits.append(snippet)
        pct = round((len(hits) / total) * 100) if hits else 0
        return pct, hits[:3]

    price_pct, price_objs = _scan(_PRICE_KEYWORDS, rejects)
    trust_pct, trust_objs = _scan(_TRUST_KEYWORDS, rejects)
    logistics_pct, logistics_objs = _scan(_LOGISTICS_KEYWORDS, rejects)

    # If nothing matched but there are rejections, assign to trust as the default
    if not price_objs and not trust_objs and not logistics_objs and rejects:
        trust_pct = round((len(rejects) / total) * 100)
        trust_objs = [r["reasoning"][:120].strip() for r in rejects[:3]]

    return {
        "price": {"dropoutPct": price_pct, "topObjections": price_objs},
        "trust": {"dropoutPct": trust_pct, "topObjections": trust_objs},
        "logistics": {"dropoutPct": logistics_pct, "topObjections": logistics_objs},
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
        summary += f" Top concern: {top_objection}"
    return summary
