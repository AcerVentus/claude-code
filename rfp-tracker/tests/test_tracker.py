"""Run from the rfp-tracker folder:  python3 -m unittest discover -s tests"""

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from rfp_tracker import __main__ as cli  # noqa: E402
from rfp_tracker import approach, config, extract, register, sources  # noqa: E402

CFG = config.load(ROOT / "config")


def signal(title, published="2026-11-18", kind="news", **extra):
    raw = {"id": "t-" + title[:40], "kind": kind, "source": "test", "publisher": "Test", "title": title, "url": "https://example.com/a",
           "published": published, "text": ""}
    raw.update(extra)
    result = extract.analyse(raw, CFG)
    result["found"] = published
    return result


class Aliases(unittest.TestCase):
    def test_plain_alias_ignores_case_and_matches_whole_words(self):
        pattern = config.compile_aliases(["Bab Gas Cap"])
        self.assertTrue(pattern.search("the bab gas cap project"))
        self.assertFalse(pattern.search("Rebab Gas Capital"))

    def test_case_sensitive_alias(self):
        pattern = config.compile_aliases(["cs:NEB"])
        self.assertTrue(pattern.search("ADNOC Onshore NEB Phase II"))
        self.assertFalse(pattern.search("a nebulous plan"))
        self.assertFalse(pattern.search("neb"))

    def test_apostrophe_spellings(self):
        pattern = config.compile_aliases(["TA'ZIZ"])
        self.assertTrue(pattern.search("TA’ZIZ methanol plant"))
        self.assertTrue(pattern.search("ta'ziz"))


class Parsing(unittest.TestCase):
    def test_google_news_strips_the_publisher_from_the_headline(self):
        xml = """<rss><channel><item><title>Contractors submit technical bids for Bab Gas Cap project - MEED</title>
        <link>https://news.google.com/rss/articles/abc</link><pubDate>Tue, 17 Nov 2026 22:30:00 GMT</pubDate>
        <source url="https://www.meed.com">MEED</source></item></channel></rss>"""
        (item,) = sources.parse_google_news(xml)
        self.assertEqual(item["title"], "Contractors submit technical bids for Bab Gas Cap project")
        self.assertEqual(item["publisher"], "MEED")
        self.assertEqual(item["published"], "2026-11-18")  # 22:30 GMT is the next day in Abu Dhabi

    def test_bing_news_unwraps_the_link_and_keeps_the_summary(self):
        xml = """<rss xmlns:News="https://www.bing.com/news/search?q=x&amp;format=rss"><channel><item>
        <title>ADNOC Gas receives technical bids</title>
        <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fexample.com%2fstory&amp;c=1</link>
        <description>Saipem and Petrofac are among the bidders.</description><pubDate>Tue, 17 Nov 2026 08:00:00 GMT</pubDate>
        <News:Source>Example Press</News:Source></item></channel></rss>"""
        (item,) = sources.parse_bing_news(xml)
        self.assertEqual(item["url"], "https://example.com/story")
        self.assertEqual(item["publisher"], "Example Press")
        self.assertIn("Petrofac", item["text"])

    def test_same_headline_from_both_aggregators_has_one_id(self):
        a = sources.parse_google_news("<rss><channel><item><title>Jereh wins $392m Bu Hasa job - MEED</title><source>MEED</source></item></channel></rss>")
        b = sources.parse_bing_news("<rss><channel><item><title>Jereh wins $392m Bu Hasa job</title></item></channel></rss>")
        self.assertEqual(a[0]["id"], b[0]["id"])

    def test_linkedin_cards_and_detail(self):
        html = """<!DOCTYPE html><li><div class="base-card" data-entity-urn="urn:li:jobPosting:4484207117">
        <h3 class="base-search-card__title">  PMC Lead Piping Engineer (Early MP) </h3>
        <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="x"> Wood </a></h4>
        <span class="job-search-card__location"> Abu Dhabi, United Arab Emirates </span>
        <time class="job-search-card__listdate" datetime="2026-11-18">5 days ago</time></div></li>"""
        (card,) = sources.parse_linkedin_cards(html)
        self.assertEqual(card, {"job_id": "4484207117", "title": "PMC Lead Piping Engineer (Early MP)", "employer": "Wood",
                                "location": "Abu Dhabi, United Arab Emirates", "published": "2026-11-18"})
        detail = '<div class="show-more-less-html__markup relative overflow-hidden"><strong>Role</strong><br>PMC for an ADNOC Offshore project</div>'
        self.assertEqual(sources.parse_linkedin_detail(detail), "Role PMC for an ADNOC Offshore project")

    def test_excerpt_keeps_only_the_text_around_a_mention(self):
        text = "x " * 500 + "experience on ADNOC Onshore projects is required" + " y" * 500
        cut = sources.excerpt(text, config.compile_aliases(["ADNOC Onshore"]), width=30)
        self.assertIn("ADNOC Onshore", cut)
        self.assertLess(len(cut), 120)


