"""The registry of grounded tools (GR-12, EN-08): pure measuring functions, each with its declared fact reads."""

import re

from . import geometry as G

TOOLS = {}

EPS = 1e-9


def tool(reads):
    def deco(fn):
        fn.reads = list(reads)
        TOOLS[fn.__name__] = fn
        return fn

    return deco


def judge(margin, tolerance=0.0) -> tuple:
    m = round(margin, 6)
    if abs(m) < tolerance - EPS:
        return (None, True)
    return (m >= 0, False)


def _outline(s):
    return s["outline"] if isinstance(s, dict) else s


def _segments(line):
    if line and isinstance(line[0][0], (int, float)):
        return [line]
    return list(line)


ALLOWED_TRUE = ("true", "yes", "y", "allowed")
ALLOWED_FALSE = ("false", "no", "n", "not allowed")


@tool(reads=["plan.footprint", "plan.placement"])
def placed_outline(footprint, placement) -> dict:
    return {"outline": G.placed_outline(footprint, placement)}


@tool(reads=["site.lot_outline", "site.house_outline", "site.structures", "plan.outline"])
def physical_fit(lot_outline, house_outline, structures, outline) -> dict:
    inside = G.within(outline, lot_outline)
    hits = []
    unknown = []
    if house_outline is None:
        unknown.append("house outline unknown")
    elif house_outline and G.overlaps(outline, house_outline):
        hits.append("house")
    if structures is None:
        unknown.append("structures unknown")
    for s in structures or []:
        if G.overlaps(outline, _outline(s)):
            hits.append(s.get("id", "structure") if isinstance(s, dict) else "structure")
    if not inside or hits:
        ok = False
    elif unknown:
        ok = None
    else:
        ok = True
    r = {"inside_lot": inside, "overlaps": hits, "pass": ok}
    if unknown:
        r["reason"] = "; ".join(unknown)
    return r


@tool(reads=["plan.outline"])
def distance_to_line(outline, line) -> dict:
    return {"distance_ft": round(min(G.distance_to_segment(outline, s) for s in _segments(line)), 6)}


@tool(reads=["plan.outline"])
def check_setback(outline, line, min_ft, tolerance_ft=0.0) -> dict:
    segs = _segments(line)
    ds = [G.distance_to_segment(outline, s) for s in segs]
    i = ds.index(min(ds))
    margin = ds[i] - min_ft
    ok, tcc = judge(margin, tolerance_ft)
    r = {
        "distance_ft": round(ds[i], 6),
        "required_ft": min_ft,
        "margin_ft": round(margin, 6),
        "pass": ok,
        "tolerance_ft": tolerance_ft,
        "too_close_to_call": tcc,
    }
    if len(segs) > 1:
        r["nearest_segment"] = i
        r["per_segment"] = [
            {"distance_ft": round(d, 6), "margin_ft": round(d - min_ft, 6)} for d in ds
        ]
    return r


@tool(reads=["site.zone"])
def check_allowed(allowed, zone, param) -> dict:
    if isinstance(allowed, bool):
        ok = allowed
    elif isinstance(allowed, str) and allowed.strip().lower() in ALLOWED_TRUE:
        ok = True
    elif isinstance(allowed, str) and allowed.strip().lower() in ALLOWED_FALSE:
        ok = False
    else:
        raise ValueError(f"allowed-use cell not readable: {allowed!r}")
    return {"allowed": ok, "zone": zone, "param": param, "cell_value": allowed}


@tool(reads=[])
def check_max(value, limit, unit, tolerance=0.0) -> dict:
    ok, tcc = judge(limit - value, tolerance)
    return {
        "value": value,
        "limit": limit,
        "unit": unit,
        "margin": round(limit - value, 6),
        "pass": ok,
        "tolerance": tolerance,
        "too_close_to_call": tcc,
    }


