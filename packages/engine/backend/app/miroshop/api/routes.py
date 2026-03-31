"""
MiroShop Flask Blueprint — mounts at /miroshop on the MiroFish Flask app.

Endpoints:
  POST /miroshop/simulate       — trigger a new panel debate (async)
  POST /miroshop/classify       — classify store niche from catalog metadata
  GET  /miroshop/health         — engine health check
"""

import threading
import logging
from flask import Blueprint, request, jsonify

from ...config import Config
from ...utils.llm_client import LLMClient
from ..services.niche_classifier import NicheClassifier
from ..services.shopify_ingestion import ingest_product, audit_trust_signals
from ..services.debate_orchestrator import DebateOrchestrator
from ..services.callback_service import post_phase_update
from ..services.archetype_generator import generate_archetypes
from ..services.product_intelligence import generate_product_intelligence, format_product_context
from ..services.listing_gap_analyzer import analyze_listing_gaps, format_gap_context
from ..services.recommendation_engine import generate_recommendations
from ..services.comparison_engine import generate_comparison_insight
from .schemas import SimulateRequest, DeltaRequest, ClassifyRequest, SynthesizeRequest, LabCompareRequest

logger = logging.getLogger("miroshop.routes")
bp = Blueprint("miroshop", __name__, url_prefix="/miroshop")

SHOPIFY_APP_API_KEY = Config.__dict__.get("SHOPIFY_APP_API_KEY", None)

# ── Concurrency cap ────────────────────────────────────────────────────────────
# Allow at most 2 simulations to run simultaneously so the TPM / RPM budgets
# aren't blown by a sudden burst.  A third caller will wait up to 10 minutes
# before being rejected with FAILED (avoids silent queue-overflow).
_simulation_semaphore = threading.Semaphore(2)

# ── Panel consistency cache ─────────────────────────────────────────────────────
# Same product URL → same panel members → consistent scores across re-runs.
# Keyed by productUrl (or product handle as fallback).
# Both caches live for the process lifetime — no TTL needed since panel composition
# should be stable for a given product listing.
_archetype_cache: dict[str, list] = {}
_intelligence_cache: dict[str, dict] = {}   # product_key → {"product_context": str, "no_return_acceptable": bool, "gap_context": str, "gap_items": list}
_niche_profile_cache: dict[str, dict] = {}


def _require_auth(f):
    """Simple bearer token auth decorator."""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        expected = getattr(Config, "ENGINE_API_KEY", None)
        if expected:
            auth = request.headers.get("Authorization", "")
            if auth != f"Bearer {expected}":
                return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


def _make_gemini_client() -> LLMClient:
    """Create an LLMClient pointing directly at Gemini (for high-quality summary calls)."""
    if not Config.FALLBACK_LLM_API_KEY or not Config.FALLBACK_LLM_BASE_URL:
        return LLMClient()  # fall back to default if Gemini not configured
    return LLMClient(
        api_key=Config.FALLBACK_LLM_API_KEY,
        base_url=Config.FALLBACK_LLM_BASE_URL,
        model=Config.FALLBACK_LLM_MODEL_NAME,
    )


