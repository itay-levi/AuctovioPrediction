"""
LLM client — dual-model (8B fast / 70B deep) on Groq + Gemini fallback.

Dual-model routing:
  Fast (8B  — llama-3.1-8b-instant):    DNA extraction, product intelligence, gap analysis,
                                          archetype generation, niche profiles, friction classification.
  Deep (70B — llama-3.3-70b-versatile): All debate phases (P1/P2/P3) + recommendations.

Each model has its OWN rate-limit pool on Groq — separate RPM / TPM quotas.

Rate-limiting strategy (Groq free tier, per model):
  Limits:  30 RPM  |  6,000 TPM  (rolling 60-second windows)
  Actual:  ~1,100 tok/call → max ~5.4 calls/min before TPM ceiling
  Config:  LLM_RPM=5 / DEEP_LLM_RPM=5  →  12s gap between calls

Two complementary guards per model tier:
  1. RPM throttle  — enforces minimum gap between requests
  2. TPM guard     — tracks tokens in a sliding 60s window

Exponential backoff: 1s → 2s → 4s on 429 before handing off to Gemini fallback.
Set LLM_RPM=0 / DEEP_LLM_RPM=0 to disable throttles (paid tier).
"""

import json
import logging
import re
import time
import threading
import collections
from typing import Optional, Dict, Any, List
from openai import OpenAI, RateLimitError

from ..config import Config

logger = logging.getLogger("miroshop.llm")

# ── Fast model (8B) rate limiters ─────────────────────────────────────────────
_fast_lock = threading.Lock()
_fast_last_call: float = 0.0

_FAST_TPM_LIMIT = 5_500      # leave headroom under Groq free tier's 6,000 TPM
_TPM_WINDOW = 60.0
_TPM_AVG_TOKENS = 1_200
_fast_tpm_lock = threading.Lock()
_fast_tpm_calls: collections.deque = collections.deque()

# ── Deep model (70B) rate limiters — SEPARATE quota pool ──────────────────────
_deep_lock = threading.Lock()
_deep_last_call: float = 0.0

_deep_tpm_lock = threading.Lock()
_deep_tpm_calls: collections.deque = collections.deque()

# ── Fallback rate limiter (Gemini) ─────────────────────────────────────────────
_fallback_lock = threading.Lock()
_fallback_last_call: float = 0.0
_FALLBACK_MIN_INTERVAL = 5.0   # 12 RPM max for Gemini free tier


def _tpm_guard_for(
    tpm_lock: threading.Lock,
    tpm_calls: collections.deque,
    tpm_limit: int,
    label: str,
    estimated_tokens: int = _TPM_AVG_TOKENS,
) -> None:
    """Generic TPM guard — shared logic for both fast and deep model pools."""
    with tpm_lock:
        while True:
            now = time.monotonic()
            while tpm_calls and now - tpm_calls[0][0] >= _TPM_WINDOW:
                tpm_calls.popleft()

            used = sum(t for _, t in tpm_calls)
            if used + estimated_tokens <= tpm_limit:
                tpm_calls.append((now, estimated_tokens))
                return

            oldest_ts = tpm_calls[0][0]
            sleep_for = _TPM_WINDOW - (now - oldest_ts) + 0.1
            logger.warning(
                f"[tpm_guard:{label}] {used}/{tpm_limit} tokens used — "
                f"sleeping {sleep_for:.1f}s"
            )
            time.sleep(sleep_for)


def _throttle_fast() -> None:
    """RPM + TPM throttle for the 8B fast model."""
    global _fast_last_call
    rpm = int(Config.LLM_RPM or 0)
    if rpm > 0:
        min_interval = 60.0 / rpm
        with _fast_lock:
            now = time.monotonic()
            wait = min_interval - (now - _fast_last_call)
            if wait > 0:
                logger.debug(f"[throttle:fast] sleeping {wait:.1f}s")
                time.sleep(wait)
            _fast_last_call = time.monotonic()
    _tpm_guard_for(_fast_tpm_lock, _fast_tpm_calls, _FAST_TPM_LIMIT, "fast")


def _throttle_deep() -> None:
    """RPM + TPM throttle for the 70B deep model — independent of fast pool."""
    global _deep_last_call
    rpm = int(Config.DEEP_LLM_RPM or 0)
    if rpm > 0:
        min_interval = 60.0 / rpm
        with _deep_lock:
            now = time.monotonic()
            wait = min_interval - (now - _deep_last_call)
            if wait > 0:
                logger.debug(f"[throttle:deep] sleeping {wait:.1f}s")
                time.sleep(wait)
            _deep_last_call = time.monotonic()
    _tpm_guard_for(
        _deep_tpm_lock, _deep_tpm_calls,
        Config.DEEP_LLM_TPM_LIMIT, "deep",
    )


# Keep old name as alias so any external callers don't break
_primary_lock = _fast_lock


def _throttle_fallback() -> None:
    global _fallback_last_call
    with _fallback_lock:
        now = time.monotonic()
        wait = _FALLBACK_MIN_INTERVAL - (now - _fallback_last_call)
        if wait > 0:
            logger.debug(f"[throttle:fallback] sleeping {wait:.1f}s")
            time.sleep(wait)
        _fallback_last_call = time.monotonic()