class Classifier(unittest.TestCase):
    def test_stages(self):
        cases = {
            "Bab gas cap: contractors submit technical bids for $8bn ADNOC Gas main plant": "bid_evaluation",
            "Mannesmann Energy Wins ADNOC Onshore NEB Phase II EPC Contract": "awarded",
            "ADNOC Onshore allows extra time for Rumaitha and Shanayel field facilities prices": "tender",
            "ADNOC extends Bu Hasa oil recovery bid deadline": "tender",
            "Adnoc set to award offshore contract next month": "bid_evaluation",
            "Wison Breaks Ground on $3.9bn ADNOC Gas Habshan Processing Train": "execution",
            "ADNOC approves Ruwais gas development plan": "planned",
            "Adnoc Onshore hires Mannesmann for phase two of its Northeast Bab upgrade": "awarded",
            "ADNOC hires new chief financial officer": "",
        }
        for title, stage in cases.items():
            with self.subTest(title=title):
                self.assertEqual(extract.detect_stage(title), stage)

    def test_values(self):
        self.assertEqual(extract.detect_value_usd("wins $392m Bu Hasa project"), 392e6)
        self.assertEqual(extract.detect_value_usd("for $8bn ADNOC Gas main plant"), 8e9)
        self.assertEqual(extract.detect_value_usd("$2.697 billion in awards"), 2.697e9)
        self.assertAlmostEqual(extract.detect_value_usd("an AED 3.6725 billion contract"), 1e9)
        self.assertIsNone(extract.detect_value_usd("totalling about NT$89 Billion"))

    def test_award_headline(self):
        s = signal("Mannesmann Energy Wins ADNOC Onshore NEB Phase II EPC Contract at ADIPEC 2026")
        self.assertEqual((s["client"], s["stage"], s["contract_type"]), ("ADNOC Onshore", "awarded", "EPC"))
        self.assertEqual(s["project"], "North East Bab (NEB) facilities upgrade")
        self.assertEqual(s["parties"], {"Mannesmann Energy": "winner"})
        self.assertGreaterEqual(s["score"], 85)

    def test_unlisted_winner_is_read_from_the_headline(self):
        s = signal("Acme Process Systems secures ADNOC Gas compression package")
        self.assertEqual(s["parties"], {"Acme Process Systems": "winner"})

    def test_specific_package_is_filed_before_its_parent_project(self):
        s = signal("Adnoc Onshore grants extra time for Bab gas cap well tie-in bids")
        self.assertEqual(s["project"], "Bab Gas Cap well tie-ins")

    def test_noise_scores_below_the_keep_line(self):
        minimum = CFG.profile["min_score"]
        for title in (
            "TotalEnergies signs five-year LNG deal with ADNOC Gas",
            "Adnoc Gas's 3Q net income doubles",
            "Al Ain beat Sharjah in ADNOC Pro League",
            "Borouge targets 13.8 MMtpy of operating capacity by 2030",
            "Saipem wins offshore contract in Qatar",
        ):
            with self.subTest(title=title):
                self.assertLess(signal(title)["score"], minimum)

    def test_forward_look_is_flagged_and_kept(self):
        s = signal("Adnoc prepares new wave of oil and gas tenders for 2027")
        self.assertTrue(s["outlook"])
        self.assertGreaterEqual(s["score"], CFG.profile["min_score"])

    def test_job_advert(self):
        s = signal("Mechanical Proposal Engineer", kind="job", publisher="Petrofac",
                   text="Prepare proposals for ADNOC Onshore EPC tenders including Bab Gas Cap.")
        self.assertEqual((s["job_phase"], s["client"], s["project"]), ("bidding", "ADNOC Onshore", "Bab Gas Cap development"))
        self.assertEqual(s["parties"], {"Petrofac": "hiring"})
        self.assertEqual(s["stage"], "")  # an advert never sets a project's stage

    def test_stated_fields_override_the_rules(self):
        s = signal("Bidders list out", kind="research", stated={"project": "Bab Gas Cap development", "stage": "tender",
                                                                 "bidders": ["Saipem", "Petrofac"], "contract_type": "EPC"})
        self.assertEqual(s["stage"], "tender")
        self.assertEqual(s["parties"], {"Saipem": "bidder", "Petrofac": "bidder"})


