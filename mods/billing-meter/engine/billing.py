#!/usr/bin/env python3
"""billing-meter engine: measures billable time from Claude Code session logs.

Reads every transcript under Claude Code's projects folder (main chats and sub-agents) and
works out, per day and per project:

  you      your time: typing each message (35 wpm, pasted text not counted as
           typing) or the pause before it while you read Claude's reply and
           decided (capped at 20 min; longer = you were away), whichever is longer
  claude   Claude's working time in the main chat: activity with no gap longer
           than BUSY_GAP minutes (waiting on you or idling counts zero)
  agents   the same for sub-agents (they run in parallel, so this can exceed the clock)
  engaged  clock time when you OR Claude OR an agent was working on that
           project; overlaps counted once.

Nothing needs setting up: a chat's time goes to the folder it ran in. Projects in
the config come first: the folders a turn touched ("paths"), then words in your
prompt ("keywords"). A follow-up takes the project of the turn before it. `tag`
forces a project for a chat from a moment on.

Usage:
  billing.py report  [--range R] [--format text|md|json|csv] [--basis B] [--project NAME]
  billing.py export  [--range R] [--basis B]      writes CSV + MD timesheets, prints paths
  billing.py status                                one line for the status bar (today)
  billing.py tag     --session ID --project NAME   ("auto" clears) from now on
  billing.py config  [--show] [--rate PROJECT AMOUNT [CURRENCY]] [--basis B] [--round MIN]
                     [--add-project NAME --path FOLDER] [--billable PROJECT yes|no]
  billing.py projects
Ranges: today yesterday week last-week month last-month all YYYY-MM YYYY-MM-DD
        YYYY-MM-DD..YYYY-MM-DD last-N-days   (weeks start Monday, local time)
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
from collections import defaultdict

HOME = os.path.expanduser("~")
CLAUDE = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
LOGS = os.path.join(CLAUDE, "projects")
DATA = os.path.join(CLAUDE, "zed-mods", "billing-meter")
CONFIG = os.path.join(DATA, "config.json")
CACHE = os.path.join(DATA, "cache.json")
TAGS = os.path.join(DATA, "tags.jsonl")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "default-config.json")
CACHE_VERSION = 2  # a bump rebuilds the cache

WRAP = re.compile(r"<(system-reminder|local-command-[a-z]+|command-[a-z]+|ide_[a-z]+|browser_instruction|user-prompt-submit-hook)[^>]*>.*?</\1>", re.S)
PASTE = re.compile(r"<pasted_content[^>]*>.*?</pasted_content[^>]*>", re.S)
SECRETS = [
    # well-known key shapes, each with its own prefix, so ordinary long words stay
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*", re.S), "[secret]"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[secret]"),
    (re.compile(r"\b(?:gh[opsur]_|github_pat_|glpat-|npm_|hf_|gsk_|sbp_|sb_secret_|whsec_|[rs]k_(?:live|test)_"
                r"|sk-|xox[a-z]-|AIza|GOCSPX-|SG\.|eyJ|re_)[A-Za-z0-9_.-]{12,}"), "[secret]"),
    (re.compile(r"\bBearer\s+[\w.~+/-]{16,}=*", re.I), "[secret]"),
    # NAME=value where the name says it is a credential (the name may be a compound)
    (re.compile(r"([\w-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|private[_-]?key)(?:[_-][\w-]*)?)"
                r"(\s*[:=]\s*)[\"']?[^\s\"',;]{6,}", re.I), r"\1\2[secret]"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"), "[email]"),
    (re.compile(r"(?<!\d)(\+?\d[\d \-]{8,}\d)(?!\d)"), "[number]"),
    (re.compile(r"https?://\S+"), "[link]"),
]


# ---------------------------------------------------------------- config

def load_config() -> dict:
    os.makedirs(DATA, exist_ok=True)
    if not os.path.exists(CONFIG):
        with open(DEFAULT_CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
        save_config(cfg)
    with open(CONFIG, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    cfg.setdefault("basis", "you")
    cfg.setdefault("round_minutes", 15)
    cfg.setdefault("busy_gap_minutes", 15)
    cfg.setdefault("idle_cap_minutes", 20)
    cfg.setdefault("words_per_minute", 35)
    cfg.setdefault("paste_words", 300)
    cfg.setdefault("utc_offset_hours", None)
    cfg.setdefault("currency", "USD")
    if not cfg.get("timesheets_dir"):
        cfg["timesheets_dir"] = os.path.join(DATA, "timesheets")
    cfg.setdefault("projects", [])
    cfg.setdefault("descriptions", False)  # the first words of your prompts on each line
    return cfg


def save_config(cfg: dict) -> None:
    os.makedirs(DATA, exist_ok=True)
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG)


def local_tz(cfg: dict) -> dt.tzinfo:
    off = cfg.get("utc_offset_hours")
    if off is None:
        return dt.datetime.now().astimezone().tzinfo
    return dt.timezone(dt.timedelta(hours=float(off)))


class Matcher:
    """Turns paths and prompt text into a project name."""

    def __init__(self, cfg: dict):
        self.paths: list[tuple[str, str]] = []
        self.words: list[tuple[re.Pattern, str]] = []
        self.meta: dict[str, dict] = {}
        self.descriptions = bool(cfg.get("descriptions"))
        for p in cfg.get("projects", []):
            name = p["name"]
            self.meta[name] = p
            for frag in p.get("paths", []):
                self.paths.append((norm(frag), name))
            for kw in p.get("keywords", []):
                try:
                    self.words.append((re.compile(kw, re.I), name))
                except re.error:
                    pass
        self.paths.sort(key=lambda x: -len(x[0]))  # longest fragment wins

    def from_text(self, text: str) -> str | None:
        t = norm(text)
        for frag, name in self.paths:
            if frag and frag in t:
                return name
        return None

    def from_cwd(self, cwd: str | None) -> str | None:
        """The project of the folder a chat runs in: a configured one, else the folder's own name."""
        if not cwd:
            return None
        known = self.from_text(cwd)
        if known:
            return known
        parts = [p for p in norm_case(cwd).split("/") if p and not p.endswith(":")]
        home = [p for p in norm_case(HOME).split("/") if p and not p.endswith(":")]
        if not parts or parts == home:
            return None
        return parts[-1]

    def from_words(self, text: str) -> str | None:
        for rx, name in self.words:
            if rx.search(text):
                return name
        return None


