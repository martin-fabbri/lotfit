import math

EPS = 1e-9


def area(poly) -> float:
    s = 0.0
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def edges(poly) -> list[tuple]:
    return list(zip(poly, poly[1:] + poly[:1]))


def _cross(o, a, b) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _on_segment(p, a, b) -> bool:
    return (
        abs(_cross(a, b, p)) <= EPS
        and min(a[0], b[0]) - EPS <= p[0] <= max(a[0], b[0]) + EPS
        and min(a[1], b[1]) - EPS <= p[1] <= max(a[1], b[1]) + EPS
    )


def _proper_cross(a, b, c, d) -> bool:
    d1 = _cross(c, d, a)
    d2 = _cross(c, d, b)
    d3 = _cross(a, b, c)
    d4 = _cross(a, b, d)
    return ((d1 > EPS and d2 < -EPS) or (d1 < -EPS and d2 > EPS)) and (
        (d3 > EPS and d4 < -EPS) or (d3 < -EPS and d4 > EPS)
    )


def on_boundary(p, poly) -> bool:
    return any(_on_segment(p, a, b) for a, b in edges(poly))


def strictly_inside(p, poly) -> bool:
    if on_boundary(p, poly):
        return False
    x, y = p
    inside = False
    for (x1, y1), (x2, y2) in edges(poly):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _probe_points(poly) -> list[list[float]]:
    pts = [list(p) for p in poly]
    for a, b in edges(poly):
        pts.append([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
    n = len(poly)
    c = [sum(p[0] for p in poly) / n, sum(p[1] for p in poly) / n]
    if strictly_inside(c, poly):
        pts.append(c)
    return pts


def overlaps(a, b) -> bool:
    for ea, eb in edges(a):
        for ec, ed in edges(b):
            if _proper_cross(ea, eb, ec, ed):
                return True
    if any(strictly_inside(p, b) for p in _probe_points(a)):
        return True
    if any(strictly_inside(p, a) for p in _probe_points(b)):
        return True
    return False


def within(inner, outer) -> bool:
    for ea, eb in edges(inner):
        for ec, ed in edges(outer):
            if _proper_cross(ea, eb, ec, ed):
                return False
    for p in _probe_points(inner):
        if not (strictly_inside(p, outer) or on_boundary(p, outer)):
            return False
    for v in outer:
        if strictly_inside(v, inner):
            return False
    return True


def point_segment_distance(p, a, b) -> float:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    L2 = dx * dx + dy * dy
    if L2 == 0:
        t = 0.0
    else:
        t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def distance_to_segment(poly, seg) -> float:
    a, b = seg
    if any(_proper_cross(ea, eb, a, b) for ea, eb in edges(poly)) or strictly_inside(a, poly):
        return 0.0
    d1 = min(point_segment_distance(p, a, b) for p in poly)
    d2 = min(point_segment_distance(x, p, q) for x in (a, b) for p, q in edges(poly))
    return min(d1, d2)


def placed_outline(footprint, placement) -> list[list[float]]:
    r = placement.get("rotation", 0)
    if r % 90 != 0:
        raise ValueError("rotation must be a multiple of 90 degrees")
    c, s = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}[r % 360]
    x0, y0 = placement["x"], placement["y"]
    return [[x0 + c * px - s * py, y0 + s * px + c * py] for px, py in footprint]


def bbox_dims(poly) -> tuple[float, float]:
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return (max(xs) - min(xs), max(ys) - min(ys))
