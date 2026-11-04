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
