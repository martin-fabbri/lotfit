import hashlib, json, math, os, re, sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tools as T

UUID7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
PROV = re.compile(r"^(OR|ORS|OAR|ORLAW|PDX|GRE|EUG)\.[A-Za-z0-9._\-]+$")
TARGETS = {"case", "client_spot", "selected_placement"}


def impl_digest() -> str:
    h = hashlib.sha256()
    tools_dir = os.path.join(HERE, "tools")
    files = sorted(os.path.join(tools_dir, f) for f in os.listdir(tools_dir) if f.endswith(".py"))
    for f in files + [os.path.abspath(__file__)]:
        h.update(os.path.relpath(f, HERE).encode())
        h.update(open(f, "rb").read())
    return h.hexdigest()


class CallError(Exception):
    def __init__(self, category, message):
        super().__init__(message)
        self.category = category


def need(a: dict, k: str):
    if k not in a:
        raise CallError("harness", f"argument {k!r} missing (it must arrive resolved)")
    return a[k]


def rp(a: dict, k: str) -> dict:
    v = need(a, k)
    if not (isinstance(v, dict) and all(key in v for key in ("provision_id", "param", "value", "unit"))):
        raise CallError("model", f"{k!r} must be a resolved parameter {{provision_id, param, value, unit}}, not {v!r}")
    return v


def measure(value, unit, limit, margin, tolerance, dimension=None, details=None) -> dict:
    ok, tcc = T.judge(margin, tolerance)
    r = {
        "value": round(value, 6),
        "unit": unit,
        "limit": limit,
        "margin": round(margin, 6),
        "tolerance": tolerance,
        "pass": ok,
        "too_close_to_call": tcc,
        "dimension_to_tape": (dimension or "the measured dimension") if tcc else None,
    }
    if details:
        r["details"] = details
    return r


def _mr_from_raw(raw, limit) -> dict | None:
    if raw is None:
        return None
    if "distance_ft" in raw:
        return measure(raw["distance_ft"], "ft", limit, raw["margin_ft"], raw.get("tolerance_ft", 0.0))
    if "max_dimension_ft" in raw:
        return measure(raw["max_dimension_ft"], "ft", limit, raw["margin_ft"], 0.0)
    if "margin" in raw:
        return measure(raw["value"], raw["unit"], limit, raw["margin"], raw.get("tolerance", 0.0))
    return None


def a_check_setback(a):
    mn = rp(a, "min")
    tol = a.get("tolerance_ft", 0.0)
    lines = need(a, "lines")
    if (
        isinstance(lines, list)
        and len(lines) > 0
        and isinstance(lines[0], (list, tuple))
        and len(lines[0]) > 0
        and isinstance(lines[0][0], (int, float))
    ):
        if len(lines) == 2:
            lines = [lines]
        else:
            raise CallError(
                "model",
                "lines must be lot-line segments (e.g. {fact: 'site.side_lot_lines'} or 'site.rear_lot_line'), not a polygon like site.lot_outline",
            )
    r = T.check_setback(need(a, "outline"), lines, mn["value"], tol)
    details = None
    if "nearest_segment" in r:
        details = {"nearest_segment": r["nearest_segment"], "per_segment": r["per_segment"]}
    return measure(
        r["distance_ft"],
        "ft",
        mn,
        r["margin_ft"],
        tol,
        a.get("dimension") or "distance to the nearest lot line",
        details,
    )


def a_check_allowed(a):
    try:
        r = T.check_allowed(need(a, "allowed"), need(a, "zone"), need(a, "param"))
    except ValueError as e:
        raise CallError("tool", str(e))
    v = 1.0 if r["allowed"] else 0.0
    return measure(
        v, "allowed", None, v - 1.0, 0.0, details={"zone": r["zone"], "param": r["param"], "cell_value": r["cell_value"]}
    )


def a_check_max(a):
    lim = rp(a, "limit")
    value = need(a, "value")
    return measure(value, lim["unit"], lim, lim["value"] - value, a.get("tolerance", 0.0), a.get("dimension"))