class LLMClient:
    """
    LLM client with Groq → Gemini fallback and exponential backoff on 429.

    use_deep_throttle=True  → uses the 70B rate-limit pool (DEEP_LLM_RPM / DEEP_LLM_TPM_LIMIT)
    use_deep_throttle=False → uses the 8B rate-limit pool (LLM_RPM / _FAST_TPM_LIMIT)
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        use_deep_throttle: bool = False,
    ):
        self.api_key = api_key or Config.LLM_API_KEY
        self.base_url = base_url or Config.LLM_BASE_URL
        self.model = model or Config.LLM_MODEL_NAME
        self._use_deep_throttle = use_deep_throttle

        if not self.api_key:
            raise ValueError("LLM_API_KEY 未配置")

        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=30.0,
        )

        # Fallback client — Gemini, only created when credentials are present
        self._fallback_client: Optional[OpenAI] = None
        self._fallback_model: Optional[str] = None
        tier_label = "deep(70B)" if use_deep_throttle else "fast(8B)"
        if Config.FALLBACK_LLM_API_KEY and Config.FALLBACK_LLM_BASE_URL:
            self._fallback_client = OpenAI(
                api_key=Config.FALLBACK_LLM_API_KEY,
                base_url=Config.FALLBACK_LLM_BASE_URL,
                timeout=30.0,
            )
            self._fallback_model = Config.FALLBACK_LLM_MODEL_NAME
            logger.info(
                f"LLMClient [{tier_label}]: primary={self.model} | fallback={self._fallback_model}"
            )
        else:
            logger.info(f"LLMClient [{tier_label}]: primary={self.model} | no fallback configured")

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _call_primary_with_backoff(self, kwargs: dict, max_retries: int = 3) -> Any:
        """
        Call primary LLM. On 429, retry with exponential backoff (1s, 2s, 4s).
        Selects the correct rate-limit pool (fast/deep) based on use_deep_throttle.
        Raises RateLimitError after all retries exhausted.
        """
        throttle = _throttle_deep if self._use_deep_throttle else _throttle_fast
        tier_label = "deep(70B)" if self._use_deep_throttle else "fast(8B)"
        for attempt in range(max_retries + 1):
            throttle()
            try:
                return self.client.chat.completions.create(**kwargs)
            except RateLimitError:
                if attempt == max_retries:
                    logger.error(
                        f"[{tier_label}] Rate limited — {max_retries + 1} attempts failed. "
                        f"Handing off to fallback."
                    )
                    raise
                wait_secs = 2 ** attempt
                logger.warning(
                    f"[{tier_label}] 429 — attempt {attempt + 1}/{max_retries + 1}, "
                    f"backoff {wait_secs}s"
                )
                time.sleep(wait_secs)
            except Exception as e:
                # Surface non-429 errors immediately with a clear message
                # (AuthenticationError = wrong API key, APIConnectionError = engine can't reach Groq)
                logger.error(f"[{tier_label}] LLM call failed ({type(e).__name__}): {e}")
                raise

    def _call_fallback(self, kwargs: dict) -> Any:
        """
        Call Gemini fallback. No internal retry — if this 429s too, let it raise.
        Strips response_format on error (Gemini compat) and retries once.
        """
        if self._fallback_client is None:
            raise RuntimeError(
                "Fallback LLM not configured (FALLBACK_LLM_API_KEY / FALLBACK_LLM_BASE_URL missing)"
            )
        _throttle_fallback()
        fallback_kwargs = {**kwargs, "model": self._fallback_model}
        try:
            return self._fallback_client.chat.completions.create(**fallback_kwargs)
        except Exception as e:
            # Some Gemini models don't support response_format — retry without it
            if "response_format" in fallback_kwargs and "response_format" in str(e).lower():
                logger.warning("Fallback: stripping response_format and retrying")
                fallback_kwargs.pop("response_format", None)
                _throttle_fallback()
                return self._fallback_client.chat.completions.create(**fallback_kwargs)
            raise

    def _complete(self, kwargs: dict) -> str:
        """
        Core dispatch: try primary with backoff, fall back to Gemini on exhaustion.
        Returns the raw content string (think-tags stripped).
        """
        try:
            response = self._call_primary_with_backoff(kwargs)
        except RateLimitError:
            logger.warning(
                "[fallback] Primary quota exhausted — routing this call to Gemini"
            )
            response = self._call_fallback(kwargs)

        content = response.choices[0].message.content or ""
        # Strip <think> CoT blocks emitted by some models
        content = re.sub(r'<think>[\s\S]*?</think>', '', content).strip()
        return content

    # ── Public API ─────────────────────────────────────────────────────────────

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 400,
        response_format: Optional[Dict] = None,
    ) -> str:
        """Send a chat request and return the model's text response."""
        kwargs: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            kwargs["response_format"] = response_format
        return self._complete(kwargs)

    def chat_json(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 800,
    ) -> Dict[str, Any]:
        """Send a chat request and return a parsed JSON dict."""
        response = self.chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        cleaned = response.strip()
        cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'\n?```\s*$', '', cleaned).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            raise ValueError(f"LLM返回的JSON格式无效: {cleaned}")
