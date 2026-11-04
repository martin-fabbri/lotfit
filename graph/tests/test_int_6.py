"""INT-6 (frozen): the bridge (INS-08, INS-09; contract C3, EN-32, EN-34, EN-36). One BridgeRequest -> one
BridgeResponse; every adapter's envelope (checked against the contract's four MeasureResult rules); per-call errors by
category; impl_digest. The CLI and the self-test are INT-7.
duration_ms is checked for presence only, never compared. Do not edit."""
import hashlib, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GRAPH = os.path.join(HERE, "..")
sys.path.insert(0, GRAPH)
import tool_runner as B  # noqa: E402

EX = json.load(open(os.path.join(GRAPH, "examples", "pdx-r5-adu-prov.json")))
S = EX["site"]
V = lambda k: S[k]["value"] if isinstance(S[k], dict) and "value" in S[k] else S[k]
FP = EX["plan"]["footprint"]["value"]
CLIENT = [[2, 74], [26, 74], [26, 98], [2, 98]]
SEL = [[13, 65], [37, 65], [37, 89], [13, 89]]
P = lambda prov, param, value, unit: {"provision_id": prov, "param": param, "value": value, "unit": unit}
SIDE = P("PDX.T110-4", "side_building_setback.R5", 5, "ft")
REAR = P("PDX.T110-4", "rear_building_setback.R5", 5, "ft")
FRONT = P("PDX.T110-4", "front_building_setback.R5", 10, "ft")
CID = "0190c0de-0000-7000-8000-000000000001"
Z = "0" * 64
EXC_PARAMS = {k: P("PDX.33.110.245.C.2", k, v, u) for k, v, u in [
    ("zones_allowing_structures_in_side_rear_setbacks", ["R7", "R5", "R2.5"], "zones"), ("min_distance_from_front_lot_line", 40, "ft"),
    ("min_distance_from_side_street_lot_line_corner", 20, "ft"), ("max_footprint_dimension", 24, "ft"), ("max_height_in_setback", 15, "ft"),
    ("max_wall_height_in_setback", 10, "ft"), ("dormer_min_setback_from_side_rear", 5, "ft"), ("max_combined_length_in_setback_per_line", 24, "ft")]}
EXC_FACTS = {"outline": CLIENT, "zone": "R5", "front_lot_line": V("front_lot_line"), "corner_lot": False, "height_ft": 15, "wall_height_ft": 12,
             "plan_kind": "adu", "openings_facing_lot_line": True, "rooftop_deck": False, "dormers": True, "dormer_setback_ft": 6,
             "structures": V("structures"), "setback_lines": [{"name": "west", "line": [[0, 0], [0, 100]], "min_ft": 5},
                                                              {"name": "rear", "line": [[0, 100], [50, 100]], "min_ft": 5}]}


def call(tool, args, provision_id="PDX.33.110.220.B", target="case"):
    resp = B.run({"config_hash": Z, "batch": [{"call_id": CID, "provision_id": provision_id, "target": target, "tool": tool, "args": args}]})
    return resp["results"][0]


MEASURE_KEYS = {"value", "unit", "limit", "margin", "tolerance", "pass", "too_close_to_call", "dimension_to_tape"}


def contract_rules(m):
    """The four rules of contract C3 MeasureResult (types.mts superRefine), checked on every measure the bridge returns."""
    assert MEASURE_KEYS <= set(m) <= MEASURE_KEYS | {"details"}, m
    tcc = abs(m["margin"]) < m["tolerance"] - 1e-9
    assert tcc == m["too_close_to_call"], ("too_close_to_call must equal |margin| < tolerance", m)
    if tcc: assert m["pass"] is None and m["dimension_to_tape"], ("too close: pass None and a dimension to tape", m)
    else: assert m["pass"] == (m["margin"] >= 0), ("pass must agree with the sign of margin", m)


def ok(tool, args, **kw):
    r = call(tool, args, **kw)
    assert r["ok"] is True, r
    res = r["result"]
    if isinstance(res, dict) and "too_close_to_call" in res and "margin" in res: contract_rules(res)
    for c in (res.get("conditions") or []) if isinstance(res, dict) else []:
        if c.get("measure") is not None: contract_rules(c["measure"])
    return res