def a_footprint_dimensions(a):
    lim = rp(a, "limit")
    r = T.footprint_dimensions(need(a, "outline"), lim["value"])
    return measure(
        r["max_dimension_ft"], "ft", lim, r["margin_ft"], 0.0, details={"width_ft": r["width_ft"], "depth_ft": r["depth_ft"]}
    )


def a_adu_max_living_area(a):
    share = rp(a, "share")
    cap = rp(a, "cap")
    r = T.adu_max_living_area(need(a, "primary_living_area"), share["value"], cap["value"], need(a, "plan_living_area"))
    lim = {
        "provision_id": cap["provision_id"],
        "param": f"max_sqft = min({share['param']} × primary, {cap['param']})",
        "value": r["max_sqft"],
        "unit": "sqft",
    }
    return measure(
        r["plan_sqft"],
        "sqft",
        lim,
        r["margin_sqft"],
        0.0,
        details={"share_sqft": r["share_sqft"], "cap_sqft": r["cap_sqft"], "binding": r["binding"]},
    )


def a_coverage_share(a):
    lim = rp(a, "limit")
    r = T.coverage_share(
        need(a, "outlines"), need(a, "lot_area"), lim["value"], a.get("outline_tolerances_ft"), a.get("lot_area_tolerance_sqft", 0.0)
    )
    return measure(
        r["pct"],
        "%",
        lim,
        r["margin_pct"],
        r["pct_tolerance"],
        dimension="the house and ADU outlines wall to wall (lot coverage)",
        details={"covered_sqft": r["covered_sqft"], "allowed_sqft": r["allowed_sqft"], "covered_tolerance_sqft": r["covered_tolerance_sqft"]},
    )


def a_total_building_coverage(a):
    c = need(a, "cap_cell")
    if not (isinstance(c, dict) and all(k in c for k in ("provision_id", "cell_id", "row", "cell"))):
        raise CallError("model", "cap_cell must be a resolved cell {provision_id, cell_id, row, cell}")
    try:
        r = T.total_building_coverage(
            need(a, "outlines"),
            need(a, "lot_area"),
            c["row"],
            c["cell"],
            a.get("outline_tolerances_ft"),
            a.get("lot_area_tolerance_sqft", 0.0),
        )
    except ValueError as e:
        raise CallError("model", str(e))
    lim = {"provision_id": c["provision_id"], "param": c["cell_id"], "value": r["max_sqft"], "unit": "sqft"}
    return measure(
        r["covered_sqft"],
        "sqft",
        lim,
        r["margin_sqft"],
        r["tolerance_sqft"],
        "the outlines of every building wall to wall (building coverage)",
        {"row": r["row"], "cell": r["cell"]},
    )


def a_check_front_or_behind(a):
    mn = rp(a, "min_front")
    tol = a.get("tolerance_ft", 0.0)
    try:
        r = T.check_front_or_behind(need(a, "outline"), need(a, "front_lot_line"), mn["value"], need(a, "house_rear_wall"), tol)
    except ValueError as e:
        raise CallError("model", str(e))
    if r["branch"] == "front":
        limit, value = mn, r["front_distance_ft"]
    else:
        limit = {"provision_id": mn["provision_id"], "param": "behind the rear building wall", "value": 0, "unit": "ft"}
        value = r["behind_margin_ft"]
    return measure(
        value,
        "ft",
        limit,
        r["margin_ft"],
        tol,
        "distance from the front lot line or the rear building wall",
        {"branch": r["branch"], "front_margin_ft": r["front_margin_ft"], "behind_margin_ft": r["behind_margin_ft"]},
    )


def a_check_exception_conditions(a):
    params = need(a, "params")
    for k, v in params.items():
        if not (isinstance(v, dict) and "value" in v):
            raise CallError("model", f"parameter {k!r} must be resolved")
    flat = {k: v["value"] for k, v in params.items()}
    try:
        r = T.check_exception_conditions(
            need(a, "exception_id"), need(a, "base_provision_id"), need(a, "facts"), flat, a.get("version", 1)
        )
    except KeyError as e:
        raise CallError("tool", f"missing fact or parameter: {e.args[0]!r}")
    except ValueError as e:
        raise CallError("tool", str(e))
    for c in r["conditions"]:
        c["measure"] = _mr_from_raw(c["measure"], params.get(c.pop("param", None) or "", None))
    return r


