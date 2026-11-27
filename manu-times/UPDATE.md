# The Manu Times: hourly update runbook

The Manu Times is a static page (`index.html`) that renders `data/edition.json`.
It is published as an Artifact at https://claude.ai/artifact/TnVFYM8ekEk7TupjVA5WAQ. A scheduled task starts a fresh
session every hour, and that session follows this runbook.

## 1. Get the paper

```bash
git fetch origin claude/loving-dijkstra-8qywnc
git checkout -B claude/loving-dijkstra-8qywnc FETCH_HEAD
```

Work in `manu-times/`. Read `data/edition.json` to see what is already printed
and when (`meta.updated_at`, `meta.update_log`).

## 2. Decide the kind of run

- **Morning edition** (first run after 05:00 UTC, i.e. `meta.date` is not
  today's UTC date): refresh every section, including `opinion` and `research`.
  Pass `--new-day` to the build script.
- **Hourly update** (every other run): refresh only what changed since
  `meta.updated_at`. Always refresh `markets` (the snapshot) while any major
  exchange is open. Leave `opinion` and `research` alone unless a story has
  broken that makes them stale.

## 3. Send out the desks (subagents, in parallel)

Create a raw folder in your scratchpad and launch these subagents together in one
message, each told the current UTC time, the previous `updated_at`, the
sections it owns, the JSON shapes below, and the editorial rules. Each writes
only the sections that need changing to `<raw>/<desk>.json` and validates it with
`python3 -m json.tool`. A desk with nothing new writes no file.

| Desk | Sections |
|---|---|
| News | front, world, us, politics |
| Regions | europe, gulf, asia, africa, americas |
| Money | markets, stocks, business |
| Science and industry | tech, energy, healthcare |
| Opinion (morning only) | opinion |
| Research (morning only) | research |
| Illustrator (morning only) | cartoon |
| Graphics (morning, plus any hour with a big data-heavy story) | explainers |

Run the Graphics desk after the others have filed, telling it to build from their
files plus its own searches, so its numbers match the rest of the paper.

The web-search allowance is shared by every agent in one session (about 200
searches). Tell each desk to cap itself: hourly desks at about 12 searches,
morning desks at about 25.

Each desk loads WebSearch with ToolSearch (`select:WebSearch`) and aggregates
across many outlets (wires, FT, Bloomberg, CNBC, WSJ, BBC, Al Jazeera, Nikkei,
SCMP and regional press).

When a desk replaces a section it writes the whole section, keeping still-current
stories from the printed version and putting new developments first. The front
page's `top_stories` must reflect the biggest stories across all desks; the News
desk reads the other sections in `edition.json` to build it.

### Editorial rules (give these to every desk)

- Original summaries in our own words; never copy article text.
- Neutral, factual wire-service tone; no loaded language. Where something is
  contested, state each side's position fairly, with sources from across the spectrum.
- Every story cites 1 to 3 real sources with URLs the desk actually found.
  Never invent facts, quotes, figures or URLs. Market numbers carry an as-of time.
- Opinion: each debate gives two good-faith, mainstream positions (centre-left
  and centre-right, or two opposed reasonable views), nothing extreme, bylined
  "The Manu Times Opinion Desk", with a "where they agree" bottom line.
- Research: data-led, every figure sourced, competing interpretations and limits stated.

### JSON shapes

```
SECTION = {
  "lead": {"headline", "dek", "dateline", "body": [4-5 paragraphs], "sources": [{"name","url"}]},
  "stories": [{"headline", "summary", "dateline", "sources": [...]}],   // 6
  "briefs": ["one-sentence brief", ...]                                   // 5
}
front    = {"top_stories": [{"headline","summary","section","sources"}] (6),
            "quote_of_day": {"text","who","source"}, "numbers": [{"figure","label"}] (4)}
markets  = SECTION + {"snapshot": [{"name","value","change","asof"}]}
stocks   = SECTION + {"movers": [{"ticker","name","move","why","asof"}]}
opinion  = {"editorial": {"headline","body"}, "debates": [{"topic","question","context",
            "views": [{"label","lean","headline","body"}] (2), "bottom_line", "sources"}] (4)}
cartoon  = {"title","caption","alt","story","section","svg"}   // single-panel pen-and-ink editorial cartoon;
            // gentle, non-partisan, no caricatures of real people; colours only via
            // classes ink / paper / tint / line / line-tint (see art/vignettes.json for the style)
explainers = {"items": [{"id","section","title","dek","sources",
            "slides": [{"kicker","title","text","visual"}] (5-7)}]}
            // visual is one of: {"type":"stat","value","label","sub"}
            //   {"type":"bar","unit","items":[{"label","value","highlight"}]}
            //   {"type":"line","unit","series":[{"name","points":[{"x","y"}]}]}   (real series only)
            //   {"type":"timeline","events":[{"date","text"}]}
            //   {"type":"compare","left":{"title","points"},"right":{"title","points"}}
research = {"pieces": [{"headline","dek","theme","key_findings","body","methodology",
            "data": [{"label","value","unit"}] (optional), "sources"}] (3)}
```

## 4. Print

```bash
python3 manu-times/scripts/build_edition.py <raw> --note "One line on what changed"   # add --new-day for the morning edition
```

The note appears in the front page's "Latest Updates" column; write it for a reader
(for example "Markets: European close; Gulf: OPEC+ meeting outcome").

## 5. Publish

1. Commit `manu-times/data/edition.json` and push to `claude/loving-dijkstra-8qywnc`
   (on a rejected push, fetch and merge, then push again).
2. Republish the Artifact: call the Artifact tool with `url` https://claude.ai/artifact/TnVFYM8ekEk7TupjVA5WAQ,
   `file_path` `manu-times/index.html` and
   `files: {"data/edition.json": "manu-times/data/edition.json", "art/vignettes.json": "manu-times/art/vignettes.json"}`. If it asks you
   to read the artifact first, do so, then publish again.

Open copies of the page pick up the new edition by themselves within ten minutes.
