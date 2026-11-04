#!/usr/bin/env python3
"""Case gate Python validator and geometry/fact computer for LotFit W3.

Uses graph/model.py (load_model, fact_index, validate_input, flatten, _holds) and
graph/tools/geometry.py (area, edges, _proper_cross, on_boundary, within,
point_segment_distance, distance_to_segment, placed_outline) against
graph/curated/facts.json, graph/curated/conventions.json, and
graph/curated/ambiguities.json.

Stdlib only; safe under `python3 -I`.
"""

import hashlib
import json
import pathlib
import re
import sys
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
GRAPH_DIR = REPO_ROOT / "graph"
sys.path.insert(0, str(GRAPH_DIR))

import model as M  # noqa: E402
from tools import geometry as G  # noqa: E402

# Geometry facts where `entered` with `rests_on` is accepted by the case gate
# pending W4 registry update in curated/facts.json.
ENTERED_GEOMETRY_FACTS = {
    "site.lot_outline",
    "site.house_outline",
    "site.structures",
    "site.front_lot_line",
    "site.rear_lot_line",
    "site.side_lot_lines",
    "site.side_street_lot_line",
    "site.house_main_entrance",
}

# Base building setbacks (ft) from PDX.T110-4 for single-dwelling zones.
PDX_T110_4_SETBACKS: dict[str, dict[str, float]] = {
    "RF": {"front": 20.0, "side": 10.0, "rear": 10.0, "side_street": 10.0},
    "R20": {"front": 20.0, "side": 10.0, "rear": 10.0, "side_street": 10.0},
    "R10": {"front": 20.0, "side": 10.0, "rear": 10.0, "side_street": 10.0},
    "R7": {"front": 15.0, "side": 5.0, "rear": 5.0, "side_street": 5.0},
    "R5": {"front": 10.0, "side": 5.0, "rear": 5.0, "side_street": 5.0},
    "R2.5": {"front": 10.0, "side": 5.0, "rear": 5.0, "side_street": 5.0},
}