def a_evaluate_guards(a):
    facts = need(a, "facts")
    guards = []
    for g in need(a, "guards"):
        v = facts.get(g["fact"])
        op = g.get("op")
        if v is None:
            holds = None
        elif op == "true":
            holds = v if isinstance(v, bool) else None
        elif op == "count>0":
            holds = v > 0 if isinstance(v, (int, float)) and not isinstance(v, bool) else None
        elif op == "nonempty":
            holds = len(v) > 0 if isinstance(v, list) else None
        elif op == "in":
            holds = (v in g.get("value")) if isinstance(v, (str, int, float, bool)) and isinstance(g.get("value"), list) else None
        else:
            holds = None
        guards.append({"clause_id": g["clause_id"], "fact": g["fact"], "value": v, "holds": holds})
    if not guards:
        result = "unknown"
    elif all(g["holds"] is False for g in guards):
        result = "known_false"
    elif all(g["holds"] is True for g in guards):
        result = "known_true"
    else:
        result = "unknown"
    return {"provision_id": need(a, "provision_id"), "result": result, "guards": guards}


def a_find_placements(a):
    sbs = []
    for s in need(a, "setbacks"):
        m = s.get("min") if isinstance(s, dict) else None
        if not (isinstance(m, dict) and "value" in m):
            raise CallError("model", "each setback's min must be a resolved parameter")
        sbs.append({"line": s["line"], "min_ft": m["value"], "provision_id": m["provision_id"]})
    tol = a.get("tolerance_ft", 0.0)
    fob = None
    if a.get("front_or_behind") is not None:
        f = a["front_or_behind"]
        mf = f.get("min_front") if isinstance(f, dict) else None
        if not (isinstance(mf, dict) and "value" in mf):
            raise CallError("model", "front_or_behind.min_front must be a resolved parameter")
        if "front_lot_line" not in f or "house_rear_wall" not in f:
            raise CallError("model", "front_or_behind needs front_lot_line and house_rear_wall")
        fob = {
            "front_lot_line": f["front_lot_line"],
            "house_rear_wall": f["house_rear_wall"],
            "min_front_ft": mf["value"],
            "provision_id": mf["provision_id"],
        }
    r = T.find_placements(
        need(a, "lot_outline"),
        need(a, "house_outline"),
        need(a, "structures"),
        need(a, "footprint"),
        sbs,
        a.get("step", 1.0),
        tuple(a.get("rotations", [0, 90])),
        tol,
        fob,
    )
    spot = a.get("client_spot")
    if spot is not None:
        o = T.G.placed_outline(need(a, "footprint"), spot)
        ms = [(s["provision_id"], T.G.distance_to_segment(o, s["line"]) - s["min_ft"]) for s in sbs]
        if fob is not None:
            fb = T.check_front_or_behind(o, fob["front_lot_line"], fob["min_front_ft"], fob["house_rear_wall"], tol)
            ms.append((fob["provision_id"], fb["margin_ft"]))
        failing = sorted({pid for pid, m in ms if m < -tol - T.EPS})
        fit = T.physical_fit(need(a, "lot_outline"), need(a, "house_outline"), need(a, "structures"), o)["pass"]
        if failing or fit is False:
            passes = False
        elif fit is True and all(m >= tol - T.EPS for _, m in ms):
            passes = True
        else:
            passes = None
        client_summary = {"passes": passes, "failing": failing}
    else:
        client_summary = None
    clear = r["candidates"][: r["clear_count"]]
    pool = clear if clear else r["candidates"]
    if spot is not None and pool:
        sr = spot.get("rotation", 0)
        best = min(
            pool,
            key=lambda c: (
                math.hypot(c["placement"]["x"] - spot["x"], c["placement"]["y"] - spot["y"]),
                c["placement"]["rotation"] != sr,
            ),
        )
        nearest = best["placement"]
    else:
        nearest = None
    if r["candidates"]:
        mc = max(r["candidates"], key=lambda c: c["min_margin_ft"] if c["min_margin_ft"] is not None else -1)
        max_clearance = mc["placement"]
    else:
        max_clearance = None
    return {
        "summary": {
            "count": r["count"],
            "clear_count": r["clear_count"],
            "client_spot": client_summary,
            "nearest_to_client": nearest,
            "max_clearance": max_clearance,
            "envelope_artifact": None,
        },
        "candidates": r["candidates"],
    }