def norm_case(s: str) -> str:
    return s.replace("\\\\", "/").replace("\\", "/").rstrip("/")


def norm(s: str) -> str:
    return norm_case(s).lower()


# ---------------------------------------------------------------- parsing

def ts_of(o: dict) -> float | None:
    s = o.get("timestamp")
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def clean_prompt(raw: str) -> tuple[str, int, bool]:
    """Returns (text, own_words, had_paste). Empty text = not a real prompt."""
    if not raw:
        return "", 0, False
    s = raw.lstrip()
    if s.startswith("<task-notification") or "[Request interrupted" in raw:
        return "", 0, False
    t = WRAP.sub("", raw)
    pasted = bool(PASTE.search(t))
    t = PASTE.sub(" ", t)
    t = re.sub(r"\[Image[^\]]*\]", " ", t).strip()
    if not t or t.startswith("[SYSTEM NOTIFICATION") or t.startswith("Caveat:"):
        return "", 0, False
    return t, len(t.split()), pasted


def describe(text: str, words: int = 12) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    for rx, rep in SECRETS:
        t = rx.sub(rep, t)
    parts = t.split(" ")
    out = " ".join(parts[:words])
    return out + ("…" if len(parts) > words else "")


def tool_paths(block: dict) -> str:
    inp = block.get("input") or {}
    if not isinstance(inp, dict):
        return ""
    bits = []
    for k in ("file_path", "path", "notebook_path", "command", "cwd", "pattern", "url"):
        v = inp.get(k)
        if isinstance(v, str):
            bits.append(v)
    return " ".join(bits)


