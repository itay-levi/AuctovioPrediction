"""
DebateOrchestrator — the core of Structured Friction.

Runs the 3-phase debate pipeline:
  Phase 1 — Vibe Check:    Each agent gives an independent BUY/REJECT + 1-sentence reason
  Phase 2 — Watercooler:   Agents debate in archetype clusters. If >80% BUY, inject dissenter.
  Phase 3 — Consensus:     Final vote + score computation + friction classification

Anti-sycophancy rules enforced at every step:
1. Hardcoded rejection thresholds per archetype (in archetype definitions)
2. Mandatory Research Analyst dissent injection when cluster >80% positive
3. Debate not done until at least 1 concrete objection per friction category
4. Report leads with objections first
"""

import json
import random
from typing import TypedDict
from dataclasses import dataclass

from ...utils.llm_client import LLMClient
from ..archetypes.definitions import ARCHETYPES, ARCHETYPE_MAP, Archetype
from .shopify_ingestion import ProductBrief, format_for_debate


class AgentVote(TypedDict):
    agent_id: str
    archetype_id: str
    phase: int
    verdict: str          # "BUY" | "REJECT" | "ABSTAIN"
    reasoning: str
    confidence: float     # 0.0-1.0


class DebateResult(TypedDict):
    score: int            # 0-100 Customer Confidence Score
    image_score: int      # 0-100 (placeholder until Moondream2 integrated)
    votes: list[AgentVote]
    friction: dict        # {"price": {...}, "trust": {...}, "logistics": {...}}
    summary: str
    phase1_votes: list[AgentVote]
    phase2_votes: list[AgentVote]
    phase3_votes: list[AgentVote]


# Vocabulary pools for anti-templating (rotate word choices to avoid identical reports)
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

VIBE_CHECK_PROMPT = """You are a customer reviewing a product listing. You are: {persona}

{niche_context}

REJECTION THRESHOLD (non-negotiable): {rejection_threshold}

Product listing:
{product_brief}

Give your IMMEDIATE gut reaction. You have 3 seconds to decide.
Respond with EXACTLY this JSON:
{{
  "verdict": "BUY" or "REJECT",
  "reasoning": "1-2 sentences. Be specific. Start with one of: {openers}",
  "confidence": 0.1-1.0
}}"""

WATERCOOLER_PROMPT = """You are {archetype_name} in a group discussion about a product listing.

Your persona: {persona}
{niche_context}

The product:
{product_brief}

Other customers said:
{other_votes_summary}

YOUR PREVIOUS POSITION: {my_verdict} — {my_reasoning}

{dissenter_instruction}

Respond with EXACTLY this JSON:
{{
  "verdict": "BUY" or "REJECT",
  "reasoning": "2-3 sentences. Reference what others said. Be specific about what changed or didn't.",
  "confidence": 0.1-1.0
}}"""

DISSENTER_INSTRUCTION = """IMPORTANT: You are the designated dissenter for this round.
The group is {agreement_pct}% positive. Your job is to find the strongest argument AGAINST buying.
Even if you lean towards BUY, you must REJECT and explain the most valid concern you can find.
Do NOT just agree with everyone."""

CONSENSUS_PROMPT = """You are {archetype_name} giving your FINAL verdict after the group debate.

Product: {product_brief}

Full debate summary:
{debate_summary}

REJECTION THRESHOLD (final check): {rejection_threshold}

Respond with EXACTLY this JSON:
{{
  "verdict": "BUY" or "REJECT",
  "reasoning": "Your final 2-3 sentence position. Be honest. Reference specific debate points.",
  "confidence": 0.1-1.0
}}"""

FRICTION_CLASSIFICATION_PROMPT = """Analyze this product debate and classify friction by category.

Product: {product_title} at {price}
Debate summary: {debate_summary}

Classify friction into these three categories. For each, give:
- dropout_pct: 0-100, what % of the panel cited this as a reason to REJECT
- top_objections: list of 3 specific objections raised (exact quotes or close paraphrases)

Respond with EXACTLY this JSON:
{{
  "price": {{
    "dropoutPct": 0-100,
    "topObjections": ["objection 1", "objection 2", "objection 3"]
  }},
  "trust": {{
    "dropoutPct": 0-100,
    "topObjections": ["objection 1", "objection 2", "objection 3"]
  }},
  "logistics": {{
    "dropoutPct": 0-100,
    "topObjections": ["objection 1", "objection 2", "objection 3"]
  }}
}}"""


