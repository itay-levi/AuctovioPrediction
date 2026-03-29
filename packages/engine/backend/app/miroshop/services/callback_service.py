"""
CallbackService — posts async simulation results back to the Shopify Remix app.
Retries up to 5 times with exponential backoff.
"""

import json
import time
import logging
import requests
from typing import Optional

logger = logging.getLogger("miroshop.callback")

MAX_RETRIES = 5
BACKOFF_BASE = 2  # seconds


def post_phase_update(
    callback_url: str,
    api_key: Optional[str],
    simulation_id: str,
    phase: int,
    status: str,  # "RUNNING" | "COMPLETED" | "FAILED"
    score: Optional[int] = None,
    image_score: Optional[int] = None,
    report_json: Optional[dict] = None,
    actual_mt_cost: Optional[int] = None,
    agent_logs: Optional[list] = None,
    partial: bool = False,  # True → fire-and-forget, 1 attempt, non-blocking
) -> bool:
    payload = {
        "simulationId": simulation_id,
        "phase": phase,
        "status": status,
    }
    if score is not None:
        payload["score"] = score
    if image_score is not None:
        payload["imageScore"] = image_score
    if report_json is not None:
        payload["reportJson"] = report_json
    if actual_mt_cost is not None:
        payload["actualMtCost"] = actual_mt_cost
    if agent_logs is not None:
        payload["agentLogs"] = agent_logs

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    max_attempts = 1 if partial else MAX_RETRIES
    for attempt in range(max_attempts):
        try:
            resp = requests.post(
                callback_url,
                data=json.dumps(payload),
                headers=headers,
                timeout=15,
            )
            if resp.status_code < 300:
                return True
            logger.warning(
                f"Callback attempt {attempt + 1} got {resp.status_code}: {resp.text[:100]}"
            )
        except Exception as e:
            logger.warning(f"Callback attempt {attempt + 1} failed: {e}")

        if attempt < max_attempts - 1:
            sleep = BACKOFF_BASE ** (attempt + 1)
            time.sleep(sleep)

    if not partial:
        logger.error(f"All {max_attempts} callback attempts failed for simulation {simulation_id}")
    return False
