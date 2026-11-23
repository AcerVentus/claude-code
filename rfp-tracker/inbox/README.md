# Inbox

Drop a lead here and the next run files it. Use it for anything the automatic sources cannot see:
a LinkedIn post in your own feed, a tip from a vendor, a bidders list from a paid service you subscribe to,
an invitation from the ADNOC Commercial Directory.

After a run, processed files move to `inbox/processed/`.

## Quickest: a text file

Save any `.md` or `.txt` file. The first line is the headline. Optional `key: value` lines follow. The rest is free text.

```
Bab Gas Cap main plant: bidders list
project: Bab Gas Cap development
stage: tender
type: EPC
bidders: Saipem, Tecnicas Reunidas, Petrofac
deadline: 2026-12-15
source: Contact at a vendor
https://www.linkedin.com/posts/...
Heard at ADIPEC that four groups were invited.
```

Keys: `project`, `client`, `stage` (`planned`, `tender`, `bid_evaluation`, `awarded`, `execution`),
`type` (`pre-FEED`, `FEED`, `PMC`, `engineering`, `EPC`, `EPCM`, `framework`, `supply`, `services`),
`bidders` (comma-separated), `winner`, `value` (US dollars), `deadline`, `date`, `source`.

Use the project name exactly as it appears in `config/watchlist.toml` to file the lead under that project.
Anything you state overrides what the tracker would have guessed from the wording.

## One command

```bash
python3 -m rfp_tracker add --title "ADNOC Offshore invites bids for Umm Shaif FEED" --stage tender --type FEED --url "https://..."
```

## Several leads: a JSON file

A list of objects with the same keys (`contract_type` instead of `type`, `value_usd` instead of `value`),
plus `title`, `url`, `text`, `publisher`, `published`, `note`, and `kind` (`manual` or `research`).
The daily research pass writes its findings this way.
