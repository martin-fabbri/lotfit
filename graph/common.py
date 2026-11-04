"""Shared, mechanical pieces of graph v6: text normalisation, clause detection (GR-32), table-cell parsing (GR-33),
the fact lexicon for not-modeled clauses, and as-of dating. No model is called anywhere; every function here is a
regular expression or arithmetic over the verbatim text, so ingest and build always agree."""
import datetime, hashlib, json, os, re, unicodedata

SCHEMA = "lotfit.codegraph/v6"
DEFAULT_TEXTS = os.environ.get("LOTFIT_CODE_TEXT", "")
UNITS = {None, "ft", "in", "sqft", "%", "count", "stories", "days", "years", "hours", "degrees", "ratio"}


# ---------- normalisation ----------
def norm(s):
    """Unicode NFKC, typographic quotes and dashes to ASCII, no soft hyphens or non-breaking spaces, every run of
    whitespace to one space."""
    s = unicodedata.normalize("NFKC", s)
    for a, b in (("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"'), (" ", " "), ("­", "")):
        s = s.replace(a, b)
    s = re.sub("[‐-―−]", "-", s)
    return re.sub(r"\s+", " ", s).strip()


def variants(raw):
    """The document text as normalised, and again with line-end hyphenation joined (dwell-\\ning -> dwelling)."""
    return [norm(raw), norm(re.sub(r"(\w)-[ \t]*\n[ \t]*(\w)", r"\1\2", raw))]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()


def fingerprint(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def is_date(s):
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s): return False
    try: datetime.date.fromisoformat(s); return True
    except ValueError: return False


# ---------- numbers in their words (the checker's rule) ----------
def number_in(value, text):
    return re.search(rf"(?<![\d.]){re.escape(str(value))}(?![\d]|\.\d)", norm(text).replace(",", "")) is not None


# ---------- GR-32: clause detection ----------
# Enumerated items: "(1)", "(a)", "(A)", "(ii)" anywhere a capitalised sentence follows; "a.", "1.", "A." only after
# a sentence end, a colon or a semicolon (or "; or", "; and"), so "33.110.250" or "sq. ft." never count.
PAREN = re.compile(r"(?<![\w(])\((\d{1,2}|[a-zA-Z]|[ivx]{2,4})\)(?=(?:\([^()\s]{1,4}\))*\s+[\"'A-Z])")
BARE = re.compile(r"(?:^|(?<=[.:;] )|(?<=; or )|(?<=; and )|(?<=, or )|(?<=, and ))(?<!Sec\. )(\d{1,2}|[a-zA-Z])\.(?=\s+[\"'A-Z(])")
# Conditions: each if / unless / except / excluding / other than / provided that / when / where.
COND = re.compile(r"\b(if|unless|except|excluding|other than|provided that|provided, however|when|whenever|where)\b", re.I)
LEAD_IN = re.compile(r"\s*(as follows|(?:all|any|one|each|both|either) of the following(?: (?:are|is) met| apply| applies)?|the following(?: (?:are|is) met| apply| applies)?)", re.I)
SENT_END = re.compile(r"[;:]|\.(?=\s+[\"'A-Z(\[]|\s*$)")


def _style(label, paren, stack=()):
    if paren and label in ("i", "v", "x"):      # roman (i) unless it follows (h), (u) or (w) at the same level
        prev = next((x[1] for x in reversed(stack) if x[0] == "plower"), None)
        return "plower" if prev == f"({chr(ord(label) - 1)})" else "proman"
    kind = "digit" if label.isdigit() else "roman" if re.fullmatch(r"[ivx]{2,4}", label) else "upper" if label.isupper() else "lower"
    return ("p" if paren else "b") + kind


def _markers(t):
    out = [(m.start(), m.end(), m.group(1), True) for m in PAREN.finditer(t)]
    out += [(m.start(), m.end(), m.group(1), False) for m in BARE.finditer(t)]
    return sorted(out)


CONTAINERS = ("item", "sentence", "heading", "caption", "reference", "stem")
STRUCTURAL = ("lead_in", "heading", "caption", "reference", "stem")    # hold no rule of their own; always structural
POSITIVE = {"if", "when", "whenever", "where", "provided that", "provided, however"}
VERBS = re.compile(r"\b(is|are|was|be|must|may|shall|will|can|cannot|does|do|apply|applies|has|have|not)\b", re.I)
SENTENCE = re.compile(r"(?<=[.:])\s+(?=[\"'A-Z(\[])")


REFERENCE = re.compile(r"^(See |.{0,160}\b(?:is|are) (?:stated|described|listed) (?:in|below|above)\b[^,;]*\.$)")


def detect_clauses(ntext, zone_ids=(), has_cells=False, is_definition=False):
    """The clause ledger's skeleton for one provision's normalised text. The ledger partitions the text: every
    enumerated item (marker to next marker), every sentence before the first marker, and inside them every condition
    (if / unless / except / excluding / other than / provided that / when / where). Spans index the normalised text,
    so `quote == ntext[a:b]` always holds."""
    clauses, stack, seen_items = [], [], {}
    marks = _markers(ntext)
    first = marks[0][0] if marks else len(ntext)
    # sentences before the first marker (a provision without markers is all sentences)
    pos, n = 0, 0
    for piece in SENTENCE.split(ntext[:first]) if ntext[:first].strip() else []:
        i = ntext.find(piece, pos); pos = i + len(piece)
        q = piece.rstrip(" ;,")
        if not q.strip(): continue
        n += 1
        kind = "sentence"
        if n == 1 and q.endswith(".") and len(q.split()) <= 5 and not VERBS.search(q) and len(ntext) > i + len(q) + 1: kind = "heading"
        elif has_cells and not VERBS.search(q): kind = "caption"          # a table's caption or row labels: the cells hold the rule
        elif REFERENCE.match(q): kind = "reference"                       # "See ...", "... are stated in Table 110-4."
        elif q.endswith(":") and marks: kind = "stem"                     # "... must be:" followed by its items
        clauses.append({"id": f"sentence:{n}", "label": f"s{n}", "kind": kind, "parent": None, "span": [i, i + len(q)], "quote": q})
    for i, (a, b, label, paren) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(ntext)
        style = _style(label, paren, stack)
        shown = f"({label})" if paren else f"{label}."
        while stack and style in [x[0] for x in stack] and stack[-1][0] != style: stack.pop()
        if stack and stack[-1][0] == style: stack.pop()
        path = "".join(x[1] for x in stack) + shown
        k = seen_items[path] = seen_items.get(path, 0) + 1
        cid = f"item:{path}" + (f"#{k}" if k > 1 else "")
        parent = stack[-1][2] if stack else None
        stack.append((style, shown, cid))
        q = ntext[a:end].rstrip(" ;,")
        clauses.append({"id": cid, "label": path, "kind": "item", "parent": parent, "span": [a, a + len(q)], "quote": q})
    containers = [c for c in clauses if c["kind"] in CONTAINERS]
    seen, conds = {}, []
    for m in COND.finditer(ntext):
        k, a = m.group(1).lower(), m.start()
        box = next((c for c in containers if c["span"][0] <= a < c["span"][1]), None)
        if box is None: continue           # in the trailing punctuation of a span: nothing to list
        p_start, p_end = box["span"]
        lead = LEAD_IN.match(ntext, m.end())
        before = ntext[p_start:a]
        opens = re.fullmatch(r"\s*(\(\w{1,4}\)|\w{1,2}\.)?\s*", before) is not None
        if lead and lead.start() == m.end():
            b, kind = lead.end(), "lead_in"
        else:
            kind = "condition"
            leading = opens or re.search(r"[.:;]\s*$", before)
            nxt = COND.search(ntext, m.end(), p_end)
            stop = min(nxt.start() if nxt else p_end, p_end)
            e = SENT_END.search(ntext, m.end(), stop)
            b = e.start() if e else stop
            if leading:
                c = ntext.find(",", m.end(), stop)
                if 0 <= c < b: b = c
        q = ntext[a:b].rstrip(" ,;")
        tag = box["label"]
        n = seen[(tag, k)] = seen.get((tag, k), 0) + 1
        c = {"id": f"{kind}:{tag}/{k.replace(' ', '_').replace(',', '')}#{n}", "label": f"{tag} {k}", "kind": kind,
             "parent": box["id"], "span": [a, a + len(q)], "quote": q}
        conds.append(c)
        if kind == "condition" and opens and k in POSITIVE and "opened_by" not in box:
            box["opened_by"] = c["id"]     # "If X, ..." : the container applies only when X can hold
    clauses += conds
    for c in clauses:
        if c["kind"] in STRUCTURAL: c["needs"], c["guards"] = [], []; continue
        own = c["quote"]
        if c["kind"] in ("item", "sentence"):   # a container's own words: its conditions are listed (and guarded) on their own
            a0 = c["span"][0]
            for d in conds:
                if c["span"][0] <= d["span"][0] and d["span"][1] <= c["span"][1]:
                    x, y = d["span"][0] - a0, d["span"][1] - a0
                    own = own[:x] + " " * (y - x) + own[y:]
        c["needs"], c["guards"] = needs_of(own, zone_ids)
        if c["kind"] == "item":     # a stem ("(b) As used in this subsection:") holds no rule of its own; its items do
            words = re.sub(r"^\s*(\(\w{1,4}\)|\w{1,2}\.)\s*", "", own).strip()
            c["stem"] = words == "" or words.endswith(":")
    if is_definition:                     # a definition is never ruled out by a word in its own text (D7)
        for c in clauses: c["guards"] = []
    return clauses


def uncovered(ntext, clauses):
    """Characters of the text (letters and digits) that no item, sentence or heading covers: must be none."""
    cov = bytearray(len(ntext))
    for c in clauses:
        if c["kind"] in CONTAINERS:
            for i in range(c["span"][0], min(c["span"][1], len(ntext))): cov[i] = 1
    return [i for i, ch in enumerate(ntext) if ch.isalnum() and not cov[i]]


BARE_FOOT = re.compile(r"\b(?:ft|feet)\.\s*(\d{1,2})\s*$", re.I)
CODE_FOOT = re.compile(r"^(?:P|L|SUR|NP)(?:/(?:P|L|SUR|NP))*(\d{1,2}(?:\s*,\s*\d{1,2})*)$")


def cell_key(c):
    """Canonical key for a table cell or a parameter's cell reference (Q1):
    (table, row_group, row_index, row, column_group, column), where missing keys count as empty."""
    rg = c.get("row_group")
    ri = c.get("row_index")
    cg = c.get("column_group")
    return (
        c.get("table") or "",
        "" if rg is None else str(rg),
        "" if ri is None else str(ri),
        c.get("row") or "",
        "" if cg is None else str(cg),
        c.get("column") or "",
    )


def cell_ref(c):
    """Cell reference dict preserving row_group, row_index, and column_group when present (Q1)."""
    ref = {"table": c["table"], "row": c["row"], "column": c["column"]}
    for k in ("row_group", "row_index", "column_group"):
        if c.get(k) is not None:
            ref[k] = c[k]
    return ref


def _table_token(table):
    m = re.search(r"Table\s+([\dA-Za-z.\-]+?)(?::|\s|$)", table or "")
    return m.group(1).rstrip(".") if m else None


def sibling_note_texts(pid, doc_id, provisions, table=None):
    """Texts of sibling .notes/.NOTES provisions for a table provision in the same document."""
    base = re.split(r"\.notes?\b", pid or "", flags=re.I)[0]
    tok = _table_token(table)
    if not tok and pid:
        mt = re.search(r"\.T([\dA-Za-z.\-]+?)(?:\.(?:notes?|far|coverage|setbacks|height|main|part)|$)", pid, flags=re.I)
        if mt:
            tok = mt.group(1).rstrip(".")
    out = []
    for q in provisions:
        qid = q.get("id") or ""
        if qid == pid or "note" not in qid.lower():
            continue
        qdoc = q.get("document") or ((q.get("versions") or [{}])[0].get("source") or {}).get("document")
        if qdoc != doc_id:
            continue
        match_base = bool(base) and qid.startswith(base) and "note" in qid[len(base):].lower()
        match_tok = bool(tok) and re.search(rf"\.T{re.escape(tok)}\.", qid + ".") is not None
        if not (match_base or match_tok):
            continue
        qtext = q.get("text") if "text" in q else ((q.get("versions") or [{}])[0].get("text") or "")
        if qtext:
            out.append(qtext)
    return out


def extract_table_footnotes(sibling_texts):
    """Map footnote number string -> normalised footnote text from sibling .notes/.NOTES provisions."""
    notes = {}
    for t in sibling_texts:
        nt = norm(t)
        for m in re.finditer(r"\[(\d{1,2})\]\s*(.*?)(?=\s*\[\d{1,2}\]|$)", nt):
            notes.setdefault(m.group(1), norm(f"[{m.group(1)}] {m.group(2)}"))
        marks = list(re.finditer(r"(?:^|(?<=[\s:.]))(?<!Section\s)(?<!Table\s)(\d{1,2})\.\s+(?=[A-Z0-9])", nt))
        if marks and int(marks[0].group(1)) > 1:
            lead = nt[:marks[0].start()].strip()
            if lead and not re.search(r"Notes:?\s*$", lead, re.I):
                prev_n = str(int(marks[0].group(1)) - 1)
                notes.setdefault(prev_n, norm(f"[{prev_n}] {lead}"))
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(nt)
            n = m.group(1)
            body = nt[m.end():end].strip()
            notes.setdefault(n, norm(f"[{n}] {body}"))
    return notes


def strip_label_footnotes(label, known_notes=(), zone_ids=()):
    """Strip footnote numbers glued onto row/row_group/column labels only when the number is in known_notes
    and the remainder is not a zone code or a number (GR-35, Q6)."""
    if not label or not known_notes:
        return norm(str(label or "")), []
    s = norm(str(label))
    zone_set = set(zone_ids or ())
    if s in zone_set:
        return s, []
    found = []
    notes_set = set(known_notes)
    real_zones_no_hyphen = {z.replace("-", "") for z in zone_set} | zone_set

    def _fix_hyphen_zone(m):
        base, d = m.group(1), m.group(2)
        if base in zone_set and f"{base}{d}" not in zone_set and d in notes_set:
            if d not in found: found.append(d)
            return base
        return m.group(0)

    s = re.sub(r"\b([A-Z]{2,4}-\d)(\d)\b", _fix_hyphen_zone, s)

    def _fix_glued_word(m):
        full = m.group(0)
        word, num = m.group(1), m.group(2)
        if full in real_zones_no_hyphen or word.endswith("-"):
            return full
        if word.isupper() and len(word) <= 4 and word not in zone_set:
            return full
        if num in notes_set:
            if num not in found: found.append(num)
            return word
        return full

    s = re.sub(r"\b([A-Za-z][A-Za-z-]*?)(\d{1,2})(?![\d]|\.\d|-)", _fix_glued_word, s)

    def _fix_trailing_list(m):
        nums = [n.strip() for n in m.group(1).split(",")]
        if all(n in notes_set for n in nums):
            for n in nums:
                if n not in found: found.append(n)
            return ""
        return m.group(0)

    s = re.sub(r"(?<=[A-Za-z)])\s+(\d{1,2}(?:\s*,\s*\d{1,2})*)(?=\s*$|\s+\d{1,2}\.\s)", _fix_trailing_list, s)
    return norm(s), found


def unverified_bare_footnote(cell, known_notes=()):
    """If cell has a trailing number after ft./feet. or on a use code that is NOT in known_notes, return it (Q6)."""
    nc = norm(cell)
    notes_set = set(known_notes or ())
    m = BARE_FOOT.search(nc)
    if m and m.group(1) not in notes_set:
        return m.group(1)
    mc = CODE_FOOT.match(nc)
    if mc:
        for n in re.split(r"\s*,\s*", mc.group(1)):
            if n not in notes_set:
                return n
    return None


def footnote_markers(cell, known_notes=(), zone_ids=(), label=False):
    nc = norm(str(cell or ""))
    notes_set = set(known_notes or ())
    out = [n for g in re.findall(r"\[(\d+(?:\s*,\s*\d+)*)\]", nc) for n in re.split(r"\s*,\s*", g)]
    t = re.sub(r"\[[\d,\s]+\]", " ", nc)
    cands = []
    for z in zone_ids:
        for m in re.finditer(rf"(?<![\w.-]){re.escape(z)}(\d{{1,2}})(?![\d]|\.\d)", t):
            if z + m.group(1) not in zone_ids:
                cands.append(m.group(1))
    for z in sorted(zone_ids, key=len, reverse=True):
        t = re.sub(rf"(?<![\w.-]){re.escape(z)}(?![\w-]|\.\d)", " ", t)
    lists = []
    lists += re.findall(r"(?<=[A-Za-z])(\d{1,2}(?:\s*,\s*\d{1,2})*)(?![\d]|\.\d|-)", t)
    lists += re.findall(r"(?<=ft\.)\s?(\d{1,2}(?:\s*,\s*\d{1,2})*)(?!\d|\.\d)", t)
    if label:
        lists += re.findall(r"(?<=[A-Za-z)])\s(\d{1,2}(?:\s*,\s*\d{1,2})*)(?=\s*$|\s+\d{1,2}\.\s)", t)
    else:
        lists += re.findall(r"(?:(?<=acre)|(?<=units))\s(\d{1,2}(?:\s*,\s*\d{1,2})*)(?=\s*$)", t)
    cands += [n for g in lists for n in re.split(r"\s*,\s*", g) if n]
    for n in cands:
        if n in notes_set and n not in out:
            out.append(n)
    return out


CELL_LABEL_KEYS = ("row", "row_group", "row_index", "column", "column_group")


def cell_footnotes(c, known_notes=(), zone_ids=()):
    """Footnote markers printed on a cell or on any row/column/group label governing it (GR-34)."""
    out = list(footnote_markers(c.get("cell") or "", known_notes, zone_ids, label=False))
    for k in CELL_LABEL_KEYS:
        if c.get(k) is not None:
            for n in footnote_markers(str(c[k]), known_notes, zone_ids, label=True):
                if n not in out:
                    out.append(n)
    return out


def detect_footnotes(cells, zone_ids=(), known_notes=None):
    """GR-32 / GR-34 for tables: each footnote marker governing a cell is a condition on those cells."""
    by = {}
    for c in cells:
        marks = (
            cell_footnotes(c, known_notes, zone_ids)
            if known_notes is not None
            else (c.get("footnotes") if "footnotes" in c else cell_footnotes(c, (), zone_ids))
        )
        for n in marks:
            by.setdefault(n, []).append(c)
    out = []
    for n, cs in sorted(by.items(), key=lambda kv: int(kv[0])):
        cols = sorted({c["column"] for c in cs})
        zones = [z for z in cols if z in zone_ids]
        guards = [{"fact": "site.zone", "op": "in", "value": zones}] if zones and len(zones) == len(cols) else []
        out.append({"id": f"footnote:{cs[0]['table']}[{n}]", "label": f"[{n}]", "kind": "footnote", "quote": f"[{n}]",
                    "cells": [cell_ref(c) for c in cs],
                    "needs": ["the footnote's own conditions"] + (["site.zone"] if guards else []), "guards": guards})
    return out


# ---------- the fact lexicon: which site or plan facts a clause's words point at (keyword match, not a model) ----------
# guard: the clause can only bite when this fact holds; a clause is ruled out only when ALL its guards are known false.
LEXICON = [
    (r"\bcorner lots?\b", "site.corner_lot", "true"),
    (r"\bside street lot line", "site.side_street_lot_line", None),
    (r"\bmore than one structure", "site.other_structures_in_setback", "count>0"),
    (r"\bgable", "plan.gable_walls", "true"),
    (r"\bdormers?\b", "plan.dormers", "true"),
    (r"\bscreen(ed|ing)?\b|\bfences?\b", "site.screening", None),
    (r"\brooftop deck", "plan.rooftop_deck", "true"),
    (r"\bdoors or windows facing", "plan.openings_facing_lot_line", "true"),
    (r"\bbasement", "plan.basement_conversion", "true"),
    (r"\bduplex", "site.primary_is_duplex", "true"),
    (r"\beaves?\b", "plan.eave_ft", None),
    (r"\bflag lots?\b", "site.flag_lot", "true"),
    (r"\bthrough lots?\b", "site.through_lot", "true"),
    (r"\balley", "site.alley", "true"),
    (r"\bwater collection cisterns?", "plan.is_cistern", "true"),
    (r"\bgarages?\b|\bcarports?\b", "plan.is_garage", None),
    (r"\btrees?\b", "site.trees", "true"),
    (r"\bslopes?\b|\bsteep", "site.slope_pct", None),
    (r"\bhistoric", "site.historic_resource", "true"),
    (r"\boverlay|\benvironmental zone|\bplan district", "site.overlays", "nonempty"),
    (r"\bmanufactured (home|dwelling)", "site.primary_is_manufactured", "true"),
    (r"\battached house", "site.primary_is_attached_house", "true"),
    (r"\bmain entrance", "site.house_main_entrance", None),
    (r"\brear (building )?wall", "site.house_rear_wall", None),
    (r"\bfront lot line", "site.front_lot_line", None),
    (r"\bheight|\bhigh\b", "plan.height_ft", None),
    (r"\bliving area", "plan.living_area_sqft", None),
    (r"\bsetbacks?\b", "plan.setbacks_used", None),
    (r"\bvacation occupanc", "plan.vacation_occupancy", "true"),
    (r"\bowner.occupancy", "plan.owner_occupancy_required", None),
    (r"\bparking", "plan.parking", None),
]


ZONE_FAMILY = re.compile(r"\b(single-dwelling|multi-dwelling|commercial(?:/mixed[- ]use)?|mixed[- ]use|industrial|employment|residential)\b[^.;:]{0,40}?\bzones?\b", re.I)
FAMILIES = {"single-dwelling": ["single_dwelling"], "multi-dwelling": ["multi_dwelling"], "commercial": ["commercial_mixed_use"],
            "mixed-use": ["commercial_mixed_use"], "industrial": ["industrial"], "employment": ["industrial"],
            "residential": ["single_dwelling", "multi_dwelling"]}


def zone_regex(z):
    return rf"(?<![\w.]){re.escape(z)}(?![\w]|\.\d)"


def needs_of(quote, zone_ids=()):
    needs, guards = [], []
    for rx, fact, g in LEXICON:
        if re.search(rx, quote, re.I):
            if fact not in needs: needs.append(fact)
            if g and not any(x["fact"] == fact for x in guards): guards.append({"fact": fact, "op": g})
    fams = []
    for m in ZONE_FAMILY.finditer(quote):
        for f in FAMILIES[m.group(1).lower().replace(" ", "-").split("/")[0]]:
            if f not in fams: fams.append(f)
    if fams:
        needs.append("site.zone_family"); guards.append({"fact": "site.zone_family", "op": "in", "value": fams})
    zones = [z for z in zone_ids if re.search(zone_regex(z), quote)]
    zl = list(zone_ids)                 # "X through Y" names every zone between them, in the layer's order (W4/step 2, 2026-11-01)
    for m in re.finditer(r"\b([A-Z][\w.]*\w) through ([A-Z][\w.]*\w)\b", quote):
        a, b = m.group(1), m.group(2)
        if a in zl and b in zl:
            i, j = sorted((zl.index(a), zl.index(b)))
            for z in zl[i:j + 1]:
                if z not in zones: zones.append(z)
    if zones:
        needs.append("site.zone"); guards.append({"fact": "site.zone", "op": "in", "value": zones})
    if not needs: needs = ["unrecognised: no fact in the lexicon matches these words; read the clause"]
    return needs, guards


def guard_known_false(g, facts):
    """True only when the fact is known and the guard cannot hold."""
    if g["fact"] not in facts or facts[g["fact"]] is None: return False
    v = facts[g["fact"]]
    if g["op"] == "true": return v is False
    if g["op"] == "count>0": return isinstance(v, (int, float)) and not isinstance(v, bool) and v <= 0
    if g["op"] == "nonempty": return isinstance(v, list) and len(v) == 0
    if g["op"] == "in": return v not in g["value"]
    return False


# ---------- GR-33: table cells ----------
FOOT = r"(?:\s*\[[\d,\s]+\])?"
CELL_FORMS = [
    (re.compile(rf"^(\d[\d,]*(?:\.\d+)?) (?:ft\.|feet\.?){FOOT}$", re.I), "ft"),   # "10 feet" too (33.110.255.B.1.a, CC 11-02)
    (re.compile(rf"^(\d[\d,]*(?:\.\d+)?) sq\. ?ft\.?{FOOT}$"), "sqft"),
    (re.compile(rf"^(\d+(?:\.\d+)?) to 1{FOOT}$"), "ratio"),
    (re.compile(rf"^(Yes|No){FOOT}$"), None),
    (re.compile(rf"^(\d+(?:\.\d+)?)% of Lot{FOOT}$"), "%"),   # Eugene Table 9.2750 "50% of Lot" (CC 11-02)
    # Eugene Table 9.2740's legend: "(P) Permitted." A bare P, or P with its special-use-limitation number "P(3)", is
    # allowed; S, SR, C and PUD (permitted only after a further review or standard) stay cells (CC 11-02).
    (re.compile(r"^(P)(?:\(\d+\))?$"), None),
]


def _strip_verified_bare_footnote(c, known_notes=()):
    m = BARE_FOOT.search(c)
    if m and m.group(1) in set(known_notes or ()):
        return c[:m.start(1)].rstrip()
    return c


def parse_cell(cell, known_notes=()):
    """A cell's value when the cell is a single plain quantity or Yes/No; None otherwise (then it stays a cell only)."""
    c = _strip_verified_bare_footnote(norm(cell), known_notes)
    for rx, unit in CELL_FORMS:
        m = rx.match(c)
        if not m: continue
        v = m.group(1)
        if v in ("Yes", "No"): return v == "Yes", None
        if v == "P": return True, None
        v = v.replace(",", "")
        return (float(v) if "." in v else int(v)), unit
    return None


def value_in_cell(value, cell, known_notes=()):
    c = _strip_verified_bare_footnote(norm(cell), known_notes)
    if isinstance(value, bool): return re.match(rf"^{'Yes' if value else 'No'}\b", c) is not None or (value and re.match(r"^P(?:\(\d+\))?$", c) is not None)
    if isinstance(value, (int, float)): return number_in(value, re.sub(r"\[[\d,\s]+\]", "", c))
    if isinstance(value, str): return norm(value) in c
    return False


def slug(label, known_notes=(), zone_ids=()):
    cleaned, _ = strip_label_footnotes(label, known_notes, zone_ids)
    s = re.sub(r"\[[\d,\s]+\]", "", norm(cleaned)).strip(" -")
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def table_region(doc_variants, anchor, table):
    """Where a table's cells may sit: from 800 chars before the provision's own words (or the table's name) to 12,000
    characters on. pdftotext's reading order keeps a table's cells together on the page (occasionally emitting the
    first column block before a rotated header banner), so this is a window, not a grid."""
    for v in doc_variants:
        for key in (norm(anchor), norm(table)):
            i = v.find(key) if key else -1
            if i >= 0: return v[max(0, i - 800):i + len(key) + 12000]
    return ""


def cell_position(region, cells, cell):
    """The strongest position evidence for one cell: its whole row, in column order, appears contiguously in the
    region ('row_sequence'); else its whole column in row order ('column_sequence'); else only the cell text
    ('present'); else ''."""
    t, rg, ri, row, _, _ = cell_key(cell)
    same_row = [c for c in cells if cell_key(c)[:4] == (t, rg, ri, row)]
    same_col = [c for c in cells if c.get("table") == cell["table"] and c.get("column") == cell["column"]]
    rowseq = " ".join(norm(c["cell"]) for c in same_row)
    colseq = " ".join(norm(c["cell"]) for c in same_col)
    if rowseq and rowseq in region and len(same_row) > 1: return "row_sequence"
    if colseq and colseq in region and len(same_col) > 1: return "column_sequence"
    if norm(cell["cell"]) in region: return "present"
    return ""


# ---------- time ----------
def in_force_from(v):
    ds = [d for d in (v.get("effective_from"), v.get("operative_from")) if d]
    return max(ds) if ds else None


def status_on(v, date):
    """in_force | not_yet_in_force | ended | in_force_date_not_stated (no date in the text: included, flagged)."""
    start = in_force_from(v)
    if v.get("effective_to") and date >= v["effective_to"]: return "ended"
    if start is None: return "in_force_date_not_stated"
    return "in_force" if date >= start else "not_yet_in_force"


MONTHS = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August",
                                         "September", "October", "November", "December"], 1)}


def dates_in(quote):
    return [f"{int(y):04d}-{MONTHS[m]:02d}-{int(d):02d}" for m, d, y in re.findall(r"\b(" + "|".join(MONTHS) + r") (\d{1,2}), (\d{4})", quote)]