def parse_lines(lines, matcher: Matcher) -> list[list]:
    """Compact events from transcript lines.

    ["P", ts, words, pasted, first_line, word_project, path_project, folder]  your prompt
    ["C", ts, path_project, folder]                                           Claude or a tool
    """
    ev: list[list] = []
    for line in lines:
        try:
            o = json.loads(line)
        except (ValueError, TypeError):
            continue
        ts = ts_of(o)
        if ts is None:
            continue
        ty = o.get("type")
        cwd = o.get("cwd")
        known = matcher.from_text(cwd) if cwd else None   # a configured project
        folder = matcher.from_cwd(cwd)                    # or just the folder's name
        if ty == "assistant":
            proj = None
            content = (o.get("message") or {}).get("content")
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        proj = matcher.from_text(tool_paths(b)) or proj
            ev.append(["C", ts, proj or known, folder])
        elif ty == "user" and not o.get("isMeta"):
            content = (o.get("message") or {}).get("content")
            if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                ev.append(["C", ts, None, folder])
                continue
            if isinstance(content, str):
                raw, img = content, False
            elif isinstance(content, list):
                raw = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
                img = any(isinstance(b, dict) and b.get("type") == "image" for b in content)
            else:
                continue
            text, w, pasted = clean_prompt(raw)
            if text:
                ev.append(["P", ts, w, bool(pasted or img), describe(text) if matcher.descriptions else "", matcher.from_words(text + " " + raw),
                           matcher.from_text(text) or known, folder])
        elif ty == "queue-operation" and o.get("operation") == "enqueue" and o.get("content"):
            text, w, pasted = clean_prompt(o["content"])
            if text:
                ev.append(["P", ts, w, bool(pasted), describe(text) if matcher.descriptions else "", matcher.from_words(text + " " + o["content"]),
                           matcher.from_text(text) or known, folder])
    return ev


def config_signature(cfg: dict) -> str:
    return json.dumps([cfg.get("projects", []), bool(cfg.get("descriptions"))], sort_keys=True, ensure_ascii=False)


def load_events(cfg: dict, matcher: Matcher, since: float | None) -> dict[str, dict]:
    """Per transcript: {"session": sid, "agent": bool, "events": [...]}. Cached, append-aware."""
    try:
        with open(CACHE, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    sig = config_signature(cfg)
    if cache.get("_version") != CACHE_VERSION or cache.get("_sig") != sig:
        cache = {"_version": CACHE_VERSION, "_sig": sig}
    out: dict[str, dict] = {}
    changed = False
    for root, dirs, files in os.walk(LOGS):
        for fn in files:
            if not fn.endswith(".jsonl"):
                continue
            path = os.path.join(root, fn)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if since is not None and st.st_mtime < since:
                continue
            is_agent = os.path.basename(root) == "subagents"
            sid = (os.path.basename(os.path.dirname(root)) if is_agent else fn[:-6])[:36]
            entry = cache.get(path)
            if entry and entry.get("size") == st.st_size and entry.get("mtime") == st.st_mtime:
                events = entry["events"]
            else:
                start = 0
                events = []
                if entry and st.st_size > entry.get("size", 0):
                    start, events = entry["read"], entry["events"]
                try:
                    with open(path, "rb") as f:
                        f.seek(start)
                        raw = f.read()
                except OSError:
                    continue
                # a chat may be writing its last line right now: leave it for the next run
                whole = raw.rfind(b"\n") + 1
                events = events + parse_lines(raw[:whole].decode("utf-8", errors="ignore").split("\n"), matcher)
                cache[path] = {"size": st.st_size, "read": start + whole, "mtime": st.st_mtime, "events": events}
                changed = True
            out[path] = {"session": sid, "agent": is_agent, "events": events}
    if changed:
        tmp = CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp, CACHE)
    return out


def load_tags() -> dict[str, list[tuple[float, str]]]:
    tags: dict[str, list[tuple[float, str]]] = defaultdict(list)
    try:
        with open(TAGS, encoding="utf-8") as f:
            for line in f:
                try:
                    t = json.loads(line)
                    tags[t["session"][:36]].append((float(t["at"]), t["project"]))
                except (ValueError, KeyError):
                    continue
    except OSError:
        pass
    for v in tags.values():
        v.sort()
    return tags


# ---------------------------------------------------------------- measuring

def busy_spans(times: list[float], gap_s: float) -> list[tuple[float, float]]:
    times = sorted(times)
    spans = []
    for a, b in zip(times, times[1:]):
        if 0 < b - a < gap_s:
            if spans and abs(spans[-1][1] - a) < 1e-6:
                spans[-1] = (spans[-1][0], b)
            else:
                spans.append((a, b))
    return spans


def pick(hits: dict[str, int], weak: set[str]) -> str:
    """Most-touched project; one marked "weak" only when nothing else was touched."""
    strong = {k: v for k, v in hits.items() if k not in weak}
    pool = strong or hits
    return max(pool.items(), key=lambda x: (x[1], x[0]))[0]


def tag_at(tags: list[tuple[float, str]], ts: float) -> str | None:
    cur = None
    for at, proj in tags:
        if at <= ts:
            cur = None if proj.lower() == "auto" else proj
        else:
            break
    return cur


