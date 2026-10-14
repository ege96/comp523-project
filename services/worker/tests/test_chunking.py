from swayambhu_worker.chunking import Chunk, Timed, chunk_segments


def segments(*bounds: tuple[int, int]) -> list[Timed]:
    return [Timed(i, start * 1000, end * 1000) for i, (start, end) in enumerate(bounds)]


def test_chunks_close_once_they_reach_the_target() -> None:
    timed = segments(*[(s, s + 15) for s in range(0, 180, 15)])
    assert chunk_segments(timed) == [
        Chunk(0, 3, 0, 60_000),
        Chunk(4, 7, 60_000, 120_000),
        Chunk(8, 11, 120_000, 180_000),
    ]


def test_a_short_tail_joins_the_previous_chunk() -> None:
    timed = segments((0, 20), (20, 40), (40, 60), (60, 75))
    assert chunk_segments(timed) == [Chunk(0, 3, 0, 75_000)]


def test_a_tail_that_would_make_a_chunk_too_long_stays_separate() -> None:
    timed = segments((0, 80), (80, 100))
    assert chunk_segments(timed) == [Chunk(0, 0, 0, 80_000), Chunk(1, 1, 80_000, 100_000)]


def test_a_short_interview_is_one_chunk_and_no_speech_is_none() -> None:
    assert chunk_segments(segments((0, 10))) == [Chunk(0, 0, 0, 10_000)]
    assert chunk_segments([]) == []
