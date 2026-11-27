from sqlalchemy.dialects import postgresql

from swayambhu_core import vector_index


def sql(clause: object) -> str:
    return str(clause.compile(dialect=postgresql.dialect()))  # type: ignore[attr-defined]


def test_search_matches_the_index_expression_and_condition() -> None:
    statement = vector_index.create_statement(384)
    assert vector_index.index_name(384) in statement
    assert "(embedding::halfvec(384)) halfvec_cosine_ops" in statement
    assert statement.endswith("WHERE vector_dims(embedding) = 384")
    # The query side casts the same way and states the condition as a literal.
    assert "CAST(chunk_embeddings.embedding AS HALFVEC(384))" in sql(
        vector_index.distance(384, [0.0] * 384)
    )
    assert sql(vector_index.same_size(384)) == "vector_dims(chunk_embeddings.embedding) = 384"
