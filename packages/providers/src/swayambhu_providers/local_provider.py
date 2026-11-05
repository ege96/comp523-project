"""Embeddings computed in-process on CPU with ONNX Runtime (no API calls, no key).

Expects a sentence-transformers style encoder exported to ONNX: a directory holding
`tokenizer.json` and `model.onnx` (or `onnx/model.onnx`, as Hugging Face repos lay it out),
whose first output is the last hidden state. Sentence vectors are the attention-masked mean
of the token states, L2-normalised, which is what multilingual-E5 uses. A model that pools
differently (e.g. CLS) would need a pooling setting first.

The images bake the model in at build time (see the Dockerfiles), so pods never download it.
"""

import logging
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import onnxruntime as ort  # type: ignore[import-untyped]
from tokenizers import Tokenizer

from swayambhu_providers import EmbeddingKind, ProviderError

log = logging.getLogger(__name__)


def find_model_file(model_dir: Path) -> Path | None:
    for candidate in (model_dir / "model.onnx", model_dir / "onnx" / "model.onnx"):
        if candidate.is_file():
            return candidate
    return None


class LocalOnnxEmbedder:
    def __init__(
        self,
        model: str,
        model_dir: Path,
        *,
        query_prefix: str = "",
        passage_prefix: str = "",
        max_tokens: int = 512,
        threads: int = 4,
        batch_size: int = 4,
    ) -> None:
        model_file = find_model_file(model_dir)
        if model_file is None:
            raise FileNotFoundError(f"no model.onnx under {model_dir}")
        self._model = model
        self._prefixes: dict[EmbeddingKind, str] = {
            "query": query_prefix,
            "passage": passage_prefix,
        }
        self._max_tokens = max_tokens
        self._batch_size = batch_size
        self._tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self._tokenizer.no_padding()
        self._tokenizer.enable_truncation(max_tokens)
        options = ort.SessionOptions()
        # Without this ONNX Runtime sizes its thread pool from the node's cores, not the pod's.
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        # The arena keeps the largest batch's working memory for good: measured 1,677 vs
        # 1,172 MiB peak with e5-small at batch 16, same vectors.
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        self._session = ort.InferenceSession(
            str(model_file), options, providers=["CPUExecutionProvider"]
        )
        self._inputs = {i.name for i in self._session.get_inputs()}

    @property
    def name(self) -> str:
        # The dimension is fixed by the model, so the model id alone identifies the vectors.
        return f"local:{self._model}"

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        prefix = self._prefixes[kind]
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            batch = [prefix + text for text in texts[start : start + self._batch_size]]
            vectors.extend(self._embed_batch(batch).tolist())
        return vectors

    def _embed_batch(self, texts: list[str]) -> np.ndarray:
        encodings = self._tokenizer.encode_batch(texts)
        if any(e.overflowing for e in encodings):
            # Only the first max_tokens tokens are embedded; the rest of the text is still
            # found by keyword search. Text is never logged.
            log.warning("Embedding input cut to %d tokens", self._max_tokens)
        length = max(len(e.ids) for e in encodings)
        ids = np.zeros((len(texts), length), dtype=np.int64)
        mask = np.zeros((len(texts), length), dtype=np.int64)
        for row, encoding in enumerate(encodings):
            ids[row, : len(encoding.ids)] = encoding.ids
            mask[row, : len(encoding.ids)] = 1
        feeds = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self._inputs:
            feeds["token_type_ids"] = np.zeros_like(ids)
        try:
            hidden = self._session.run(None, {k: v for k, v in feeds.items() if k in self._inputs})
        except Exception as exc:  # ONNX Runtime raises its own unexported error types
            raise ProviderError(f"Local embedding failed: {exc}", retryable=False) from exc
        states = np.asarray(hidden[0], dtype=np.float32)
        weights = mask[..., None].astype(np.float32)
        pooled = (states * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1.0)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        result: np.ndarray = pooled / np.maximum(norms, 1e-12)
        return result
