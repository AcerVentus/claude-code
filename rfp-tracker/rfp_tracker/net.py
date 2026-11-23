"""A small, polite HTTP GET. Stdlib only; honours the proxy and CA settings in the environment."""

from __future__ import annotations

import time
import urllib.error
import urllib.request

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36"
)
# Statuses that mean "slow down". Anything else that is not 200 is final: a refusal is
# recorded and left alone, never worked around.
RETRY_STATUSES = {429, 503}


class FetchError(Exception):
    def __init__(self, url: str, status: int, reason: str):
        super().__init__(f"{status} {reason}: {url}")
        self.status = status
        self.reason = reason


def get(url: str, *, timeout: int = 30, retry_waits: tuple[int, ...] = (), sleep=time.sleep) -> str:
    """Return the body of `url` as text. Waits and retries only on RETRY_STATUSES."""
    waits = list(retry_waits)
    while True:
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.8"}
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="replace")
        except urllib.error.HTTPError as error:
            if error.code in RETRY_STATUSES and waits:
                sleep(waits.pop(0))
                continue
            raise FetchError(url, error.code, str(error.reason)) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise FetchError(url, 0, str(getattr(error, "reason", error))) from None
