---
name: Swayambhu Stories
description: Warm cream archive with terracotta accents, serif headings and paired original/English transcript lines.
colors:
  accent: "#963a35"
  accent-deep: "#7a2e2a"
  on-accent: "#ffffff"
  on-accent-muted: "#f3d9d5"
  ground: "#f6f3ef"
  paper: "#fdfcfa"
  ground-alt: "#efe9e2"
  ink: "#2b2724"
  ink-muted: "#635d57"
  rule: "#e2dbd3"
  rule-strong: "#8a8178"
  mark: "#f4d58d"
  here-tint: "rgba(150, 58, 53, 0.08)"
typography:
  display:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "2.5rem"
    fontWeight: 400
    lineHeight: 1.15
  heading:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "1.75rem"
    fontWeight: 400
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
  sm: "4px"
spacing:
  unit: "8px"
  row: "12px"
  section: "40px"
components:
  time-plate:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  time-plate-here:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    height: "40px"
  search-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
---

## Overview

The original warm archive look, kept on purpose: cream ground, lighter paper for the header and
panels, a terracotta accent, Georgia headings. Body text is Mukta, one family for Devanagari and
Latin, self-hosted. The structure leads with the interviewees' words: every transcript line and
search moment is a pair, original above English.

## Colors

- **Accent** (terracotta) is for actions and wayfinding: buttons, links, the current nav item, time labels.
- **Here tint + filled time label** marks the one line that is "you are here": the line opened from a search, then the line playing.
- **Mark** (pale gold) is reserved for find-in-transcript matches.
- Text: `ink` on cream/paper; secondary `ink-muted` (5.9:1 on cream). Input borders `rule-strong` (3.5:1).

## Typography

Headings Georgia 400 (h1 2.5rem, h2 1.75rem, h3 1.375rem). Body Mukta 400/600/800 from
`@fontsource/mukta` (the CSP allows no font host). Devanagari lines get line-height 1.75 via a
global `[lang]` rule. Times use tabular figures. In-page section labels are small tracked labels
over a 1px rule; panel titles are Georgia h3.

## Layout

Search: 15rem filter rail + results; filters fold behind a "Filters" button below `md`. Viewer:
20rem pinned side column (player and details) + transcript; below `md` the side column dissolves
and audio pins to the top. Transcript lines and moments are a 2-column grid: time in the margin,
the line pair beside it. Interview lists are a catalogue panel with columns on wide screens.
Admin: upload panel beside the recordings list (stacked below `lg`, list first); a recording's
page is a next-step panel, then Processing beside Details and Who can see it, then the transcript.

## Elevation & Depth

None. Separation by 1px `rule` lines and outlined paper panels (as in the mockups). No shadows.

## Shapes

4px corners on buttons, fields, the logo tile and time labels.

## Components

- **Header:** paper bar with bottom rule; terracotta waveform tile + Georgia wordmark; nav items Search · Interviews · About, current one underlined in terracotta.
- **Search box:** paper field with a terracotta Search button inset; terracotta outline on focus.
- **Catalogue (InterviewList):** outlined panel with a tinted header row on wide screens, one detail line on phones; title link stretched over the row.
- **Moment:** outlined card as in the search mockup: Georgia title, details, a soft time pill ("0:44 – 1:40"), line pairs, then an "Open at this moment" button.
- **Admin stage pill:** soft pill naming where a recording is: Needs attention (amber), Processing (neutral), Not published (terracotta tint), Published (green). Same words as the admin tabs.
- **Next step panel:** outlined panel with a 4px left edge in the stage colour; "Next step" label, one heading, a sentence or two, and at most two buttons.
- **Processing checklist:** one line per step in plain words with a mark (tick, spinner, empty ring, red "!"); a failed step says how many tries and folds the technical text.
- **Transcript editor:** its own page (`/admin/interviews/$id/transcript`, md container). A pinned toolbar holds the native audio player, the line filters, Find and replace, "Edit the line playing", "Follow the recording" and a Jump-to strip in 5-minute steps. The line playing gets the `hereTint` row with a 3px terracotta left edge.
- **Recording date:** Year, Month and Day fields, each optional from the right.
- **LinePair:** original above, English below in `ink-muted`; whichever half is alone leads at full size.
- **Transcript line:** time button (terracotta text; filled when current, row tinted), line pair, "Corrected" caption.

## Do's and Don'ts

- Do show the original words first and the English beneath; don't hide the original behind a tab by default.
- Do keep visible keyboard focus on every control (ripple is off globally).
- Don't add shadows or gradients. Pills are only for status and times, never decoration.
- Admin pages: write for someone who isn't technical. Say what to do next in a sentence; keep error codes folded away.
- Don't use the accent for decoration; it marks actions and "you are here".
