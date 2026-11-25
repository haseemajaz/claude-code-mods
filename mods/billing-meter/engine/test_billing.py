"""Tests for billing.py on synthetic transcripts with known answers. Run: python test_billing.py"""
import datetime as dt
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import billing  # noqa: E402

UTC = dt.timezone.utc
T0 = dt.datetime(2026, 10, 6, 9, 0, tzinfo=UTC)  # 09:00 UTC on a Tuesday


def iso(minutes: float) -> str:
    return (T0 + dt.timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def prompt(m, text, cwd="C:/work"):
    return {"type": "user", "timestamp": iso(m), "cwd": cwd, "message": {"role": "user", "content": text}}


def tool(m, path=None, cwd="C:/work"):
    content = [{"type": "tool_use", "name": "Edit", "input": {"file_path": path}}] if path else [{"type": "text", "text": "ok"}]
    return {"type": "assistant", "timestamp": iso(m), "cwd": cwd, "message": {"role": "assistant", "content": content}}


def result(m):
    return {"type": "user", "timestamp": iso(m), "message": {"role": "user", "content": [{"type": "tool_result", "content": "done"}]}}


CFG = {
    "basis": "engaged", "round_minutes": 15, "busy_gap_minutes": 15, "idle_cap_minutes": 20,
    "words_per_minute": 35, "paste_words": 300, "utc_offset_hours": 0, "timesheets_dir": "", "descriptions": True,
    "projects": [
        {"name": "Alpha", "client": "Alpha Co", "paths": ["projects/alpha"], "keywords": ["\\balpha\\b"], "rate": 100, "currency": "USD", "billable": True},
        {"name": "Beta", "client": "Beta Co", "paths": ["projects/beta"], "keywords": ["beta"], "rate": 0, "billable": True},
        {"name": "Internal", "client": "us", "paths": ["work-log"], "keywords": [], "billable": False, "weak": True},
    ],
}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.logs = os.path.join(self.tmp, "projects", "proj")
        os.makedirs(self.logs)
        billing.LOGS = os.path.join(self.tmp, "projects")
        billing.DATA = os.path.join(self.tmp, "data")
        billing.CACHE = os.path.join(billing.DATA, "cache.json")
        billing.TAGS = os.path.join(billing.DATA, "tags.jsonl")
        billing.CONFIG = os.path.join(billing.DATA, "config.json")
        os.makedirs(billing.DATA)
        self.cfg = json.loads(json.dumps(CFG))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, lines, agent_of=None):
        folder = self.logs if not agent_of else os.path.join(self.logs, agent_of, "subagents")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, name + ".jsonl"), "w", encoding="utf-8") as f:
            for o in lines:
                f.write(json.dumps(o, ensure_ascii=False) + "\n")

    def rows(self, spec="2026-10-06"):
        start, end, _ = billing.parse_range(spec, UTC)
        m = billing.Matcher(self.cfg)
        files = billing.load_events(self.cfg, m, since=None)
        return billing.measure(self.cfg, files, billing.load_tags(), start, end)