def a_raw(fn, *names):
    return lambda a: fn(*[need(a, n) for n in names])


ADAPTERS = {
    "check_allowed": a_check_allowed,
    "check_setback": a_check_setback,
    "check_max": a_check_max,
    "footprint_dimensions": a_footprint_dimensions,
    "adu_max_living_area": a_adu_max_living_area,
    "coverage_share": a_coverage_share,
    "total_building_coverage": a_total_building_coverage,
    "check_front_or_behind": a_check_front_or_behind,
    "check_exception_conditions": a_check_exception_conditions,
    "evaluate_guards": a_evaluate_guards,
    "find_placements": a_find_placements,
    "placed_outline": a_raw(T.placed_outline, "footprint", "placement"),
    "physical_fit": a_raw(T.physical_fit, "lot_outline", "house_outline", "structures", "outline"),
    "distance_to_line": a_raw(T.distance_to_line, "outline", "line"),
}

NOT_YET = {"check_solar_shadow": "check_solar_shadow is not built in milestone 1 (WK-09 comes after the spine)"}

CONTRACT_TOOLS = set(ADAPTERS) | set(NOT_YET)


def check_request(req) -> list[str]:
    if not isinstance(req, dict):
        return ["request is not an object"]
    probs = []
    extra = [k for k in req if k not in ("config_hash", "batch")]
    if extra:
        probs.append(f"unexpected keys {sorted(extra)}")
    ch = req.get("config_hash")
    if not (isinstance(ch, str) and SHA.match(ch)):
        probs.append("config_hash must be a sha256 hex")
    batch = req.get("batch")
    if not (isinstance(batch, list) and len(batch) > 0):
        return probs + ["batch must be a non-empty list"]
    for i, call in enumerate(batch):
        if not isinstance(call, dict):
            probs.append(f"batch[{i}] is not an object")
            continue
        extra_c = [k for k in call if k not in ("call_id", "provision_id", "target", "tool", "args")]
        if extra_c:
            probs.append(f"batch[{i}] unexpected keys")
        cid = call.get("call_id")
        if not (isinstance(cid, str) and UUID7.match(cid)):
            probs.append(f"batch[{i}].call_id must be a UUIDv7")
        pid = call.get("provision_id")
        if pid is not None and not (isinstance(pid, str) and PROV.match(pid)):
            probs.append(f"batch[{i}].provision_id")
        if call.get("target") not in TARGETS:
            probs.append(f"batch[{i}].target")
        tool = call.get("tool")
        if tool not in CONTRACT_TOOLS:
            probs.append(f"batch[{i}].tool {tool!r} is not a bridge tool")
        if not isinstance(call.get("args"), dict):
            probs.append(f"batch[{i}].args must be an object")
    return probs


def run(req: dict) -> dict:
    probs = check_request(req)
    if probs:
        raise ValueError("; ".join(probs))
    out = []
    for call in req["batch"]:
        call_id = call["call_id"]
        t0 = time.perf_counter()
        try:
            tool = call["tool"]
            if tool in NOT_YET:
                raise CallError("tool", NOT_YET[tool])
            res = ADAPTERS[tool](call["args"])
            out.append(
                {
                    "call_id": call_id,
                    "ok": True,
                    "result": res,
                    "duration_ms": round((time.perf_counter() - t0) * 1000, 3),
                }
            )
        except CallError as e:
            out.append({"call_id": call_id, "ok": False, "error": {"category": e.category, "message": str(e)}})
        except KeyError as e:
            out.append(
                {"call_id": call_id, "ok": False, "error": {"category": "tool", "message": f"missing fact or parameter: {e.args[0]!r}"}}
            )
        except Exception as e:
            out.append(
                {"call_id": call_id, "ok": False, "error": {"category": "tool", "message": f"{type(e).__name__}: {e}"}}
            )
    return {"impl_digest": impl_digest(), "results": out}


