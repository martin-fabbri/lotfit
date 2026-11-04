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
