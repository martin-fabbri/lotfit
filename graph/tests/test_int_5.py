"""INT-5 (frozen): find_placements (INS-07; EN-10, GR-29). Every placement on a grid, in each rotation, that fits the lot,
clears every setback and the front-or-behind rule, and touches no structure; clear candidates first. Pinned on the
example lot (examples/pdx-r5-adu-prov.json: 50 x 100 lot, house 12..38 x 20..55, shed, 24 x 24 plan). Do not edit."""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import tools as T  # noqa: E402

EX = json.load(open(os.path.join(HERE, "..", "examples", "pdx-r5-adu-prov.json")))
S = EX["site"]
V = lambda k: S[k]["value"] if isinstance(S[k], dict) and "value" in S[k] else S[k]
FP = EX["plan"]["footprint"]["value"] if isinstance(EX["plan"]["footprint"], dict) else EX["plan"]["footprint"]
LOT, HOUSE, STRUCTS = V("lot_outline"), V("house_outline"), V("structures")
SB = [{"line": V("front_lot_line"), "min_ft": 10}, {"line": V("rear_lot_line"), "min_ft": 5}] + [{"line": l, "min_ft": 5} for l in V("side_lot_lines")]
FOB = {"front_lot_line": V("front_lot_line"), "min_front_ft": 40, "house_rear_wall": [[12, 55], [38, 55]]}


def fp(**kw):
    return T.find_placements(LOT, HOUSE, STRUCTS, FP, SB, **kw)


def test_INT5_result_shape():
    r = fp()
    assert set(r) == {"candidates", "count", "clear_count", "search_pass"} and r["count"] == len(r["candidates"]) and r["search_pass"] == "grid"
    assert all(set(c) == {"placement", "outline", "min_margin_ft"} for c in r["candidates"])


def test_INT5_example_lot_counts_without_tolerance():
    r = fp()
    assert r["count"] == 478 and r["clear_count"] == 478
    assert sum(c["placement"]["rotation"] == 0 for c in r["candidates"]) == 239
    assert sum(c["placement"]["rotation"] == 90 for c in r["candidates"]) == 239


def test_INT5_grid_order_rotation_then_x_then_y():
    r = fp()
    c = r["candidates"]
    assert c[0]["placement"] == {"x": 5.0, "y": 55.0, "rotation": 0} and c[0]["min_margin_ft"] == 0.0
    assert c[1]["placement"] == {"x": 5.0, "y": 56.0, "rotation": 0} and c[2]["placement"] == {"x": 5.0, "y": 57.0, "rotation": 0}
    assert c[-1]["placement"] == {"x": 45.0, "y": 61.0, "rotation": 90}
    first90 = next(x for x in c if x["placement"]["rotation"] == 90)
    assert first90["placement"] == {"x": 29.0, "y": 55.0, "rotation": 90}


def test_INT5_candidate_outline_is_the_placed_outline():
    r = fp()
    assert r["candidates"][0]["outline"] == [[5.0, 55.0], [29.0, 55.0], [29.0, 79.0], [5.0, 79.0]]
    first90 = next(x for x in r["candidates"] if x["placement"]["rotation"] == 90)
    assert first90["outline"] == [[29.0, 55.0], [29.0, 79.0], [5.0, 79.0], [5.0, 55.0]]
    assert all(c["outline"] == T.G.placed_outline(FP, c["placement"]) for c in r["candidates"][:50])


def test_INT5_every_candidate_fits_and_clears():
    r = fp()
    for c in r["candidates"]:
        o = c["outline"]
        assert T.physical_fit(LOT, HOUSE, STRUCTS, o)["pass"] is True
        assert all(T.G.distance_to_segment(o, s["line"]) - s["min_ft"] >= -1e-9 for s in SB)


