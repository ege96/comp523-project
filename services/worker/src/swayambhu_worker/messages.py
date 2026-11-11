"""Plain-language failure messages for admins, each with what to do next.

Admins aren't programmers, so they see these on the interview page
instead of the provider's raw response. The raw error is still kept in the job's
`last_error` and the worker log, for the operator.
"""

from swayambhu_providers import ProviderError

from swayambhu_worker.audio import AudioError

# Who did the work, in words an admin knows. Provider names stay out: they're config.
_SERVICE = {
    "transcribe": "The transcription service",
    "retranscribe": "The transcription service",
    "translate": "The translation service",
    "retranslate": "The translation service",
    "index": "The search indexing service",
}
_RETRY = "Press Retry next to the step"
_OPERATOR = "ask the archive's operator"


def _provider(kind: str, exc: ProviderError) -> str:
    service = _SERVICE.get(kind, "An outside service")
    code = exc.status_code
    if code in (401, 403):
        return (
            f"{service} refused the archive's account: its key may be missing or wrong, or "
            f"the account may be out of credit. Please {_OPERATOR} to check it, then press "
            "Retry next to the step."
        )
    if code == 429:
        return (
            f"{service} is limiting requests (too many at once, or the account's quota is "
            f"used up). {_RETRY} in an hour or so. If it keeps happening, {_OPERATOR} to "
            "check the account's quota."
        )
    if (code is None and exc.retryable) or (code is not None and code >= 500):
        return f"{service} didn't respond after several tries. {_RETRY} in a few minutes."
    advice = (
        " If the original language is wrong, correct it under Edit details, then press "
        "Translate again."
        if kind in ("translate", "retranslate")
        else ""
    )
    return (
        f"{service} couldn't process this interview.{advice} {_RETRY} once; if it fails "
        f"again, {_OPERATOR} (the technical details are in the processing steps)."
    )


def explain(kind: str, exc: BaseException) -> str:
    """What failed and what to do, for the interview's status line."""
    if isinstance(exc, ProviderError):
        return _provider(kind, exc)
    if isinstance(exc, AudioError):
        return (
            "The recording couldn't be read. The file may be damaged or in an unusual "
            "format. Try converting it to MP3 or MP4 and uploading it again."
        )
    if isinstance(exc, FileNotFoundError):
        return (
            f"The uploaded recording is missing from storage. Upload it again, or {_OPERATOR} "
            "to check the media storage."
        )
    return (
        f"Something went wrong in the processing worker. {_RETRY}; if it fails again, "
        f"{_OPERATOR} to check the worker's logs."
    )


WORKER_STOPPED = (
    "The worker stopped while running this step, possibly because it ran out of memory. "
    f"{_RETRY}; if it happens again, {_OPERATOR}."
)