def _uuid7(i: int) -> str:
    return f"0190c0de-0000-7000-8000-{i:012x}"


def self_test(write_fixtures: bool = False) -> bool:
    ex = json.load(open(os.path.join(HERE, "examples", "pdx-r5-adu-prov.json")))

    def V(e):
        return e["value"] if isinstance(e, dict) and "value" in e else e

    site = ex["site"]
    plan = ex["plan"]
    lot = V(site["lot_outline"])
    house = V(site["house_outline"])
    structures = V(site["structures"])
    footprint = V(plan["footprint"])
    front_line = V(site["front_lot_line"])
    rear_line = V(site["rear_lot_line"])
    side_lines = V(site["side_lot_lines"])
    zone = V(site["zone"])
    client = {"x": 2, "y": 74, "rotation": 0}
    selected = {"x": 13, "y": 65, "rotation": 0}
    client_outline = T.G.placed_outline(footprint, client)
    selected_outline = T.G.placed_outline(footprint, selected)

    def RP(provision_id, param, value, unit):
        return {"provision_id": provision_id, "param": param, "value": value, "unit": unit}

    def call(i, provision_id, target, tool, args):
        return {"call_id": _uuid7(i), "provision_id": provision_id, "target": target, "tool": tool, "args": args}

    side_min = RP("PDX.T110-4", "side_building_setback.R5", 5, "ft")
    req = {
        "config_hash": "0" * 64,
        "batch": [
            call(
                0,
                "PDX.33.110.220.B",
                "client_spot",
                "check_setback",
                {"outline": client_outline, "lines": side_lines, "min": side_min, "tolerance_ft": 0.5},
            ),
            call(
                1,
                "PDX.33.110.220.B",
                "selected_placement",
                "check_setback",
                {"outline": selected_outline, "lines": side_lines, "min": side_min, "tolerance_ft": 0.5},
            ),
            call(
                2,
                "PDX.33.110.220.B",
                "client_spot",
                "check_setback",
                {"outline": client_outline, "lines": side_lines, "min": 5},
            ),
            call(
                3,
                "PDX.33.205.040.C.1",
                "case",
                "adu_max_living_area",
                {
                    "primary_living_area": 1400,
                    "plan_living_area": 576,
                    "share": RP("PDX.33.205.040.C.1", "max_share_of_primary_living_area", 75, "%"),
                    "cap": RP("PDX.33.205.040.C.1", "max_living_area", 800, "sqft"),
                },
            ),
            call(
                4,
                "PDX.33.110.245.C.1",
                "case",
                "check_max",
                {"value": 15, "limit": RP("PDX.33.110.245.C.1", "max_height", 20, "ft")},
            ),
            call(
                5,
                "PDX.33.110.245.C.2",
                "selected_placement",
                "footprint_dimensions",
                {"outline": selected_outline, "limit": RP("PDX.33.110.245.C.2", "max_footprint_dimension", 24, "ft")},
            ),
            call(
                6,
                "PDX.33.110.245.C.3.a",
                "selected_placement",
                "coverage_share",
                {
                    "outlines": [selected_outline, structures[0]],
                    "lot_area": 5000,
                    "limit": RP("PDX.33.110.245.C.3.a", "max_combined_accessory_coverage_pct_of_site", 20, "%"),
                },
            ),
            call(
                7,
                "PDX.33.110.225.B",
                "selected_placement",
                "total_building_coverage",
                {
                    "outlines": [selected_outline, house, structures[0]],
                    "lot_area": 5000,
                    "cap_cell": {
                        "provision_id": "PDX.T110-5",
                        "cell_id": "T110-5:R3",
                        "row": "5,000 sq. ft. or more but less than 20,000 sq. ft.",
                        "cell": "2,250 sq. ft + 15% of lot area over 5,000 sq. ft.",
                    },
                },
            ),
            call(
                8,
                "PDX.33.205.040.C.2",
                "selected_placement",
                "check_front_or_behind",
                {
                    "outline": selected_outline,
                    "front_lot_line": front_line,
                    "min_front": RP("PDX.33.205.040.C.2", "front_lot_line_setback", 40, "ft"),
                    "house_rear_wall": [[12, 55], [38, 55]],
                },
            ),
            call(
                9,
                "PDX.33.110.245.C.2",
                "client_spot",
                "check_exception_conditions",
                {
                    "exception_id": "PDX.33.110.245.C.2",
                    "base_provision_id": "PDX.33.110.220.B",
                    "params": {
                        "zones_allowing_structures_in_side_rear_setbacks": RP(
                            "PDX.33.110.245.C.2",
                            "zones_allowing_structures_in_side_rear_setbacks",
                            ["R7", "R5", "R2.5"],
                            "zones",
                        ),
                        "min_distance_from_front_lot_line": RP(
                            "PDX.33.110.245.C.2", "min_distance_from_front_lot_line", 40, "ft"
                        ),
                        "min_distance_from_side_street_lot_line_corner": RP(
                            "PDX.33.110.245.C.2", "min_distance_from_side_street_lot_line_corner", 20, "ft"
                        ),
                        "max_footprint_dimension": RP("PDX.33.110.245.C.2", "max_footprint_dimension", 24, "ft"),
                        "max_height_in_setback": RP("PDX.33.110.245.C.2", "max_height_in_setback", 15, "ft"),
                        "max_wall_height_in_setback": RP("PDX.33.110.245.C.2", "max_wall_height_in_setback", 10, "ft"),
                        "dormer_min_setback_from_side_rear": RP(
                            "PDX.33.110.245.C.2", "dormer_min_setback_from_side_rear", 5, "ft"
                        ),
                        "max_combined_length_in_setback_per_line": RP(
                            "PDX.33.110.245.C.2", "max_combined_length_in_setback_per_line", 24, "ft"
                        ),
                    },
                    "facts": {
                        "outline": client_outline,
                        "zone": zone,
                        "front_lot_line": front_line,
                        "corner_lot": V(site["corner_lot"]),
                        "height_ft": V(plan["height_ft"]),
                        "wall_height_ft": 12,
                        "plan_kind": V(plan["kind"]),
                        "openings_facing_lot_line": True,
                        "rooftop_deck": False,
                        "dormers": False,
                        "structures": structures,
                        "setback_lines": [
                            {"name": "west", "line": side_lines[0], "min_ft": 5},
                            {"name": "rear", "line": rear_line, "min_ft": 5},
                        ],
                    },
                },
            ),
            call(
                10,
                "PDX.11.50.020",
                "case",
                "evaluate_guards",
                {
                    "provision_id": "PDX.11.50.020",
                    "facts": {"site.trees": V(site["trees"])},
                    "guards": [{"clause_id": "PDX.11.50.020#v1::sentence:1", "fact": "site.trees", "op": "true"}],
                },
            ),
            call(
                11,
                "PDX.33.110.220.B",
                "client_spot",
                "find_placements",
                {
                    "lot_outline": lot,
                    "house_outline": house,
                    "structures": structures,
                    "footprint": footprint,
                    "tolerance_ft": 0.5,
                    "setbacks": [
                        {"line": front_line, "min": RP("PDX.T110-4", "front_building_setback.R5", 10, "ft")},
                        {"line": rear_line, "min": RP("PDX.T110-4", "rear_building_setback.R5", 5, "ft")},
                        {"line": side_lines[0], "min": RP("PDX.T110-4", "side_building_setback.R5", 5, "ft")},
                        {"line": side_lines[1], "min": RP("PDX.T110-4", "side_building_setback.R5", 5, "ft")},
                    ],
                    "client_spot": client,
                },
            ),
            call(12, None, "case", "check_solar_shadow", {}),
            call(
                13,
                "PDX.T110-2",
                "case",
                "check_allowed",
                {"allowed": "true", "zone": zone, "param": "accessory_dwelling_unit_see_chapter_33_205.R5"},
            ),
            call(14, "PDX.T110-2", "case", "check_allowed", {"allowed": "false", "zone": zone, "param": "x.R5"}),
        ],
    }
    resp = run(req)
    R = resp["results"]
    checks = [
        (
            "client spot fails the side setback (margin -3)",
            R[0]["ok"] and R[0]["result"]["pass"] is False and R[0]["result"]["margin"] == -3.0,
        ),
        (
            "selected spot passes it (margin 8)",
            R[1]["ok"] and R[1]["result"]["pass"] is True and R[1]["result"]["margin"] == 8.0,
        ),
        (
            "a model-typed limit is refused as a model error",
            (not R[2]["ok"]) and R[2]["error"]["category"] == "model",
        ),
        (
            "size cap 800, plan 576 passes by 224",
            R[3]["result"]["limit"]["value"] == 800 and R[3]["result"]["margin"] == 224.0 and R[3]["result"]["pass"] is True,
        ),
        ("height 15 under 20", R[4]["result"]["pass"] is True),
        ("footprint 24 at the 24 limit passes", R[5]["result"]["pass"] is True),
        (
            "accessory coverage 13.12% under 20%",
            R[6]["result"]["pass"] is True and abs(R[6]["result"]["value"] - 13.12) < 1e-6,
        ),
        (
            "total coverage 1,566 under 2,250",
            R[7]["result"]["limit"]["value"] == 2250 and R[7]["result"]["value"] == 1566.0,
        ),
        ("selected spot is far enough from the front or behind the house", R[8]["result"]["pass"] is True),
        (
            "the exception fails at the client spot on the wall and the windows",
            R[9]["ok"]
            and R[9]["result"]["pass"] is False
            and {c["clause_id"].split("::item:")[1] for c in R[9]["result"]["conditions"] if c["holds"] is False}
            == {"b.(4)", "b.(6)"},
        ),
        ("no trees: the tree gate is known false", R[10]["result"]["result"] == "known_false"),
        (
            "placements found, client spot fails, nearest clear named",
            R[11]["ok"]
            and R[11]["result"]["summary"]["count"] > 0
            and R[11]["result"]["summary"]["client_spot"]["passes"] is False
            and R[11]["result"]["summary"]["nearest_to_client"] is not None,
        ),
        ("the solar check is a stated tool error", (not R[12]["ok"]) and R[12]["error"]["category"] == "tool"),
        ("a malformed request is refused", _refused({"config_hash": "x", "batch": []})),
        (
            "an ADU allowed in R5 passes the gate (L32)",
            R[13]["ok"] and R[13]["result"]["pass"] is True and R[13]["result"]["margin"] == 0.0,
        ),
        (
            "a use not allowed fails the gate (L32)",
            R[14]["ok"] and R[14]["result"]["pass"] is False and R[14]["result"]["margin"] == -1.0,
        ),
    ]
    oks = [bool(ok) for _, ok in checks]
    for (name, _), ok in zip(checks, oks):
        print(("ok  " if ok else "FAIL") + " " + name)
    passed = sum(oks)
    total = len(checks)
    print(f"{passed}/{total} bridge checks · impl_digest {resp['impl_digest'][:12]}")
    if not write_fixtures:
        return all(oks)
    fx = os.path.join(HERE, "..", "query", "contracts", "fixtures", "valid")
    with open(os.path.join(fx, "C3_BridgeRequest.self-test.json"), "w") as fh:
        json.dump(req, fh, indent=1)
    resp_out = json.loads(json.dumps(resp))
    for bcall, res in zip(req["batch"], resp_out["results"]):
        if bcall["tool"] == "find_placements" and res.get("ok"):
            res["result"] = {"summary": res["result"]["summary"], "candidates": res["result"]["candidates"][:3]}
    with open(os.path.join(fx, "C3_BridgeResponse.self-test.json"), "w") as fh:
        json.dump(resp_out, fh, indent=1)
    return all(oks)


def _refused(req) -> bool:
    try:
        run(req)
    except ValueError:
        return True
    return False


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(0 if self_test("--write-fixtures" in sys.argv) else 1)
    try:
        req = json.load(sys.stdin)
    except ValueError as e:
        print(json.dumps({"error": f"request is not JSON: {e}"}))
        sys.exit(2)
    try:
        print(json.dumps(run(req)))
    except ValueError as e:
        print(json.dumps({"error": f"request does not match contract C3: {e}"}))
        sys.exit(2)