def _run_simulation(req: SimulateRequest, archetypes: list | None, delta_context: dict | None = None):
    """
    Runs in a background thread — calls back to Shopify app after each phase.
    `archetypes` is None when called from the /simulate endpoint (generation happens here
    inside the thread so the HTTP response returns immediately).
    `delta_context` is set for What-If runs and contains priority + original sim data.
    """
    import time as _time

    # Queue priority: What-If runs yield to initial scans by waiting briefly at startup.
    # priority=1 means lower priority (What-If); priority=0 means initial scan (high).
    if delta_context and delta_context.get("priority", 0) > 0:
        _time.sleep(15)  # 15s grace window — lets any pending initial scans start first

    # Concurrency cap — block until a slot is free (up to 10 minutes)
    acquired = _simulation_semaphore.acquire(timeout=600)
    if not acquired:
        logger.error(
            f"Simulation {req.simulationId} rejected — semaphore timeout (server at capacity)"
        )
        post_phase_update(
            callback_url=req.callbackUrl,
            api_key=getattr(Config, "SHOPIFY_APP_API_KEY", None),
            simulation_id=req.simulationId,
            phase=0,
            status="FAILED",
        )
        return

    try:
        llm = LLMClient()
        # What-If runs use Gemini for the summarizer/recommendations (higher quality output).
        summary_llm = _make_gemini_client() if delta_context else llm

        # Panel cache key — stable identifier for this product listing
        _panel_key = req.productUrl or req.productJson.get("handle", "")

        # Generate product-specific archetypes inside the thread so the HTTP endpoint
        # returns 202 instantly rather than blocking for 30+ seconds.
        if archetypes is None:
            if _panel_key and _panel_key in _archetype_cache:
                archetypes = _archetype_cache[_panel_key]
                print(
                    f"[{req.productJson.get('title', '?')}] Using cached archetypes "
                    f"({len(archetypes)} members)",
                    flush=True,
                )
            else:
                archetypes = generate_archetypes(llm, req.productJson, count=5)
                if _panel_key:
                    _archetype_cache[_panel_key] = archetypes

        # Product intelligence — run once per product, cached alongside archetypes.
        # Feeds BOTH the panel prompts (product_context) AND the trust audit (no_return_acceptable).
        product_context = ""
        gap_context = ""
        gap_items_for_recs: list = []
        no_return_from_intelligence: bool | None = None
        if _panel_key and _panel_key in _intelligence_cache:
            cached_intel = _intelligence_cache[_panel_key]
            product_context = cached_intel["product_context"]
            no_return_from_intelligence = cached_intel["no_return_acceptable"]
            gap_context = cached_intel.get("gap_context", "")
            gap_items_for_recs = cached_intel.get("gap_items", [])
        else:
            intelligence = generate_product_intelligence(llm, req.productJson)
            product_context = format_product_context(intelligence)
            no_return_from_intelligence = intelligence.no_return_acceptable if intelligence else None

            # Gap analysis — score the listing against the category checklist
            if intelligence and intelligence.checklist:
                from ..services.shopify_ingestion import ingest_product as _ingest_for_gaps
                try:
                    _brief_for_gaps = _ingest_for_gaps(req.productJson, req.shopDomain)
                    _listing_text = _brief_for_gaps.get("description_text", "")
                    # Also include title and key fields for completeness
                    _title = req.productJson.get("title", "")
                    _product_type = req.productJson.get("productType") or req.productJson.get("product_type", "")
                    _listing_full = f"Title: {_title}\nType: {_product_type}\n\n{_listing_text}"
                    gap_analysis = analyze_listing_gaps(llm, intelligence.checklist, _listing_full)
                    gap_context = format_gap_context(gap_analysis)
                    gap_items_for_recs = [
                        {"question": item.question, "status": item.status, "evidence": item.evidence}
                        for item in gap_analysis.items
                    ] if gap_analysis else []
                except Exception as _gap_err:
                    logger.warning(f"Gap analysis failed for {req.simulationId}: {_gap_err}")
                    gap_analysis = None

            if _panel_key:
                _intelligence_cache[_panel_key] = {
                    "product_context": product_context,
                    "no_return_acceptable": no_return_from_intelligence,
                    "gap_context": gap_context,
                    "gap_items": gap_items_for_recs,
                }

        # ── Customer Lab configuration ────────────────────────────────────────
        # Resolved first so lab_audience_context is available for trust_context assembly.
        lab = req.labConfig
        lab_temp_modifier = 0.0
        lab_audience_context = ""
        lab_focus_override: list[str] = []
        lab_brutality_level = 5

        if lab:
            # Skepticism → temperature modifier
            if lab.skepticism <= 3:
                lab_temp_modifier = +0.12    # Fan: warmer, more generous
            elif lab.skepticism >= 8:
                lab_temp_modifier = -0.12   # Auditor: colder, harder to please

            # Audience → context injected into every agent prompt
            _audience_map = {
                "professional": (
                    "AUDIENCE CONTEXT: This panel represents professional buyers (ages 28–50). "
                    "They prioritise ROI, spec completeness, and clear terms. "
                    "Visual appeal matters less than data and credibility."
                ),
                "gen_z": (
                    "AUDIENCE CONTEXT: This panel represents Gen-Z shoppers (ages 18–28). "
                    "They decide in seconds from the hero image and vibe. "
                    "Brand authenticity and social proof matter more than detailed specs. "
                    "If the listing doesn't feel real and interesting immediately, they bounce."
                ),
                "luxury": (
                    "AUDIENCE CONTEXT: This panel represents luxury shoppers. "
                    "Price sensitivity is LOW — they will pay premium. "
                    "What they will NOT tolerate: cheap presentation, amateurish images, "
                    "or absence of brand story. Quality signals and exclusivity language matter."
                ),
            }
            lab_audience_context = _audience_map.get(lab.audience, "")

            # Skepticism tier label injected as panel tone
            if lab.skepticism <= 3:
                lab_audience_context = (lab_audience_context + "\n" if lab_audience_context else "") + (
                    "PANEL TONE: This is an enthusiast panel. They lean positive and give "
                    "benefit of the doubt on minor gaps. Focus on what works well."
                )
            elif lab.skepticism >= 8:
                lab_audience_context = (lab_audience_context + "\n" if lab_audience_context else "") + (
                    "PANEL TONE: This is a highly skeptical panel. They are looking for "
                    "reasons to reject. Every missing detail is a red flag. "
                    "Only a near-perfect listing earns BUY from this panel."
                )

            # Core concern → focus areas override (replaces merchant-selected focus areas)
            _concern_map = {
                "price":    ["price_value"],
                "trust":    ["trust_credibility"],
                "shipping": ["mobile_friction"],
                "quality":  ["technical_specs"],
            }
            if lab.coreConcern and lab.coreConcern in _concern_map:
                lab_focus_override = _concern_map[lab.coreConcern]

            # Brutality level — passed to orchestrator for evidence injection
            lab_brutality_level = max(1, min(10, lab.brutalityLevel))

        # ── Trust audit (rule-based, no LLM call) ────────────────────────────
        trust_audit: dict = {}
        trust_context = ""
        try:
            from ..services.shopify_ingestion import ingest_product as _ingest
            _brief_for_audit = _ingest(req.productJson, req.shopDomain)
            trust_audit = audit_trust_signals(
                req.productJson,
                _brief_for_audit,
                no_return_override=no_return_from_intelligence,
            )
            killers = trust_audit.get("trustKillers", [])

            confirmed_parts = []
            if trust_audit.get("hasReturnPolicy"):
                confirmed_parts.append("return/refund policy")
            if trust_audit.get("hasShippingInfo"):
                confirmed_parts.append("shipping information")
            if trust_audit.get("hasContact"):
                confirmed_parts.append("contact/about-us info")
            if trust_audit.get("hasReviews"):
                confirmed_parts.append(f"customer reviews ({trust_audit.get('hasStrongSocialProof') and '10+' or 'some'})")
            if trust_audit.get("hasTrustBadges"):
                confirmed_parts.append("trust badges/payment icons")

            sections = []

            if not trust_audit.get("hasReviews"):
                sections.append(
                    "EVALUATION CONTEXT: Review data is not available in this product listing — "
                    "this is normal for new products or stores using a separate review app. "
                    "Do NOT penalise for absent review data. Evaluate on description quality, "
                    "pricing fairness, and stated policies. New listings without reviews are "
                    "legitimately purchased every day by early adopters."
                )

            if confirmed_parts:
                sections.append(
                    "CONFIRMED PRESENT IN LISTING (do NOT claim these are missing — "
                    "you may only critique their quality):\n" +
                    "\n".join(f"✓ {p}" for p in confirmed_parts)
                )
            if killers:
                sections.append(
                    "TRUST ISSUES (genuinely absent — factor into your evaluation):\n" +
                    "\n".join(f"- {k['label']}: {k['fix']}" for k in killers)
                )
            trust_context = "\n\n".join(sections)

            if lab_audience_context:
                trust_context = (trust_context + "\n\n" + lab_audience_context).strip()
        except Exception as e:
            logger.warning(f"Trust audit failed for {req.simulationId}: {e}")

        # Accumulate all votes as partial callbacks fire — available by the time
        # the final non-partial phase-3 callback is reached.
        _accumulated_votes: list = []
        _brief_store: dict = {}

        def callback_fn(phase: int, votes: list, score=None, friction=None, summary=None, partial: bool = False):
            # Accumulate votes from partial callbacks so recommendations have full data
            if partial and votes:
                _accumulated_votes.extend(votes)
            _score_breakdown: dict | None = None

            # partial=True means a single vote came in — fire-and-forget, no retry
            status = "RUNNING" if (phase < 3 or partial) else "COMPLETED"
            report_json = None
            recommendations = None
            comparison_insight_str: str | None = None

            # ── Score calibration ─────────────────────────────────────────────
            # Applied only at final phase.
            if phase == 3 and not partial and score is not None:
                killer_signals = {k["signal"] for k in trust_audit.get("trustKillers", [])}
                critical_signals = {"return_policy", "no_shipping_info", "no_contact_info"}
                all_critical_resolved = not critical_signals.intersection(killer_signals)

                # Quality bonus: reward merchant-controllable listing signals on top of vote score.
                # This ensures a well-prepared listing gets credit even with low social proof.
                _raw_score = score  # preserve pre-bonus score for breakdown display
                _brief_for_bonus = _brief_store.get("brief") or {}
                quality_bonus = 0
                if trust_audit.get("hasReturnPolicy"):    quality_bonus += 5
                if trust_audit.get("hasShippingInfo"):    quality_bonus += 5
                if trust_audit.get("hasContact"):         quality_bonus += 5
                if len(_brief_for_bonus.get("description_text", "")) > 300: quality_bonus += 5
                if _brief_for_bonus.get("image_count", 0) > 1:              quality_bonus += 3
                if quality_bonus:
                    new_score = min(95, score + quality_bonus)
                    logger.info(
                        f"[quality_bonus] {req.simulationId}: +{quality_bonus}pts listing "
                        f"quality bonus — {score} → {new_score}"
                    )
                    score = new_score

                # Score floor: all 3 critical trust killers resolved → minimum 60
                _floor_applied = False
                if all_critical_resolved and score < 60:
                    logger.info(
                        f"[score_floor] {req.simulationId}: all 3 critical trust killers "
                        f"resolved — lifting score {score} → 60"
                    )
                    score = 60
                    _floor_applied = True

                # Breakdown for frontend score transparency card
                _score_breakdown = {
                    "panelScore": _raw_score,
                    "qualityBonus": quality_bonus,
                    "floorApplied": _floor_applied,
                    "floorValue": 60 if _floor_applied else None,
                }

            if phase == 3 and not partial and friction is not None:
                report_json = {
                    "friction": friction,
                    "summary": summary,
                    "scoreBreakdown": _score_breakdown,
                    "labConfig": lab.model_dump() if lab else None,
                    "gapItems": gap_items_for_recs if gap_items_for_recs else None,
                }
                # All votes are now accumulated from previous partial callbacks
                all_votes = list(_accumulated_votes)
                # Use Gemini (summary_llm) for recommendations — higher quality output
                try:
                    recommendations = generate_recommendations(
                        llm=summary_llm,
                        brief=_brief_store.get("brief"),
                        all_votes=all_votes,
                        friction=friction,
                        trust_audit=trust_audit,
                        focus_areas=req.focusAreas,
                        score=score or 0,
                        gap_analysis=gap_items_for_recs or None,
                    )
                except Exception as e:
                    logger.warning(f"Recommendation generation failed: {e}")
                    recommendations = []

                # For What-If runs: generate a comparison insight (why did the score change?)
                if delta_context and delta_context.get("originalScore") is not None:
                    brief = _brief_store.get("brief")
                    try:
                        comparison_insight_str = generate_comparison_insight(
                            llm=summary_llm,
                            product_title=brief["title"] if brief else "Product",
                            delta_params={
                                **req.productJson.get("__delta_params__", {}),
                                **(delta_context.get("deltaParams") or {}),
                            },
                            original_score=delta_context["originalScore"],
                            delta_score=score or 0,
                            original_friction=delta_context.get("originalFriction") or {},
                            delta_friction=friction,
                            trust_killers=(trust_audit or {}).get("trustKillers", []),
                        )
                    except Exception as e:
                        logger.warning(f"Comparison insight failed: {e}")

            agent_logs = [
                {
                    "agentId": v["agent_id"],
                    "archetype": v["archetype_id"],
                    "archetypeName": v.get("archetype_name", v["archetype_id"]),
                    "archetypeEmoji": v.get("archetype_emoji", "🧑"),
                    "personaName": v.get("persona_name", ""),
                    "personaAge": v.get("persona_age", 0),
                    "personaOccupation": v.get("persona_occupation", ""),
                    "personaMotivation": v.get("persona_motivation", ""),
                    "nicheConcern": v.get("niche_concern", ""),
                    "phase": v["phase"],
                    "verdict": v["verdict"],
                    "reasoning": v["reasoning"],
                }
                for v in votes
            ]

            mt_so_far = req.agentCount * 2 * phase

            post_phase_update(
                callback_url=req.callbackUrl,
                api_key=getattr(Config, "SHOPIFY_APP_API_KEY", None),
                simulation_id=req.simulationId,
                phase=phase,
                status=status,
                score=score,
                report_json=report_json,
                actual_mt_cost=mt_so_far if (phase == 3 and not partial) else None,
                agent_logs=agent_logs,
                recommendations=recommendations,
                trust_audit=trust_audit if (phase == 3 and not partial) else None,
                comparison_insight=comparison_insight_str if (phase == 3 and not partial) else None,
                partial=partial,
            )

        try:
            brief = ingest_product(req.productJson, req.shopDomain)
            _brief_store["brief"] = brief

            # Dynamic Niche Profiler — single LLM call to generate product-specific
            # persona profiles (name, age, occupation, motivation, concern).
            # Cached per product URL so the same product always gets the same panel members.
            from ..archetypes.niche_contexts import generate_niche_profiles
            if _panel_key and _panel_key in _niche_profile_cache:
                niche_map = _niche_profile_cache[_panel_key]
                print(
                    f"[{req.productJson.get('title', '?')}] Using cached niche profiles",
                    flush=True,
                )
            else:
                niche_map = generate_niche_profiles(llm, req.productJson)
                if _panel_key:
                    _niche_profile_cache[_panel_key] = niche_map
            print(
                f"[{req.productJson.get('title', '?')}] Persona profiles generated: "
                + ", ".join(
                    f"{k[:8]}={p.get('name','?')},{p.get('age','?')},{p.get('motivation','?')}"
                    for k, p in niche_map.items()
                ),
                flush=True,
            )

            # Lab: core concern overrides merchant focus areas; lab temp + brutality applied
            effective_focus = lab_focus_override if lab_focus_override else req.focusAreas
            orchestrator = DebateOrchestrator(
                llm=llm,
                agent_count=req.agentCount,
                archetypes=archetypes,
                callback_fn=callback_fn,
                niche_map=niche_map,
                focus_areas=effective_focus,
                trust_context=trust_context,
                product_context=product_context,
                gap_context=gap_context,
                temp_modifier=lab_temp_modifier,
                brutality_level=lab_brutality_level,
            )
            orchestrator.run(brief)
        except Exception as e:
            from openai import RateLimitError
            if isinstance(e, RateLimitError):
                logger.error(f"Simulation {req.simulationId} aborted — LLM quota exceeded (429). Rotate or upgrade API key.")
            else:
                logger.exception(f"Simulation {req.simulationId} failed: {e}")
            post_phase_update(
                callback_url=req.callbackUrl,
                api_key=getattr(Config, "SHOPIFY_APP_API_KEY", None),
                simulation_id=req.simulationId,
                phase=0,
                status="FAILED",
            )
    finally:
        _simulation_semaphore.release()


