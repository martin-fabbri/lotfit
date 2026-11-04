"""The modeled layer of graph v6: what the evaluating agent reads besides the code text. CC, 2026-11-01.

  facts         the registry of typed facts (GR-11)                 curated/facts.json
  operators     each kind of rule -> tool, facts, parameters (GR-12) curated/operators.json, tools/
  conventions   lot frame, placement anchor, faces (GR-31)          curated/conventions.json
  relations     modifies / preempts / uses, quoted (GR-15, GR-06)   curated/relations.json
  ambiguities   when a gray area matters (GR-30)                    curated/ambiguities.json
  confirmations a person's act, pinned (GR-10)                      curated/confirmations.jsonl (append-only)
  reading guide the index-first procedure and skeleton (GR-18)      curated/reading-guide.md

ingest.py embeds it in the graph as g["model"]; build.py validates it with validate_model. Functions here answer the
agent's questions: family(), index(), confirmation_status(), validate_input(), resolve_doubts()."""
import datetime, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import norm, status_on  # noqa: E402
import tools as T  # noqa: E402

CURATED = os.path.join(HERE, "curated")
VERDICTS = ["FITS", "FITS_IF", "NO_LEGS", "BLOCKED_BY_GATE", "NEEDS_CHECK", "NOT_MODELED"]
TYPES = {"bool", "quantity", "count", "enum", "list", "polygon", "line", "lines", "point", "structures", "placement", "text", "date"}
GENERIC_PEOPLE = {"", "system", "auto", "automatic", "script", "bot", "unknown", "n/a"}


def load_model(curated=CURATED):
    def j(name):
        return json.load(open(os.path.join(curated, name), encoding="utf-8"))
    log = os.path.join(curated, "confirmations.jsonl")
    conf = [json.loads(l) for l in open(log, encoding="utf-8") if l.strip()] if os.path.exists(log) else []
    return {"facts": j("facts.json"), "operators": j("operators.json"), "conventions": j("conventions.json"),
            "relations": j("relations.json"), "ambiguities": j("ambiguities.json"), "confirmations": conf,
            "reading_guide": open(os.path.join(curated, "reading-guide.md"), encoding="utf-8").read(),
            "verdicts": VERDICTS}


def fact_index(m):
    return {f["name"]: f for f in m["facts"]["facts"]}


def _latest(p):
    return p["versions"][-1]


