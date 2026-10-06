---
name: Spät
description: Delay forecasts for trains through Munich, shown as odds with receipts.
colors:
  paper: "#f5f3ee"
  paper-shade: "#efece5"
  canvas: "#e4e1d9"
  surface: "#ffffff"
  sunken: "#eae7e0"
  track: "#edeae3"
  line: "#dad6cd"
  rail: "#c9c5bb"
  ink: "#15171c"
  muted: "#5e6169"
  pewter: "#8c8f96"
  leaf-green: "#2f8f5b"
  mustard: "#e5b340"
  saffron: "#d9971a"
  paprika: "#d0702a"
  brick: "#c8412e"
  chili: "#9e2f20"
  oxblood: "#6e1f15"
  honey: "#e0a93a"
typography:
  display:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "58px"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  figure:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "96px"
    fontWeight: 700
    lineHeight: 0.85
    letterSpacing: "-0.05em"
  headline:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
  body:
    fontFamily: "Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  data:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "17px"
    fontWeight: 700
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "0.06em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "22px"
  xl: "36px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "11px 16px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "11px 16px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
  segmented:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "4px"
  segmented-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "6px"
    padding: "8px 10px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "20px 22px"
  train-tag:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    padding: "2px 7px"
---

# Design System: Spät

## Overview

**Creative North Star: "The Forecaster's Ledger"**

Spät reads like the notebook of a careful analyst who shows their working. Every forecast is a set of odds written in ink on warm paper, ruled into columns, with its sources and its track record kept right alongside. The mood is **precise, candid and unhurried**. Nothing shouts, nothing is decorated for its own sake, and doubt is written down rather than hidden. Big monospaced figures carry the answer. Everything else steps back so the numbers lead.

Density is moderate, like a ledger page rather than a cockpit. Departure boards, journey rails and stat strips use generous rows, hairline rules and tabular figures, so a rider can scan them and an engineer can audit them. Colour is held back almost entirely for meaning. The one expressive register is the Ripening scale, which runs from leaf green to oxblood and says how late a train will probably be.

It must never pass for an official Deutsche Bahn product (no DB corporate red as a brand colour, no Navigator look), a generic SaaS dashboard (gradient KPI tiles, purple accents, glassmorphism), or a neon dark-mode "data" screen.

**Key Characteristics:**
- Warm off-white paper, near-black ink, white surfaces for content
- Monospaced figures for every time, percentage and delay; grotesk for words
- 1px warm-grey rules do the structuring; borders, not shadows
- Colour means delay risk, and nothing else
- Quiet, exact controls with ink-solid primaries and hairline ghosts

## Colors

A warm paper-and-ink neutral base, with one meaningful ramp that ripens from green to oxblood as the delay grows.

In code (`src/styles.css`), each colour below is a primitive custom property with the same name (`--brick`, `--pewter`, …). Components use the role layer on top of it:
- `--good` / `--warn` / `--bad` for the contract's tones;
- `--b0`…`--b6` and `--cancelled` for the delay buckets;
- `--split-mid` for the honey segment;
- `--neutral` for pewter.

In TypeScript, use `BUCKET_COLORS`, `SPLIT_COLORS` and `splitLabel()` from `components/ui.tsx` rather than listing colours inline.

### Primary
- **Ledger Ink** (`ink`): text, primary buttons, selected chips, active nav underline, chart baselines, focus ring. Ink is the only "brand" colour. It is the action colour and the emphasis colour at once.

### Secondary: the Ripening scale (delay buckets)
Mapped in order to the buckets `≤2 | 3–5 | 6–10 | 11–15 | 16–30 | 31–60 | >60`:
- **Leaf Green** (`leaf-green`): on time (≤2 min). Also the `good` tone.
- **Mustard** (`mustard`): 3–5 min.
- **Saffron** (`saffron`): 6–10 min. Also the `warn` tone (warning labels, risky signals).
- **Paprika** (`paprika`): 11–15 min.
- **Brick** (`brick`): 16–30 min. Also the `bad` tone: the hero "late" figure, errors, missed limits. Brick is a rust red, deliberately not DB red.
- **Chili** (`chili`): 31–60 min.
- **Oxblood** (`oxblood`): over 60 min.
- **Honey** (`honey`): the merged "3–10 min" segment in the three-part split bars on departure boards.