class YourTime(Base):
    def test_reading_pause_counts_up_to_cap(self):
        # Claude finishes at minute 10; you answer at 18 (8 min reading), short message.
        self.write("s1", [prompt(0, "fix alpha header"), tool(1, "C:/projects/alpha/a.ts"), result(2), tool(10),
                          prompt(18, "ok ship it"), tool(19, "C:/projects/alpha/a.ts"), tool(20)])
        r = self.rows()[("2026-10-06", "Alpha")]
        # first prompt: no previous Claude event -> typing only (3 words / 35 wpm = ~5 s); second: 8 min reading
        self.assertAlmostEqual(r["you"], 8 * 60 + 3 / 35 * 60, delta=2)
        self.assertEqual(r["prompts"], 2)

    def test_long_pause_is_away_not_work(self):
        self.write("s1", [prompt(0, "alpha"), tool(1, "C:/projects/alpha/a.ts"), tool(2),
                          prompt(120, "back again"), tool(121, "C:/projects/alpha/a.ts")])
        r = self.rows()[("2026-10-06", "Alpha")]
        self.assertLess(r["you"], 4 * 60)  # 3 min allowance on return, not 118 min

    def test_pasted_text_is_not_typing(self):
        big = "<pasted_content id='x'>" + ("word " * 2000) + "</pasted_content> please use this for alpha"
        self.write("s1", [prompt(0, big), tool(1, "C:/projects/alpha/a.ts"), tool(2)])
        r = self.rows()[("2026-10-06", "Alpha")]
        self.assertLess(r["you"], 2 * 60)  # 1 min for the paste + a few words, not 57 min of typing

    def test_long_message_without_tags_counts_as_paste(self):
        self.write("s1", [prompt(0, "alpha " + "word " * 1000), tool(1, "C:/projects/alpha/a.ts"), tool(2)])
        r = self.rows()[("2026-10-06", "Alpha")]
        self.assertLess(r["you"], 4 * 60)


class ClaudeTime(Base):
    def test_busy_gap_splits_spans(self):
        # active 0..10, idle 40 min, active 50..55
        ev = [prompt(0, "alpha")] + [tool(m, "C:/projects/alpha/a.ts") for m in (1, 4, 7, 10)] + \
             [tool(m) for m in (50, 52, 55)]
        self.write("s1", ev)
        r = self.rows()[("2026-10-06", "Alpha")]
        self.assertAlmostEqual(r["claude"], (10 + 5) * 60, delta=1)

    def test_engaged_counts_overlap_once(self):
        # main chat busy 0..10; an agent busy 2..12 on the same project -> engaged 0..12
        self.write("s1", [prompt(0, "alpha")] + [tool(m, "C:/projects/alpha/a.ts") for m in (1, 5, 10)])
        self.write("agent-1", [tool(m, "C:/projects/alpha/b.ts") for m in (2, 6, 12)], agent_of="s1")
        r = self.rows()[("2026-10-06", "Alpha")]
        self.assertAlmostEqual(r["claude"], 10 * 60, delta=1)
        self.assertAlmostEqual(r["agents"], 10 * 60, delta=1)
        self.assertAlmostEqual(r["engaged"], 12 * 60, delta=2)


class Attribution(Base):
    def test_paths_beat_words_and_weak_loses(self):
        # the prompt says beta, the work touched alpha (and the history log) -> Alpha
        self.write("s1", [prompt(0, "do the beta thing"), tool(1, "C:/projects/alpha/a.ts"),
                          tool(2, "C:/work-log/history/log.md"), tool(3, "C:/work-log/x.md"), tool(4)])
        rows = self.rows()
        self.assertIn(("2026-10-06", "Alpha"), rows)
        self.assertNotIn(("2026-10-06", "Internal"), rows)

    def test_words_when_no_paths(self):
        self.write("s1", [prompt(0, "question about beta pricing"), tool(1), tool(3)])
        self.assertIn(("2026-10-06", "Beta"), self.rows())

    def test_follow_up_inherits_previous_turn(self):
        self.write("s1", [prompt(0, "alpha"), tool(1, "C:/projects/alpha/a.ts"), tool(2),
                          prompt(5, "yes go ahead"), tool(6), tool(8)])
        rows = self.rows()
        self.assertEqual(rows[("2026-10-06", "Alpha")]["prompts"], 2)
        self.assertNotIn(("2026-10-06", "Unassigned"), rows)

    def test_tag_overrides_from_its_moment(self):
        self.write("s1", [prompt(0, "alpha"), tool(1, "C:/projects/alpha/a.ts"), tool(2),
                          prompt(10, "more"), tool(11, "C:/projects/alpha/a.ts"), tool(12)])
        with open(billing.TAGS, "w") as f:
            f.write(json.dumps({"session": "s1", "project": "Beta", "at": (T0 + dt.timedelta(minutes=9)).timestamp()}) + "\n")
        rows = self.rows()
        self.assertEqual(rows[("2026-10-06", "Alpha")]["prompts"], 1)
        self.assertEqual(rows[("2026-10-06", "Beta")]["prompts"], 1)

    def test_agent_takes_parent_turn_project(self):
        self.write("s1", [prompt(0, "alpha"), tool(1, "C:/projects/alpha/a.ts"), tool(3)])
        self.write("agent-1", [tool(m) for m in (2, 5, 8)], agent_of="s1")
        self.assertGreater(self.rows()[("2026-10-06", "Alpha")]["agents"], 5 * 60)


