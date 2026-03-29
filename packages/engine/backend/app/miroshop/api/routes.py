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
from ..archetypes.definitions import ARCHETYPES
from ..services.niche_classifier import NicheClassifier
from ..services.shopify_ingestion import ingest_product
from ..services.debate_orchestrator import DebateOrchestrator
from ..services.callback_service import post_phase_update
from .schemas import SimulateRequest, DeltaRequest, ClassifyRequest, SynthesizeRequest

logger = logging.getLogger("miroshop.routes")
bp = Blueprint("miroshop", __name__, url_prefix="/miroshop")

SHOPIFY_APP_API_KEY = Config.__dict__.get("SHOPIFY_APP_API_KEY", None)


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


def _run_simulation(req: SimulateRequest, archetype_contexts: dict):
    """Runs in a background thread — calls back to Shopify app after each phase."""
    llm = LLMClient()

    def callback_fn(phase: int, votes: list, score=None, friction=None, summary=None):
        status = "RUNNING" if phase < 3 else "COMPLETED"
        report_json = None
        if phase == 3 and friction is not None:
            report_json = {"friction": friction, "summary": summary}

        agent_logs = [
            {
                "agentId": v["agent_id"],
                "archetype": v["archetype_id"],
                "phase": v["phase"],
                "verdict": v["verdict"],
                "reasoning": v["reasoning"],
            }
            for v in votes
        ]

        # Estimate MT cost: ~2 MT per agent per phase
        mt_so_far = req.agentCount * 2 * phase

        post_phase_update(
            callback_url=req.callbackUrl,
            api_key=getattr(Config, "SHOPIFY_APP_API_KEY", None),
            simulation_id=req.simulationId,
            phase=phase,
            status=status,
            score=score,
            report_json=report_json,
            actual_mt_cost=mt_so_far if phase == 3 else None,
            agent_logs=agent_logs,
        )

    try:
        brief = ingest_product(req.productJson, req.shopDomain)
        orchestrator = DebateOrchestrator(
            llm=llm,
            agent_count=req.agentCount,
            callback_fn=callback_fn,
        )
        orchestrator.run(brief, archetype_contexts)
    except Exception as e:
        logger.exception(f"Simulation {req.simulationId} failed: {e}")
        post_phase_update(
            callback_url=req.callbackUrl,
            api_key=getattr(Config, "SHOPIFY_APP_API_KEY", None),
            simulation_id=req.simulationId,
            phase=0,
            status="FAILED",
        )


@bp.post("/simulate")
@_require_auth
def simulate():
    try:
        req = SimulateRequest(**request.get_json(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    # Archetype contexts should be passed in productJson.__archetype_contexts__
    # or fetched from DB. For simplicity we pass empty (uses base personas).
    archetype_contexts = req.productJson.pop("__archetype_contexts__", {})

    # Estimate MT cost
    estimated_mt = req.agentCount * 2 * 3  # 3 phases

    # Fire simulation in background thread
    thread = threading.Thread(
        target=_run_simulation,
        args=(req, archetype_contexts),
        daemon=True,
    )
    thread.start()

    return jsonify({"queued": True, "estimatedMtCost": estimated_mt}), 202


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
        productUrl=product_json.get("onlineStoreUrl", ""),
        productJson=product_json,
        agentCount=req.agentCount,
        callbackUrl=req.callbackUrl,
    )

    archetype_contexts = {}
    estimated_mt = req.agentCount * 2 * 3

    thread = threading.Thread(
        target=_run_simulation,
        args=(sim_req, archetype_contexts),
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
        result = llm.chat_json(prompt)
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
        # Quick ping — just init the client, don't make a real call
        model = llm.model
        ollama_ok = True
    except Exception:
        ollama_ok = False
        model = None

    return jsonify({
        "status": "ok" if ollama_ok else "degraded",
        "ollama_available": ollama_ok,
        "model_loaded": model,
    })