# ---------------------------------------------------------------- validation (build)
def validate_model(g):
    """Problems and warnings for the modeled layer; build.py adds them to its own."""
    problems, warnings = [], []
    P, W = problems.append, warnings.append
    m = g.get("model")
    if not m: P("model: the graph carries no modeled layer (GR-10/11/12/15/18/22/29/30/31)"); return problems, warnings
    prov = {p["id"]: p for p in g["provisions"]}
    F = fact_index(m)
    kinds = set(m["facts"]["source_kinds"])
    markers = set(m["facts"].get("markers_not_facts", []))

    # GR-11: facts are typed, sourced, and every fact the graph reads is registered
    for n, f in F.items():
        if not re.fullmatch(r"(site|plan|jurisdiction)\.[a-z0-9_]+", n): P(f"fact {n}: name must be scope.snake_case")
        if f.get("scope") != n.split(".")[0]: P(f"fact {n}: scope must match its name")
        if f.get("type") not in TYPES: P(f"fact {n}: type {f.get('type')!r} is not one of {sorted(TYPES)}")
        if f.get("type") == "quantity" and not f.get("unit"): P(f"fact {n}: a quantity needs a unit")
        if not f.get("accepted_sources") or set(f["accepted_sources"]) - kinds: P(f"fact {n}: accepted_sources must be from {sorted(kinds)}")
        if "computed" in f.get("accepted_sources", []) and not (f.get("computed") or {}).get("from"): P(f"fact {n}: a computed fact says how and from what")
        for d in (f.get("computed") or {}).get("from", []):
            if d not in F: P(f"fact {n}: computed from unregistered fact {d}")
    for p in g["provisions"]:
        for v in p["versions"]:
            for c in v.get("clauses", []):
                for x in c.get("needs", []) + [gd["fact"] for gd in c.get("guards", [])]:
                    if x not in F and x not in markers: P(f"{p['id']} v{v['version']} {c['id']}: needs unregistered fact {x} (GR-11)")

    # GR-12: operators name existing tools, registered facts, real parameters; GR-29: placing operators read the site
    for o in m["operators"]["operators"]:
        oid = o.get("id")
        if o.get("tool") not in T.TOOLS: P(f"operator {oid}: tool {o.get('tool')!r} does not exist (GR-12)"); continue
        for r in o.get("reads", []) + T.TOOLS[o["tool"]].reads:
            if r not in F: P(f"operator {oid}: reads unregistered fact {r}")
        for x in o.get("params", []):
            pv = prov.get(x["provision"])
            if pv is None or x["param"] not in {q["name"] for q in _latest(pv)["params"]}: P(f"operator {oid}: parameter {x['provision']}:{x['param']} is not in the graph")
        for pid in o.get("provisions", []):
            if pid not in prov: P(f"operator {oid}: provision {pid} is not in the graph")
        # Measure 2 (11-02): each required check names an existing tool, registered facts, and a real parameter per zone
        for rq in o.get("requires", []):
            if rq.get("tool") not in T.TOOLS: P(f"operator {oid}: required tool {rq.get('tool')!r} does not exist")
            for f in (rq.get("match") or {}).values():
                if f not in F: P(f"operator {oid}: required check matches unregistered fact {f}")
            if rq.get("param"):
                rp, rn = rq["param"].split(":", 1)
                names = {q["name"] for q in _latest(prov[rp])["params"]} if rp in prov else set()
                # {zone} is checked for one zone of the parameter's own layer that the parameter actually carries
                lay = (prov.get(rp) or {}).get("layer")
                zs = [z["id"] for z in g.get("zones", []) if z.get("layer", lay) == lay] or ["R5"]
                hit = [rn.replace("{zone}", z) for z in zs if rn.replace("{zone}", z) in names]
                want = (hit[:1] or [rn.replace("{zone}", zs[0])]) if "{zone}" in rn else [rn]
                for w in want:
                    if w not in names: P(f"operator {oid}: required parameter {rp}:{w} is not in the graph")
        # L40 (11-02): a covered clause is one this operator's tool evaluates. It must exist in a provision the operator
        # models, be quoted verbatim, and not be structural (a structural clause has no rule of its own).
        for cv in o.get("covers", []):
            pv = prov.get(cv.get("provision"))
            if cv.get("provision") not in o.get("provisions", []): P(f"operator {oid}: covers a clause of {cv.get('provision')}, which it does not model")
            cl = next((c for c in _latest(pv)["clauses"] if c["id"] == cv.get("clause")), None) if pv else None
            if cl is None: P(f"operator {oid}: covered clause {cv.get('provision')} {cv.get('clause')} is not in the graph"); continue
            if cl.get("quote") != cv.get("quote"): P(f"operator {oid}: covered clause {cv.get('clause')} quote differs from the clause text")
            if cl.get("status") == "structural": P(f"operator {oid}: covered clause {cv.get('clause')} is structural")
        if o.get("places") and not {"site.lot_outline", "site.house_outline", "site.structures"} <= set(o.get("reads", []) + T.TOOLS[o["tool"]].reads):
            P(f"operator {oid}: a placing operator must read the lot outline, the house and existing structures (GR-29)")

    # GR-31: the conventions are stated
    cv = m["conventions"]
    for k in ("lot_frame", "plan_frame", "placement"):
        if not cv.get(k): P(f"conventions: {k} is not stated (GR-31)")
    if set((cv.get("plan_frame") or {}).get("faces", {})) != {"front", "rear", "left", "right"}: P("conventions: the plan's four faces are not all defined (GR-31)")

    # GR-15 / GR-06: relations quote their source and connect the right types
    want = {"modifies": {"exception"}, "preempts": {"preemption"}}
    for r in m["relations"]["relations"]:
        tag = f"relation {r.get('from')} -{r.get('kind')}-> {r.get('to')}"
        a, b = prov.get(r.get("from")), prov.get(r.get("to"))
        if a is None or b is None: P(f"{tag}: an end is not in the graph"); continue
        if r["kind"] not in ("modifies", "preempts", "uses"): P(f"{tag}: unknown kind"); continue
        if not r.get("quote") or norm(r["quote"]) not in norm(_latest(a)["text"]): P(f"{tag}: quote not found in {r['from']}")
        if r["kind"] in want and a["type"] not in want[r["kind"]]: P(f"{tag}: a {r['kind']} relation starts at a {sorted(want[r['kind']])[0]}, not a {a['type']}")
        if r["kind"] == "uses" and (b["type"] != "definition" or r.get("term") not in b.get("terms", [])): P(f"{tag}: 'uses' must reach a definition by one of its terms")

    # GR-30: ambiguities point at a recorded reading
    for x in m["ambiguities"]["ambiguities"]:
        pv = prov.get(x.get("provision"))
        rs = [r for v in (pv or {}).get("versions", []) for r in v.get("readings") or []]
        hit = [r for r in rs if norm(r["phrase"]) == norm(x.get("phrase", ""))]
        if not hit: P(f"ambiguity {x.get('id')}: no reading with that phrase in {x.get('provision')}"); continue
        if x.get("status") not in ("active", "settled"): P(f"ambiguity {x['id']}: status must be active or settled")
        for c in x.get("matters_when", []):
            if c["fact"] not in F: P(f"ambiguity {x['id']}: matters_when reads unregistered fact {c['fact']}")
        for e in x.get("effects", []):
            if "by_reading" in e and len(e["by_reading"]) != len(hit[0]["readings"]): P(f"ambiguity {x['id']}: effects give {len(e['by_reading'])} values for {len(hit[0]['readings'])} readings")
            if e.get("fact") and e["fact"] not in F: P(f"ambiguity {x['id']}: effect on unregistered fact {e['fact']}")

    # GR-10: the confirmation log is an append-only chain of single, named, dated acts
    prev = None
    seen = set()
    for i, c in enumerate(m.get("confirmations", [])):
        tag = f"confirmation {i + 1}"
        if c.get("prev") != prev: P(f"{tag}: the log was edited or reordered (prev hash breaks the chain)")
        prev = hashlib.sha256(json.dumps(c, sort_keys=True).encode()).hexdigest()
        if str(c.get("by", "")).strip().lower() in GENERIC_PEOPLE: P(f"{tag}: confirmed by an unnamed person")
        if not isinstance(c.get("item"), str): P(f"{tag}: one item per confirmation")
        try:
            on = datetime.date.fromisoformat(c.get("date", ""))
            last = item_last_changed(g, c.get("item"))
            if last and on < last: P(f"{tag}: dated {on}, before its item last changed ({last})")
        except ValueError:
            P(f"{tag}: date must be YYYY-MM-DD")
        key = (c.get("by"), c.get("at"))
        if key in seen: P(f"{tag}: two confirmations by {c.get('by')} at the same instant (no bulk re-stamp)")
        seen.add(key)
        if c.get("item") and resolve_item(g, c["item"]) is None: P(f"{tag}: item {c['item']} is not in the graph")
    return problems, warnings