@bp.post("/simulate")
@_require_auth
def simulate():
    try:
        req = SimulateRequest(**request.get_json(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    req.productJson.pop("__archetype_contexts__", None)  # remove legacy field if present

    # Archetype generation happens inside the thread (see _run_simulation).
    # Returning 202 immediately so the Shopify app isn't kept waiting.
    estimated_mt = req.agentCount * 2 * 3 + 1

    thread = threading.Thread(
        target=_run_simulation,
        args=(req, None),   # None → archetypes generated inside thread
        daemon=True,
    )
    thread.start()

    return jsonify({"queued": True, "estimatedMtCost": estimated_mt}), 202


def _get_base_price(product_json: dict) -> float:
    """Extract first variant price from product JSON."""
    variants = product_json.get("variants", [])
    if variants and isinstance(variants, list):
        try:
            return float(variants[0].get("price", 0))
        except (TypeError, ValueError):
            pass
    return 0.0


@bp.post("/simulate/delta")
@_require_auth
def simulate_delta():
    try:
        req = DeltaRequest(**request.get_json(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    # Apply delta overrides to productJson before ingestion
    product_json = dict(req.productJson)
    delta = req.deltaParams

    if delta.get("price") is not None:
        # Override variant prices with the what-if price
        variants = product_json.get("variants", [])
        if isinstance(variants, list):
            product_json["variants"] = [
                {**v, "price": str(delta["price"])} for v in variants
            ]

    # Inject shipping days as metadata for the debate
    if delta.get("shippingDays") is not None:
        product_json["__shipping_days_override__"] = delta["shippingDays"]

    # Create a modified SimulateRequest-like object
    sim_req = SimulateRequest(
        simulationId=req.simulationId,
        shopDomain=req.shopDomain,
        shopType=req.shopType,
        productUrl=product_json.get("onlineStoreUrl") or "",
        productJson=product_json,
        agentCount=req.agentCount,
        callbackUrl=req.callbackUrl,
        focusAreas=req.focusAreas,
    )

    # Bundle original sim data so the comparison insight can be generated at completion
    delta_context = {
        "priority": req.priority,
        "deltaParams": {**req.deltaParams, "originalPrice": _get_base_price(req.productJson)},
        "originalScore": req.originalScore,
        "originalFriction": req.originalFriction,
        "originalTrustAudit": req.originalTrustAudit,
    }

    estimated_mt = req.agentCount * 2 * 3 + 1

    thread = threading.Thread(
        target=_run_simulation,
        args=(sim_req, None, delta_context),
        daemon=True,
    )
    thread.start()

    return jsonify({"queued": True, "estimatedMtCost": estimated_mt}), 202


@bp.post("/classify")
@_require_auth
def classify():
    try:
        req = ClassifyRequest(**request.get_json(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    llm = LLMClient()
    classifier = NicheClassifier(llm)
    # Build a simple catalog metadata dict from the product titles
    catalog_metadata = {"product_titles": req.sampleProductTitles}
    classification = classifier.classify(catalog_metadata)

    return jsonify({"niche": classification.get("niche", "general_retail")})


@bp.post("/synthesize")
@_require_auth
def synthesize():
    try:
        req = SynthesizeRequest(**request.get_json(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    llm = LLMClient()

    # Build the debate transcript
    transcript_lines = []
    for log in req.agent_logs:
        verdict_emoji = "✅" if log.vote == "BUY" else "❌" if log.vote == "REJECT" else "⬜"
        transcript_lines.append(
            f"[Phase {log.phase}] {log.archetype.replace('_', ' ').title()} — "
            f"{verdict_emoji} {log.vote}: {log.reasoning}"
        )
    transcript = "\n".join(transcript_lines)

    buy_count = sum(1 for l in req.agent_logs if l.vote == "BUY")
    total = len(req.agent_logs)

    prompt = f"""You are a professional focus-group moderator writing a client-ready intelligence report.
You have just moderated a panel of {total} AI agents representing {req.niche} customers who evaluated this product listing: "{req.product_title}".

Panel outcome: {buy_count} out of {total} panelists said they would buy.

Here is the full panel transcript:

{transcript}

Write a 400-600 word moderator's report. Follow these rules exactly:
1. Write in first person as the moderator ("The panel raised...", "Our agents flagged...", "The majority noted...")
2. Lead with objections first — what stopped people from buying
3. Use ONLY decision language: "panel responded", "agents flagged", "the majority noted", "our simulation surfaced"
4. NEVER use: "will convert", "predict", "forecast", "will sell", "guarantee"
5. Reference specific data points from the transcript (price figures, missing elements, exact objections)
6. End with a clear "What would make them buy" paragraph
7. Write as if presenting to the merchant, not describing an AI system

Respond with valid JSON only, no markdown:
{{"synthesis": "your 400-600 word report here", "top_themes": ["theme1", "theme2", "theme3"], "what_would_make_them_buy": "one paragraph", "panel_profile": "one sentence describing the simulated panel"}}"""

    try:
        result = llm.chat_json([{"role": "user", "content": prompt}])
        synthesis_text = result.get("synthesis", "")
        if not synthesis_text:
            raise ValueError("Empty synthesis returned")
        return jsonify({
            "synthesis": synthesis_text,
            "top_themes": result.get("top_themes", []),
            "what_would_make_them_buy": result.get("what_would_make_them_buy", ""),
            "panel_profile": result.get("panel_profile", ""),
        })
    except Exception as e:
        logger.exception(f"Synthesis failed for {req.simulation_id}: {e}")
        return jsonify({"error": f"Synthesis failed: {str(e)}"}), 500


_AUDIENCE_LABELS = {
    "general": "General Public",
    "professional": "Professional Buyers",
    "gen_z": "Gen-Z Shoppers",
    "luxury": "Luxury Shoppers",
}

_PRESET_LABELS = {
    "soft_launch": "Soft Launch",
    "skeptic_audit": "Skeptic Audit",
    "holiday_rush": "Holiday Rush",
}


_FIX_PROMPTS: dict[str, str] = {
    "return_policy": (
        "Write a clear, professional 30-day return policy for a Shopify store selling '{product_type}'. "
        "Include: eligibility window (30 days), condition requirements (unused, original packaging), "
        "refund method (original payment method within 5-7 business days), how to initiate (email or form), "
        "and exceptions (digital products, final sale items). "
        "Write in plain English, 150-200 words. No legalese. Friendly tone."
    ),
    "no_shipping_info": (
        "Write a concise shipping policy for a Shopify store selling '{product_type}'. "
        "Include: standard processing time (1-2 business days), domestic shipping options with estimated "
        "transit times (3-5 days standard, 1-2 days express), free shipping threshold ($50+), "
        "international shipping note (7-14 business days, duties may apply), and order tracking info. "
        "Write in plain English, 120-150 words. Merchant-friendly, no jargon."
    ),
    "no_contact_info": (
        "Write a brief, friendly About Us + Contact section for a Shopify store selling '{product_type}'. "
        "Include: a 2-sentence brand story (passionate team, quality focus), a contact email placeholder, "
        "response time commitment (within 24 hours on business days), and a closing trust statement. "
        "Write in plain English, 80-100 words. Warm, real-sounding tone — not generic."
    ),
}

_FIX_HEADINGS: dict[str, str] = {
    "return_policy": "Returns & Refunds Policy",
    "no_shipping_info": "Shipping Policy",
    "no_contact_info": "About Us & Contact",
}


@bp.post("/generate-fix")
@_require_auth
def generate_fix():
    """
    Generate a draft policy/page text for a specific trust killer signal.
    Used by the Fix-it flow in the merchant dashboard.
    """
    body = request.get_json(force=True) or {}
    signal = body.get("signal", "")
    product_type = body.get("productType", "general retail products")

    if signal not in _FIX_PROMPTS:
        return jsonify({"error": f"No fix template for signal '{signal}'"}), 400

    prompt = _FIX_PROMPTS[signal].format(product_type=product_type)

    try:
        llm = _make_gemini_client()
        text = llm.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=400,
        )
        return jsonify({
            "heading": _FIX_HEADINGS[signal],
            "text": text.strip(),
            "shopifySettingsPath": {
                "return_policy": "/admin/settings/policies",
                "no_shipping_info": "/admin/settings/shipping",
                "no_contact_info": "/admin/pages",
            }.get(signal, "/admin/settings"),
        })
    except Exception as e:
        logger.exception(f"generate-fix failed for signal={signal}: {e}")
        return jsonify({"error": f"Generation failed: {str(e)}"}), 500


@bp.post("/lab/compare")
@_require_auth
def lab_compare():
    """
    Generate a comparison summary (Score Delta, Why Gap, divergence topics) from two
    completed simulation reports — baseline (general public) vs. target (custom Lab).
    Called by the Shopify app after both simulations reach COMPLETED status.
    """
    try:
        req = LabCompareRequest(**request.get_json(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    score_delta = req.targetScore - req.baselineScore
    audience_label = _AUDIENCE_LABELS.get(req.labConfig.audience, req.labConfig.audience)
    preset_label = _PRESET_LABELS.get(req.labConfig.preset, "") if req.labConfig.preset else ""
    scenario_label = preset_label or audience_label

    # Build friction summaries for the prompt
    def _friction_summary(report: dict) -> str:
        friction = report.get("friction", {})
        parts = []
        for category in ("price", "trust", "logistics"):
            f = friction.get(category, {})
            pct = f.get("dropoutPct", 0)
            objections = f.get("topObjections", [])
            if pct or objections:
                top = objections[0] if objections else "no specific objection"
                parts.append(f"{category.title()}: {pct}% dropout — '{top}'")
        return "; ".join(parts) or "No friction data"

    baseline_friction = _friction_summary(req.baselineReport)
    target_friction = _friction_summary(req.targetReport)

    sign = "+" if score_delta >= 0 else ""
    prompt = f"""You are a conversion analyst comparing two audience simulations of the same product listing.

Product: "{req.productTitle}"
Baseline audience: General Public — Score: {req.baselineScore}/100
Target audience: {scenario_label} — Score: {req.targetScore}/100
Score delta: {sign}{score_delta} points

Baseline friction: {baseline_friction}
Target friction: {target_friction}

Lab settings: Audience={audience_label}, Skepticism={req.labConfig.skepticism}/10, Concern="{req.labConfig.coreConcern or "balanced"}", Brutality={req.labConfig.brutalityLevel}/10

Write a comparison analysis. Rules:
1. The "why_gap" MUST be one sentence (max 20 words) explaining WHY the scores differ — reference a specific product attribute.
   Good example: "Your visuals carry you with Gen-Z, but your lack of specs kills you with Experts."
   Bad example: "The scores differ because the audiences have different expectations."
2. "divergence_topics" must be 3 friction categories where the two audiences disagreed most (e.g. "Price sensitivity", "Social proof requirements", "Shipping expectations")
3. "target_persona_card" must be 2-3 sentences describing the target audience as real people — their age range, shopping habits, what makes them buy or reject.
4. Use ONLY decision language. Never use "will convert", "predict", "guarantee".

Respond with valid JSON only:
{{"why_gap":"one sentence max 20 words","divergence_topics":["topic1","topic2","topic3"],"target_persona_card":"2-3 sentences","baseline_label":"General Public","target_label":"{scenario_label}"}}"""

    try:
        llm = _make_gemini_client()
        result = llm.chat_json([{"role": "user", "content": prompt}])
        return jsonify({
            "scoreDelta": score_delta,
            "whyGap": result.get("why_gap", ""),
            "divergenceTopics": result.get("divergence_topics", []),
            "targetPersonaCard": result.get("target_persona_card", ""),
            "baselineLabel": result.get("baseline_label", "General Public"),
            "targetLabel": result.get("target_label", scenario_label),
        })
    except Exception as e:
        logger.exception(f"Lab compare failed: {e}")
        return jsonify({"error": f"Comparison generation failed: {str(e)}"}), 500


@bp.get("/health")
def health():
    try:
        llm = LLMClient()
        model = llm.model
        llm_ok = True
    except Exception:
        llm_ok = False
        model = None

    return jsonify({
        "status": "ok" if llm_ok else "degraded",
        "llm_available": llm_ok,
        "model": model,
    })