class Register(unittest.TestCase):
    def build(self, *signals):
        return register.build(list(signals), CFG, "2026-11-23")

    def test_one_award_told_by_three_outlets_is_one_opportunity(self):
        opportunities, _ = self.build(
            signal("Mannesmann Energy Wins ADNOC Onshore NEB Phase II EPC Contract"),
            signal("Mannesmann Energy secures ADNOC Onshore facilities upgrade contract", published="2026-11-19"),
            signal("Adnoc Onshore hires Mannesmann for phase two of its Northeast Bab upgrade", published="2026-11-22"),
        )
        self.assertEqual(len(opportunities), 1)
        self.assertEqual(opportunities[0]["stage"], "awarded")
        self.assertEqual(opportunities[0]["parties"]["Mannesmann Energy"]["role"], "winner")

    def test_unrelated_stories_stay_apart(self):
        opportunities, _ = self.build(
            signal("Acme secures ADNOC Gas compression package"),
            signal("Zenith Contracting secures ADNOC Offshore jacket package"),
        )
        self.assertEqual(len(opportunities), 2)

    def test_title_case_headlines_do_not_merge_on_shared_ordinary_words(self):
        opportunities, _ = self.build(
            signal("Borouge International Taps Acme For Major Plant Expansion Upgrade"),
            signal("Borouge Prepares Tender For Major Storage Expansion Upgrade", published="2026-11-19"),
        )
        self.assertEqual(len(opportunities), 2)

    def test_stage_follows_the_newest_news_and_keeps_other_live_packages(self):
        opportunities, _ = self.build(
            signal("$2bn+ Bu Hasa EOR Project Opens Bidding", published="2026-11-04"),
            signal("ADNOC Onshore receives technical bids for Bu Hasa-Shuaiba EOR pipeline package", published="2026-11-11"),
        )
        (opp,) = opportunities
        self.assertEqual(opp["stage"], "bid_evaluation")
        self.assertEqual([a["stage"] for a in opp["also"]], ["tender"])

    def test_jobs_without_a_project_are_returned_separately(self):
        opportunities, loose = self.build(signal("Lead Process Engineer", kind="job", publisher="Worley", text="ADNOC Gas experience"))
        self.assertEqual((len(opportunities), len(loose)), (0, 1))

    def test_changes(self):
        first = signal("Contractors prepare bids for Bab Gas Cap project", published="2026-11-01")
        before, _ = self.build(first)
        after, _ = self.build(
            first,
            signal("Contractors submit technical bids for Bab Gas Cap project", kind="research",
                   stated={"bidders": ["Saipem"], "stage": "bid_evaluation"}),
            signal("Zenith Contracting secures ADNOC Offshore jacket package"),
        )
        delta = register.changes(before, after)
        self.assertEqual(len(delta["new"]), 1)
        self.assertEqual(delta["stage"], [{"id": "p-bab-gas-cap-development", "from": "tender", "to": "bid_evaluation"}])
        self.assertEqual(delta["parties"], [{"id": "p-bab-gas-cap-development", "added": ["Saipem"]}])