# ---------------------------------------------------------------- GR-15 families
def family(g, rule_id):
    """A rule with its exceptions (recursively), the preemptions that can override it, every definition reachable
    through uses (recursively, from any member), and the gray areas recorded on any member."""
    rel = g["model"]["relations"]["relations"]
    prov = {p["id"]: p for p in g["provisions"]}
    exc, todo = [], [rule_id]
    while todo:
        t = todo.pop()
        for r in rel:
            if r["kind"] == "modifies" and r["to"] == t and r["from"] not in exc:
                exc.append(r["from"]); todo.append(r["from"])
    members = [rule_id] + exc
    pre = [r["from"] for r in rel if r["kind"] == "preempts" and r["to"] in members]
    defs, todo = [], list(members + pre)
    seen = set(todo)
    while todo:
        t = todo.pop()
        for r in rel:
            if r["kind"] == "uses" and r["from"] == t and r["to"] not in defs:
                defs.append(r["to"])
                if r["to"] not in seen: seen.add(r["to"]); todo.append(r["to"])
        for u in prov[t].get("uses", []):                         # uses the extraction already states
            if u in prov and u not in defs:
                defs.append(u)
                if u not in seen: seen.add(u); todo.append(u)
    amb = [{"provision": pid, "phrase": r["phrase"], "question": r["question"]}
           for pid in members + pre + defs for v in prov[pid]["versions"] for r in v.get("readings") or []]
    return {"rule": rule_id, "exceptions": exc, "preemptions": pre, "definitions": defs, "ambiguities": amb}