@tool(reads=["plan.outline"])
def footprint_dimensions(outline, limit_ft=None, tolerance_ft=0.0) -> dict:
    w, d = G.bbox_dims(outline)
    r = {"width_ft": round(w, 6), "depth_ft": round(d, 6), "max_dimension_ft": round(max(w, d), 6)}
    if limit_ft is not None:
        ok, tcc = judge(limit_ft - max(w, d), tolerance_ft)
        r["limit_ft"] = limit_ft
        r["margin_ft"] = round(limit_ft - max(w, d), 6)
        r["too_close_to_call"] = tcc
        r["pass"] = ok
    return r


@tool(reads=["site.primary_living_area_sqft"])
def adu_max_living_area(primary_living_area_sqft, share_pct, cap_sqft, plan_living_area_sqft=None) -> dict:
    share = primary_living_area_sqft * share_pct / 100
    mx = min(share, cap_sqft)
    r = {
        "share_sqft": round(share, 6),
        "cap_sqft": cap_sqft,
        "max_sqft": round(mx, 6),
        "binding": "share" if share < cap_sqft else "cap",
    }
    if plan_living_area_sqft is not None:
        ok, _ = judge(mx - plan_living_area_sqft, 0.0)
        r["plan_sqft"] = plan_living_area_sqft
        r["margin_sqft"] = round(mx - plan_living_area_sqft, 6)
        r["pass"] = ok
    return r


def _perimeter(pts) -> float:
    s = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i - 1]
        x1, y1 = pts[i]
        dx = x1 - x0
        dy = y1 - y0
        s += ((dx) ** 2 + (dy) ** 2) ** 0.5
    return s


def _area_bound(pts, t) -> float:
    return _perimeter(pts) * t + 4 * t * t


@tool(reads=["plan.outline", "site.lot_area_sqft"])
def coverage_share(
    outlines, lot_area_sqft, limit_pct=None, outline_tolerances_ft=None, lot_area_tolerance_sqft=0.0
) -> dict:
    tols = list(outline_tolerances_ft or []) + [0.0] * (len(outlines) - len(outline_tolerances_ft or []))
    a = sum(G.area(_outline(o)) for o in outlines)
    da = sum(_area_bound(_outline(o), float(t)) for o, t in zip(outlines, tols))
    pct = 100 * a / lot_area_sqft
    pct_tol = 100 * (da / lot_area_sqft + a * float(lot_area_tolerance_sqft) / lot_area_sqft**2)
    r = {
        "covered_sqft": round(a, 6),
        "site_sqft": lot_area_sqft,
        "pct": round(pct, 6),
        "covered_tolerance_sqft": round(da, 6),
        "pct_tolerance": round(pct_tol, 6),
    }
    if limit_pct is not None:
        ok, tcc = judge(limit_pct - pct, pct_tol)
        r["limit_pct"] = limit_pct
        r["allowed_sqft"] = round(lot_area_sqft * limit_pct / 100, 6)
        r["margin_pct"] = round(limit_pct - pct, 6)
        r["too_close_to_call"] = tcc
        r["pass"] = ok
    return r


_NUM = r"([\d,]+(?:\.\d+)?)"


def _n(s) -> float:
    return float(s.replace(",", ""))


def parse_row_range(row) -> tuple[float, float]:
    t = row.lower()
    m = re.match(rf"less than {_NUM}", t)
    if m:
        return (0.0, _n(m.group(1)))
    m = re.match(rf"{_NUM} sq\. ft\.? or more but less than {_NUM}", t)
    if m:
        return (_n(m.group(1)), _n(m.group(2)))
    m = re.match(rf"{_NUM} sq\. ft\.? or more", t)
    if m:
        return (_n(m.group(1)), float("inf"))
    raise ValueError(f"unrecognised row label: {row!r}")