def err(tool, args):
    r = call(tool, args)
    assert r["ok"] is False and set(r) == {"call_id", "ok", "error"}, r
    return r["error"]["category"], r["error"]["message"]


# ---------------------------------------------------------------- the envelope (INS-08)
def test_INT6_request_refusals_each_message():
    good = {"call_id": CID, "provision_id": None, "target": "case", "tool": "check_max", "args": {}}
    cases = [
        ([], ["request is not an object"]),
        ({"config_hash": Z, "batch": [good], "x": 1}, ["unexpected keys ['x']"]),
        ({"config_hash": "x", "batch": [good]}, ["config_hash must be a sha256 hex"]),
        ({"config_hash": "A" * 64, "batch": [good]}, ["config_hash must be a sha256 hex"]),
        ({"config_hash": Z}, ["batch must be a non-empty list"]),
        ({"config_hash": Z, "batch": []}, ["batch must be a non-empty list"]),
        ({"config_hash": Z, "batch": [5]}, ["batch[0] is not an object"]),
        ({"config_hash": Z, "batch": [{**good, "extra": 1}]}, ["batch[0] unexpected keys"]),
        ({"config_hash": Z, "batch": [{**good, "call_id": "0190c0de-0000-4000-8000-000000000001"}]}, ["batch[0].call_id must be a UUIDv7"]),
        ({"config_hash": Z, "batch": [{**good, "provision_id": "XX.1"}]}, ["batch[0].provision_id"]),
        ({"config_hash": Z, "batch": [{**good, "provision_id": 5}]}, ["batch[0].provision_id"]),
        ({"config_hash": Z, "batch": [{**good, "target": "lot"}]}, ["batch[0].target"]),
        ({"config_hash": Z, "batch": [{**good, "tool": "nope"}]}, ["batch[0].tool 'nope' is not a bridge tool"]),
        ({"config_hash": Z, "batch": [{**good, "args": []}]}, ["batch[0].args must be an object"]),
    ]
    for req, want in cases:
        assert B.check_request(req) == want, (req, B.check_request(req))
    assert B.check_request({"config_hash": Z, "batch": [good]}) == []


def test_INT6_run_raises_on_an_invalid_request_with_all_problems():
    try:
        B.run({"config_hash": "x", "batch": []})
        assert False
    except ValueError as e:
        assert str(e) == "config_hash must be a sha256 hex; batch must be a non-empty list"


def test_INT6_response_shape_and_order():
    resp = B.run({"config_hash": Z, "batch": [
        {"call_id": CID, "provision_id": None, "target": "case", "tool": "distance_to_line", "args": {"outline": CLIENT, "line": V("side_lot_lines")}},
        {"call_id": "0190c0de-0000-7000-8000-000000000002", "provision_id": None, "target": "case", "tool": "check_max", "args": {"value": 1}}]})
    assert set(resp) == {"impl_digest", "results"} and len(resp["results"]) == 2
    a, b = resp["results"]
    assert a["call_id"] == CID and a["ok"] is True and set(a) == {"call_id", "ok", "result", "duration_ms"} and isinstance(a["duration_ms"], (int, float))
    assert b["call_id"].endswith("2") and b["ok"] is False and "duration_ms" not in b      # the batch goes on after an error


def test_INT6_per_call_error_categories():
    assert err("check_max", {"value": 15}) == ("harness", "argument 'limit' missing (it must arrive resolved)")
    cat, msg = err("check_setback", {"outline": CLIENT, "lines": V("side_lot_lines"), "min": 5})
    assert cat == "model" and msg == "'min' must be a resolved parameter {provision_id, param, value, unit}, not 5"
    assert err("check_setback", {"outline": SEL, "lines": V("lot_outline"), "min": SIDE}) == (
        "model", "lines must be lot-line segments (e.g. {fact: 'site.side_lot_lines'} or 'site.rear_lot_line'), not a polygon like site.lot_outline")
    assert err("check_max", {"value": "a", "limit": P("X.1", "h", 20, "ft")}) == ("tool", "TypeError: unsupported operand type(s) for -: 'int' and 'str'")
    assert err("check_solar_shadow", {}) == ("tool", "check_solar_shadow is not built in milestone 1 (WK-09 comes after the spine)")