class Output(Base):
    def test_rounding_and_amount(self):
        self.write("s1", [prompt(0, "alpha")] + [tool(m, "C:/projects/alpha/a.ts") for m in range(1, 21)])
        rep = billing.build(self.cfg, "2026-10-06", None, None)
        ln = [l for l in rep["lines"] if l["project"] == "Alpha"][0]
        self.assertEqual(ln["billable_h"], 0.5)   # ~20 min engaged rounds up to 30
        self.assertEqual(ln["amount"], 50.0)      # 0.5 h x 100
        self.assertIn("alpha", ln["work"])

    def test_internal_is_not_billed(self):
        self.write("s1", [prompt(0, "update the history"), tool(1, "C:/work-log/history/log.md"), tool(5)])
        rep = billing.build(self.cfg, "2026-10-06", None, None)
        ln = [l for l in rep["lines"] if l["project"] == "Internal"][0]
        self.assertFalse(ln["billable"])
        self.assertEqual(ln["billable_h"], 0.0)

    def test_descriptions_hide_secrets(self):
        # made-up values in real shapes, put together so no scanner reads them here
        key = "ghp_" + "Ab1" * 12
        d = billing.describe(f"use key {key} and mail jo@example.com then DB_PASSWORD=" + "Qx7pLm2vRt9k and "
                             "app_db_pass: " + "Zz9yYx8wWv7u per the recommendations", 40)
        for leak in (key, "jo@example.com", "Qx7pLm2vRt9k", "Zz9yYx8wWv7u"):
            self.assertNotIn(leak, d)
        self.assertIn("DB_PASSWORD=[secret]", d)
        self.assertIn("recommendations", d)  # a long ordinary word is not a key

    def test_day_split_at_midnight(self):
        late = dt.datetime(2026, 10, 6, 23, 55, tzinfo=UTC)
        def at(minutes): return (late + dt.timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")
        lines = [{"type": "user", "timestamp": at(0), "message": {"content": "alpha"}}] + \
                [{"type": "assistant", "timestamp": at(m), "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "C:/projects/alpha/a"}}]}} for m in (1, 5, 9)]
        self.write("s1", lines)
        rows = self.rows("2026-10-06..2026-10-07")
        self.assertAlmostEqual(rows[("2026-10-06", "Alpha")]["claude"], 5 * 60, delta=1)  # 23:55 prompt -> midnight
        self.assertAlmostEqual(rows[("2026-10-07", "Alpha")]["claude"], 4 * 60, delta=1)  # midnight -> 00:04

    def test_cache_appends(self):
        self.write("s1", [prompt(0, "alpha"), tool(1, "C:/projects/alpha/a.ts"), tool(3)])
        self.rows()
        with open(os.path.join(self.logs, "s1.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(tool(6, "C:/projects/alpha/a.ts")) + "\n")
        self.assertAlmostEqual(self.rows()[("2026-10-06", "Alpha")]["claude"], 6 * 60, delta=1)

    def test_ranges(self):
        a, b, label = billing.parse_range("2026-09", UTC)
        self.assertEqual(label, "2026-09-01 to 2026-09-30")
        a, b, label = billing.parse_range("2026-09-22..2026-10-06", UTC)
        self.assertEqual(round((b - a) / 86400), 15)


class NoSetup(Base):
    """No projects configured: the folder a chat ran in is its project."""

    def setUp(self):
        super().setUp()
        self.cfg["projects"] = []

    def test_time_goes_to_the_folder(self):
        self.write("s1", [prompt(0, "fix the header", "C:/code/shop"), tool(1, "C:/code/shop/a.ts", "C:/code/shop"), tool(6, None, "C:/code/shop")])
        self.write("s2", [prompt(30, "write a post", "/home/me/blog"), tool(31, None, "/home/me/blog"), tool(35, None, "/home/me/blog")])
        rows = self.rows()
        self.assertEqual({p for _, p in rows}, {"shop", "blog"})

    def test_folder_time_is_billable_and_the_home_folder_is_not_a_project(self):
        home = billing.HOME
        self.write("s1", [prompt(0, "hello", home), tool(1, None, home), tool(6, None, home)])
        self.assertEqual({p for _, p in self.rows()}, {"Unassigned"})

    def test_a_tag_can_name_any_project(self):
        self.write("s1", [prompt(0, "x", "C:/code/shop"), tool(1, None, "C:/code/shop"), tool(5, None, "C:/code/shop")])
        with open(billing.TAGS, "w") as f:
            f.write(json.dumps({"session": "s1", "project": "Acme", "at": (T0 - dt.timedelta(minutes=1)).timestamp()}) + "\n")
        self.assertEqual({p for _, p in self.rows()}, {"Acme"})

    def test_a_rate_makes_the_project(self):
        import argparse
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            billing.cmd_config(argparse.Namespace(rate=["shop", "80", "EUR"], basis=None, round=None, add_project=None, billable=None),
                               {**self.cfg, "timesheets_dir": self.tmp})
        with open(billing.CONFIG, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["projects"][0]["rate"], 80.0)


class PromptText(Base):
    """Prompt text stays out of the cache and the sheets unless the person asks for it."""

    def setUp(self):
        super().setUp()
        self.cfg.pop("descriptions", None)
        self.write("s1", [prompt(0, "alpha zebrafish invoice"), tool(1, "C:/projects/alpha/a.ts"), tool(9)])

    def cached(self):
        with open(billing.CACHE, encoding="utf-8") as f:
            return f.read()

    def test_not_stored_by_default(self):
        rep = billing.build(self.cfg, "2026-10-06", None, None)
        self.assertNotIn("zebrafish", self.cached())
        self.assertNotIn("zebrafish", billing.render_csv(rep) + billing.render_md(rep))
        self.assertGreater(rep["lines"][0]["engaged_h"], 0)  # the hours are still there

    def test_stored_when_asked_and_gone_when_not(self):
        on = {**self.cfg, "descriptions": True}
        self.assertIn("zebrafish", billing.render_csv(billing.build(on, "2026-10-06", None, None)))
        self.assertIn("zebrafish", self.cached())
        billing.build(self.cfg, "2026-10-06", None, None)
        self.assertNotIn("zebrafish", self.cached())


class HalfLine(Base):
    def test_a_line_still_being_written_is_read_next_time(self):
        self.write("s1", [prompt(0, "alpha"), tool(1, "C:/projects/alpha/a.ts"), tool(3)])
        path = os.path.join(self.logs, "s1.jsonl")
        line = json.dumps(tool(6, "C:/projects/alpha/a.ts"))
        with open(path, "a", encoding="utf-8") as f:
            f.write(line[:40])
        self.assertAlmostEqual(self.rows()[("2026-10-06", "Alpha")]["claude"], 3 * 60, delta=1)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line[40:] + "\n")
        self.assertAlmostEqual(self.rows()[("2026-10-06", "Alpha")]["claude"], 6 * 60, delta=1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