def measure(cfg: dict, files: dict[str, dict], tags: dict, start: float, end: float) -> dict:
    """Returns {(day, project): {...}} for activity in [start, end)."""
    gap_s = cfg["busy_gap_minutes"] * 60
    idle_s = cfg["idle_cap_minutes"] * 60
    wpm = cfg["words_per_minute"]
    paste_words = cfg["paste_words"]
    tz = local_tz(cfg)
    weak = {p["name"] for p in cfg.get("projects", []) if p.get("weak")}
    known_names = {p["name"] for p in cfg.get("projects", [])}

    # 1. main chats: turns and their projects
    turn_project: dict[str, list[tuple[float, str]]] = {}  # session -> [(turn_start, project)]
    you_iv: list[tuple[str, float, float, dict]] = []      # (project, a, b, prompt)
    claude_iv: list[tuple[str, float, float]] = []
    for path, f in files.items():
        if f["agent"]:
            continue
        sid = f["session"]
        ev = sorted(f["events"], key=lambda e: e[1])
        if not ev:
            continue
        stags = tags.get(sid, [])
        prompts_idx = [i for i, e in enumerate(ev) if e[0] == "P"]
        turns: list[tuple[float, float, str, int]] = []  # (start, end, project, idx)
        prev_proj, prev_end = None, None
        bounds = prompts_idx + [len(ev)]
        if prompts_idx and prompts_idx[0] > 0:
            bounds = [0] + bounds  # activity before the first prompt (resumed chat)
        for k in range(len(bounds) - 1):
            i, j = bounds[k], bounds[k + 1]
            seg = ev[i:j]
            hits: dict[str, int] = defaultdict(int)
            for e in seg:
                if e[0] == "C" and e[2]:
                    hits[e[2]] += 1
            first = seg[0]
            proj = tag_at(stags, first[1])
            if not proj and hits:
                proj = pick(hits, weak)
            if not proj and first[0] == "P":
                proj = first[6] or first[5]
            recent = prev_proj if prev_proj and prev_end is not None and first[1] - prev_end < 3 * 3600 else None
            if not proj and recent in known_names:
                proj = recent
            if not proj:
                folders: dict[str, int] = defaultdict(int)
                for e in seg:
                    if e[-1]:
                        folders[e[-1]] += 1
                proj = max(folders.items(), key=lambda x: (x[1], x[0]))[0] if folders else recent
            proj = proj or "Unassigned"
            seg_end = max(e[1] for e in seg)
            turns.append((first[1], seg_end, proj, i))
            prev_proj, prev_end = proj, seg_end
        turn_project[sid] = [(t[0], t[2]) for t in turns]

        # your time per prompt
        claude_times = [e[1] for e in ev if e[0] == "C"]
        for t_start, t_end, proj, i in turns:
            e = ev[i]
            if e[0] != "P":
                continue
            ts, words, pasted = e[1], e[2], e[3]
            typed = 60 if words > paste_words else words
            typing = typed / wpm * 60 + (60 if (pasted or words > paste_words) else 0)
            prev_c = [c for c in claude_times if c < ts]
            next_c = [c for c in claude_times if c >= ts]
            read = 0.0
            if prev_c:
                gap = ts - prev_c[-1]
                working = next_c and next_c[0] - ts < 60 and gap < 60
                if working:
                    read = 0.0
                elif gap <= idle_s:
                    read = gap
                else:
                    read = 180.0
            dur = max(typing, read)
            if dur > 0:
                you_iv.append((proj, ts - dur, ts, {"desc": e[4]}))
            else:
                you_iv.append((proj, ts, ts, {"desc": e[4]}))

        # Claude busy spans, attributed to the turn they start in
        starts = [t[0] for t in turns]
        projs = [t[2] for t in turns]
        for a, b in busy_spans([e[1] for e in ev], gap_s):
            k = 0
            for idx, s in enumerate(starts):
                if s <= a:
                    k = idx
                else:
                    break
            claude_iv.append((projs[k] if projs else "Unassigned", a, b))

    # 2. sub-agents
    agent_iv: list[tuple[str, float, float]] = []
    for path, f in files.items():
        if not f["agent"]:
            continue
        ev = f["events"]
        if len(ev) < 2:
            continue
        hits: dict[str, int] = defaultdict(int)
        for e in ev:
            found = e[2] if e[0] == "C" else e[6]
            if found:
                hits[found] += 1
        first_ts = min(e[1] for e in ev)
        proj = tag_at(tags.get(f["session"], []), first_ts)
        if not proj and hits:
            proj = pick(hits, weak)
        if not proj:
            parent = turn_project.get(f["session"], [])
            proj = "Unassigned"
            for s, p in parent:
                if s <= first_ts:
                    proj = p
        for a, b in busy_spans([e[1] for e in ev], gap_s):
            agent_iv.append((proj, a, b))

    # 3. split by day, clip to range, aggregate
    rows: dict[tuple[str, str], dict] = defaultdict(lambda: {
        "you": 0.0, "claude": 0.0, "agents": 0.0, "engaged_iv": [], "prompts": 0, "desc": []})

    def pieces(a: float, b: float):
        a, b = max(a, start), min(b, end)
        while a < b:
            d = dt.datetime.fromtimestamp(a, tz)
            nxt = (d.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=1)).timestamp()
            cut = min(b, nxt)
            yield d.date().isoformat(), a, cut
            a = cut

    for proj, a, b, info in you_iv:
        if b < start or a >= end:
            continue
        day = dt.datetime.fromtimestamp(min(max(b, start), end - 1), tz).date().isoformat()
        r = rows[(day, proj)]
        r["prompts"] += 1
        if info["desc"] and info["desc"] not in r["desc"]:
            r["desc"].append(info["desc"])
        for d, x, y in pieces(a, b):
            rows[(d, proj)]["you"] += y - x
            rows[(d, proj)]["engaged_iv"].append((x, y))
    for key, iv in (("claude", claude_iv), ("agents", agent_iv)):
        for proj, a, b in iv:
            for d, x, y in pieces(a, b):
                rows[(d, proj)][key] += y - x
                rows[(d, proj)]["engaged_iv"].append((x, y))

    result = {}
    for k, r in rows.items():
        ivs = sorted(r.pop("engaged_iv"))
        eng, cur = 0.0, None
        for a, b in ivs:
            if cur is None or a > cur[1]:
                if cur:
                    eng += cur[1] - cur[0]
                cur = [a, b]
            else:
                cur[1] = max(cur[1], b)
        if cur:
            eng += cur[1] - cur[0]
        r["engaged"] = eng
        if r["you"] + r["claude"] + r["agents"] + r["engaged"] < 1 and not r["prompts"]:
            continue
        result[k] = r
    return result


