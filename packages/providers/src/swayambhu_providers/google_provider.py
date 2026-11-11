"""Google Cloud Translation, basic edition (NMT) over the v2 REST API with an API key.

Verify that Nepal Bhasa ("new") is still listed and check output quality before relying on
it; a failed or empty translation must leave the segment untranslated, not invent text.
"""

from collections.abc import Iterator, Sequence

import httpx2 as httpx

from swayambhu_providers import ProviderError, Translation, raise_for_status

GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2"


class GoogleNmtTranslator:
    def __init__(
        self,
        client: httpx.Client,
        api_key: str,
        url: str = GOOGLE_TRANSLATE_URL,
        batch_size: int = 100,
        max_batch_bytes: int = 30_000,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self._url = url
        self._batch_size = batch_size
        self._max_batch_bytes = max_batch_bytes

    @property
    def name(self) -> str:
        return "google:nmt"

    def _batches(self, texts: Sequence[str]) -> Iterator[list[str]]:
        """Consecutive batches of at most `batch_size` texts and `max_batch_bytes` of UTF-8.
        A single text over the byte limit is sent alone."""
        batch: list[str] = []
        size = 0
        for text in texts:
            text_bytes = len(text.encode("utf-8"))
            if batch and (
                len(batch) >= self._batch_size or size + text_bytes > self._max_batch_bytes
            ):
                yield batch
                batch, size = [], 0
            batch.append(text)
            size += text_bytes
        if batch:
            yield batch

    def translate_to_english(
        self, texts: Sequence[str], source_language: str | None
    ) -> list[Translation]:
        results: list[Translation] = []
        for batch in self._batches(texts):
            body: dict[str, object] = {"q": batch, "target": "en", "format": "text"}
            if source_language:  # otherwise Google detects the language
                body["source"] = source_language
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
            try:
                translations = response.json()["data"]["translations"]
                if not isinstance(translations, list) or not all(
                    isinstance(t, dict) for t in translations
                ):
                    raise TypeError("translations is not a list of objects")
            except (ValueError, KeyError, TypeError) as exc:
                raise ProviderError(
                    "Google returned a malformed translation response", retryable=False
                ) from exc
            if len(translations) != len(batch):
                raise ProviderError(
                    f"Google returned {len(translations)} translations for {len(batch)} texts",
                    retryable=False,
                )
            results.extend(
                Translation(
                    str(t.get("translatedText", "")),
                    t.get("detectedSourceLanguage") or None,
                )
                for t in translations
            )
        return results
