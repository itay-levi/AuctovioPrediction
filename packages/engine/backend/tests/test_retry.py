"""Unit tests for app.utils.retry — branch coverage for backoff + client helpers."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from app.utils.retry import (
    RetryableAPIClient,
    retry_with_backoff,
    retry_with_backoff_async,
)


class TestRetryWithBackoff:
    def test_success_first_call(self):
        @retry_with_backoff(max_retries=2, initial_delay=0.01, jitter=False)
        def f():
            return 7

        assert f() == 7

    def test_retries_then_succeeds(self):
        n = {"c": 0}

        @retry_with_backoff(max_retries=3, initial_delay=0.01, max_delay=0.02, jitter=False)
        def f():
            n["c"] += 1
            if n["c"] < 2:
                raise ValueError("fail")
            return "ok"

        with patch("time.sleep"):
            assert f() == "ok"

    def test_exhausts_and_raises(self):
        @retry_with_backoff(max_retries=1, initial_delay=0.01, jitter=False)
        def f():
            raise RuntimeError("always")

        with patch("time.sleep"):
            with pytest.raises(RuntimeError, match="always"):
                f()

    def test_on_retry_callback(self):
        seen = []

        def on_retry(exc, attempt):
            seen.append((type(exc).__name__, attempt))

        @retry_with_backoff(max_retries=2, initial_delay=0.01, jitter=False, on_retry=on_retry)
        def f():
            raise ConnectionError("x")

        with patch("time.sleep"):
            with pytest.raises(ConnectionError):
                f()
        assert len(seen) >= 1

    def test_custom_exceptions_tuple(self):
        @retry_with_backoff(max_retries=0, exceptions=(ValueError,))
        def f():
            raise OSError("not retried")

        with pytest.raises(OSError):
            f()


class TestRetryWithBackoffAsync:
    @pytest.mark.asyncio
    async def test_success(self):
        @retry_with_backoff_async(max_retries=2, initial_delay=0.01, jitter=False)
        async def f():
            return 42

        assert await f() == 42

    @pytest.mark.asyncio
    async def test_retry_async(self):
        n = {"c": 0}

        @retry_with_backoff_async(max_retries=3, initial_delay=0.01, jitter=False)
        async def f():
            n["c"] += 1
            if n["c"] < 2:
                raise ValueError("nope")
            return 1

        with patch("asyncio.sleep", new_callable=MagicMock):
            assert await f() == 1


class TestRetryableAPIClient:
    def test_call_with_retry_success(self):
        c = RetryableAPIClient(max_retries=1, initial_delay=0.01, max_delay=0.02, backoff_factor=2)
        fn = MagicMock(return_value="r")
        with patch("time.sleep"):
            assert c.call_with_retry(fn, "a") == "r"
        fn.assert_called_once_with("a")

    def test_call_with_retry_raises(self):
        c = RetryableAPIClient(max_retries=1, initial_delay=0.01, max_delay=0.02)
        fn = MagicMock(side_effect=ValueError("e"))
        with patch("time.sleep"):
            with pytest.raises(ValueError):
                c.call_with_retry(fn)
        assert fn.call_count == 2

    def test_call_batch_continue_on_failure(self):
        c = RetryableAPIClient(max_retries=0, initial_delay=0.01, max_delay=0.02)
        def boom(x):
            raise ValueError(x)

        with patch("time.sleep"):
            ok, bad = c.call_batch_with_retry([1, 2], boom, continue_on_failure=True)
        assert ok == []
        assert len(bad) == 2

    def test_call_batch_stop_on_failure(self):
        c = RetryableAPIClient(max_retries=0, initial_delay=0.01, max_delay=0.02)
        def boom(x):
            raise ValueError(x)

        with patch("time.sleep"):
            with pytest.raises(ValueError):
                c.call_batch_with_retry([1, 2], boom, continue_on_failure=False)
