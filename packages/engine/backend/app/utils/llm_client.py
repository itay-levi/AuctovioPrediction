"""
LLM client — Groq primary + Gemini fallback, dual rate-limiting.

Rate-limiting strategy (Groq free tier — llama-3.1-8b-instant):
  Limits:  30 RPM  |  6,000 TPM  (rolling 60-second windows)
  Actual:  ~1,100 tok/call (948 in + 156 out) → max ~5.4 calls/min before TPM ceiling
  Config:  LLM_RPM=5   →  12s gap between calls (safe for single simulation)
  TPM cap: _TPM_LIMIT=5500  →  pause when 60s window would exceed this

Two complementary guards run on every primary call:
  1. RPM throttle  (_throttle_primary)  — enforces minimum gap between requests
  2. TPM guard     (_tpm_guard)         — tracks tokens in a sliding 60s window;
                                          sleeps until the window resets if close to ceiling

With concurrent simulations all threads share the same TPM window:
  5,500 TPM ÷ 1,200 tok/call = ~4 calls before TPM guard triggers a wait
  RPM guard keeps per-thread cadence clean; TPM guard protects the shared quota

Exponential backoff: 1s → 2s → 4s on 429 before handing off to Gemini fallback.
Set LLM_RPM=0 to disable both throttles (paid tier — update _TPM_LIMIT too).
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

# ── Primary RPM throttle ───────────────────────────────────────────────────────
_primary_lock = threading.Lock()
_primary_last_call: float = 0.0

# ── Primary TPM sliding-window guard ─────────────────────────────────────────
# Tracks (timestamp, tokens) pairs for the last 60 seconds across all threads.
# Pauses execution when the projected total would exceed _TPM_LIMIT.
_TPM_LIMIT = 5_500           # leave 500 token headroom under Groq free tier's 6,000 TPM
_TPM_WINDOW = 60.0           # rolling window in seconds
_TPM_AVG_TOKENS = 1_200      # conservative estimate — actual is ~1,100 (948 in + 156 out)
_tpm_lock = threading.Lock()
_tpm_calls: collections.deque = collections.deque()  # deque of (monotonic_time, tokens)


def _tpm_guard(estimated_tokens: int = _TPM_AVG_TOKENS) -> None:
    """
    Block until adding `estimated_tokens` would not exceed _TPM_LIMIT in the
    current 60-second rolling window. Called inside _primary_lock so no
    separate lock is needed here, but we use _tpm_lock defensively.
    """
    with _tpm_lock:
        while True:
            now = time.monotonic()
            # Drop entries older than 60s
            while _tpm_calls and now - _tpm_calls[0][0] >= _TPM_WINDOW:
                _tpm_calls.popleft()

            used = sum(t for _, t in _tpm_calls)
            if used + estimated_tokens <= _TPM_LIMIT:
                _tpm_calls.append((now, estimated_tokens))
                return

            # Window is full — wait until the oldest entry expires
            oldest_ts = _tpm_calls[0][0]
            sleep_for = _TPM_WINDOW - (now - oldest_ts) + 0.1
            logger.warning(
                f"[tpm_guard] {used}/{_TPM_LIMIT} tokens used in window — "
                f"sleeping {sleep_for:.1f}s"
            )
            time.sleep(sleep_for)


# ── Fallback rate limiter (Gemini) ─────────────────────────────────────────────
# Emergency-only — fires when Groq quota exhausted; keep at ≤12 RPM
_fallback_lock = threading.Lock()
_fallback_last_call: float = 0.0
_FALLBACK_MIN_INTERVAL = 5.0   # 12 RPM max for Gemini free tier


def _throttle_primary() -> None:
    """RPM throttle + TPM guard — both run under the same lock for atomicity."""
    global _primary_last_call
    rpm = int(Config.LLM_RPM or 0)
    if rpm <= 0:
        return
    min_interval = 60.0 / rpm
    with _primary_lock:
        now = time.monotonic()
        wait = min_interval - (now - _primary_last_call)
        if wait > 0:
            logger.debug(f"[throttle:primary] sleeping {wait:.1f}s (RPM gap)")
            time.sleep(wait)
        _primary_last_call = time.monotonic()

    # TPM guard runs after RPM wait, outside the primary lock (has its own lock)
    _tpm_guard()


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
    """LLM client with Groq → Gemini fallback and exponential backoff on 429."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.api_key = api_key or Config.LLM_API_KEY
        self.base_url = base_url or Config.LLM_BASE_URL
        self.model = model or Config.LLM_MODEL_NAME

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
        if Config.FALLBACK_LLM_API_KEY and Config.FALLBACK_LLM_BASE_URL:
            self._fallback_client = OpenAI(
                api_key=Config.FALLBACK_LLM_API_KEY,
                base_url=Config.FALLBACK_LLM_BASE_URL,
                timeout=30.0,
            )
            self._fallback_model = Config.FALLBACK_LLM_MODEL_NAME
            logger.info(
                f"LLMClient: primary={self.model} | fallback={self._fallback_model}"
            )
        else:
            logger.info(f"LLMClient: primary={self.model} | no fallback configured")

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _call_primary_with_backoff(self, kwargs: dict, max_retries: int = 3) -> Any:
        """
        Call primary LLM. On 429, retry with exponential backoff (1s, 2s, 4s).
        Raises RateLimitError after all retries exhausted.
        """
        for attempt in range(max_retries + 1):
            _throttle_primary()
            try:
                return self.client.chat.completions.create(**kwargs)
            except RateLimitError:
                if attempt == max_retries:
                    logger.error(
                        f"Primary LLM rate limited — {max_retries + 1} attempts failed. "
                        f"Handing off to fallback."
                    )
                    raise
                wait_secs = 2 ** attempt  # 1, 2, 4 seconds
                logger.warning(
                    f"Primary LLM 429 — attempt {attempt + 1}/{max_retries + 1}, "
                    f"backoff {wait_secs}s"
                )
                time.sleep(wait_secs)

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