@dataclass
class DebateOrchestrator:
    llm: LLMClient
    agent_count: int       # 5 | 25 | 50 based on tier
    callback_fn: callable  # called after each phase with partial results

    def _assign_archetypes(self) -> list[tuple[int, Archetype]]:
        """Distribute agent_count across 5 archetypes as evenly as possible."""
        agents = []
        per_archetype = max(1, self.agent_count // len(ARCHETYPES))
        remainder = self.agent_count - (per_archetype * len(ARCHETYPES))

        for i, archetype in enumerate(ARCHETYPES):
            count = per_archetype + (1 if i < remainder else 0)
            for j in range(count):
                agent_idx = len(agents)
                agents.append((agent_idx, archetype))

        return agents

    def _call_agent(
        self,
        prompt: str,
        archetype: Archetype,
    ) -> tuple[str, float]:
        """Call LLM for a single agent. Returns (verdict, confidence, reasoning)."""
        try:
            raw = self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=archetype.temperature,
                max_tokens=300,
            )
            data = json.loads(raw)
            verdict = data.get("verdict", "REJECT").upper()
            reasoning = data.get("reasoning", "No reasoning provided.")
            confidence = float(data.get("confidence", 0.5))
            if verdict not in ("BUY", "REJECT"):
                verdict = "REJECT"
            return verdict, confidence, reasoning
        except Exception as e:
            return "REJECT", 0.3, f"Analysis error: {str(e)[:100]}"

    def run(self, brief: ProductBrief, archetype_contexts: dict[str, str]) -> DebateResult:
        agents = self._assign_archetypes()
        product_brief = format_for_debate(brief)

        # ── Phase 1: Vibe Check ──────────────────────────────────────────────
        phase1_votes: list[AgentVote] = []
        for agent_idx, archetype in agents:
            niche_ctx = archetype_contexts.get(archetype.id, "")
            openers = REJECTION_OPENERS if random.random() > 0.5 else BUY_OPENERS
            prompt = VIBE_CHECK_PROMPT.format(
                persona=archetype.base_persona,
                niche_context=f"Your niche expertise: {niche_ctx}" if niche_ctx else "",
                rejection_threshold=archetype.rejection_threshold,
                product_brief=product_brief,
                openers=", ".join(random.sample(openers, 3)),
            )
            verdict, confidence, reasoning = self._call_agent(prompt, archetype)
            phase1_votes.append({
                "agent_id": f"agent_{agent_idx}",
                "archetype_id": archetype.id,
                "phase": 1,
                "verdict": verdict,
                "reasoning": reasoning,
                "confidence": confidence,
            })

        self.callback_fn(phase=1, votes=phase1_votes)

        # ── Phase 2: Watercooler ─────────────────────────────────────────────
        phase2_votes: list[AgentVote] = []
        buy_pct = sum(1 for v in phase1_votes if v["verdict"] == "BUY") / len(phase1_votes)

        for agent_idx, archetype in agents:
            niche_ctx = archetype_contexts.get(archetype.id, "")
            my_p1 = phase1_votes[agent_idx]

            # Summarise what others said (exclude self)
            others = [v for v in phase1_votes if v["agent_id"] != f"agent_{agent_idx}"]
            other_summary = "\n".join(
                f"- {ARCHETYPE_MAP[v['archetype_id']].name}: {v['verdict']} — {v['reasoning'][:80]}..."
                for v in others[:6]  # cap at 6 to save tokens
            )

            # Inject dissenter if cluster too positive AND this is the Research Analyst
            dissenter_instr = ""
            if buy_pct > 0.8 and archetype.id == "research_analyst":
                dissenter_instr = DISSENTER_INSTRUCTION.format(
                    agreement_pct=int(buy_pct * 100)
                )

            prompt = WATERCOOLER_PROMPT.format(
                archetype_name=archetype.name,
                persona=archetype.base_persona,
                niche_context=f"Your niche expertise: {niche_ctx}" if niche_ctx else "",
                product_brief=product_brief[:600],  # truncate for context budget
                other_votes_summary=other_summary,
                my_verdict=my_p1["verdict"],
                my_reasoning=my_p1["reasoning"],
                dissenter_instruction=dissenter_instr,
            )
            verdict, confidence, reasoning = self._call_agent(prompt, archetype)
            phase2_votes.append({
                "agent_id": f"agent_{agent_idx}",
                "archetype_id": archetype.id,
                "phase": 2,
                "verdict": verdict,
                "reasoning": reasoning,
                "confidence": confidence,
            })

        self.callback_fn(phase=2, votes=phase2_votes)

        # ── Phase 3: Consensus ────────────────────────────────────────────────
        phase3_votes: list[AgentVote] = []

        # Compress debate for context window
        debate_summary = _compress_debate(phase1_votes + phase2_votes)

        for agent_idx, archetype in agents:
            niche_ctx = archetype_contexts.get(archetype.id, "")
            prompt = CONSENSUS_PROMPT.format(
                archetype_name=archetype.name,
                persona=archetype.base_persona + (f"\nNiche expertise: {niche_ctx}" if niche_ctx else ""),
                product_brief=f"{brief['title']} at ${brief['price_min']:.2f}",
                debate_summary=debate_summary,
                rejection_threshold=archetype.rejection_threshold,
            )
            verdict, confidence, reasoning = self._call_agent(prompt, archetype)
            phase3_votes.append({
                "agent_id": f"agent_{agent_idx}",
                "archetype_id": archetype.id,
                "phase": 3,
                "verdict": verdict,
                "reasoning": reasoning,
                "confidence": confidence,
            })

        # Compute Customer Confidence Score (0-100)
        buy_votes = [v for v in phase3_votes if v["verdict"] == "BUY"]
        score = round((len(buy_votes) / len(phase3_votes)) * 100)

        # Classify friction
        friction = _classify_friction(
            self.llm,
            brief,
            phase1_votes + phase2_votes + phase3_votes,
        )

        # Build summary (objections first)
        summary = _build_summary(brief, score, phase3_votes, friction)

        all_votes = phase1_votes + phase2_votes + phase3_votes
        self.callback_fn(phase=3, votes=phase3_votes, score=score, friction=friction, summary=summary)

        return {
            "score": score,
            "image_score": 50,  # placeholder — Moondream2 not yet integrated
            "votes": all_votes,
            "friction": friction,
            "summary": summary,
            "phase1_votes": phase1_votes,
            "phase2_votes": phase2_votes,
            "phase3_votes": phase3_votes,
        }