# ---------------------------------------------------------------- GR-18 index
def index(g):
    """A compact index per layer: no text, only what tells the agent which provisions to read."""
    out = {}
    for lay in sorted(g["layers"], key=lambda l: l["order"]):
        rows = []
        for p in g["provisions"]:
            if p["layer"] != lay["id"]: continue
            v = _latest(p)
            rows.append({"id": p["id"], "type": p["type"], "title": p.get("title"), "section": p.get("section"),
                         "topics": p.get("topics", []), "params": [q["name"] for q in v.get("params", [])],
                         "gray_areas": len(v.get("readings") or []), "from": v.get("operative_from") or v.get("effective_from"),
                         "versions": len(p["versions"])})
        out[lay["id"]] = {"order": lay["order"], "provisions": rows}
    return out


def tokens(obj):
    """A token estimate: about four characters per token, on compact JSON or plain text."""
    s = obj if isinstance(obj, str) else json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    return len(s) // 4


def evaluation_reading(g, rule_ids, date):
    """What an agent reading index-first reads for one evaluation: the index, the guide, and for each rule's family
    the text of the versions in force on the date, with their parameters."""
    prov = {p["id"]: p for p in g["provisions"]}
    ids = []
    for r in rule_ids:
        f = family(g, r)
        for x in [r] + f["exceptions"] + f["preemptions"] + f["definitions"]:
            if x not in ids: ids.append(x)
    texts = []
    for pid in ids:
        live = [v for v in prov[pid]["versions"] if status_on(v, date) in ("in_force", "in_force_date_not_stated")]
        for v in live[-1:]:
            texts.append({"id": pid, "text": v["text"], "params": v.get("params", []), "readings": v.get("readings", [])})
    return {"index": index(g), "guide": g["model"]["reading_guide"], "texts": texts}


# ---------------------------------------------------------------- GR-10 confirmations
def resolve_item(g, item):
    """An item is 'provision:<id>' (its latest version), 'operator:<id>', 'relation:<from>><to>' or 'fact:<name>'."""
    kind, _, key = (item or "").partition(":")
    m = g["model"]
    if kind == "provision": return next((p for p in g["provisions"] if p["id"] == key), None)
    if kind == "operator": return next((o for o in m["operators"]["operators"] if o["id"] == key), None)
    if kind == "relation": return next((r for r in m["relations"]["relations"] if f"{r['from']}>{r['to']}" == key), None)
    if kind == "fact": return fact_index(m).get(key)
    return None


def item_last_changed(g, item):
    """The latest date the item or the documents it rests on changed: the curated file's date, or the version's
    effective date and its document's retrieval date."""
    kind, _, key = (item or "").partition(":")
    if kind == "provision":
        p = resolve_item(g, item)
        if p is None: return None
        v = _latest(p)
        doc = next((d for d in g["documents"] if d["id"] == v["source"]["document"]), {})
        ds = [x for x in (v.get("effective_from"), (doc.get("retrieved") or "")[:10]) if x]
        return max(datetime.date.fromisoformat(x) for x in ds) if ds else None
    src = {"operator": "operators", "relation": "relations"}.get(kind)
    if src: return datetime.date.fromisoformat(g["model"][src]["date"])
    return None