def parse_coverage_cell(cell):
    t = cell.lower()
    m = re.match(rf"{_NUM}% of lot area$", t.strip(". "))
    if m:
        p = _n(m.group(1))
        return lambda a: a * p / 100
    m = re.match(rf"{_NUM} sq\. ?ft\.? \+ {_NUM}% of lot area over {_NUM} sq\. ?ft", t)
    if m:
        b, p, th = _n(m.group(1)), _n(m.group(2)), _n(m.group(3))
        return lambda a: b + max(0.0, a - th) * p / 100
    raise ValueError(f"unrecognised coverage cell: {cell!r}")


@tool(reads=["plan.outline", "site.structures", "site.house_outline", "site.lot_area_sqft"])
def total_building_coverage(
    outlines, lot_area_sqft, row, cell, outline_tolerances_ft=None, lot_area_tolerance_sqft=0.0
) -> dict:
    lo, hi = parse_row_range(row)
    if not (lo <= lot_area_sqft < hi):
        raise ValueError(f"row {row!r} does not hold a lot of {lot_area_sqft} sq ft")
    f = parse_coverage_cell(cell)
    cap = f(lot_area_sqft)
    a = sum(G.area(_outline(o)) for o in outlines)
    tols = list(outline_tolerances_ft or []) + [0.0] * (len(outlines) - len(outline_tolerances_ft or []))
    da = sum(_area_bound(_outline(o), float(t)) for o, t in zip(outlines, tols))
    dl = float(lot_area_tolerance_sqft)
    if dl != 0:
        dcap = max(abs(f(lot_area_sqft + dl) - cap), abs(f(max(0.0, lot_area_sqft - dl)) - cap))
    else:
        dcap = 0.0
    tol = da + dcap
    ok, tcc = judge(cap - a, tol)
    return {
        "covered_sqft": round(a, 6),
        "max_sqft": round(cap, 6),
        "margin_sqft": round(cap - a, 6),
        "pass": ok,
        "row": row,
        "cell": cell,
        "tolerance_sqft": round(tol, 6),
        "too_close_to_call": tcc,
    }


@tool(reads=["plan.outline", "site.front_lot_line", "site.house_rear_wall"])
def check_front_or_behind(outline, front_lot_line, min_front_ft, house_rear_wall, tolerance_ft=0.0) -> dict:
    m_front = G.distance_to_segment(outline, front_lot_line) - min_front_ft
    (ax, ay), (bx, by) = house_rear_wall
    nx, ny = -(by - ay), bx - ax
    L = (nx**2 + ny**2) ** 0.5
    if L <= EPS:
        raise ValueError("house_rear_wall has zero length")
    nx, ny = nx / L, ny / L
    fx = (front_lot_line[0][0] + front_lot_line[1][0]) / 2
    fy = (front_lot_line[0][1] + front_lot_line[1][1]) / 2
    if (fx - ax) * nx + (fy - ay) * ny > 0:
        nx, ny = -nx, -ny
    m_behind = min((px - ax) * nx + (py - ay) * ny for px, py in outline)
    best = max(m_front, m_behind)
    ok, tcc = judge(best, tolerance_ft)
    return {
        "front_distance_ft": round(m_front + min_front_ft, 6),
        "front_margin_ft": round(m_front, 6),
        "behind_margin_ft": round(m_behind, 6),
        "branch": "front" if m_front >= m_behind else "behind",
        "margin_ft": round(best, 6),
        "pass": ok,
        "tolerance_ft": tolerance_ft,
        "too_close_to_call": tcc,
    }


def _and(vals: list) -> bool | None:
    if any(v is False for v in vals):
        return False
    if any(v is None for v in vals):
        return None
    return True


def G_closest(px, py, ax, ay, bx, by) -> tuple[float, float]:
    dx = bx - ax
    dy = by - ay
    L2 = dx * dx + dy * dy or 1e-12
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return (ax + t * dx, ay + t * dy)


