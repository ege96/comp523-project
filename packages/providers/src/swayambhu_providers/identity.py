"""The identity stored with each embedding, shared by the embedder and the config-only lookup."""

import hashlib
import json

# Mean pooling over non-padding tokens followed by L2 normalisation, as local_provider does.
LOCAL_POOLING = "mean-l2"


def local_embedding_name(
    model: str,
    revision: str | None,
    *,
    query_prefix: str,
    passage_prefix: str,
    max_tokens: int,
) -> str:
    """`local:<model>[@<revision>]#<digest>`. The digest covers everything that changes the
    vectors without changing the model files: both prefixes, the token limit and the pooling."""
    preprocessing = json.dumps(
        {
            "query_prefix": query_prefix,
            "passage_prefix": passage_prefix,
            "max_tokens": max_tokens,
            "pooling": LOCAL_POOLING,
        },
        sort_keys=True,
    )
    digest = hashlib.sha256(preprocessing.encode()).hexdigest()[:12]
    return f"local:{model}" + (f"@{revision}" if revision else "") + f"#{digest}"
