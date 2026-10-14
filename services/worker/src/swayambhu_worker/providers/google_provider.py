"""Google Cloud Translation, basic edition (NMT) over the v2 REST API with an API key (D-011).

Verify that Nepal Bhasa ("new") is still listed and check output quality before relying on
it; a failed or empty translation must leave the segment untranslated, not invent text.
"""

from collections.abc import Sequence

import httpx2 as httpx

from swayambhu_worker.providers import ProviderError, raise_for_status

GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2"


class GoogleNmtTranslator:
    def __init__(
        self,
        client: httpx.Client,
        api_key: str,
        url: str = GOOGLE_TRANSLATE_URL,
        batch_size: int = 100,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self._url = url
        self._batch_size = batch_size

    @property
    def name(self) -> str:
        return "google:nmt"

    def translate_to_english(self, texts: Sequence[str], source_language: str) -> list[str]:
        results: list[str] = []
        for start in range(0, len(texts), self._batch_size):
            batch = list(texts[start : start + self._batch_size])
            body = {"q": batch, "source": source_language, "target": "en", "format": "text"}
            try:
                # Key in a header, not the URL, so it never lands in access logs.
                response = self._client.post(
                    self._url, json=body, headers={"X-Goog-Api-Key": self._api_key}
                )
            except httpx.TimeoutException as exc:
                raise ProviderError(f"Google timed out: {exc}", retryable=True) from exc
            except httpx.TransportError as exc:
                raise ProviderError(f"Google unreachable: {exc}", retryable=True) from exc
            raise_for_status(response.status_code, response.text, "Google Translate")
            translations = response.json().get("data", {}).get("translations", [])
            if len(translations) != len(batch):
                raise ProviderError(
                    f"Google returned {len(translations)} translations for {len(batch)} texts",
                    retryable=False,
                )
            results.extend(str(t.get("translatedText", "")) for t in translations)
        return results