# ---------------------------------------------------------------- ranges

def parse_range(spec: str, tz: dt.tzinfo) -> tuple[float, float, str]:
    now = dt.datetime.now(tz)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day = dt.timedelta(days=1)
    s = (spec or "today").strip().lower()

    def d(x: str) -> dt.datetime:
        return dt.datetime.strptime(x, "%Y-%m-%d").replace(tzinfo=tz)

    if s == "today":
        a, b = today, today + day
    elif s == "yesterday":
        a, b = today - day, today
    elif s in ("week", "this-week"):
        a = today - dt.timedelta(days=today.weekday()); b = a + 7 * day
    elif s == "last-week":
        b = today - dt.timedelta(days=today.weekday()); a = b - 7 * day
    elif s in ("month", "this-month"):
        a = today.replace(day=1); b = (a + 32 * day).replace(day=1)
    elif s == "last-month":
        b = today.replace(day=1); a = (b - day).replace(day=1)
    elif s == "all":
        a, b = dt.datetime(2020, 1, 1, tzinfo=tz), today + day
    elif re.fullmatch(r"\d{4}-\d{2}", s):
        a = dt.datetime.strptime(s + "-01", "%Y-%m-%d").replace(tzinfo=tz); b = (a + 32 * day).replace(day=1)
    elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        a = d(s); b = a + day
    elif re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}", s):
        x, y = s.split(".."); a = d(x); b = d(y) + day
    elif re.fullmatch(r"last-\d+-days", s):
        n = int(s.split("-")[1]); a = today - (n - 1) * day; b = today + day
    else:
        raise SystemExit(f"Unknown range '{spec}'. Use today, yesterday, week, last-week, month, last-month, all, YYYY-MM, YYYY-MM-DD, A..B or last-N-days.")
    label = f"{a.date().isoformat()} to {(b - day).date().isoformat()}" if (b - a) > day else a.date().isoformat()
    return a.timestamp(), b.timestamp(), label


# ---------------------------------------------------------------- output

def billable_seconds(r: dict, basis: str) -> float:
    if basis == "you":
        return r["you"]
    if basis == "claude":
        return r["claude"] + r["agents"]
    if basis == "you+claude":
        return r["you"] + r["claude"] + r["agents"]
    return r["engaged"]