### Neutral
- **Paper** (`paper`): page background, top bar, tab bar, PWA theme colour.
- **Paper Shade** (`paper-shade`): the trip bar band and row hover on wide boards. A paper one step darker.
- **Canvas** (`canvas`): segmented-control troughs inside the trip bar, empty meter tracks.
- **Surface** (`surface`): cards, fields, selected stops and connections, dropdowns, tooltips.
- **Sunken** (`sunken`): segmented-control troughs, notices, empty split-bar tracks, skeleton base.
- **Track** (`track`): chart gridlines, stop hover, accuracy bands, skeleton highlight.
- **Line** (`line`): every hairline rule and card border.
- **Rail** (`rail`): the journey rail, reference lines, dashed transfer boxes, inactive step dots.
- **Muted** (`muted`): secondary text, labels, the status line, inactive nav.
- **Pewter** (`pewter`): cancelled, replayed history, step numbers and arrows. It sits deliberately outside the Ripening scale.

### Named Rules
**The Colour Means Delay Rule.** Ripening colours are reserved for delay risk and its tones (good / warn / bad). Never use them for decoration, category coding or brand accent.

**The Ink Is The Accent Rule.** Interactive emphasis is always ink on paper. If something needs to look selected or primary, invert it to ink. Don't add a hue.

**The Not-DB-Red Rule.** The "bad" tone is Brick, a warm rust. No pure signal red, and no red used as a brand surface.

## Typography

**Display / Body Font:** Schibsted Grotesk (with system-ui)
**Figure / Label Font:** JetBrains Mono (with ui-monospace)

**Character:** a newsy, slightly condensed grotesk for the words, paired with a technical mono for every number. The pairing reads like ruled ledger columns: prose on the left, figures in tabular mono on the right.

### Hierarchy
- **Display** (700, 58px; 64px wide, 46px under 1100px, 34px on phones; line-height 1.02; −0.035em; balanced wrap): the start-screen question only.
- **Figure** (mono 700, 96px; 64px on phones; line-height 0.85; −0.05em): the single answer on Estimate. A sibling at 88px/52px carries the start screen's "late" figure.
- **Headline** (700, 32px; 26px on phones; −0.02em): page titles. Step titles in How it works use 22px.
- **Title** (700, 17px): section titles. Card titles use 600 at 15px.
- **Body** (400, 15px, line-height 1.45–1.5; measure capped around 680–760px): explanations, notes, footers (12–13px for metadata).
- **Data** (mono 700, 14–17px; stat values 22–28px): board times, expected delays, percentages, stat strips, train tags.
- **Label** (mono 500, 11–12px, 0.06em, uppercase): eyebrows, column heads, why-cell titles, axis text.

### Named Rules
**The Numbers Are Mono Rule.** Every time, percentage, minute count and train number is set in JetBrains Mono. Words never are, except uppercase labels.

**The One Big Figure Rule.** Each screen has at most one display-scale figure: the answer. Everything else is data-size.

## Layout

Full-bleed app shell: a sticky 60px top bar ruled off with a hairline, main content, a hairline footer carrying the attribution, and a fixed bottom tab bar under 860px that replaces the top nav and status line. Content pads 26–36px on desktop and 16px on phones.

The start screen is one set of blocks rearranged with CSS grid areas at three sizes:
- **Phone (≤860px):** a single column.
- **Default:** a hero beside the late figure and departures, with the network outlook along the bottom.
- **Wide (≥1400px):** capped at about 1440–1520px and centred, with the top bar padded to match.

Other screens use two-column grids with uneven ratios (1.25 : 1, 1.6 : 1, content : 280px aside) that collapse to one column under 1100px.

Tabular content is laid out with fixed-width grid columns (time, train tag, destination, split bar, expected delay). On phones it reflows into two-row grid areas rather than scrolling sideways. Rhythm sits on a loose 4px base: gaps of 8, 10, 14, 18 and 22px inside components, and 36–44px between major sections.

**The Ruled Columns Rule.** Lists are rows separated by 1px `line` rules, with a 2px `ink` rule under the column head. Don't use zebra striping or spaced-out row cards.

## Elevation & Depth

