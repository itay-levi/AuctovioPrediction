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
from .schemas import SimulateRequest, ClassifyRequest

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


@bp.post("/classify")
@_require_auth
def classify():
    try:
        req = ClassifyRequest(**request.get_json(force=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    llm = LLMClient()
    classifier = NicheClassifier(llm)
    classification = classifier.classify(req.catalogMetadata)
    contexts = classifier.generate_archetype_contexts(classification, ARCHETYPES)

    return jsonify({
        "classification": classification,
        "archetypeContexts": contexts,
    })


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