def _eug_setbacks() -> dict[str, dict[str, float]]:
    """Eugene's base setbacks for a detached ADU, read from the graph (never typed here): the front yard setback of
    Table 9.2750 and the ADU interior setback of 9.2751(17)(b)4.a. (interior = side and rear lines, EC 9.0500). The
    street side of a corner lot is a front lot line in Eugene. CC, 2026-11-02."""
    try:
        g = json.loads((GRAPH_DIR / "out" / "graph-or.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    params = {p["id"]: {q["name"]: q["value"] for q in p["versions"][-1]["params"]} for p in g.get("provisions", []) if p.get("layer") == "EUG"}
    interior = params.get("EUG.9.2751.17.b.4.a.setback", {}).get("min_interior_setback")
    out: dict[str, dict[str, float]] = {}
    for name, v in params.get("EUG.T9.2750", {}).items():
        if name.startswith("front_yard_setback_excluding_garages_and.") and interior is not None:
            z = name.split(".", 1)[1]
            out[z] = {"front": float(v), "side": float(interior), "rear": float(interior), "side_street": float(v)}
    return out


EUG_SETBACKS = _eug_setbacks()
BASE_SETBACKS: dict[str, dict[str, float]] = {**PDX_T110_4_SETBACKS, **EUG_SETBACKS}
SINGLE_DWELLING_ZONES = set(PDX_T110_4_SETBACKS.keys()) | {"R-1"}   # Eugene: R-1 is designed for single-unit dwellings (EC 9.2700)
KNOWN_CITY_LAYERS = ("PDX", "GRE", "EUG")
VALID_FACT_STATUSES = {"known", "unconfirmed", "conflicting"}
VALID_AS_OF_MEANINGS = {"planned_submittal", "submitted_on", "today"}
UUIDV7_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
FALLBACK_UUID = "019a4000-0000-7000-8000-000000000000"


def _clean_num(x: float) -> int | float:
    r = round(float(x), 6)
    if r == 0.0:
        return 0
    if abs(r - round(r)) < 1e-9:
        return int(round(r))
    return r


def _refusal(case_id: str, invariant: str, message: str, path: str | None = None) -> dict[str, Any]:
    valid_id = case_id if isinstance(case_id, str) and UUIDV7_RE.match(case_id) else FALLBACK_UUID
    out: dict[str, Any] = {
        "case_id": valid_id,
        "refused": True,
        "invariant": invariant,
        "message": message,
    }
    if path is not None:
        out["path"] = path
    return out


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _is_point(pt: Any) -> bool:
    return (
        isinstance(pt, list)
        and len(pt) == 2
        and all(isinstance(c, (int, float)) and not isinstance(c, bool) for c in pt)
    )


def _is_segment(seg: Any) -> bool:
    return isinstance(seg, list) and len(seg) == 2 and _is_point(seg[0]) and _is_point(seg[1])


def _is_polygon(poly: Any) -> bool:
    return isinstance(poly, list) and len(poly) >= 3 and all(_is_point(pt) for pt in poly)


def _seg_len(a: list[float] | tuple[float, float], b: list[float] | tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _check_simple_polygon(poly: Any, label: str) -> str | None:
    if not _is_polygon(poly):
        return f"{label} must be a polygon of at least 3 [x, y] points"
    pts = [[float(p[0]), float(p[1])] for p in poly]
    n = len(pts)
    seen = set()
    for p in pts:
        key = (round(p[0], 6), round(p[1], 6))
        if key in seen:
            return f"{label} has duplicate vertices at {p}"
        seen.add(key)
    poly_edges = G.edges(pts)
    for i, (a, b) in enumerate(poly_edges):
        if _seg_len(a, b) <= G.EPS:
            return f"{label} has a zero-length edge at index {i}"
    for i in range(n):
        for j in range(i + 1, n):
            if j == i or j == (i + 1) % n or i == (j + 1) % n:
                continue
            if G._proper_cross(poly_edges[i][0], poly_edges[i][1], poly_edges[j][0], poly_edges[j][1]):
                return f"{label} self-intersects between edges {i} and {j}"
    if G.area(pts) <= G.EPS:
        return f"{label} must have positive area"
    return None


def _segment_on_polygon_boundary(seg: Any, poly: list[Any]) -> bool:
    if not _is_segment(seg):
        return False
    p1 = [float(seg[0][0]), float(seg[0][1])]
    p2 = [float(seg[1][0]), float(seg[1][1])]
    if _seg_len(p1, p2) <= G.EPS:
        return False
    pts = [[float(p[0]), float(p[1])] for p in poly]
    mid = [(p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0]
    return G.on_boundary(p1, pts) and G.on_boundary(p2, pts) and G.on_boundary(mid, pts)


def _extract_entry_tolerances(entry: Any) -> list[float]:
    tols: list[float] = []
    if not isinstance(entry, dict):
        return tols
    obs = entry.get("observations") if "observations" in entry else [entry]
    if not isinstance(obs, list):
        return tols
    for o in obs:
        if isinstance(o, dict) and isinstance(o.get("prov"), list):
            for p in o["prov"]:
                if isinstance(p, dict):
                    t = p.get("tolerance")
                    if isinstance(t, dict) and isinstance(t.get("value"), (int, float)) and not isinstance(t.get("value"), bool):
                        tols.append(float(t["value"]))
                    elif isinstance(t, (int, float)) and not isinstance(t, bool):
                        tols.append(float(t))
    return tols


def _extract_entry_status(entry: Any) -> str:
    if not isinstance(entry, dict):
        return "known"
    st = entry.get("status")
    if st in ("known", "unconfirmed"):
        return st
    prov = entry.get("prov")
    if isinstance(prov, list):
        for p in prov:
            if isinstance(p, dict) and (p.get("status") == "unconfirmed" or p.get("kind") == "owner_statement"):
                return "unconfirmed"
    return "known"


def _compute_house_rear_wall(
    house_poly: list[Any],
    front_line: list[Any] | None,
    main_entrance: list[Any] | None,
) -> tuple[list[list[int | float]], str, str, bool]:
    pts = [[float(p[0]), float(p[1])] for p in house_poly]
    poly_edges = G.edges(pts)

    if main_entrance is not None and _is_point(main_entrance):
        ent = [float(main_entrance[0]), float(main_entrance[1])]
        ent_edge = min(poly_edges, key=lambda e: G.point_segment_distance(ent, e[0], e[1]))

        def dist_to_ent_edge(e: tuple[list[float], list[float]]) -> float:
            mid = [(e[0][0] + e[1][0]) / 2.0, (e[0][1] + e[1][1]) / 2.0]
            return G.point_segment_distance(mid, ent_edge[0], ent_edge[1])

        rear_edge = max(poly_edges, key=dist_to_ent_edge)
        doc = "derived from site.house_outline + site.house_main_entrance"
        where = "wall of site.house_outline farthest from the wall containing site.house_main_entrance (33.205.040.C.2.b)"
        unconfirmed_fallback = False
    else:
        f_a = [float(front_line[0][0]), float(front_line[0][1])] if front_line is not None else [0.0, 0.0]
        f_b = [float(front_line[1][0]), float(front_line[1][1])] if front_line is not None else [50.0, 0.0]

        def dist_to_front(e: tuple[list[float], list[float]]) -> float:
            mid = [(e[0][0] + e[1][0]) / 2.0, (e[0][1] + e[1][1]) / 2.0]
            return G.point_segment_distance(mid, f_a, f_b)

        rear_edge = max(poly_edges, key=dist_to_front)
        doc = "derived from site.house_outline + site.front_lot_line"
        where = "wall farthest from front_lot_line (assumed main entrance faces street; site.house_main_entrance not supplied)"
        unconfirmed_fallback = True

    p1 = [_clean_num(rear_edge[0][0]), _clean_num(rear_edge[0][1])]
    p2 = [_clean_num(rear_edge[1][0]), _clean_num(rear_edge[1][1])]
    if (p1[0], p1[1]) <= (p2[0], p2[1]):
        seg_out = [p1, p2]
    else:
        seg_out = [p2, p1]
    return seg_out, doc, where, unconfirmed_fallback


def validate_and_compute(payload: Any, expected_case_hash: str | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return _refusal(FALLBACK_UUID, "I1", "Case input must be a JSON object", "schema")

    case_id = payload.get("case_id") if isinstance(payload.get("case_id"), str) else FALLBACK_UUID

    # I1: schema version & envelope
    if payload.get("schema") != "lotfit.case/1":
        return _refusal(
            case_id,
            "I1",
            f"Unsupported or missing case schema: {payload.get('schema')!r} (expected 'lotfit.case/1')",
            "schema",
        )
    if not isinstance(payload.get("case_id"), str) or not UUIDV7_RE.match(payload["case_id"]):
        return _refusal(case_id, "I1", "case_id must be a valid UUIDv7 string", "case_id")

    mode = payload.get("mode")
    if mode not in ("check_spot", "find_spots", "propose"):
        return _refusal(case_id, "I1", f"Invalid mode: {mode!r}", "mode")

    # I3: Jurisdiction layers known
    jur = payload.get("jurisdiction")
    if not isinstance(jur, dict):
        return _refusal(case_id, "I3", "jurisdiction must be an object with state_layer and city_layer", "jurisdiction")
    if jur.get("state_layer") != "OR":
        return _refusal(case_id, "I3", f"Unknown state_layer: {jur.get('state_layer')!r}", "jurisdiction.state_layer")
    if jur.get("city_layer") not in KNOWN_CITY_LAYERS:
        return _refusal(case_id, "I3", f"Unknown city_layer: {jur.get('city_layer')!r}", "jurisdiction.city_layer")

    # I2: as_of.date within Portland coverage (from 2026-11-01)
    as_of = payload.get("as_of")
    if not isinstance(as_of, dict) or not isinstance(as_of.get("date"), str):
        return _refusal(case_id, "I2", "as_of.date is required (YYYY-MM-DD)", "as_of.date")
    as_of_date = as_of["date"]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", as_of_date):
        return _refusal(case_id, "I2", f"as_of.date must be YYYY-MM-DD, got {as_of_date!r}", "as_of.date")
    if as_of.get("meaning") not in VALID_AS_OF_MEANINGS:
        return _refusal(case_id, "I2", f"Invalid as_of.meaning: {as_of.get('meaning')!r}", "as_of.meaning")
    if jur.get("city_layer") == "PDX" and as_of_date < "2026-11-01":
        return _refusal(
            case_id,
            "I2",
            f"as_of.date {as_of_date} is before Portland Title 33 modeled coverage (effective 2026-11-01; NOT_MODELED-eligible)",
            "as_of.date",
        )

    site = payload.get("site")
    plan = payload.get("plan")
    if not isinstance(site, dict):
        return _refusal(case_id, "I1", "site must be an object", "site")
    if not isinstance(plan, dict):
        return _refusal(case_id, "I1", "plan must be an object", "plan")

    # Load model and fact registry from graph/model.py
    m = M.load_model()
    F = M.fact_index(m)

    # Temporary allowance until W4 updates curated/facts.json: allow `entered` on geometry facts (with rests_on checked below)
    for gfact in ENTERED_GEOMETRY_FACTS:
        if gfact in F and "entered" not in F[gfact]["accepted_sources"]:
            F[gfact]["accepted_sources"] = list(F[gfact]["accepted_sources"]) + ["entered"]

    # I11: unknowns validation
    unknowns_raw = payload.get("unknowns", [])
    if not isinstance(unknowns_raw, list):
        return _refusal(case_id, "I11", "unknowns must be a list of {fact, reason} objects", "unknowns")
    unknown_facts: set[str] = set()
    for idx, u in enumerate(unknowns_raw):
        if not isinstance(u, dict) or not isinstance(u.get("fact"), str) or not isinstance(u.get("reason"), str) or not u["reason"].strip():
            return _refusal(case_id, "I11", f"unknowns[{idx}] must be {{fact, reason}}", "unknowns")
        uf = u["fact"]
        if uf not in F:
            return _refusal(case_id, "I4", f"Unregistered fact in unknowns: {uf}", "unknowns")
        sc, _, key = uf.partition(".")
        bag = site if sc == "site" else plan if sc == "plan" else {}
        if key in bag:
            return _refusal(
                case_id,
                "I11",
                f"{uf} is listed as unknown and also given a value",
                "unknowns",
            )
        unknown_facts.add(uf)

    # I8: check_spot placement rules (checked before general input validation so missing placement yields I8)
    has_placement = "placement" in plan and plan["placement"] is not None
    if mode == "check_spot" and not has_placement:
        return _refusal(case_id, "I8", "check_spot needs plan.placement", "plan.placement")
    if mode != "check_spot" and has_placement:
        return _refusal(case_id, "I8", "only check_spot carries a placement", "plan.placement")

    # Per-fact checks for I4, I6, I9, I11
    for scope_name, bag in (("site", site), ("plan", plan)):
        for k, fentry in bag.items():
            fname = f"{scope_name}.{k}"
            if fname not in F:
                return _refusal(case_id, "I4", f"{fname}: not a registered fact (GR-11)", fname)
            if not isinstance(fentry, dict):
                return _refusal(case_id, "I4", f"{fname}: fact entry must be an object", fname)

            # I11: status check
            if "status" in fentry and fentry["status"] not in VALID_FACT_STATUSES:
                return _refusal(case_id, "I11", f"{fname}: invalid fact status {fentry['status']!r}", fname)

            # I9: conflicting fact checks
            if "observations" in fentry:
                obs_list = fentry.get("observations")
                if not isinstance(obs_list, list) or len(obs_list) < 2:
                    return _refusal(
                        case_id,
                        "I9",
                        f"{fname}: conflicting fact must carry at least 2 observations with provenance",
                        fname,
                    )
                for o_idx, obs in enumerate(obs_list):
                    if not isinstance(obs, dict) or "value" not in obs or not isinstance(obs.get("prov"), list) or len(obs["prov"]) == 0:
                        return _refusal(
                            case_id,
                            "I9",
                            f"{fname}.observations[{o_idx}] requires value and non-empty prov",
                            fname,
                        )
                distinct_vals = {_canonical_json(obs["value"]) for obs in obs_list}
                if len(distinct_vals) < 2:
                    return _refusal(
                        case_id,
                        "I9",
                        f"{fname}: conflicting observations must not collapse to identical values",
                        fname,
                    )
            else:
                if fentry.get("status") == "conflicting":
                    return _refusal(
                        case_id,
                        "I9",
                        f"{fname}: status 'conflicting' cannot sit on a collapsed single value; use observations (>= 2)",
                        fname,
                    )

            # I6: provenance checks (including entered geometry rests_on)
            obs_to_check = fentry["observations"] if "observations" in fentry else [fentry]
            for obs in obs_to_check:
                provs = obs.get("prov")
                if not isinstance(provs, list) or len(provs) == 0:
                    return _refusal(case_id, "I6", f"{fname}: empty or missing provenance", fname)
                for pr in provs:
                    if not isinstance(pr, dict):
                        return _refusal(case_id, "I6", f"{fname}: provenance entry must be an object", fname)
                    miss = [x for x in ("kind", "document", "where", "when", "by") if not pr.get(x) or not isinstance(pr.get(x), str)]
                    if miss:
                        return _refusal(case_id, "I6", f"{fname}: provenance lacks {miss}", fname)
                    tol = pr.get("tolerance")
                    if tol is not None:
                        if (
                            not isinstance(tol, dict)
                            or not isinstance(tol.get("value"), (int, float))
                            or isinstance(tol.get("value"), bool)
                            or float(tol["value"]) < 0
                            or tol.get("unit") not in ("ft", "m", "sqft", "deg")
                        ):
                            return _refusal(case_id, "I6", f"{fname}: invalid tolerance object on provenance", fname)
                    if tol is None and not pr.get("status"):
                        return _refusal(case_id, "I6", f"{fname}: provenance needs a tolerance or a status (GR-22)", fname)
                    if pr["kind"] == "entered" and fname in ENTERED_GEOMETRY_FACTS:
                        rests_on = pr.get("rests_on")
                        if not isinstance(rests_on, str) or not rests_on.strip():
                            return _refusal(
                                case_id,
                                "I6",
                                f"{fname}: entered geometry needs rests_on (the capture or document it was read from)",
                                fname,
                            )

    # Run graph/model.py validate_input
    problems, _conflicts = M.validate_input(payload, m, purpose="adu_evaluation")
    for prob in problems:
        fname = prob.split(":", 1)[0].strip()
        if "required for adu_evaluation and missing" in prob:
            if fname in unknown_facts:
                continue
            return _refusal(case_id, "I5", prob, fname)
        if "not a registered fact" in prob:
            return _refusal(case_id, "I4", prob, fname)
        if (
            "source kind" in prob
            or "official record" in prob
            or "provenance" in prob
        ):
            return _refusal(case_id, "I6", prob, fname)
        if fname == "plan.placement":
            return _refusal(case_id, "I8", prob, "plan.placement")
        return _refusal(case_id, "I4", prob, fname)

    # Also ensure rear_lot_line and side_lot_lines are present for ADU evaluation unless in unknowns
    for req_line in ("site.rear_lot_line", "site.side_lot_lines"):
        _, _, rkey = req_line.partition(".")
        if rkey not in site and req_line not in unknown_facts:
            return _refusal(case_id, "I5", f"{req_line}: required for adu_evaluation and missing", req_line)

    # Flatten values for geometry and ambiguity checks
    flat_vals = M.flatten(payload)

    # I7: Site geometry checks in feet in the lot frame (curated/conventions.json)
    lot_val = flat_vals.get("site.lot_outline")
    if lot_val is not None:
        poly_err = _check_simple_polygon(lot_val, "site.lot_outline")
        if poly_err:
            return _refusal(case_id, "I7", poly_err, "site.lot_outline")
        if any(float(p[1]) < -G.EPS for p in lot_val):
            return _refusal(
                case_id,
                "I7",
                "site.lot_outline has negative y coordinates outside the lot frame (+y into the lot from street)",
                "site.lot_outline",
            )
        lot_pts = [[float(p[0]), float(p[1])] for p in lot_val]

        for line_key in ("site.front_lot_line", "site.rear_lot_line", "site.side_street_lot_line"):
            lval = flat_vals.get(line_key)
            if lval is not None:
                if not _segment_on_polygon_boundary(lval, lot_pts):
                    return _refusal(
                        case_id,
                        "I7",
                        f"{line_key} must have positive length and lie on the boundary of site.lot_outline",
                        line_key,
                    )

        svals = flat_vals.get("site.side_lot_lines")
        if svals is not None:
            if not isinstance(svals, list) or len(svals) == 0:
                return _refusal(
                    case_id,
                    "I7",
                    "site.side_lot_lines must be a non-empty list of segments on the boundary of site.lot_outline",
                    "site.side_lot_lines",
                )
            for idx, seg in enumerate(svals):
                if not _segment_on_polygon_boundary(seg, lot_pts):
                    return _refusal(
                        case_id,
                        "I7",
                        f"site.side_lot_lines[{idx}] must have positive length and lie on the boundary of site.lot_outline",
                        "site.side_lot_lines",
                    )

        hval = flat_vals.get("site.house_outline")
        if hval is not None:
            herr = _check_simple_polygon(hval, "site.house_outline")
            if herr:
                return _refusal(case_id, "I7", herr, "site.house_outline")
            house_pts = [[float(p[0]), float(p[1])] for p in hval]
            if not G.within(house_pts, lot_pts):
                return _refusal(
                    case_id,
                    "I7",
                    "site.house_outline must lie inside site.lot_outline",
                    "site.house_outline",
                )
            ent_val = flat_vals.get("site.house_main_entrance")
            if ent_val is not None:
                if not _is_point(ent_val) or not G.on_boundary([float(ent_val[0]), float(ent_val[1])], house_pts):
                    return _refusal(
                        case_id,
                        "I7",
                        "site.house_main_entrance must lie on the boundary of site.house_outline",
                        "site.house_main_entrance",
                    )

        structs = flat_vals.get("site.structures")
        if isinstance(structs, list):
            for idx, st in enumerate(structs):
                if not isinstance(st, dict) or "outline" not in st:
                    return _refusal(case_id, "I7", f"site.structures[{idx}] is missing outline", "site.structures")
                serr = _check_simple_polygon(st["outline"], f"site.structures[{idx}].outline")
                if serr:
                    return _refusal(case_id, "I7", serr, "site.structures")
                st_pts = [[float(p[0]), float(p[1])] for p in st["outline"]]
                if not G.within(st_pts, lot_pts):
                    return _refusal(
                        case_id,
                        "I7",
                        f"site.structures[{idx}].outline must lie inside site.lot_outline",
                        "site.structures",
                    )

    # I8: Plan footprint and placement validation
    fp_val = flat_vals.get("plan.footprint")
    if fp_val is not None:
        fperr = _check_simple_polygon(fp_val, "plan.footprint")
        if fperr:
            return _refusal(case_id, "I8", fperr, "plan.footprint")

    placement_val = flat_vals.get("plan.placement")
    if mode == "check_spot":
        if (
            not isinstance(placement_val, dict)
            or not isinstance(placement_val.get("x"), (int, float))
            or isinstance(placement_val.get("x"), bool)
            or not isinstance(placement_val.get("y"), (int, float))
            or isinstance(placement_val.get("y"), bool)
        ):
            return _refusal(case_id, "I8", "plan.placement value must be {x, y, rotation}", "plan.placement")
        rot = placement_val.get("rotation", 0)
        if not isinstance(rot, (int, float)) or isinstance(rot, bool) or rot % 90 != 0:
            return _refusal(case_id, "I8", "plan.placement rotation must be a multiple of 90 degrees", "plan.placement")

    # I12: Active ambiguities check (curated/ambiguities.json)
    for amb in m["ambiguities"].get("ambiguities", []):
        if amb.get("status") != "active":
            continue
        amb_id = amb["id"]
        holds = [M._holds(c, flat_vals) for c in amb.get("matters_when", [])]
        if any(h is False for h in holds):
            continue
        for eff in amb.get("effects", []):
            if eff.get("per_reading") and eff.get("fact"):
                target_fact = eff["fact"]
                sc, _, tkey = target_fact.partition(".")
                bag = site if sc == "site" else plan if sc == "plan" else {}
                target_entry = bag.get(tkey)
                if not isinstance(target_entry, dict):
                    return _refusal(
                        case_id,
                        "I12",
                        f"Ambiguity {amb_id} is active; {target_fact} must provide by_reading[{amb_id!r}]",
                        f"{target_fact}.by_reading",
                    )
                by_reading = target_entry.get("by_reading")
                readings_for_amb = by_reading.get(amb_id) if isinstance(by_reading, dict) else None
                if (
                    not isinstance(readings_for_amb, list)
                    or len(readings_for_amb) < 2
                    or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in readings_for_amb)
                ):
                    return _refusal(
                        case_id,
                        "I12",
                        f"Ambiguity {amb_id} requires numeric readings in {target_fact}.by_reading[{amb_id!r}]",
                        f"{target_fact}.by_reading",
                    )

    # I10: Compute canonical case_hash and verify if an expected hash was provided
    parsed_case: dict[str, Any] = {
        "schema": "lotfit.case/1",
        "case_id": payload["case_id"],
        "as_of": payload["as_of"],
        "jurisdiction": payload["jurisdiction"],
        "mode": payload["mode"],
        "capture": payload.get("capture", None),
        "site": site,
        "plan": plan,
        "unknowns": unknowns_raw,
    }
    if "parcel" in payload and payload["parcel"] is not None:
        parsed_case["parcel"] = payload["parcel"]
    if "context" in payload and payload["context"] is not None:
        parsed_case["context"] = payload["context"]

    case_hash = hashlib.sha256(_canonical_json(parsed_case).encode("utf-8")).hexdigest()
    supplied_hash = expected_case_hash if expected_case_hash is not None else payload.get("case_hash")
    if supplied_hash is not None and supplied_hash != case_hash:
        return _refusal(
            case_id,
            "I10",
            f"case_hash mismatch: supplied {supplied_hash!r} != computed {case_hash!r}",
            "case_hash",
        )

    # Materialize the 5 COMPUTED_FACTS
    computed: dict[str, Any] = {}

    # 1. site.zone_family
    zone_entry = site.get("zone")
    zone_val = flat_vals.get("site.zone")
    if isinstance(zone_val, str) and zone_val in SINGLE_DWELLING_ZONES:
        zf_tols = _extract_entry_tolerances(zone_entry)
        zf_tol = _clean_num(max(zf_tols)) if zf_tols else 0
        zf_status = _extract_entry_status(zone_entry)
        computed["site.zone_family"] = {
            "value": "single_dwelling",
            "status": zf_status,
            "prov": [
                {
                    "kind": "computed",
                    "document": "derived from site.zone",
                    "where": f"{'EUG 9.2700' if zone_val == 'R-1' else 'PDX.33.110.020'} ({zone_val} -> single_dwelling)",
                    "when": as_of_date,
                    "by": "lotfit.case-gate",
                    "tolerance": {"value": zf_tol, "unit": "ft"},
                    "status": zf_status,
                }
            ],
        }

    # 2. site.lot_area_sqft
    lot_entry = site.get("lot_outline")
    if lot_val is not None and lot_entry is not None:
        area_val = _clean_num(G.area([[float(p[0]), float(p[1])] for p in lot_val]))
        la_tols = _extract_entry_tolerances(lot_entry)
        # The outline's tolerance is a length (ft): how far each edge may sit from where it is drawn. The area's
        # bound is every edge at that distance outward: perimeter x tolerance (sq ft). Copying the length as an area
        # understated it ~100x on a 64 x 100 ft lot (CC, 2026-11-02).
        edge_tol_ft = max(la_tols) if la_tols else 0
        pts = [[float(p[0]), float(p[1])] for p in lot_val]
        perim_ft = sum(((pts[i][0] - pts[i - 1][0]) ** 2 + (pts[i][1] - pts[i - 1][1]) ** 2) ** 0.5 for i in range(len(pts)))
        la_tol = _clean_num(perim_ft * edge_tol_ft)
        la_status = _extract_entry_status(lot_entry)
        computed["site.lot_area_sqft"] = {
            "value": area_val,
            "status": la_status,
            "prov": [
                {
                    "kind": "computed",
                    "document": "derived from site.lot_outline",
                    "where": "shoelace area of site.lot_outline (33.930.025)",
                    "when": as_of_date,
                    "by": "lotfit.case-gate",
                    "tolerance": {"value": la_tol, "unit": "sqft"},
                    "status": la_status,
                }
            ],
        }

    # 3. site.house_rear_wall
    house_entry = site.get("house_outline")
    front_entry = site.get("front_lot_line")
    ent_entry = site.get("house_main_entrance")
    house_val = flat_vals.get("site.house_outline")
    front_val = flat_vals.get("site.front_lot_line")
    ent_val = flat_vals.get("site.house_main_entrance")
    if house_val is not None:
        rw_seg, rw_doc, rw_where, rw_unconfirmed = _compute_house_rear_wall(house_val, front_val, ent_val)
        rw_inputs = [house_entry] + ([ent_entry] if ent_val is not None else [front_entry])
        rw_tols = [t for e in rw_inputs if e is not None for t in _extract_entry_tolerances(e)]
        rw_tol = _clean_num(max(rw_tols)) if rw_tols else 0
        rw_statuses = [_extract_entry_status(e) for e in rw_inputs if e is not None]
        rw_status = "unconfirmed" if ("unconfirmed" in rw_statuses or rw_unconfirmed) else "known"
        computed["site.house_rear_wall"] = {
            "value": rw_seg,
            "status": rw_status,
            "prov": [
                {
                    "kind": "computed",
                    "document": rw_doc,
                    "where": rw_where,
                    "when": as_of_date,
                    "by": "lotfit.case-gate",
                    "tolerance": {"value": rw_tol, "unit": "ft"},
                    "status": rw_status,
                }
            ],
        }

    # 4 & 5. plan.outline and plan.setbacks_used (only in check_spot)
    if mode == "check_spot" and isinstance(placement_val, dict) and fp_val is not None:
        fp_entry = plan.get("footprint")
        pl_entry = plan.get("placement")
        raw_placed = G.placed_outline(
            [[float(p[0]), float(p[1])] for p in fp_val],
            {
                "x": float(placement_val["x"]),
                "y": float(placement_val["y"]),
                "rotation": int(placement_val.get("rotation", 0)),
            },
        )
        placed_clean = [[_clean_num(p[0]), _clean_num(p[1])] for p in raw_placed]
        po_tols = [t for e in (fp_entry, pl_entry) if e is not None for t in _extract_entry_tolerances(e)]
        po_tol = _clean_num(max(po_tols)) if po_tols else 0
        po_status = _extract_entry_status(fp_entry)
        computed["plan.outline"] = {
            "value": placed_clean,
            "status": po_status,
            "prov": [
                {
                    "kind": "computed",
                    "document": "derived from plan.footprint + plan.placement",
                    "where": f"placed_outline at ({placement_val['x']}, {placement_val['y']}) rot={placement_val.get('rotation', 0)} deg",
                    "when": as_of_date,
                    "by": "lotfit.case-gate",
                    "tolerance": {"value": po_tol, "unit": "ft"},
                    "status": po_status,
                }
            ],
        }

        if isinstance(zone_val, str) and zone_val in BASE_SETBACKS:
            req_sb = BASE_SETBACKS[zone_val]
            used: list[str] = []
            sb_inputs: list[Any] = [fp_entry, pl_entry, zone_entry]

            if front_val is not None:
                sb_inputs.append(front_entry)
                d_front = G.distance_to_segment(
                    raw_placed,
                    [[float(front_val[0][0]), float(front_val[0][1])], [float(front_val[1][0]), float(front_val[1][1])]],
                )
                if d_front < req_sb["front"] - G.EPS:
                    used.append("front")

            side_entry = site.get("side_lot_lines")
            side_vals = flat_vals.get("site.side_lot_lines")
            if isinstance(side_vals, list) and side_vals:
                sb_inputs.append(side_entry)
                d_side = min(
                    G.distance_to_segment(
                        raw_placed,
                        [[float(s[0][0]), float(s[0][1])], [float(s[1][0]), float(s[1][1])]],
                    )
                    for s in side_vals
                )
                if d_side < req_sb["side"] - G.EPS:
                    used.append("side")

            rear_entry = site.get("rear_lot_line")
            rear_val = flat_vals.get("site.rear_lot_line")
            if rear_val is not None:
                sb_inputs.append(rear_entry)
                d_rear = G.distance_to_segment(
                    raw_placed,
                    [[float(rear_val[0][0]), float(rear_val[0][1])], [float(rear_val[1][0]), float(rear_val[1][1])]],
                )
                if d_rear < req_sb["rear"] - G.EPS:
                    used.append("rear")

            ss_entry = site.get("side_street_lot_line")
            ss_val = flat_vals.get("site.side_street_lot_line")
            if ss_val is not None and _is_segment(ss_val):
                sb_inputs.append(ss_entry)
                d_ss = G.distance_to_segment(
                    raw_placed,
                    [[float(ss_val[0][0]), float(ss_val[0][1])], [float(ss_val[1][0]), float(ss_val[1][1])]],
                )
                if d_ss < req_sb["side_street"] - G.EPS:
                    used.append("side_street")

            sb_tols = [t for e in sb_inputs if e is not None for t in _extract_entry_tolerances(e)]
            sb_tol = _clean_num(max(sb_tols)) if sb_tols else 0
            sb_statuses = [_extract_entry_status(e) for e in sb_inputs if e is not None]
            sb_status = "unconfirmed" if "unconfirmed" in sb_statuses else "known"

            computed["plan.setbacks_used"] = {
                "value": used,
                "status": sb_status,
                "prov": [
                    {
                        "kind": "computed",
                        "document": "derived from plan.outline + site.*_lot_line + PDX.T110-4",
                        "where": f"setbacks in {zone_val} where distance < base building setback ({req_sb})",
                        "when": as_of_date,
                        "by": "lotfit.case-gate",
                        "tolerance": {"value": sb_tol, "unit": "ft"},
                        "status": sb_status,
                    }
                ],
            }

    return {
        "ok": True,
        "case_hash": case_hash,
        "computed": computed,
    }


def main() -> None:
    if len(sys.argv) > 1:
        raw_text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
    else:
        raw_text = sys.stdin.read()
    try:
        data = json.loads(raw_text)
    except Exception as exc:
        res = _refusal(FALLBACK_UUID, "I1", f"Invalid JSON: {exc}", "schema")
        print(json.dumps(res))
        return
    expected_hash = sys.argv[2] if len(sys.argv) > 2 else None
    res = validate_and_compute(data, expected_case_hash=expected_hash)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