def _face_toward(seg, outline, rotation: int) -> str:
    if rotation % 90 != 0:
        raise ValueError("rotation must be a multiple of 90 degrees")
    n = len(outline)
    cx = sum(p[0] for p in outline) / n
    cy = sum(p[1] for p in outline) / n
    qx, qy = G_closest(cx, cy, *seg[0], *seg[1])
    dx, dy = qx - cx, qy - cy
    if abs(dx) >= abs(dy):
        d = "+x" if dx > 0 else "-x"
    else:
        d = "+y" if dy > 0 else "-y"
    table = {
        0: {"-y": "front", "+y": "rear", "-x": "left", "+x": "right"},
        90: {"+x": "front", "-x": "rear", "-y": "left", "+y": "right"},
        180: {"+y": "front", "-y": "rear", "+x": "left", "-x": "right"},
        270: {"-x": "front", "+x": "rear", "+y": "left", "-y": "right"},
    }
    return table[rotation % 360][d]


def _extent_along(outline, seg) -> float:
    (ax, ay), (bx, by) = seg
    vx, vy = bx - ax, by - ay
    L = (vx**2 + vy**2) ** 0.5
    ts = [((x - ax) * vx + (y - ay) * vy) / L for x, y in outline]
    return max(ts) - min(ts)


