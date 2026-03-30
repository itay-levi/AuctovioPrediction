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
from ..services.recommendation_engine import generate_recommendations
from ..services.comparison_engine import generate_comparison_insight
from .schemas import SimulateRequest, DeltaRequest, ClassifyRequest, SynthesizeRequest

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

        # Run trust audit (rule-based, no LLM call) and build agent trust context
        trust_audit: dict = {}
        trust_context = ""
        try:
            from ..services.shopify_ingestion import ingest_product as _ingest
            _brief_for_audit = _ingest(req.productJson, req.shopDomain)
            trust_audit = audit_trust_signals(req.productJson, _brief_for_audit)
            killers = trust_audit.get("trustKillers", [])

            # Build two-section trust context:
            #   CONFIRMED PRESENT — prevents agents hallucinating absence of things that exist
            #   ISSUES FOUND      — the usual killer list (only if killers remain)
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

            # New-listing context: when reviews are unknown/absent, tell agents to
            # evaluate on listing quality only — not social proof maturity.
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
                if all_critical_resolved and score < 60:
                    logger.info(
                        f"[score_floor] {req.simulationId}: all 3 critical trust killers "
                        f"resolved — lifting score {score} → 60"
                    )
                    score = 60

            if phase == 3 and not partial and friction is not None:
                report_json = {"friction": friction, "summary": summary}
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

            orchestrator = DebateOrchestrator(
                llm=llm,
                agent_count=req.agentCount,
                archetypes=archetypes,
                callback_fn=callback_fn,
                niche_map=niche_map,
                focus_areas=req.focusAreas,
                trust_context=trust_context,
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
