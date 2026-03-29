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
import logging
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import TypedDict, List, Union
from dataclasses import dataclass

from ...utils.llm_client import LLMClient
from ..archetypes.definitions import Archetype
from .shopify_ingestion import ProductBrief, format_for_debate
from .archetype_generator import DynamicArchetype

logger = logging.getLogger("miroshop.orchestrator")

# Union type — orchestrator works with both static and dynamic archetypes
AnyArchetype = Union[Archetype, DynamicArchetype]


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
    agent_count: int                  # 5 | 25 | 50 based on tier
    archetypes: List[AnyArchetype]    # product-specific archetypes from archetype_generator
    callback_fn: callable             # called after each phase with partial results

    def _assign_archetypes(self) -> list[tuple[int, AnyArchetype, str]]:
        """
        Distribute agent_count across self.archetypes as evenly as possible.
        Returns list of (agent_idx, archetype, sub_persona_string).

        Dynamic archetypes already ARE specific people — sub_personas is empty.
        Static archetypes use the sub_personas list for variation across instances.
        """
        pool = self.archetypes
        agents: list[tuple[int, AnyArchetype, str]] = []
        per_archetype = max(1, self.agent_count // len(pool))
        remainder = self.agent_count - (per_archetype * len(pool))

        for i, archetype in enumerate(pool):
            count = per_archetype + (1 if i < remainder else 0)
            subs = list(archetype.sub_personas) if archetype.sub_personas else [""]
            random.shuffle(subs)
            for j in range(count):
                sub_persona = subs[j % len(subs)]
                agent_idx = len(agents)
                agents.append((agent_idx, archetype, sub_persona))

        return agents

    def _call_agent(
        self,
        prompt: str,
        archetype: Archetype,
        timeout_seconds: int = 150,
    ) -> tuple[str, float]:
        """Call LLM for a single agent. Returns (verdict, confidence, reasoning).

        Uses a dedicated thread + future.result(timeout) so that a slow Ollama
        streaming response cannot hang the orchestrator indefinitely.  The OpenAI
        client timeout only covers idle-read time (between tokens), not total
        generation time — this threading wrapper enforces a hard wall-clock limit.
        """
        from concurrent.futures import ThreadPoolExecutor as _TPE, TimeoutError as _TE

        def _do_call():
            return self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=archetype.temperature,
                max_tokens=300,
            )

        # Do NOT use `with ThreadPoolExecutor()` — the context manager calls
        # shutdown(wait=True) on exit, which blocks until the submitted thread
        # finishes even if future.result(timeout=...) already raised TimeoutError.
        # We call shutdown(wait=False) ourselves to release immediately.
        ex = _TPE(max_workers=1)
        try:
            fut = ex.submit(_do_call)
            try:
                raw = fut.result(timeout=timeout_seconds)
            except _TE:
                ex.shutdown(wait=False)  # release immediately, don't wait for Ollama
                print(
                    f"[{archetype.name}] LLM timed out after {timeout_seconds}s — "
                    f"using fallback REJECT",
                    flush=True,
                )
                return "REJECT", 0.2, f"Agent timed out after {timeout_seconds}s."
            ex.shutdown(wait=False)
            data = json.loads(raw)
            verdict = data.get("verdict", "REJECT").upper()
            reasoning = data.get("reasoning", "No reasoning provided.")
            confidence = float(data.get("confidence", 0.5))
            if verdict not in ("BUY", "REJECT"):
                verdict = "REJECT"
            return verdict, confidence, reasoning
        except Exception as e:
            ex.shutdown(wait=False)
            return "REJECT", 0.3, f"Analysis error: {str(e)[:100]}"

    def _build_persona(self, archetype: Archetype, sub_persona: str, niche_ctx: str) -> str:
        """Merge base persona + sub-persona identity + niche context into one persona string."""
        parts = [archetype.base_persona]
        if sub_persona:
            parts.append(f"\nYour specific identity: {sub_persona}")
        if niche_ctx:
            parts.append(f"\nYour niche expertise: {niche_ctx}")
        return "".join(parts)

    def _run_phase1_agent(
        self,
        agent_idx: int,
        archetype: AnyArchetype,
        sub_persona: str,
        product_brief: str,
    ) -> AgentVote:
        openers = REJECTION_OPENERS if random.random() > 0.5 else BUY_OPENERS
        prompt = VIBE_CHECK_PROMPT.format(
            persona=self._build_persona(archetype, sub_persona, ""),
            niche_context="",
            rejection_threshold=archetype.rejection_threshold,
            product_brief=product_brief,
            openers=", ".join(random.sample(openers, 3)),
        )
        verdict, confidence, reasoning = self._call_agent(prompt, archetype)
        return {
            "agent_id": f"agent_{agent_idx}",
            "archetype_id": archetype.id,
            "archetype_name": archetype.name,
            "archetype_emoji": archetype.emoji,
            "phase": 1,
            "verdict": verdict,
            "reasoning": reasoning,
            "confidence": confidence,
        }

    def _run_phase2_agent(
        self,
        agent_idx: int,
        archetype: AnyArchetype,
        sub_persona: str,
        product_brief: str,
        phase1_votes: list[AgentVote],
        buy_pct: float,
    ) -> AgentVote:
        my_p1 = phase1_votes[agent_idx]
        others = [v for v in phase1_votes if v["agent_id"] != f"agent_{agent_idx}"]
        other_summary = "\n".join(
            f"- {v.get('archetype_name', v['archetype_id'])}: {v['verdict']} — {v['reasoning'][:80]}..."
            for v in others[:6]
        )
        # Inject dissenter when panel is too positive — pick the most sceptical archetype
        dissenter_instr = ""
        is_dissenter = (buy_pct > 0.8 and agent_idx == _pick_dissenter_idx(phase1_votes))
        if is_dissenter:
            dissenter_instr = DISSENTER_INSTRUCTION.format(agreement_pct=int(buy_pct * 100))

        prompt = WATERCOOLER_PROMPT.format(
            archetype_name=archetype.name,
            persona=self._build_persona(archetype, sub_persona, ""),
            niche_context="",
            product_brief=product_brief[:600],
            other_votes_summary=other_summary,
            my_verdict=my_p1["verdict"],
            my_reasoning=my_p1["reasoning"],
            dissenter_instruction=dissenter_instr,
        )
        verdict, confidence, reasoning = self._call_agent(prompt, archetype)
        return {
            "agent_id": f"agent_{agent_idx}",
            "archetype_id": archetype.id,
            "archetype_name": archetype.name,
            "archetype_emoji": archetype.emoji,
            "phase": 2,
            "verdict": verdict,
            "reasoning": reasoning,
            "confidence": confidence,
        }

    def _run_phase3_agent(
        self,
        agent_idx: int,
        archetype: AnyArchetype,
        sub_persona: str,
        brief: ProductBrief,
        debate_summary: str,
    ) -> AgentVote:
        prompt = CONSENSUS_PROMPT.format(
            archetype_name=archetype.name,
            persona=self._build_persona(archetype, sub_persona, ""),
            product_brief=f"{brief['title']} at ${brief['price_min']:.2f}",
            debate_summary=debate_summary,
            rejection_threshold=archetype.rejection_threshold,
        )
        verdict, confidence, reasoning = self._call_agent(prompt, archetype)
        return {
            "agent_id": f"agent_{agent_idx}",
            "archetype_id": archetype.id,
            "archetype_name": archetype.name,
            "archetype_emoji": archetype.emoji,
            "phase": 3,
            "verdict": verdict,
            "reasoning": reasoning,
            "confidence": confidence,
        }

    def run(self, brief: ProductBrief) -> DebateResult:
        """Run the 3-phase debate. Archetypes were injected at construction time."""
        agents = self._assign_archetypes()
        product_brief = format_for_debate(brief)
        # Cap workers at Ollama's parallel limit to avoid request queuing delays
        max_workers = min(len(agents), 4)

        print(
            f"[{brief['title']}] Starting debate: {len(agents)} agents, "
            f"{max_workers} parallel workers, 3 phases",
            flush=True,
        )

        # ── Phase 1: Vibe Check — all agents in parallel ─────────────────────
        print(f"[{brief['title']}] Phase 1 — Vibe Check: {len(agents)} agents voting...", flush=True)
        phase1_votes: list[AgentVote] = [None] * len(agents)  # type: ignore[list-item]
        completed_p1 = 0
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(self._run_phase1_agent, idx, arch, sub, product_brief): idx
                for idx, arch, sub in agents
            }
            for future in as_completed(futures):
                result = future.result()
                phase1_votes[futures[future]] = result
                completed_p1 += 1
                print(
                    f"[{brief['title']}] P1 vote {completed_p1}/{len(agents)}: "
                    f"{result.get('archetype_name', result['archetype_id'])} → {result['verdict']}",
                    flush=True,
                )
                # Fire a partial callback immediately so the UI updates vote-by-vote
                self.callback_fn(phase=1, votes=[result], partial=True)

        buy_count = sum(1 for v in phase1_votes if v["verdict"] == "BUY")
        print(
            f"[{brief['title']}] Phase 1 complete: {buy_count}/{len(agents)} BUY — "
            f"sending callback...",
            flush=True,
        )
        # Final Phase 1 callback (idempotent — skipDuplicates on agent logs)
        self.callback_fn(phase=1, votes=phase1_votes)

        # ── Phase 2: Watercooler — all agents in parallel ────────────────────
        print(f"[{brief['title']}] Phase 2 — Watercooler debate: {len(agents)} agents...", flush=True)
        buy_pct = buy_count / len(phase1_votes)
        phase2_votes: list[AgentVote] = [None] * len(agents)  # type: ignore[list-item]
        completed_p2 = 0
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(self._run_phase2_agent, idx, arch, sub, product_brief, phase1_votes, buy_pct): idx
                for idx, arch, sub in agents
            }
            for future in as_completed(futures):
                result = future.result()
                phase2_votes[futures[future]] = result
                completed_p2 += 1
                print(
                    f"[{brief['title']}] P2 vote {completed_p2}/{len(agents)}: "
                    f"{result.get('archetype_name', result['archetype_id'])} → {result['verdict']}",
                    flush=True,
                )
                self.callback_fn(phase=2, votes=[result], partial=True)

        print(f"[{brief['title']}] Phase 2 complete — sending callback...", flush=True)
        self.callback_fn(phase=2, votes=phase2_votes)

        # ── Phase 3: Consensus — all agents in parallel ───────────────────────
        print(f"[{brief['title']}] Phase 3 — Final consensus: {len(agents)} agents...", flush=True)
        debate_summary = _compress_debate(phase1_votes + phase2_votes)
        phase3_votes: list[AgentVote] = [None] * len(agents)  # type: ignore[list-item]
        completed_p3 = 0
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(self._run_phase3_agent, idx, arch, sub, brief, debate_summary): idx
                for idx, arch, sub in agents
            }
            for future in as_completed(futures):
                result = future.result()
                phase3_votes[futures[future]] = result
                completed_p3 += 1
                print(
                    f"[{brief['title']}] P3 vote {completed_p3}/{len(agents)}: "
                    f"{result.get('archetype_name', result['archetype_id'])} → {result['verdict']}",
                    flush=True,
                )
                self.callback_fn(phase=3, votes=[result], partial=True)

        # Compute Customer Confidence Score (0-100)
        buy_votes = [v for v in phase3_votes if v["verdict"] == "BUY"]
        score = round((len(buy_votes) / len(phase3_votes)) * 100)
        print(f"[{brief['title']}] Phase 3 complete — Score: {score}/100 ({len(buy_votes)}/{len(phase3_votes)} BUY)", flush=True)

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


def _pick_dissenter_idx(phase1_votes: list[AgentVote]) -> int:
    """Pick the agent to be the dissenter in Phase 2 — prefer the lowest-confidence BUY voter."""
    buy_voters = [(v["confidence"], v["agent_id"]) for v in phase1_votes if v["verdict"] == "BUY"]
    if not buy_voters:
        return -1
    # Lowest confidence BUY voter becomes the dissenter
    _, agent_id = min(buy_voters, key=lambda x: x[0])
    idx_str = agent_id.replace("agent_", "")
    try:
        return int(idx_str)
    except ValueError:
        return 0


def _compress_debate(votes: list[AgentVote]) -> str:
    """Compress debate logs to ~500 tokens for context window management."""
    lines = []
    for v in votes:
        name = v.get("archetype_name") or v.get("archetype_id", "agent")
        lines.append(f"[P{v['phase']}] {name}: {v['verdict']} — {v['reasoning'][:100]}")
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