class Approach(unittest.TestCase):
    def advice(self, *signals):
        opportunities, _ = register.build(list(signals), CFG, "2026-11-23")
        return approach.advise(opportunities[0], CFG, approach.usual_bidders(list(signals), CFG))

    def test_epc_tender_points_at_the_bidders(self):
        result = self.advice(signal("Bab Gas Cap EPC tender: bidders named", kind="research",
                                    stated={"stage": "tender", "bidders": ["Saipem", "Petrofac", "Makamin"]}))
        self.assertEqual([t["org"] for t in result["targets"]], ["Saipem", "Petrofac"])
        self.assertTrue(all(t["urgency"] == 1 for t in result["targets"]))
        self.assertIn("Competitor in the race: Makamin.", result["notes"])
        self.assertIn("linkedin.com/search/results/people", result["targets"][0]["links"][0]["url"])

    def test_epc_award_points_at_the_winner(self):
        result = self.advice(signal("Mannesmann Energy Wins ADNOC Onshore NEB Phase II EPC Contract"))
        self.assertEqual([(t["org"], t["kind"]) for t in result["targets"]], [("Mannesmann Energy", "winner")])

    def test_feed_tender_is_bid_direct_to_the_client(self):
        result = self.advice(signal("ADNOC Offshore invites bids for Umm Shaif FEED contract"))
        self.assertEqual((result["targets"][0]["org"], result["targets"][0]["kind"]), ("ADNOC Offshore", "client"))

    def test_tender_without_named_bidders_says_so(self):
        result = self.advice(signal("ADNOC Onshore allows extra time for Rumaitha and Shanayel EPC prices"))
        self.assertTrue(any("Bidders are not named" in note for note in result["notes"]))


class EndToEnd(unittest.TestCase):
    def test_inbox_lead_reaches_the_digest(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(tmp)
            shutil.copytree(ROOT / "config", root / "config")
            (root / "inbox").mkdir()
            (root / "inbox" / "lead.md").write_text(
                "Bab Gas Cap main plant: bidders list\nstage: tender\ntype: EPC\nbidders: Saipem, Tecnicas Reunidas\n"
                "source: Contact at a vendor\nhttps://example.com/post\nHeard at ADIPEC that four groups were invited.\n",
                encoding="utf-8",
            )
            (root / "inbox" / "more.json").write_text(json.dumps([{"title": "ADNOC Gas to tender Habshan FEED", "kind": "research"}]), encoding="utf-8")
            self.assertEqual(cli.main(["--root", str(root), "run", "--skip", "news,linkedin", "--date", "2026-11-23"]), 0)
            text = (root / "digests" / "2026-11-23.md").read_text(encoding="utf-8")
            self.assertIn("| This week | **Saipem** |", text)
            self.assertIn("**Tecnicas Reunidas**", text)
            self.assertIn("ADNOC Gas to tender Habshan FEED", text)
            self.assertEqual(sorted(p.name for p in (root / "inbox").iterdir()), ["processed"])
            summary = json.loads((root / "data" / "last_run.json").read_text(encoding="utf-8"))
            self.assertEqual(len(summary["new_opportunities"]), 2)
            # A second run the same day changes nothing and still reports the day's news as new.
            self.assertEqual(cli.main(["--root", str(root), "run", "--skip", "news,linkedin", "--date", "2026-11-23"]), 0)
            self.assertEqual(len(json.loads((root / "data" / "last_run.json").read_text(encoding="utf-8"))["new_opportunities"]), 2)
            # The next day nothing is new.
            self.assertEqual(cli.main(["--root", str(root), "run", "--skip", "news,linkedin", "--date", "2026-11-24"]), 0)
            self.assertEqual(json.loads((root / "data" / "last_run.json").read_text(encoding="utf-8"))["new_opportunities"], [])


if __name__ == "__main__":
    unittest.main()