def round_up(seconds: float, minutes: int) -> float:
    if minutes <= 0 or seconds <= 0:
        return seconds / 3600
    step = minutes * 60
    return -(-seconds // step) * step / 3600


def build(cfg: dict, spec: str, basis: str | None, only: str | None) -> dict:
    tz = local_tz(cfg)
    start, end, label = parse_range(spec, tz)
    matcher = Matcher(cfg)
    files = load_events(cfg, matcher, since=start - 2 * 86400)
    rows = measure(cfg, files, load_tags(), start, end)
    basis = basis or cfg["basis"]
    meta = matcher.meta
    lines = []
    for (day, proj), r in sorted(rows.items()):
        if only and proj.lower() != only.lower():
            continue
        m = meta.get(proj, {})
        billable = m.get("billable", proj != "Unassigned")
        hours = round_up(billable_seconds(r, basis), cfg["round_minutes"]) if billable else 0.0
        rate = float(m.get("rate") or 0)
        lines.append({
            "date": day, "project": proj, "client": m.get("client", proj),
            "billable": billable, "prompts": r["prompts"],
            "you_h": r["you"] / 3600, "claude_h": r["claude"] / 3600, "agents_h": r["agents"] / 3600,
            "engaged_h": r["engaged"] / 3600, "billable_h": hours,
            "rate": rate, "currency": m.get("currency", cfg.get("currency", "USD")),
            "amount": round(hours * rate, 2), "work": "; ".join(r["desc"][:4]),
        })
    return {"range": label, "basis": basis, "round_minutes": cfg["round_minutes"], "lines": lines}


def totals_by_project(rep: dict) -> list[dict]:
    agg: dict[str, dict] = {}
    for ln in rep["lines"]:
        a = agg.setdefault(ln["project"], {"project": ln["project"], "client": ln["client"], "billable": ln["billable"],
                                           "you_h": 0, "claude_h": 0, "agents_h": 0, "engaged_h": 0,
                                           "billable_h": 0, "amount": 0, "currency": ln["currency"], "rate": ln["rate"], "days": 0})
        for k in ("you_h", "claude_h", "agents_h", "engaged_h", "billable_h", "amount"):
            a[k] += ln[k]
        a["days"] += 1
    return sorted(agg.values(), key=lambda x: (-x["billable_h"], -x["engaged_h"]))


def fmt_h(h: float) -> str:
    return f"{h:.2f}"


def render_text(rep: dict) -> str:
    out = [f"Billing meter · {rep['range']} · billable basis: {rep['basis']} (rounded up to {rep['round_minutes']} min per project per day)"]
    tots = totals_by_project(rep)
    if not tots:
        return out[0] + "\nNo activity in this range."
    out.append("")
    out.append(f"{'Project':26} {'You':>6} {'Claude':>7} {'Agents':>7} {'Engaged':>8} {'Billable':>9} {'Amount':>10}")
    gt = defaultdict(float)
    for t in tots:
        amt = f"{t['amount']:.0f} {t['currency']}" if t["rate"] else "-"
        bill = fmt_h(t["billable_h"]) if t["billable"] else "not billed"
        out.append(f"{t['project'][:26]:26} {fmt_h(t['you_h']):>6} {fmt_h(t['claude_h']):>7} {fmt_h(t['agents_h']):>7} {fmt_h(t['engaged_h']):>8} {bill:>9} {amt:>10}")
        for k in ("you_h", "claude_h", "agents_h", "engaged_h", "billable_h", "amount"):
            gt[k] += t[k]
    out.append(f"{'TOTAL':26} {fmt_h(gt['you_h']):>6} {fmt_h(gt['claude_h']):>7} {fmt_h(gt['agents_h']):>7} {fmt_h(gt['engaged_h']):>8} {fmt_h(gt['billable_h']):>9} {gt['amount']:>10.0f}")
    days = sorted({ln["date"] for ln in rep["lines"]})
    if len(days) > 1:
        out.append("")
        out.append("By day (billable h): " + "  ".join(f"{d[5:]} {sum(l['billable_h'] for l in rep['lines'] if l['date'] == d):.2f}" for d in days))
    out.append("")
    out.append("Hours in decimal. You = your typing + reading; Claude = main chat; Agents = helpers in parallel; Engaged = clock time anyone worked on it.")
    return "\n".join(out)


def render_md(rep: dict) -> str:
    out = [f"# Timesheet · {rep['range']}", "",
           f"Billable basis: **{rep['basis']}**, rounded up to {rep['round_minutes']} minutes per project per day. Hours are decimal.", "",
           "## Summary by project", "",
           "| Project | Client | Days | You | Claude | Agents | Engaged | Billable | Rate | Amount |",
           "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for t in totals_by_project(rep):
        out.append(f"| {t['project']} | {t['client']} | {t['days']} | {fmt_h(t['you_h'])} | {fmt_h(t['claude_h'])} | {fmt_h(t['agents_h'])} | "
                   f"{fmt_h(t['engaged_h'])} | {fmt_h(t['billable_h']) if t['billable'] else 'not billed'} | "
                   f"{t['rate'] or '-'} | {('%.2f %s' % (t['amount'], t['currency'])) if t['rate'] else '-'} |")
    out += ["", "## Daily lines", "",
            "| Date | Project | Billable h | What was done (from the prompts; check before sending) |",
            "| --- | --- | --- | --- |"]
    for ln in rep["lines"]:
        if not ln["billable"]:
            continue
        work = ln["work"].replace("|", "/")
        out.append(f"| {ln['date']} | {ln['project']} | {fmt_h(ln['billable_h'])} | {work} |")
    out += ["", "How it is measured: You = typing each message (35 wpm, pasted text not counted as typing) or the pause before it while reading and deciding (max 20 min). "
            "Claude = activity in the main chat with no gap longer than the busy gap. Agents = helpers, in parallel. "
            "Engaged = clock time when anyone worked on the project, overlaps counted once. Not measured: work outside Claude Code (other apps, calls, meetings, claude.ai chats)."]
    return "\n".join(out) + "\n"


def render_csv(rep: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "client", "project", "billable_hours", "rate", "currency", "amount", "you_hours", "claude_hours",
                "agent_hours", "engaged_hours", "prompts", "work_done"])
    for ln in rep["lines"]:
        w.writerow([ln["date"], ln["client"], ln["project"], fmt_h(ln["billable_h"]), ln["rate"] or "", ln["currency"],
                    f"{ln['amount']:.2f}" if ln["rate"] else "", fmt_h(ln["you_h"]), fmt_h(ln["claude_h"]),
                    fmt_h(ln["agents_h"]), fmt_h(ln["engaged_h"]), ln["prompts"], ln["work"]])
    return buf.getvalue()


# ---------------------------------------------------------------- commands

def cmd_report(a, cfg):
    rep = build(cfg, a.range, a.basis, a.project)
    if a.format == "json":
        print(json.dumps({**rep, "totals": totals_by_project(rep)}, ensure_ascii=False, indent=1))
    elif a.format == "md":
        print(render_md(rep))
    elif a.format == "csv":
        print(render_csv(rep), end="")
    else:
        print(render_text(rep))


def cmd_export(a, cfg):
    rep = build(cfg, a.range, a.basis, a.project)
    folder = cfg["timesheets_dir"]
    os.makedirs(folder, exist_ok=True)
    name = "timesheet_" + re.sub(r"[^0-9A-Za-z_-]+", "_", rep["range"]).strip("_")
    if a.project:
        name += "_" + re.sub(r"[^0-9A-Za-z_-]+", "_", a.project)
    p_csv = os.path.join(folder, name + ".csv")
    p_md = os.path.join(folder, name + ".md")
    with open(p_csv, "w", encoding="utf-8-sig", newline="") as f:
        f.write(render_csv(rep))
    with open(p_md, "w", encoding="utf-8") as f:
        f.write(render_md(rep))
    print(render_text(rep))
    print("")
    print("Saved:")
    print(p_csv)
    print(p_md)


def cmd_status(a, cfg):
    try:
        rep = build(cfg, "today", None, None)
    except Exception as exc:  # the status bar must never break
        print(f"billing: {exc.__class__.__name__}")
        return
    tots = [t for t in totals_by_project(rep) if t["billable"]]
    total = sum(t["billable_h"] for t in tots)
    top = ", ".join(f"{t['project']} {t['billable_h']:.2f}" for t in tots[:2])
    print(f"{total:.2f} h billable today" + (f" · {top}" if top else ""))


def cmd_tag(a, cfg):
    names = {p["name"].lower(): p["name"] for p in cfg["projects"]}
    proj = names.get(a.project.lower(), a.project)
    at = dt.datetime.now().timestamp() if not a.at else dt.datetime.fromisoformat(a.at).timestamp()
    os.makedirs(DATA, exist_ok=True)
    with open(TAGS, "a", encoding="utf-8") as f:
        f.write(json.dumps({"session": a.session, "project": proj, "at": at}) + "\n")
    print(f"From now on this chat's time goes to: {proj}" if proj.lower() != "auto" else "This chat is back to automatic project detection.")


def cmd_config(a, cfg):
    changed = False
    if a.rate:
        proj, amount = a.rate[0], a.rate[1]
        cur = a.rate[2] if len(a.rate) > 2 else None
        for p in cfg["projects"]:
            if p["name"].lower() == proj.lower():
                p["rate"] = float(amount)
                if cur:
                    p["currency"] = cur.upper()
                break
        else:
            cfg["projects"].append({"name": proj, "client": proj, "paths": [], "keywords": [], "rate": float(amount),
                                    "currency": (cur or cfg.get("currency", "USD")).upper(), "billable": True})
        changed = True
    if getattr(a, "descriptions", None) is not None:
        cfg["descriptions"] = a.descriptions == "on"
        changed = True
    if a.basis:
        if a.basis not in ("engaged", "you", "claude", "you+claude"):
            raise SystemExit("basis must be engaged, you, claude or you+claude")
        cfg["basis"] = a.basis; changed = True
    if a.round is not None:
        cfg["round_minutes"] = int(a.round); changed = True
    if a.add_project:
        if any(p["name"].lower() == a.add_project.lower() for p in cfg["projects"]):
            raise SystemExit("That project already exists.")
        cfg["projects"].append({"name": a.add_project, "client": a.client or a.add_project, "paths": a.path or [],
                                "keywords": a.keyword or [], "rate": 0, "currency": cfg.get("currency", "USD"), "billable": True})
        changed = True
    if a.billable is not None:
        name, flag = a.billable
        for p in cfg["projects"]:
            if p["name"].lower() == name.lower():
                p["billable"] = flag.lower() in ("yes", "true", "1", "on")
                changed = True
    if changed:
        save_config(cfg)
        print("Saved.")
    print(f"Descriptions: {'on, the first words of your prompts are kept' if cfg.get('descriptions') else 'off'}")
    print(f"Settings: {CONFIG}")
    print(f"Basis: {cfg['basis']} · round up to {cfg['round_minutes']} min · busy gap {cfg['busy_gap_minutes']} min · timesheets: {cfg['timesheets_dir']}")
    if not cfg["projects"]:
        print("  No projects set up: time goes to the folder each chat ran in. /bill add <name> <folder> names one.")
    for p in cfg["projects"]:
        rate = f"{p.get('rate') or 0:g} {p.get('currency') or cfg.get('currency', 'USD')}/h" if p.get("rate") else "no rate"
        print(f"  {p['name']:28} {'billed' if p.get('billable', True) else 'NOT billed':10} {rate}")


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(prog="billing.py", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd")
    for name in ("report", "export"):
        p = sub.add_parser(name)
        p.add_argument("--range", default="today")
        p.add_argument("--basis")
        p.add_argument("--project")
        if name == "report":
            p.add_argument("--format", default="text", choices=["text", "md", "json", "csv"])
    sub.add_parser("status")
    sub.add_parser("projects")
    p = sub.add_parser("tag"); p.add_argument("--session", required=True); p.add_argument("--project", required=True); p.add_argument("--at")
    p = sub.add_parser("config")
    p.add_argument("--show", action="store_true")
    p.add_argument("--rate", nargs="+", metavar=("PROJECT", "AMOUNT"))
    p.add_argument("--basis"); p.add_argument("--round", type=int)
    p.add_argument("--descriptions", choices=["on", "off"])
    p.add_argument("--add-project"); p.add_argument("--client"); p.add_argument("--path", action="append"); p.add_argument("--keyword", action="append")
    p.add_argument("--billable", nargs=2, metavar=("PROJECT", "YES_NO"))
    a = ap.parse_args(argv)
    cfg = load_config()
    if a.cmd == "report":
        cmd_report(a, cfg)
    elif a.cmd == "export":
        cmd_export(a, cfg)
    elif a.cmd == "status":
        cmd_status(a, cfg)
    elif a.cmd == "tag":
        cmd_tag(a, cfg)
    elif a.cmd in ("config", "projects"):
        if a.cmd == "projects":
            a = argparse.Namespace(rate=None, basis=None, round=None, add_project=None, billable=None)
        cmd_config(a, cfg)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
