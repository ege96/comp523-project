# Results

Measured on 2026-11-26 and 27 with the tools in this folder (see [README.md](README.md)). These are **local** numbers: one machine running containers with the CloudApps pods' CPU and memory limits, not the live site. "Before" is `main` at 25a5df6. "After" is this branch, with its two search fixes (the keyword index and the vector query), plus the connection fix where noted. The last section adds the HNSW index and fewer round trips, measured against the branch without them.

## Environment

| | |
|---|---|
| Host | 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB, Docker 29.9 (cgroup v1) |
| db | `pgvector/pgvector:pg16` (PostgreSQL 16.16, pgvector 0.8.7), 0.5 CPU / 512 MiB, pinned to core 1; `shared_buffers` 128MB, `work_mem` 4MB (the same as the CloudApps database) |
| api | 1 CPU / 768 MiB, pinned to core 0, local e5-small on 1 thread |
| worker | 2 CPU / 1 GiB, cores 2-3, e5-small on 2 threads, batch 4 |
| Load client | cores 2-3, so it never shares a core with the api or db |

**How the CPU compares with CloudApps.** The same embedding probe run on CloudApps took 21 ms per query (median) and 36.2 s for 64 passages of 512 tokens. Locally it took 8-10 ms and 30-31 s. A CloudApps pod is therefore about 1.2x slower on long batches and about 2x slower on short queries, so expect live search latency to be somewhat above the figures here.

**Test data.** Real text, not placeholders: FLEURS Nepali and English sentences (CC BY 4.0) and Wikipedia ne/en passages (CC BY-SA 4.0), embedded with e5-small. About 40% of the vectors are Nepali text.

| Size | Vectors | Interviews | Transcript lines | Database |
|---|---|---|---|---|
| 1x | 3,052 | 327 | 23,529 | 55 MB |
| 10x | 30,012 | 4,892 | 251,711 | 368 MB |
| 30x | 90,000 | 17,151 | 718,821 | 1,009 MB |

## Search latency, one search at a time

`bench latency`: client-measured `GET /api/search` as a visitor, so each time includes embedding the query on the api's one CPU. The full set is 953 queries (the 50 in `queries.txt` plus 903 labelled Nepali/English queries), 2 passes after a warm-up pass, repeated after 2 fresh starts; the table shows the first start, and the second was within 10%. On `main` at 10x and 30x a search takes 10-35 s, so those rows use a fixed random sample, 150 queries at 10x and 50 at 30x, and the "after" row beside each uses the same sample.

| Size | Queries | Before p50 / p95 | After p50 / p95 | Speed-up (p50) |
|---|---|---|---|---|
| 1x | full | 916 / 1,205 ms | 43 / 58 ms | 21x |
| 10x | full | (not run) | 105 / 177 ms | |
| 10x | sample of 150 | 10,284 / 11,414 ms | 116 / 193 ms | 89x |
| 30x | full | (not run) | 660 / 888 ms | |
| 30x | sample of 50 | 30,576 / 33,321 ms | 487 / 626 ms | 63x |

**Where the time went.** `bench split` at 10x shows the keyword query taking 10.9 s (p50) without the partial index on untranslated lines, and 5 ms with it. At 30x the vector query takes 610 ms (p50) on `main` and 296 ms with the nearest-first rewrite.

At 30x the 1 GB database no longer fits in the db pod's 512 MiB (its memory reached the limit), so that size is where the current pod sizes run out.

## Exact vs approximate vector search, 30x

`bench ann`: the search's vector query only, in process, 948 queries x 3 runs. Recall is overlap with exact search and labelled task recall (903 queries, as an admin).

| | p50 / p95 | Overlap with exact @10 | Task recall@10 | Index size | Build time |
|---|---|---|---|---|---|
| Exact | 368 / 494 ms | 1.000 | 0.761 | | |
| HNSW halfvec, ef_search 1000 | 23 / 71 ms | 0.990 | 0.751 | 100.5 MB | 190 s |
| HNSW halfvec, ef_search 40-200 | 14 / 58 ms | 0.957-0.963 | 0.680 | 100.5 MB | 190 s |
| HNSW vector, ef_search 1000 | 33 / 81 ms | 0.989 | 0.751 | 175.8 MB | 226 s |

An HNSW halfvec index makes the vector query about 16x faster at 30x for a 1-point drop in task recall. The build ran with `maintenance_work_mem` 64MB, which the graph outgrew. Search now uses this index with `ef_search` 1000 (see the last section).

## Load: how much one api pod serves (10x)

`search_load.js PROFILE=ceiling`: the arrival rate rises in one-minute steps, with no think time. The pass bar is p95 under 500 ms with under 1% errors.