def test_INT5_tolerance_splits_clear_and_marginal():
    """I-D2: a spot that misses a setback by less than the tolerance is kept, as marginal (too close to call)."""
    r = fp(tolerance_ft=1.6)
    assert r["count"] == 552 and r["clear_count"] == 342
    clear, marginal = r["candidates"][:342], r["candidates"][342:]
    assert clear[0]["placement"] == {"x": 7.0, "y": 55.0, "rotation": 0} and clear[0]["min_margin_ft"] == 2.0
    assert marginal[0]["placement"] == {"x": 4.0, "y": 55.0, "rotation": 0} and marginal[0]["min_margin_ft"] == -1.0
    assert all(c["min_margin_ft"] >= 1.6 - 1e-9 for c in clear) and all(-1.6 - 1e-9 <= c["min_margin_ft"] < 1.6 - 1e-9 for c in marginal)
    assert sum(c["min_margin_ft"] < 0 for c in marginal) == 74


def test_INT5_near_misses_are_marginal_not_dropped():
    """ADV-1: a 34.6 ft lot with 5 ft sides fits a 24 ft plan only 0.6 ft short of clear: at tolerance 0.5 every spot is
    marginal (count > 0, clear 0), so the search never says "no spot" when spots are only too close to call."""
    lot = [[0, 0], [34.6, 0], [34.6, 100], [0, 100]]
    sides = [{"line": [[0, 0], [0, 100]], "min_ft": 5}, {"line": [[34.6, 0], [34.6, 100]], "min_ft": 5}]
    r = T.find_placements(lot, [], [], FP, sides, rotations=(0,), tolerance_ft=0.5)
    assert r["count"] == 154 and r["clear_count"] == 0 and r["search_pass"] == "grid"
    assert r["candidates"][0]["placement"] == {"x": 5.0, "y": 0.0, "rotation": 0} and r["candidates"][0]["min_margin_ft"] == 0.0
    exact = T.find_placements(lot, [], [], FP, sides, rotations=(0,))
    assert exact["count"] == 77 and exact["clear_count"] == 77


def test_INT5_an_exact_fit_between_grid_points_is_found():
    """I-D2: a 35 ft lot with 5.5 ft side setbacks fits a 24 ft plan only at x = 5.5; the grid misses it, the step/4
    refinement pass finds it."""
    lot = [[0, 0], [35, 0], [35, 100], [0, 100]]
    sides = [{"line": [[0, 0], [0, 100]], "min_ft": 5.5}, {"line": [[35, 0], [35, 100]], "min_ft": 5.5}]
    r = T.find_placements(lot, [], [], FP, sides, rotations=(0,))
    assert r["search_pass"] == "refined" and r["count"] == 305 and r["clear_count"] == 305
    assert r["candidates"][0]["placement"] == {"x": 5.5, "y": 0.0, "rotation": 0}


def test_INT5_front_or_behind_margin_counts_toward_clear():
    """A spot that clears the side setbacks but meets front-or-behind by less than the tolerance is marginal."""
    small = [[0, 0], [10, 0], [10, 10], [0, 10]]
    side_only = [{"line": l, "min_ft": 5} for l in V("side_lot_lines")]
    loose = T.find_placements(LOT, HOUSE, STRUCTS, small, side_only, rotations=(0,), tolerance_ft=0.5)
    strict = T.find_placements(LOT, HOUSE, STRUCTS, small, side_only, rotations=(0,), tolerance_ft=0.5, front_or_behind=FOB)
    assert (loose["count"], loose["clear_count"]) == (1382, 1303) and (strict["count"], strict["clear_count"]) == (1041, 984)
    # with no house in the way, the row 40 ft from the front (front branch margin 0) is kept but only as marginal
    loose = T.find_placements(LOT, [], STRUCTS, small, side_only, rotations=(0,), tolerance_ft=0.5)
    strict = T.find_placements(LOT, [], STRUCTS, small, side_only, rotations=(0,), tolerance_ft=0.5, front_or_behind=FOB)
    assert (loose["count"], loose["clear_count"]) == (2746, 2579) and (strict["count"], strict["clear_count"]) == (1506, 1390)
    row40 = [c for c in strict["candidates"] if c["placement"]["y"] == 40.0]
    assert row40 and all(c["min_margin_ft"] == 0.0 for c in row40) and all(c in strict["candidates"][1390:] for c in row40)