Flat today, though not forbidden to lift. Depth comes from tonal layering (paper → white surface → sunken troughs) and hairline borders. Only layers that float above the page carry a shadow. Light elevation may be introduced later if a surface genuinely needs it, but it should stay ambient, never decorative.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 12px 40px rgba(0,0,0,0.08)`): station-picker dropdowns and chart tooltips only.

### Named Rules
**The Borders Before Shadows Rule.** Separate things with a `line` hairline or a tonal step first. A shadow means "this floats over the page".

## Shapes

Gently rounded, never soft. Controls and fields use 8px corners, cards and stat strips 10px (12px on phones), and train tags, heat cells and split bars a tight 4px. Chips and pills are full capsules. Chart bars round only their top corners (3px).

Recurring silhouettes:
- the journey rail: a 2px vertical line with 10px stop dots;
- the brand mark: an ink ring with a clock hand;
- dashed rail-coloured boxes for transfers;
- 2px dashed ink "ghost" lines for comparison values.

## Components

### Buttons
Quiet and exact.
- **Shape:** gently rounded (8px).
- **Primary:** solid ink with paper text, weight 600–700, 11px × 16px padding (taller in the trip bar and splash search).
- **Ghost:** transparent with a `line` hairline border and ink text.
- **Disabled:** 50% opacity. No hover colour shift.
- **Focus:** 2px ink outline, offset 2px, on every focusable element.

### Chips
- **Style:** capsules with a `line` border, transparent background and 600 weight at 14px.
- **Selected:** inverted to an ink fill with paper text (`aria-pressed`).
- **Splash "try" chips:** paper fill. On hover the border turns ink and the fill turns surface.

### Segmented control
A `sunken` trough (8px, 4px inset) with flat buttons. The selected segment becomes a white surface tile with ink text, and unselected segments use muted text. An inline variant sizes to its content.

### Cards / Containers
- **Corner Style:** 10px (12px on phones).
- **Background:** surface white on paper.
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px `line`.
- **Internal Padding:** 20–22px (14px on phones). Stat strips divide their cells with internal hairlines instead of gaps.

### Inputs / Fields
- **Style:** white surface, 1px `line` border, 8px radius. A small muted label sits above a 16px, 600-weight value inside the same box.
- **Focus:** the border turns ink. Inside the joined trip-bar field group, focus shows as a 2px ink underline.
- **Combobox list:** a floating white panel with the Float shadow. The active option is tinted `sunken`.

### Navigation
- **Top bar:** muted 15px/500 links with a 2px ink underline when active; ink on hover. The right side carries a mono status line (model · data freshness · live state).
- **Mobile:** a fixed paper tab bar of five 12px/600 labels, ink when active, padded for the safe area.

### Train Tag (signature)
A train number such as `ICE 514` in mono 700, inside a 1.5px ink outline with 4px corners. It's the ledger's line-item marker, used everywhere a train is named.

### Delay Spread Chart (signature)
One column per bucket. The percentage sits on top in mono, a bar in the bucket's Ripening colour fills a 180px well (110px on phones), and the bucket label sits underneath in muted mono. The chart sits on a 1px ink baseline, and cancellation is stated beside it in text.

### Split Bar (signature)
The forecast compressed into a strip: on time (leaf green) / 3–10 (honey) / over 10 (brick), on a `sunken` track. It's 22px tall with mono percentages on departure boards and a 4–6px sliver on the start screen.

### Journey Rail (signature)
A five-column grid row: scheduled time, a rail with stop dots coloured by risk, the stop name, the live delay in muted mono, and the forecast in mono 700. The selected stop lifts to a white surface with a hairline border.

## Do's and Don'ts

### Do:
- **Do** set every number in JetBrains Mono, and give each screen one display-scale answer at most.
- **Do** colour only by delay risk, in Ripening order: leaf green (≤2) through oxblood (>60), with pewter for cancelled.
- **Do** structure with 1px `line` rules and paper → surface tonal steps before reaching for a shadow.
- **Do** show selection by inverting to ink (chips, segments, current stop and connection outlines).
- **Do** keep the attribution footer ("Delay data © Deutsche Bahn AG (CC BY 4.0)… Forecasts are estimates, not guarantees.") on every screen.

### Don't:
- **Don't** use DB corporate red as a brand colour, or anything that reads as DB Navigator or an official DB product.
- **Don't** build generic SaaS-dashboard furniture: gradient KPI tiles, purple accents, glassmorphism.
- **Don't** go neon or default to a dark "data terminal" look. The ledger is ink on warm paper.
- **Don't** use Ripening colours for decoration, categories or emphasis unrelated to delay.
- **Don't** add shadows to cards or rows at rest. The Float shadow is for dropdowns and tooltips.