def _h(x):
    return hashlib.sha256(json.dumps(x, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def pins(g, item):
    """Everything an item rests on, hashed: the item itself; for a provision, its version (text and parameters), its
    document, the definitions it uses and the operators that model it with the facts they read."""
    m = g["model"]
    F = fact_index(m)
    out = {"item": _h(resolve_item(g, item))}
    kind, _, key = item.partition(":")
    if kind == "provision":
        p = resolve_item(g, item)
        v = _latest(p)
        out["version"] = _h({"v": v["version"], "text": v["text"], "params": v.get("params"), "from": v.get("effective_from")})
        doc = next((d for d in g["documents"] if d["id"] == v["source"]["document"]), {})
        out["document"] = doc.get("sha256")
        prov = {q["id"]: q for q in g["provisions"]}
        defs = sorted({r["to"] for r in m["relations"]["relations"] if r["kind"] == "uses" and r["from"] == key} | set(p.get("uses", [])))
        for d in defs:
            if d in prov: out[f"definition:{d}"] = _h(_latest(prov[d])["text"])
        for o in m["operators"]["operators"]:
            if key in o.get("provisions", []):
                out[f"operator:{o['id']}"] = _h(o)
                for f in sorted(set(o.get("reads", []))):
                    out[f"fact:{f}"] = _h(F.get(f))
    if kind == "operator":
        o = resolve_item(g, item)
        for f in sorted(set(o.get("reads", []))): out[f"fact:{f}"] = _h(F.get(f))
    return out


def confirmation_status(g, item):
    """confirmed (with who and when), stale (with what changed), or unconfirmed. The latest confirmation counts."""
    cs = [c for c in g["model"].get("confirmations", []) if c.get("item") == item]
    if not cs: return {"item": item, "status": "unconfirmed"}
    c = cs[-1]
    now = pins(g, item)
    changed = sorted(k for k in set(now) | set(c["pins"]) if now.get(k) != c["pins"].get(k))
    if changed: return {"item": item, "status": "stale", "changed": changed, "by": c["by"], "date": c["date"]}
    return {"item": item, "status": "confirmed", "by": c["by"], "date": c["date"]}


def confirm(g, item, by, date, log_path, note=""):
    """Append ONE confirmation to the log (there is no bulk form). Returns the entry."""
    if str(by).strip().lower() in GENERIC_PEOPLE: raise ValueError("a confirmation is a named person's act")
    if resolve_item(g, item) is None: raise ValueError(f"{item} is not in the graph")
    lines = [l for l in open(log_path, encoding="utf-8") if l.strip()] if os.path.exists(log_path) else []
    prev = hashlib.sha256(json.dumps(json.loads(lines[-1]), sort_keys=True).encode()).hexdigest() if lines else None
    e = {"item": item, "by": by, "date": date, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
         "pins": pins(g, item), "note": note, "prev": prev}
    with open(log_path, "a", encoding="utf-8") as fh: fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    g["model"].setdefault("confirmations", []).append(e)
    return e


# ---------------------------------------------------------------- GR-22 inputs
def _typed(f, v):
    t = f["type"]
    num = isinstance(v, (int, float)) and not isinstance(v, bool)
    pt = lambda p: isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(c, (int, float)) for c in p)
    return {"bool": isinstance(v, bool), "quantity": num, "count": isinstance(v, int) and not isinstance(v, bool) and v >= 0,
            "enum": v in f.get("values", [v]), "list": isinstance(v, list), "polygon": isinstance(v, list) and len(v) >= 3 and all(map(pt, v)),
            "line": isinstance(v, list) and len(v) == 2 and all(map(pt, v)), "lines": isinstance(v, list) and all(isinstance(s, list) and len(s) == 2 and all(map(pt, s)) for s in v),
            "point": pt(v), "structures": isinstance(v, list) and all(isinstance(s, dict) and "outline" in s for s in v),
            "placement": isinstance(v, dict) and {"x", "y"} <= set(v), "text": isinstance(v, str), "date": isinstance(v, str)}.get(t, False)


def validate_input(case, m, purpose="adu_evaluation"):
    """GR-22: every primary value is {value, prov} (or {observations: [{value, prov}, ...]}); each provenance entry
    has kind, document, where, when, by, and tolerance or status; the kind is one the fact accepts; an official record
    names its issuer and is never the owner's word; required facts are present and typed. Returns (problems, conflicts)."""
    F = fact_index(m)
    problems, conflicts = [], []
    P = problems.append
    got = set()
    for scope in ("site", "plan"):
        for k, entry in (case.get(scope) or {}).items():
            name = f"{scope}.{k}"
            f = F.get(name)
            if f is None: P(f"{name}: not a registered fact (GR-11)"); continue
            obs = entry.get("observations") if isinstance(entry, dict) and "observations" in entry else [entry]
            vals = []
            for o in obs:
                if not isinstance(o, dict) or "value" not in o or "prov" not in o: P(f"{name}: a value must be {{value, prov}}"); continue
                if not o["prov"]: P(f"{name}: empty provenance"); continue
                for pr in o["prov"]:
                    miss = [x for x in ("kind", "document", "where", "when", "by") if not pr.get(x)]
                    if miss: P(f"{name}: provenance lacks {miss}")
                    if not (pr.get("tolerance") is not None or pr.get("status")): P(f"{name}: provenance needs a tolerance or a status")
                    if pr.get("kind") not in f["accepted_sources"]: P(f"{name}: source kind {pr.get('kind')!r} is not one {name} accepts ({f['accepted_sources']})")
                    if pr.get("kind") == "official_record" and (not pr.get("issuer") or pr.get("role") == "owner" or str(pr.get("issuer")).lower() == "owner"):
                        P(f"{name}: an official record names its issuing agency and is never the owner's statement")
                if o["value"] is not None and not _typed(f, o["value"]): P(f"{name}: value {o['value']!r} is not a {f['type']}")
                vals.append(o["value"])
            if len({json.dumps(v, sort_keys=True) for v in vals}) > 1: conflicts.append({"fact": name, "values": vals, "observations": obs})
            got.add(name)
    for n, f in F.items():
        if purpose in f.get("required_for", []) and n not in got: P(f"{n}: required for {purpose} and missing")
    return problems, conflicts


def flatten(case, choose=None):
    """{scope.name: value} from a provenance-carrying case; `choose` picks an observation index per fact (conflicts)."""
    out = {}
    for scope in ("site", "plan"):
        for k, entry in (case.get(scope) or {}).items():
            name = f"{scope}.{k}"
            if isinstance(entry, dict) and "observations" in entry:
                out[name] = entry["observations"][(choose or {}).get(name, 0)]["value"]
            elif isinstance(entry, dict) and "value" in entry:
                out[name] = entry["value"]
            else:
                out[name] = entry
    return out


# ---------------------------------------------------------------- GR-30 doubts
def _holds(c, facts):
    """True, False, or None (unknown) for one matters_when condition."""
    v = facts.get(c["fact"])
    if c["op"] == "unknown": return v is None
    if v is None: return None
    ops = {"==": lambda: v == c.get("value"), "!=": lambda: v != c.get("value"), ">=": lambda: v >= c["value"],
           "<=": lambda: v <= c["value"], "in": lambda: v in c["value"], "contains": lambda: c["value"] in (v or [])}
    return ops[c["op"]]()


def resolve_doubts(evaluate, case, m):
    """Run `evaluate(facts, params) -> verdict` once plainly and once per doubt reading or observation (GR-30).

    Conflicts: same verdict every way -> kept, reported; different -> NEEDS_CHECK.
    Ambiguities: only when active and matters_when holds (or may: an unknown counts). Same verdict under every reading
    -> kept, reported; different -> FITS_IF naming the reading(s) that fit; effects not modeled -> left for the agent."""
    _, conflicts = validate_input(case, m)
    base_facts = flatten(case)
    verdict = evaluate(base_facts, {})
    report = {"verdict": verdict, "conflicts": [], "ambiguities": [], "conditions": []}
    for c in conflicts:
        outs = [evaluate(flatten(case, {c["fact"]: i}), {}) for i in range(len(c["values"]))]
        same = len(set(outs)) == 1
        report["conflicts"].append({"fact": c["fact"], "values": c["values"], "verdicts": outs, "changes_outcome": not same})
        if not same: report["verdict"] = "NEEDS_CHECK"
    for a in m["ambiguities"]["ambiguities"]:
        if a["status"] != "active": continue
        hold = [_holds(c, base_facts) for c in a.get("matters_when", [])]
        if any(h is False for h in hold): continue
        if not a.get("effects"):
            report["ambiguities"].append({"id": a["id"], "provision": a["provision"], "effect": "not modeled: the agent reads both readings"}); continue
        n = max(len(e.get("by_reading", [])) for e in a["effects"]) or 2
        outs = []
        for i in range(n):
            facts, params = dict(base_facts), {}
            for e in a["effects"]:
                if "by_reading" in e and e["by_reading"][i] is not None: params[e["param"]] = e["by_reading"][i]
                if e.get("fact") and "per_reading" in e:
                    br = (case.get(e["fact"].split(".")[0], {}).get(e["fact"].split(".", 1)[1], {}) or {}).get("by_reading", {}).get(a["id"])
                    if br is not None: facts[e["fact"]] = br[i]
            outs.append(evaluate(facts, params))
        same = len(set(outs)) == 1
        report["ambiguities"].append({"id": a["id"], "provision": a["provision"], "verdicts": outs, "changes_outcome": not same,
                                      "settled_by": a.get("settled_by"), "may_matter": any(h is None for h in hold)})
        if not same and report["verdict"] != "NEEDS_CHECK":
            fits = [i + 1 for i, o in enumerate(outs) if o in ("FITS", "FITS_IF")]
            if fits:
                report["verdict"] = "FITS_IF"
                report["conditions"].append({"ambiguity": a["id"], "fits_under_readings": fits, "clause": a["provision"], "settled_by": a.get("settled_by")})
            else:
                report["verdict"] = outs[0]
    return report