def _digest(graph_dir):
    h = hashlib.sha256()
    tools_dir = os.path.join(graph_dir, "tools")
    files = sorted(os.path.join(tools_dir, f) for f in os.listdir(tools_dir) if f.endswith(".py"))
    for f in files + [os.path.join(graph_dir, "tool_runner.py")]:
        h.update(os.path.relpath(f, graph_dir).encode())
        h.update(open(f, "rb").read())
    return h.hexdigest()


def test_INT6_impl_digest_is_over_the_tools_and_the_runner():
    assert B.impl_digest() == _digest(os.path.abspath(GRAPH))
    assert len(B.impl_digest()) == 64


def test_INT6_impl_digest_changes_with_one_byte():
    with tempfile.TemporaryDirectory() as d:
        shutil.copytree(os.path.join(GRAPH, "tools"), os.path.join(d, "tools"), ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(os.path.join(GRAPH, "tool_runner.py"), d)
        before = _digest(d)
        with open(os.path.join(d, "tools", "geometry.py"), "a") as fh:
            fh.write("\n")
        assert _digest(d) != before


# ---------------------------------------------------------------- adapters (INS-09)
def test_INT6_check_setback_two_lines_with_details():
    r = ok("check_setback", {"outline": CLIENT, "lines": V("side_lot_lines"), "min": SIDE, "tolerance_ft": 0.5})
    assert r == {"value": 2.0, "unit": "ft", "limit": SIDE, "margin": -3.0, "tolerance": 0.5, "pass": False, "too_close_to_call": False,
                 "dimension_to_tape": None, "details": {"nearest_segment": 0, "per_segment": [{"distance_ft": 2.0, "margin_ft": -3.0},
                                                                                              {"distance_ft": 24.0, "margin_ft": 19.0}]}}


def test_INT6_check_setback_one_segment_is_wrapped_and_has_no_details():
    r = ok("check_setback", {"outline": SEL, "lines": V("rear_lot_line"), "min": SIDE})
    assert r == {"value": 11.0, "unit": "ft", "limit": SIDE, "margin": 6.0, "tolerance": 0.0, "pass": True, "too_close_to_call": False,
                 "dimension_to_tape": None}


def test_INT6_too_close_names_the_dimension_to_tape():
    o = [[13, 70.85], [37, 70.85], [37, 94.85], [13, 94.85]]
    r = ok("check_setback", {"outline": o, "lines": V("rear_lot_line"), "min": SIDE, "tolerance_ft": 1.6})
    assert r["value"] == 5.15 and r["margin"] == 0.15 and r["pass"] is None and r["too_close_to_call"] is True
    assert r["dimension_to_tape"] == "distance to the nearest lot line"
    r2 = ok("check_setback", {"outline": o, "lines": V("rear_lot_line"), "min": SIDE, "tolerance_ft": 1.6, "dimension": "rear wall to rear line"})
    assert r2["dimension_to_tape"] == "rear wall to rear line"


def test_INT6_check_allowed():
    r = ok("check_allowed", {"allowed": "Yes", "zone": "R5", "param": "p.R5"})
    assert r == {"value": 1.0, "unit": "allowed", "limit": None, "margin": 0.0, "tolerance": 0.0, "pass": True, "too_close_to_call": False,
                 "dimension_to_tape": None, "details": {"zone": "R5", "param": "p.R5", "cell_value": "Yes"}}
    for v in ("true", "y", "ALLOWED", True):
        assert ok("check_allowed", {"allowed": v, "zone": "R5", "param": "p"})["pass"] is True
    for v in ("false", "no", "not allowed", False):
        r = ok("check_allowed", {"allowed": v, "zone": "R5", "param": "p"})
        assert r["pass"] is False and r["margin"] == -1.0 and r["value"] == 0.0
    for v in ("", None, 1, "1"):                  # I-D7: an unreadable cell is a tool error (no measure: unknown), never "not allowed"
        assert err("check_allowed", {"allowed": v, "zone": "R5", "param": "p"}) == ("tool", f"allowed-use cell not readable: {v!r}")


def test_INT6_check_max_with_and_without_tolerance():
    lim = P("X.1", "max_height", 20, "ft")
    r = ok("check_max", {"value": 19.7, "limit": lim, "tolerance": 0.5})
    assert r == {"value": 19.7, "unit": "ft", "limit": lim, "margin": 0.3, "tolerance": 0.5, "pass": None, "too_close_to_call": True,
                 "dimension_to_tape": "the measured dimension"}
    r = ok("check_max", {"value": 15, "limit": P("PDX.33.110.245.C.1", "max_height", 20, "ft")})
    assert r["margin"] == 5 and r["pass"] is True and r["dimension_to_tape"] is None and r["unit"] == "ft"
    r = ok("check_max", {"value": 21, "limit": lim, "dimension": "ridge height"})
    assert r["pass"] is False and r["margin"] == -1 and r["dimension_to_tape"] is None


def test_INT6_footprint_dimensions():
    lim = P("PDX.33.110.245.C.2", "max_footprint_dimension", 24, "ft")
    r = ok("footprint_dimensions", {"outline": SEL, "limit": lim})
    assert r == {"value": 24, "unit": "ft", "limit": lim, "margin": 0, "tolerance": 0.0, "pass": True, "too_close_to_call": False,
                 "dimension_to_tape": None, "details": {"width_ft": 24, "depth_ft": 24}}


def test_INT6_adu_max_living_area_builds_its_limit():
    share = P("PDX.33.205.040.C.1", "max_share_of_primary_living_area", 75, "%")
    cap = P("PDX.33.205.040.C.1", "max_living_area", 800, "sqft")
    r = ok("adu_max_living_area", {"primary_living_area": 1400, "plan_living_area": 576, "share": share, "cap": cap})
    assert r == {"value": 576, "unit": "sqft",
                 "limit": {"provision_id": "PDX.33.205.040.C.1", "param": "max_sqft = min(max_share_of_primary_living_area × primary, max_living_area)",
                           "value": 800, "unit": "sqft"},
                 "margin": 224, "tolerance": 0.0, "pass": True, "too_close_to_call": False, "dimension_to_tape": None,
                 "details": {"share_sqft": 1050.0, "cap_sqft": 800, "binding": "cap"}}
    r = ok("adu_max_living_area", {"primary_living_area": 800, "plan_living_area": 650, "share": share, "cap": cap})
    assert r["limit"]["value"] == 600.0 and r["margin"] == -50.0 and r["pass"] is False and r["details"]["binding"] == "share"


def test_INT6_coverage_share():
    lim = P("PDX.33.110.245.C.3.a", "max_combined_accessory_coverage_pct_of_site", 20, "%")
    r = ok("coverage_share", {"outlines": [SEL] + V("structures"), "lot_area": 5000, "limit": lim})
    assert r == {"value": 13.12, "unit": "%", "limit": lim, "margin": 6.88, "tolerance": 0.0, "pass": True, "too_close_to_call": False,
                 "dimension_to_tape": None, "details": {"covered_sqft": 656.0, "allowed_sqft": 1000.0, "covered_tolerance_sqft": 0.0}}
    house = [[5, 5], [45, 5], [45, 45], [5, 45]]
    plan = [[50, 60], [86, 60], [86, 76], [50, 76]]
    r = ok("coverage_share", {"outlines": [house, plan], "lot_area": 5000.0, "limit": P("X.2", "max_cov", 40, "%"), "outline_tolerances_ft": [3.0, 0.0]})
    assert r["pass"] is None and r["too_close_to_call"] is True and r["tolerance"] == 10.32
    assert r["dimension_to_tape"] == "the house and ADU outlines wall to wall (lot coverage)"


def test_INT6_total_building_coverage():
    cell = {"provision_id": "PDX.T110-5", "cell_id": "T110-5:R3", "row": "5,000 sq. ft. or more but less than 20,000 sq. ft.",
            "cell": "2,250 sq. ft + 15% of lot area over 5,000 sq. ft."}
    r = ok("total_building_coverage", {"outlines": [SEL, V("house_outline")] + V("structures"), "lot_area": 5000, "cap_cell": cell})
    assert r == {"value": 1566.0, "unit": "sqft", "limit": {"provision_id": "PDX.T110-5", "param": "T110-5:R3", "value": 2250.0, "unit": "sqft"},
                 "margin": 684.0, "tolerance": 0.0, "pass": True, "too_close_to_call": False, "dimension_to_tape": None,
                 "details": {"row": cell["row"], "cell": cell["cell"]}}
    bad_row = {**cell, "cell_id": "T110-5:R1", "row": "Less than 3,000 sq. ft.", "cell": "50% of lot area"}
    assert err("total_building_coverage", {"outlines": [SEL], "lot_area": 5000, "cap_cell": bad_row}) == (
        "model", "row 'Less than 3,000 sq. ft.' does not hold a lot of 5000 sq ft")
    assert err("total_building_coverage", {"outlines": [SEL], "lot_area": 5000, "cap_cell": "x"}) == (
        "model", "cap_cell must be a resolved cell {provision_id, cell_id, row, cell}")


def test_INT6_check_front_or_behind_value_by_branch():
    mn = P("PDX.33.205.040.C.2", "front_lot_line_setback", 40, "ft")
    r = ok("check_front_or_behind", {"outline": SEL, "front_lot_line": V("front_lot_line"), "min_front": mn, "house_rear_wall": [[12, 55], [38, 55]]})
    assert r == {"value": 65.0, "unit": "ft", "limit": mn, "margin": 25.0, "tolerance": 0.0, "pass": True, "too_close_to_call": False,
                 "dimension_to_tape": None, "details": {"branch": "front", "front_margin_ft": 25.0, "behind_margin_ft": 10.0}}
    mn60 = P("PDX.33.205.040.C.2", "front_lot_line_setback", 60, "ft")
    r = ok("check_front_or_behind", {"outline": [[13, 56], [37, 56], [37, 80], [13, 80]], "front_lot_line": V("front_lot_line"), "min_front": mn60,
                                     "house_rear_wall": [[12, 55], [38, 55]]})
    assert r["value"] == 1.0 and r["margin"] == 1.0 and r["details"] == {"branch": "behind", "front_margin_ft": -4.0, "behind_margin_ft": 1.0}


def test_INT6_exception_conditions_measures_carry_their_limits():
    r = ok("check_exception_conditions", {"exception_id": "PDX.33.110.245.C.2", "base_provision_id": "PDX.33.110.220.B", "params": EXC_PARAMS,
                                          "facts": EXC_FACTS})
    m = {c["clause_id"].split("::item:")[1]: c for c in r["conditions"]}
    assert r["pass"] is False
    assert m["b.(1)"]["measure"] == {"value": 74.0, "unit": "ft", "limit": EXC_PARAMS["min_distance_from_front_lot_line"], "margin": 34.0,
                                     "tolerance": 0.0, "pass": True, "too_close_to_call": False, "dimension_to_tape": None}
    assert m["b.(2)"]["measure"]["limit"] == EXC_PARAMS["max_footprint_dimension"] and m["b.(2)"]["measure"]["margin"] == 0
    assert m["b.(4)"]["measure"] == {"value": 12, "unit": "ft", "limit": EXC_PARAMS["max_wall_height_in_setback"], "margin": -2, "tolerance": 0.0,
                                     "pass": False, "too_close_to_call": False, "dimension_to_tape": None}
    # I-D4: a minimum shows the dormer's own setback as the value, the 5 ft minimum as the limit
    assert m["b.(8)"]["measure"]["value"] == 6 and m["b.(8)"]["measure"]["margin"] == 1 and m["b.(8)"]["measure"]["limit"] == EXC_PARAMS["dormer_min_setback_from_side_rear"]
    assert all(m[k]["measure"] is None for k in ("b.", "b.(3)", "b.(5)", "b.(6)", "b.(7)"))
    assert all(set(c) <= {"clause_id", "name", "holds", "measure", "reason"} for c in r["conditions"])   # "param" never leaves the bridge


def test_INT6_exception_measures_show_the_failing_number():
    """I-D4 (ADV-3): over-height with a passing wall shows the height; a failing side street shows the side street."""
    base = {"exception_id": "PDX.33.110.245.C.2", "base_provision_id": "PDX.33.110.220.B", "params": EXC_PARAMS}
    r = ok("check_exception_conditions", {**base, "facts": {**EXC_FACTS, "height_ft": 17, "wall_height_ft": 9}})
    m4 = next(c for c in r["conditions"] if c["clause_id"].endswith("b.(4)"))["measure"]
    assert m4["value"] == 17 and m4["limit"] == EXC_PARAMS["max_height_in_setback"] and m4["margin"] == -2 and m4["pass"] is False
    r = ok("check_exception_conditions", {**base, "facts": {**EXC_FACTS, "corner_lot": True, "side_street_lot_line": [[0, 0], [0, 100]]}})
    m1 = next(c for c in r["conditions"] if c["clause_id"].endswith("b.(1)"))["measure"]
    assert m1["value"] == 2.0 and m1["limit"] == EXC_PARAMS["min_distance_from_side_street_lot_line_corner"] and m1["pass"] is False


def test_INT6_exception_conditions_errors():
    base = {"exception_id": "PDX.33.110.245.C.2", "base_provision_id": "PDX.33.110.220.B", "params": EXC_PARAMS, "facts": EXC_FACTS}
    assert err("check_exception_conditions", {**base, "exception_id": "PDX.X"}) == ("tool", "no evaluator for exception PDX.X")
    assert err("check_exception_conditions", {**base, "params": {"a": 5}}) == ("model", "parameter 'a' must be resolved")
    f = dict(EXC_FACTS); del f["outline"]
    assert err("check_exception_conditions", {**base, "facts": f}) == ("tool", "missing fact or parameter: 'outline'")   # I-D11
    f = {**EXC_FACTS, "openings_facing_lot_line": None, "openings_by_face": {"left": True}, "rotation": 45}
    assert err("check_exception_conditions", {**base, "facts": f}) == ("tool", "rotation must be a multiple of 90 degrees")


def test_INT6_evaluate_guards_three_valued():
    def g(guards, facts):
        return ok("evaluate_guards", {"provision_id": "PDX.11.50.020", "facts": facts, "guards": guards})
    T1 = {"clause_id": "c1", "fact": "site.trees", "op": "true"}
    assert g([T1], {"site.trees": False}) == {"provision_id": "PDX.11.50.020", "result": "known_false",
                                             "guards": [{"clause_id": "c1", "fact": "site.trees", "value": False, "holds": False}]}
    assert g([T1], {"site.trees": True})["result"] == "known_true"
    assert g([T1], {}) == {"provision_id": "PDX.11.50.020", "result": "unknown", "guards": [{"clause_id": "c1", "fact": "site.trees", "value": None, "holds": None}]}
    assert g([], {})["result"] == "unknown"
    cnt = {"clause_id": "c", "fact": "site.n", "op": "count>0"}
    assert g([cnt], {"site.n": True})["guards"][0]["holds"] is None and g([cnt], {"site.n": 2})["result"] == "known_true"   # I-D6
    assert g([cnt], {"site.n": 0})["result"] == "known_false"
    ne = {"clause_id": "c", "fact": "site.n", "op": "nonempty"}
    assert g([ne], {"site.n": []})["result"] == "known_false" and g([ne], {"site.n": [1]})["result"] == "known_true"
    inn = {"clause_id": "c", "fact": "site.z", "op": "in", "value": ["R5"]}
    assert g([inn], {"site.z": "R5"})["result"] == "known_true" and g([inn], {"site.z": "R7"})["result"] == "known_false"
    assert g([{"clause_id": "c", "fact": "site.z", "op": "weird"}], {"site.z": "R5"})["guards"][0]["holds"] is None
    assert g([T1, inn], {"site.trees": False, "site.z": "R5"})["result"] == "unknown"     # mixed: unknown, never a ruling
    # I-D6 (ADV-6): a fact whose type does not fit the operator is unknown, never False (never a known_false ruling)
    assert g([T1], {"site.trees": "no"})["guards"][0]["holds"] is None and g([T1], {"site.trees": "no"})["result"] == "unknown"
    assert g([ne], {"site.n": "x"})["guards"][0]["holds"] is None and g([cnt], {"site.n": "3"})["guards"][0]["holds"] is None
    assert g([inn], {"site.z": ["R5"]})["guards"][0]["holds"] is None
    assert g([{"clause_id": "c", "fact": "site.z", "op": "in"}], {"site.z": "R5"})["guards"][0]["holds"] is None   # no value list: unknown


def _fa(**kw):
    a = {"lot_outline": V("lot_outline"), "house_outline": V("house_outline"), "structures": V("structures"), "footprint": FP, "tolerance_ft": 0.5,
         "setbacks": [{"line": V("front_lot_line"), "min": FRONT}, {"line": V("rear_lot_line"), "min": REAR}] + [{"line": l, "min": SIDE} for l in V("side_lot_lines")],
         "client_spot": {"x": 2, "y": 74, "rotation": 0}}
    a.update(kw)
    return a


def test_INT6_find_placements_summary_failing_client():
    r = ok("find_placements", _fa(), target="client_spot")
    assert set(r) == {"summary", "candidates"} and len(r["candidates"]) == 478
    assert r["summary"] == {"count": 478, "clear_count": 408, "client_spot": {"passes": False, "failing": ["PDX.T110-4"]},
                            "nearest_to_client": {"x": 6.0, "y": 70.0, "rotation": 0}, "max_clearance": {"x": 13.0, "y": 55.0, "rotation": 0},
                            "envelope_artifact": None}
    assert r["candidates"][0]["placement"] == {"x": 6.0, "y": 55.0, "rotation": 0}


def test_INT6_find_placements_summary_passing_client_and_none():
    r = ok("find_placements", _fa(client_spot={"x": 13, "y": 65, "rotation": 0}))
    assert r["summary"]["client_spot"] == {"passes": True, "failing": []} and r["summary"]["nearest_to_client"] == {"x": 13.0, "y": 65.0, "rotation": 0}
    fa = _fa(); del fa["client_spot"]
    s = ok("find_placements", fa)["summary"]
    assert s["client_spot"] is None and s["nearest_to_client"] is None and s["max_clearance"] == {"x": 13.0, "y": 55.0, "rotation": 0}


def test_INT6_find_placements_with_front_or_behind():
    fob = {"front_lot_line": V("front_lot_line"), "min_front": P("PDX.33.205.040.C.2", "front_lot_line_setback", 40, "ft"), "house_rear_wall": [[12, 55], [38, 55]]}
    s = ok("find_placements", _fa(front_or_behind=fob))["summary"]
    assert s["count"] == 478 and s["clear_count"] == 408 and s["client_spot"] == {"passes": False, "failing": ["PDX.T110-4"]}


def test_INT6_client_spot_inside_the_tolerance_is_too_close_to_call():
    """I-D3 (ADV-2): 0.3 ft clear of a 5 ft side setback with a 0.5 ft tolerance is neither a pass nor a fail."""
    s = ok("find_placements", _fa(client_spot={"x": 5.3, "y": 65, "rotation": 0}))["summary"]
    assert s["client_spot"] == {"passes": None, "failing": []}


def test_INT6_client_spot_short_by_less_than_the_tolerance_is_not_failing():
    """I-D3: 0.3 ft short of a 5 ft side setback with a 0.5 ft tolerance is too close to call, not a failure."""
    s = ok("find_placements", _fa(client_spot={"x": 4.7, "y": 65, "rotation": 0}))["summary"]
    assert s["client_spot"] == {"passes": None, "failing": []}


def test_INT6_client_spot_that_overlaps_a_structure_fails():
    """I-D3: every setback clear but the spot overlaps the shed: it fails, with no setback to name."""
    s = ok("find_placements", _fa(client_spot={"x": 20, "y": 70, "rotation": 0}))["summary"]
    assert s["client_spot"] == {"passes": False, "failing": []}


def test_INT6_client_spot_is_judged_with_front_or_behind():
    """I-D3 (ADV-2): a spot 56 ft from the front, before a rear wall at 60 ft, fails a 70 ft front-or-behind rule,
    and the rule's provision is named; without the rule the same spot passes."""
    fob = {"front_lot_line": V("front_lot_line"), "min_front": P("PDX.33.205.040.C.2", "front_lot_line_setback", 70, "ft"), "house_rear_wall": [[12, 60], [38, 60]]}
    spot = {"x": 13, "y": 56, "rotation": 0}
    assert ok("find_placements", _fa(client_spot=spot, front_or_behind=fob))["summary"]["client_spot"] == {"passes": False, "failing": ["PDX.33.205.040.C.2"]}
    assert ok("find_placements", _fa(client_spot=spot))["summary"]["client_spot"] == {"passes": True, "failing": []}


def test_INT6_client_spot_with_an_unknown_house_is_unknown():
    s = ok("find_placements", _fa(client_spot={"x": 13, "y": 65, "rotation": 0}, house_outline=None))["summary"]
    assert s["client_spot"] == {"passes": None, "failing": []}


def test_INT6_front_or_behind_behind_branch_names_its_own_limit():
    """I-D9 (ADV-11): when "behind" is the branch that passes, the limit is 0 ft behind the rear wall, never the front minimum."""
    mn = P("PDX.33.205.040.C.2", "front_lot_line_setback", 70, "ft")
    r = ok("check_front_or_behind", {"outline": SEL, "front_lot_line": V("front_lot_line"), "min_front": mn, "house_rear_wall": [[12, 55], [38, 55]]})
    assert r["value"] == 10.0 and r["margin"] == 10.0 and r["pass"] is True and r["details"]["branch"] == "behind"
    assert r["limit"] == {"provision_id": "PDX.33.205.040.C.2", "param": "behind the rear building wall", "value": 0, "unit": "ft"}
    assert err("check_front_or_behind", {"outline": SEL, "front_lot_line": V("front_lot_line"), "min_front": mn,
                                         "house_rear_wall": [[12, 55], [12, 55]]}) == ("model", "house_rear_wall has zero length")   # I-D10


def test_INT6_total_building_coverage_with_tolerances():
    cell = {"provision_id": "PDX.T110-5", "cell_id": "T110-5:R3", "row": "5,000 sq. ft. or more but less than 20,000 sq. ft.",
            "cell": "2,250 sq. ft + 15% of lot area over 5,000 sq. ft."}
    r = ok("total_building_coverage", {"outlines": [[[0, 0], [47, 0], [47, 47], [0, 47]]], "lot_area": 5000, "cap_cell": cell, "outline_tolerances_ft": [0.5]})
    assert r["margin"] == 41.0 and r["tolerance"] == 95.0 and r["pass"] is None and r["too_close_to_call"] is True
    assert r["dimension_to_tape"] == "the outlines of every building wall to wall (building coverage)"


def test_INT6_find_placements_refusals():
    assert err("find_placements", _fa(setbacks=[{"line": V("front_lot_line"), "min": 10}])) == ("model", "each setback's min must be a resolved parameter")
    assert err("find_placements", _fa(front_or_behind={"front_lot_line": V("front_lot_line"), "min_front": 40})) == (
        "model", "front_or_behind.min_front must be a resolved parameter")
    assert err("find_placements", _fa(front_or_behind={"front_lot_line": V("front_lot_line"),
                                                       "min_front": P("PDX.33.205.040.C.2", "front_lot_line_setback", 40, "ft")})) == (
        "model", "front_or_behind needs front_lot_line and house_rear_wall")


def test_INT6_raw_tools():
    assert ok("placed_outline", {"footprint": FP, "placement": {"x": 13, "y": 65, "rotation": 90}}) == {"outline": [[13, 65], [13, 89], [-11, 89], [-11, 65]]}
    assert ok("physical_fit", {"lot_outline": V("lot_outline"), "house_outline": V("house_outline"), "structures": V("structures"),
                               "outline": [[30, 80], [45, 80], [45, 90], [30, 90]]}) == {"inside_lot": True, "overlaps": ["shed"], "pass": False}
    assert ok("distance_to_line", {"outline": CLIENT, "line": V("side_lot_lines")}) == {"distance_ft": 2.0}