def _compress_debate(votes: list[AgentVote]) -> str:
    """Compress debate logs to ~500 tokens for context window management."""
    lines = []
    for v in votes:
        archetype_name = ARCHETYPE_MAP.get(v["archetype_id"], {})
        name = archetype_name.name if hasattr(archetype_name, "name") else v["archetype_id"]
        lines.append(f"[P{v['phase']}] {name}: {v['verdict']} — {v['reasoning'][:100]}")
    # Keep last 20 entries if too long
    if len(lines) > 20:
        lines = lines[-20:]
    return "\n".join(lines)


def _classify_friction(
    llm: LLMClient,
    brief: ProductBrief,
    all_votes: list[AgentVote],
) -> dict:
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
        return json.loads(raw)
    except Exception:
        return {
            "price": {"dropoutPct": 0, "topObjections": []},
            "trust": {"dropoutPct": 0, "topObjections": []},
            "logistics": {"dropoutPct": 0, "topObjections": []},
        }


def _build_summary(
    brief: ProductBrief,
    score: int,
    final_votes: list[AgentVote],
    friction: dict,
) -> str:
    rejects = [v for v in final_votes if v["verdict"] == "REJECT"]
    buys = [v for v in final_votes if v["verdict"] == "BUY"]

    top_objection = ""
    for cat in ["price", "trust", "logistics"]:
        objs = friction.get(cat, {}).get("topObjections", [])
        if objs:
            top_objection = objs[0]
            break

    if score >= 70:
        tone = "Your simulated panel responded positively."
    elif score >= 45:
        tone = "Your simulated panel had mixed reactions."
    else:
        tone = "Your simulated panel raised significant concerns."

    summary = f"{tone} {len(buys)} of {len(final_votes)} customers said they would buy."
    if top_objection:
        summary += f" The most common concern: {top_objection}"

    return summary