def _exc_245c2(f: dict, p: dict, version: int) -> list[dict]:
    def cond(item, name, holds, measure=None, reason=None, param=None):
        c = {
            "clause_id": f"PDX.33.110.245.C.2#v{version}::item:{item}",
            "name": name,
            "holds": holds,
            "measure": measure,
        }
        if reason is not None:
            c["reason"] = reason
        if param is not None:
            c["param"] = param
        return c

    def is_inside(x, ln):
        return G.distance_to_segment(x, ln["line"]) < ln["min_ft"] - EPS

    o = f["outline"]
    tol = f.get("tolerance_ft", 0.0)
    conds = []
    zones = p["zones_allowing_structures_in_side_rear_setbacks"]
    zone = f.get("zone")
    conds.append(cond("b.", "zone is one of " + ", ".join(zones), None if zone is None else zone in zones))
    r1 = check_setback(o, f["front_lot_line"], p["min_distance_from_front_lot_line"], tol)
    h1 = r1["pass"]
    rs = None
    if f.get("corner_lot") is None:
        h1 = _and([h1, None]) if h1 is not False else False
    elif f.get("corner_lot") and f.get("side_street_lot_line") is None:
        h1 = _and([h1, None]) if h1 is not False else False
    elif f.get("corner_lot"):
        rs = check_setback(o, f["side_street_lot_line"], p["min_distance_from_side_street_lot_line_corner"], tol)
        h1 = _and([h1, rs["pass"]])
    if rs is not None and rs["pass"] is False and r1["pass"] is not False:
        measure1, param1 = rs, "min_distance_from_side_street_lot_line_corner"
    else:
        measure1, param1 = r1, "min_distance_from_front_lot_line"
    conds.append(
        cond(
            "b.(1)",
            "at least 40 ft from a front lot line (20 ft from a side street on a corner lot)",
            h1,
            measure1,
            param=param1,
        )
    )
    r2 = footprint_dimensions(o, p["max_footprint_dimension"])
    conds.append(
        cond(
            "b.(2)",
            "footprint within 24 ft by 24 ft, excluding eaves",
            r2["pass"],
            r2,
            param="max_footprint_dimension",
        )
    )
    if f.get("setback_lines", []) is None or f.get("structures", []) is None:
        conds.append(
            cond(
                "b.(3)",
                "combined length of structures in the setback, per line, no more than 24 ft",
                None,
                None,
                reason="structures or setback lines unknown",
                param="max_combined_length_in_setback_per_line",
            )
        )
    else:
        lines = f.get("setback_lines", [])
        structs = f.get("structures", [])
        h3 = True
        if any(is_inside(o, ln) for ln in lines):
            why3 = "only this structure is in the setback"
        else:
            why3 = "this structure is in no setback"
        for ln in lines:
            inside = [o] if is_inside(o, ln) else []
            others = [_outline(s) for s in structs if is_inside(_outline(s), ln)]
            if inside and others:
                total = sum(_extent_along(x, ln["line"]) for x in inside + others)
                why3 = f"{ln.get('name', 'line')}: combined {round(total, 3)} ft"
                if total > p["max_combined_length_in_setback_per_line"] + EPS:
                    h3 = False
                    break
        conds.append(
            cond(
                "b.(3)",
                "combined length of structures in the setback, per line, no more than 24 ft",
                h3,
                None,
                reason=why3,
                param="max_combined_length_in_setback_per_line",
            )
        )
    hh = None if f.get("height_ft") is None else f["height_ft"] <= p["max_height_in_setback"] + EPS
    hw = None if f.get("wall_height_ft") is None else f["wall_height_ft"] <= p["max_wall_height_in_setback"] + EPS
    if hh is False:
        m4, p4 = check_max(f["height_ft"], p["max_height_in_setback"], "ft"), "max_height_in_setback"
    elif f.get("wall_height_ft") is not None:
        m4, p4 = check_max(f["wall_height_ft"], p["max_wall_height_in_setback"], "ft"), "max_wall_height_in_setback"
    elif f.get("height_ft") is not None:
        m4, p4 = check_max(f["height_ft"], p["max_height_in_setback"], "ft"), "max_height_in_setback"
    else:
        m4, p4 = None, None
    conds.append(
        cond(
            "b.(4)",
            "no more than 15 ft high, walls no more than 10 ft (gable portion excluded)",
            _and([hh, hw]),
            m4,
            param=p4,
        )
    )
    if f.get("enclosed", f.get("plan_kind") == "adu"):
        h5, r5 = True, 'enclosed structure: "Screening is not required for enclosed structures."'
    else:
        h5, r5 = f.get("screening"), None
    conds.append(cond("b.(5)", "screened from adjoining lots, or enclosed", h5, None, reason=r5))
    lines6 = f.get("setback_lines", [])
    in_setback = [ln for ln in (lines6 or []) if is_inside(o, ln)]
    if f.get("openings_by_face") is not None and f.get("rotation") is not None and lines6 is None:
        h6, r6 = None, "setback lines unknown"
    elif f.get("openings_by_face") is not None and f.get("rotation") is not None:
        obf = f.get("openings_by_face")
        if isinstance(obf, list):
            obf = {face: True for face in obf}
        bad = [
            ln.get("name", "line") for ln in in_setback if obf.get(_face_toward(ln["line"], o, f["rotation"]))
        ]
        h6 = not bad
        r6 = "openings toward " + ", ".join(bad) if bad else None
    elif f.get("openings_facing_lot_line") is not None:
        h6, r6 = not f.get("openings_facing_lot_line"), None
    else:
        h6, r6 = None, "openings per face not stated"
    conds.append(
        cond("b.(6)", "no doors or windows in walls within the setback facing the lot line", h6, None, reason=r6)
    )
    rd = f.get("rooftop_deck")
    conds.append(cond("b.(7)", "no rooftop deck", None if rd is None else not rd))
    if f.get("dormers") is False:
        conds.append(cond("b.(8)", "dormers at least 5 ft from side and rear lot lines", True, None, reason="no dormers"))
    elif f.get("dormer_setback_ft") is not None:
        sb = f["dormer_setback_ft"]
        mn8 = p["dormer_min_setback_from_side_rear"]
        ok8, tcc8 = judge(sb - mn8, 0.0)
        r8 = {
            "value": sb,
            "limit": mn8,
            "unit": "ft",
            "margin": round(sb - mn8, 6),
            "pass": ok8,
            "tolerance": 0.0,
            "too_close_to_call": tcc8,
        }
        conds.append(
            cond(
                "b.(8)",
                "dormers at least 5 ft from side and rear lot lines",
                r8["pass"],
                r8,
                param="dormer_min_setback_from_side_rear",
            )
        )
    else:
        conds.append(
            cond(
                "b.(8)",
                "dormers at least 5 ft from side and rear lot lines",
                None,
                None,
                reason="dormer positions not stated",
            )
        )
    return conds


