---
name: Swayambhu Stories
description: Bilingual-signage frame around a calm reading column for a searchable oral-history archive.
colors:
  plate: "#173a8c"
  plate-deep: "#0f2a6b"
  on-plate: "#ffffff"
  on-plate-muted: "#c9d6f5"
  ground: "#ffffff"
  ground-alt: "#f2f4f8"
  ink: "#141821"
  ink-muted: "#4a5161"
  rule: "#d6dbe5"
  rule-strong: "#7f8a9e"
  mark: "#ffd257"
  here: "#c2321d"
typography:
  display:
    fontFamily: "Mukta, Noto Sans Devanagari, Nirmala UI, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "Mukta, Noto Sans Devanagari, Nirmala UI, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1.25
  title:
    fontFamily: "Mukta, Noto Sans Devanagari, Nirmala UI, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.35
  original-line:
    fontFamily: "Mukta, Noto Sans Devanagari, Nirmala UI, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.65
  english-line:
    fontFamily: "Mukta, Noto Sans Devanagari, Nirmala UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Mukta, Noto Sans Devanagari, Nirmala UI, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  section-label:
    fontFamily: "Mukta, Noto Sans Devanagari, Nirmala UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.06em"
rounded:
  plate: "2px"
spacing:
  unit: "8px"
  row: "12px"
  section: "40px"
components:
  time-plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.on-plate}"
    rounded: "{rounded.plate}"
    padding: "8px 12px"
  time-plate-here:
    backgroundColor: "{colors.here}"
    textColor: "{colors.on-plate}"
    rounded: "{rounded.plate}"
  button-primary:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.on-plate}"
    rounded: "{rounded.plate}"
    height: "40px"
  search-field:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
---

## Overview

The frame comes from Kathmandu's bilingual enamel street signs: a deep blue plate with white
lettering, Devanagari above Roman. The plate owns the masthead, the search band on Home and
Search, the player frame and the small time plates. Everything people read sits on white, in a
calm column. One family, Mukta, sets both scripts so a Nepali line and its English read as a pair.

## Colors

- **Plate** blue is the frame, never the reading ground. White and `on-plate-muted` are the only text colours on it.
- **Mark** (marigold) is reserved for find-in-transcript matches and the focus ring of the search field on the plate.
- **Here** (vermilion) marks the one line that is "you are here": the line opened from a search, then the line playing. Never decorative.
- Body text on white uses `ink`; secondary text `ink-muted` (7.9:1). Input borders use `rule-strong` (3.5:1).

## Typography

Mukta 400/600/800, self-hosted from `@fontsource/mukta` (the CSP allows no font host). Headings
800; titles 600. Devanagari lines get line-height 1.75 via a global `[lang]` rule. Times use
tabular figures. Section headings inside pages are small caps-tracked labels over a 2px ink rule
(they are the heading, not a label above one).

## Layout

Container width from MUI (max 1200px, 16/24px gutters). Search: 15rem filter rail + results;
filters fold behind a "Filters" button below `md`. Viewer: 20rem pinned side column (player and
details) + transcript; below `md` the side column dissolves and audio pins to the top.
Transcript lines and moments are a 2-column grid: time in the margin, the line pair beside it.

## Elevation & Depth

None. No shadows. Separation is by rules: 2px ink rule under section headings and above
catalogue tables, 1px `rule` between rows.

## Shapes

Square, 2px corners on plates, fields and buttons. No pills, no cards.

## Components

- **Masthead:** plate, place name in Devanagari above "Swayambhu Stories", nav items underlined 3px white when current.
- **Search box:** white field on the plate, plate-blue Search button inset, marigold outline on focus.
- **Catalogue (InterviewList):** ruled table on wide screens, one detail line on phones; title link stretched over the row.
- **Moment:** time plate link in the margin ("0:44 to 1:40, Listen" with a drawn play icon), title, details, then line pairs.
- **LinePair:** original above, English below in `ink-muted`; whichever half is alone leads at full size.
- **Transcript line:** time button (plate text; `here` fill when current), line pair, "Corrected" caption.

## Do's and Don'ts

- Do show the original words first and the English beneath; never hide the original behind a tab by default.
- Do keep the plate to the frame; never put running text on blue.
- Don't add cards, shadows, gradients, pills or rounded corners above 2px.
- Don't use colour for anything but plate, mark and here.
