# Product

<!-- impeccable:product-schema 1 -->

<!-- Derived from the project's decisions_log.md and full-stack handoff (2026-11-10), not from a
new interview. The decisions log wins where this file and it disagree. -->

## Platform

web

## Users

- **Public visitor** (anonymous): researchers, students, community members in Kathmandu and the
  diaspora, often on a phone. They come with a question ("how have festivals changed?", a
  family name, a ritual) and want the moment where someone talks about it, then to listen.
- **Admin/contributor** (individual Firebase accounts, one role, D-005): the archive team
  uploading recordings, fixing metadata and language, correcting transcripts, and publishing.

## Product Purpose

Swayambhu Stories is a searchable archive of multilingual oral-history interviews about the
Swayambhu stupa in Kathmandu, led by Dr. Lauren Leve (UNC Religious Studies) with Baakhan Nyane
Waa. Success: a visitor types a question and lands on the exact timestamped moment in a
recording, reads it in the original language and in English, and plays it.

## Positioning

Search-first, not a curated exhibit. Results are transcript moments with timestamps, not
documents. Original-language words (Nepali, Nepal Bhasa, English) are always shown and kept
separate from machine translation and human edits.

## Operating Context

Interviews are hour-long audio or video. Transcripts are machine-made (ASR + Google NMT) and
labelled as such; lines fixed by the team are marked "Corrected". Nepal Bhasa is a separate
low-resource language and often has no English. Hosted on UNC CloudApps; the CSP allows no
external font or script hosts (self-hosted assets only).

## Capabilities and Constraints

- Keyword + semantic search; filters: original language, interviewee (with Unknown), recording
  date (with "also undated"). Never show an exact result count.
- Visibility is Public/Private only, enforced by the API. Interview status Processing/Done/Failed.
- Viewer: player, transcript with Original/English, play from any line, deep link `?t=ms`,
  find in transcript.
- Stack is fixed: React + TypeScript + Vite, MUI, TanStack Router/Query/Form, zod.
- No themes, featured content, recommendations, favourites, or AI summaries.

## Brand Commitments

No logo or brand assets exist yet. The name is "Swayambhu Stories". Mockup PNGs in the handoff
bundle are illustrative only.

## Evidence on Hand

No real interviews, quotes, names or photographs may be invented or taken from mockups. Credits,
citation format and removal contact are still to come from the archive team (marked boxes on
/about).

## Product Principles

1. The interviewee's own words lead; titles and metadata support them.
2. Every result is a place in a recording you can play.
3. Machine output is labelled honestly; missing translation is a normal state, not an error.
4. Respect for the community and the site over spectacle.

## Accessibility & Inclusion

WCAG 2.2 AA. Devanagari must render well (correct `lang`, adequate size and line height).
Works on low-end phones and slow connections.
