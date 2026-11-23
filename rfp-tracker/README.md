# ADNOC enquiry tracker

A daily watch on new and upcoming ADNOC group enquiries, built for an engineering consultancy.
Each morning it answers three questions:

1. **What is new on the market?** Tenders issued, bids submitted, awards, and plans that come before a tender.
2. **Who should we approach?** The contractors bidding for or winning each package, and the firms hiring for ADNOC work.
3. **What is coming?** A forward look and a pipeline of every tracked project by stage.

Today's digest is always at [`digests/latest.md`](digests/latest.md). The full pipeline opens in Excel from
[`data/pipeline.csv`](data/pipeline.csv).

## The idea

ADNOC's own tender portal is closed to the public, so the tracker reads the traces an enquiry leaves elsewhere:

| Trace | What it tells you | Source |
|---|---|---|
| Trade-press headlines | A tender was issued, extended, bid or awarded; who won | Google News and Bing News search feeds (MEED, Upstream, Oil & Gas Middle East, Zawya, AGBI, TradeArabia and others) |
| Job adverts that name ADNOC work | Who is staffing a bid (proposal and estimation roles) or a won job (FEED, PMC, lead engineers) | LinkedIn public job search, signed out |
| Your own leads | Bidders lists, LinkedIn posts in your feed, vendor tips, portal invitations | The [`inbox/`](inbox/README.md) folder |
| Daily research | Bidders, deadlines and values the headlines leave out | Web searches by the daily Claude run, saved through the inbox |

Work reaches a consultancy by two routes, and the advice follows them:

- **FEED, pre-FEED, PMC and study packages** are bid direct to the ADNOC company. The tracker points you at the client:
  confirm prequalification, get on the bidders list.
- **EPC packages** are bid by main contractors, who buy bid-phase and detailed engineering. The tracker points you at
  the **bidders** while the tender is open, and at the **winner** in the weeks after award.

## How it works

```
 sources                    classify                     register                    outputs
 ───────                    ────────                     ────────                    ───────
 news feeds   ─┐            client (ADNOC company)       one opportunity             digests/YYYY-MM-DD.md
 LinkedIn jobs ├─► signal ─► project, stage, type   ─►   per project or story   ─►   digests/latest.md
 inbox leads  ─┘            firms named, value           stage, firms and roles      data/pipeline.csv
                            relevance score              who to approach, and why    data/opportunities.json
```

- **Signals** are single facts: one headline, one advert, one lead. Every kept signal is appended to `data/signals.jsonl`.
- **The register** (`data/opportunities.json`) groups signals into opportunities. It is rebuilt from the signal log on
  every run, so nothing is lost when you rename a project or add an alias.
- **Stages:** planned → out to tender → bids in → awarded → in execution.
- **Roles:** each firm on an opportunity is a bidder, winner, contractor, hiring, or just named.
- **Score:** client + stage + contract type + value + your focus sectors, minus noise (earnings, LNG sales, football).
  85 and over is High priority, 65 and over Medium. The parts of each score are stored with the signal.

The rules are plain tables in [`rfp_tracker/extract.py`](rfp_tracker/extract.py), and the advice is in
[`rfp_tracker/approach.py`](rfp_tracker/approach.py). There is no model in the pipeline itself: the same input gives the
same output.

## The daily update

A scheduled Claude task runs each morning (Abu Dhabi time) and follows [`DAILY_RUN.md`](DAILY_RUN.md):

1. runs the collectors and builds the day's digest;
2. researches the gaps: bidders and deadlines for open tenders, and anything new;
3. files what it found, commits the day's data to this repository, and sends you the briefing.

You can also run it yourself at any time:

```bash
cd rfp-tracker
```

```bash
python3 -m rfp_tracker run
```

It needs Python 3.11 or newer and nothing else. A full run takes 5 to 12 minutes, most of it waiting politely between
LinkedIn requests.

| Command | What it does |
|---|---|
| `python3 -m rfp_tracker run` | Collect from every source, update the register, write today's digest |
| `python3 -m rfp_tracker run --backfill 30` | The same, asking the news feeds for the last 30 days |
| `python3 -m rfp_tracker run --skip linkedin` | Leave a source out (`news`, `linkedin`, `inbox`) |
| `python3 -m rfp_tracker rebuild` | Re-read every stored signal with the current rules and watchlist |
| `python3 -m rfp_tracker add --title "..."` | File a lead of your own (see [`inbox/README.md`](inbox/README.md)) |
| `python3 -m rfp_tracker show "bab gas"` | Print an opportunity with all its evidence |
| `python3 -m unittest discover -s tests` | Run the tests |

## Make it yours

| File | Edit it to |
|---|---|
| [`config/profile.toml`](config/profile.toml) | Name your consultancy, list your services and focus sectors, say which contract types you bid as prime, set how quiet the digest is |
| [`config/watchlist.toml`](config/watchlist.toml) | Add ADNOC companies, named projects, contractors, consultants and competitors |
| [`config/sources.toml`](config/sources.toml) | Change the news and LinkedIn search queries, or switch a source off |

After any edit, run `python3 -m rfp_tracker rebuild`.

Two habits make the tracker much better:

- **Name projects.** Leads listed under "Other leads" in the digest are stories the tracker could not tie to a project.
  Add a `[[project]]` entry with the words the press uses, and every past and future signal files under it.
- **Feed the inbox.** Bidders lists are usually behind paywalls (MEED, Upstream). If you subscribe, paste the names into
  an inbox file and the digest turns them into approach targets at once.

## What it cannot see

- **Tenders issued only inside the ADNOC Commercial Directory or SAP Ariba.** If you are registered, add your invitations
  through the inbox.
- **Paywalled article text.** The tracker reads headlines and search summaries. It never claims a bidder it has not seen named.
- **LinkedIn posts and profiles.** Only public job adverts are read, signed out, at a few dozen requests a day, and the
  tracker stops when LinkedIn says to slow down. LinkedIn's terms discourage automated reading even of public pages; set
  `enabled = false` under `[linkedin]` in `config/sources.toml` if you would rather not. The "find the people" links in the
  digest open a LinkedIn search in your own browser; the tracker never opens them.
- **Certainty.** A headline or an advert is a lead. Check the source before you call anyone.

## Where this goes next

| Step | What it adds |
|---|---|
| Paid feed | A MEED Projects or similar subscription, exported to the inbox, gives named bidders and budgets for most packages |
| Bid decisions | A go / no-go field and an owner per opportunity, kept in a small annotations file the rebuild preserves |
| Contacts | A contact sheet per contractor (who you know, last touch), joined to the approach list |
| Win / loss | Recording which approaches led to an enquiry, to tune the scoring towards what converts |
| Dashboard | A live page over `data/opportunities.json`, next to the Competitor Hiring Watch |

## Layout

```
rfp-tracker/
  config/          watchlist, sources, your profile
  rfp_tracker/     the pipeline (Python standard library only)
  inbox/           leads waiting to be filed; processed/ holds the ones already read
  data/            signals.jsonl (log), opportunities.json (register), pipeline.csv, last_run.json, state.json
  digests/         one digest per day, plus latest.md
  tests/           unit tests
  DAILY_RUN.md     what the scheduled daily run does
```