EXCEPTIONS = {"PDX.33.110.245.C.2": _exc_245c2}


@tool(
    reads=[
        "plan.outline",
        "site.front_lot_line",
        "site.side_street_lot_line",
        "site.corner_lot",
        "site.zone",
        "plan.height_ft",
        "plan.wall_height_ft",
        "plan.rooftop_deck",
        "plan.openings_facing_lot_line",
        "plan.dormers",
        "site.screening",
        "site.structures",
    ]
)
def check_exception_conditions(
    exception_id: str, base_provision_id: str, facts: dict, params: dict, version: int = 1
) -> dict:
    if exception_id not in EXCEPTIONS:
        raise ValueError(f"no evaluator for exception {exception_id}")
    conds = EXCEPTIONS[exception_id](facts, params, version)
    return {
        "exception_id": exception_id,
        "base_provision_id": base_provision_id,
        "pass": _and([c["holds"] for c in conds]),
        "conditions": conds,
    }


def _bbox(poly) -> tuple[float, float, float, float]:
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return (min(xs), min(ys), max(xs), max(ys))


@tool(reads=["site.lot_outline", "site.house_outline", "site.structures", "plan.footprint"])
def find_placements(
    lot_outline,
    house_outline,
    structures,
    footprint,
    setbacks,
    step=1.0,
    rotations=(0, 90),
    tolerance_ft=0.0,
    front_or_behind=None,
) -> dict:
    out, clear_n = _grid_search(
        lot_outline, house_outline, structures, footprint, setbacks, step, rotations, tolerance_ft, front_or_behind
    )
    used = "grid"
    if not out:
        out, clear_n = _grid_search(
            lot_outline,
            house_outline,
            structures,
            footprint,
            setbacks,
            step / 4,
            rotations,
            tolerance_ft,
            front_or_behind,
        )
        used = "refined"
    return {"candidates": out, "count": len(out), "clear_count": clear_n, "search_pass": used}


def _grid_search(
    lot_outline, house_outline, structures, footprint, setbacks, step, rotations, tolerance_ft, front_or_behind
) -> tuple[list, int]:
    lx0, ly0, lx1, ly1 = _bbox(lot_outline)
    pad = max(max(abs(c) for c in p) for p in footprint)
    clear = []
    marginal = []
    for r in rotations:
        for i in range(int((lx1 - lx0 + 2 * pad) / step) + 1):
            for j in range(int((ly1 - ly0 + 2 * pad) / step) + 1):
                pl = {"x": round(lx0 - pad + i * step, 6), "y": round(ly0 - pad + j * step, 6), "rotation": r}
                o = G.placed_outline(footprint, pl)
                x0, y0, x1, y1 = _bbox(o)
                if x0 < lx0 - EPS or y0 < ly0 - EPS or x1 > lx1 + EPS or y1 > ly1 + EPS:
                    continue
                ms = [G.distance_to_segment(o, s["line"]) - s["min_ft"] for s in setbacks]
                if any(m < -tolerance_ft - EPS for m in ms):
                    continue
                if front_or_behind is not None:
                    fob = front_or_behind
                    fb = check_front_or_behind(
                        o, fob["front_lot_line"], fob["min_front_ft"], fob["house_rear_wall"], tolerance_ft
                    )
                    if fb["margin_ft"] < -tolerance_ft - EPS:
                        continue
                    ms.append(fb["margin_ft"])
                fit = physical_fit(lot_outline, house_outline, structures, o)["pass"]
                if fit is False:
                    continue
                c = {"placement": pl, "outline": o, "min_margin_ft": round(min(ms), 6) if ms else None}
                if fit is True and (not ms or min(ms) >= tolerance_ft - EPS):
                    clear.append(c)
                else:
                    marginal.append(c)
    return (clear + marginal, len(clear))