| Arrival rate | Before connection fix: p95 / failed | After: p95 / failed |
|---|---|---|
| 5.8-5.9 /s | 182 ms / 0 | 161 ms / 0 |
| 7.7-7.8 /s | 2,408 ms / 0 | 1,499 ms / 0 |
| 10-30 /s (overloaded) | every request timed out at 60 s, 47.7% failed, throughput fell to 3.3 /s | served 7.4-8.3 /s, 0 of 7,479 failed |
| After the load stopped | unresponsive for about 14 minutes | answering again at once |

**Ceiling: about 6 searches per second per api pod within the bar, about 8 per second flat out.** `main` was not load-tested: at 10x it takes about 10 s per search, which is under one search per second.

**The connection fix.** Before it, an overload locked the api up. `py-spy` and `pg_stat_activity` showed the 15 pool connections idle in transaction, held by searches that had finished their queries and were waiting for a worker thread to validate their response. Meanwhile all 40 threads were waiting for a connection. The search now closes its session before returning (`search.py`), so the connection goes back to the pool before the wait.

## Worker: processing time per recording hour

The worker at its CloudApps limits, with offline transcription and translation so the timings cover our own processing and not a provider's. Each recording was ingested with `python -m swayambhu_worker.ingest` and run twice. Stage times come from the worker's job log lines, and memory from the container's cgroup.

| 60-minute recording | Total, ingest to done | Transcribe step* | Playback copy | CPU | Peak RSS |
|---|---|---|---|---|---|
| MP3 (FLEURS Nepali, 128k) | 78 / 75 s | 27 / 26 s | 46 / 44 s (M4A) | ~105 CPU-s | 545-574 MiB |
| 720p video (test pattern, 1.26 GB) | 735 / 742 s | 24 / 25 s | 703 / 709 s (H.264) | ~1,400 CPU-s | 654-660 MiB |

\* Decode, loudness scan, quiet-point cuts and piece cutting, with the provider call faked.

Embedding real chunk text runs at 18.4 texts/s (60 six-sentence Nepali passages plus their English: 120 texts in 6.5 s). A recording hour is about 60 chunks in two languages, so its embeddings take about 7 s. With page cache counted, memory reached the 1 GiB limit during the video re-encode; the kernel reclaimed the cache and nothing was killed. Real interview video compresses far better than the test pattern, which came out at 1.67 Mbit/s, so it should encode faster.

So, apart from the provider's own transcription time, an hour of audio is ready in about 1.5 minutes and an hour of 720p video in about 12 minutes, nearly all of it the browser-friendly video copy.

## Media start and seek

`media_timing.js`: Playwright Chromium against the api directly, with a cold cache on each run, 10 runs. "Start" runs from setting the source to the `playing` event; "seek" jumps to 30:00.

| Media | Network | Start, median / max | Seek, median / max |
|---|---|---|---|
| Audio M4A (125 kbit/s) | unthrottled | 38 / 56 ms | 12 / 27 ms |
| 720p video (1.67 Mbit/s) | unthrottled | 120 / 186 ms | 42 / 58 ms |
| Audio | 1.5 Mbit/s, 300 ms RTT | 3.8 / 3.8 s | 0.66 / 0.97 s |
| 720p video | 1.5 Mbit/s, 300 ms RTT | 20.8 / 20.8 s | 0.86 / 1.33 s |

Seeking stays near a second even on the slow link, because playback copies are written with `+faststart` and served with range requests. The slow video start comes from the test pattern's bitrate being above the link speed.

## HNSW index and fewer round trips

Search now walks the HNSW halfvec index with `hnsw.ef_search` 1000, which the worker builds. Each search makes three queries instead of five: both candidate searches run as one query, and a page's interviews and excerpts come from one more. Measured on 2026-11-27 in one session, against this branch without those two changes ("before"), with the full 953 queries, 2 passes and 2 fresh starts each.

| Size | Before p50 / p95 | After p50 / p95 | Index build |
|---|---|---|---|
| 10x (30,012 vectors) | 111 / 184 ms | 97 / 162 ms | 25 s, 34 MB |
| 30x (90,000 vectors) | 641 / 855 ms | 238 / 420 ms | 221 s, 100 MB |

At 30x, p95 is now under 500 ms. At 10x the gain is small, because the vector query was already only about a fifth of a search. In process at 10x, a search spends about this long on each step (medians): embedding the query 20 ms, the candidates query 20 ms (its vector part went from 80 to 19 ms), matching interview details 23 ms, and excerpts 5 ms.

**Load at 10x is unchanged:** about 6 searches/s within the bar and 7.5-8/s flat out, before and after, with 0 failures and immediate recovery. The api's one CPU is the limit, mostly spent embedding queries and running Python, not waiting on Postgres. So the next gains are in the api: profiling it, adding a second replica (within the quota), and indexing interview details, which are matched on the fly today.

## What is not covered

- The live CloudApps site: only a light check is planned there (about one search per second), never a load test.
- Real transcription and translation providers: their time is the provider's, and the paid concurrency comparison is left out.
- HTTP/2, nginx and the OpenShift router: the api was called directly.