def test_INT5_an_unknown_house_makes_every_spot_marginal():
    """I-D5: physical_fit is unknown when the house or the structures are unknown (None): kept, never clear."""
    r = T.find_placements([[0, 0], [3, 0], [3, 3], [0, 3]], None, None, [[0, 0], [1, 0], [1, 1], [0, 1]], [], rotations=(0,))
    assert r["count"] == 9 and r["clear_count"] == 0


def test_INT5_no_setbacks_means_no_margin():
    r = T.find_placements(LOT, HOUSE, STRUCTS, FP, [], rotations=(0,))
    assert r["count"] == 444 and r["clear_count"] == 444
    assert r["candidates"][0]["placement"] == {"x": 0.0, "y": 55.0, "rotation": 0} and r["candidates"][0]["min_margin_ft"] is None


def test_INT5_step_and_four_rotations():
    r = fp(step=2.0, rotations=(0, 90, 180, 270))
    assert r["count"] == 216 and r["clear_count"] == 216 and r["candidates"][0]["placement"] == {"x": 6.0, "y": 56.0, "rotation": 0}


def test_INT5_front_or_behind_filters_and_counts_toward_clear():
    r = fp(front_or_behind=FOB, tolerance_ft=0.5)
    assert r["count"] == 478 and r["clear_count"] == 408
    assert r["candidates"][0]["placement"] == {"x": 6.0, "y": 55.0, "rotation": 0} and r["candidates"][0]["min_margin_ft"] == 1.0


def test_INT5_front_or_behind_removes_front_yard_spots():
    # a 10 x 10 plan fits in the front yard; front-or-behind (40 ft from the front, or behind the rear wall) drops it
    small = [[0, 0], [10, 0], [10, 10], [0, 10]]
    side_only = [{"line": l, "min_ft": 5} for l in V("side_lot_lines")]
    loose = T.find_placements(LOT, HOUSE, STRUCTS, small, side_only, rotations=(0,))
    strict = T.find_placements(LOT, HOUSE, STRUCTS, small, side_only, rotations=(0,), front_or_behind=FOB)
    assert loose["count"] == 1382 and strict["count"] == 1041
    assert min(min(p[1] for p in c["outline"]) for c in strict["candidates"]) == 55.0
    assert strict["candidates"][0]["placement"] == {"x": 5.0, "y": 55.0, "rotation": 0}


def test_INT5_nothing_fits_a_narrow_lot():
    assert T.find_placements([[0, 0], [20, 0], [20, 100], [0, 100]], [], [], FP, []) == {"candidates": [], "count": 0, "clear_count": 0, "search_pass": "refined"}


def test_INT5_tiny_grid_and_pad():
    r = T.find_placements([[0, 0], [3, 0], [3, 3], [0, 3]], [], [], [[0, 0], [1, 0], [1, 1], [0, 1]], [], rotations=(0,))
    assert r["count"] == 9 and r["clear_count"] == 9
    assert [c["placement"] for c in r["candidates"]][:4] == [{"x": 0.0, "y": 0.0, "rotation": 0}, {"x": 0.0, "y": 1.0, "rotation": 0},
                                                             {"x": 0.0, "y": 2.0, "rotation": 0}, {"x": 1.0, "y": 0.0, "rotation": 0}]


def test_INT5_tiny_all_marginal():
    r = T.find_placements([[0, 0], [3, 0], [3, 3], [0, 3]], [], [], [[0, 0], [1, 0], [1, 1], [0, 1]],
                          [{"line": [[0, 0], [3, 0]], "min_ft": 1}], rotations=(0,), tolerance_ft=1.5)
    assert r["count"] == 9 and r["clear_count"] == 0
    assert [c["min_margin_ft"] for c in r["candidates"]] == [-1.0, 0.0, 1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0]


def test_INT5_registry_reads_of_find_placements():
    assert T.TOOLS["find_placements"].reads == ["site.lot_outline", "site.house_outline", "site.structures", "plan.footprint"]
