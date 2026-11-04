"""INT-3: coverage_share, Table 110-5 parsing, total_building_coverage (INS-04) and check_front_or_behind (INS-05).
Frozen; pinned values. Run: python3 -m pytest -q --noconftest graph/tests/test_int_3.py"""
import math, os, sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tools as T  # noqa: E402

SEL = [[13, 65], [37, 65], [37, 89], [13, 89]]
HOUSE = [[12, 20], [38, 20], [38, 55], [12, 55]]
SHED = [{"id": "shed", "outline": [[40, 85], [48, 85], [48, 95], [40, 95]]}]
FRONT = [[0, 0], [50, 0]]
ROW = "5,000 sq. ft. or more but less than 20,000 sq. ft."
CELL = "2,250 sq. ft + 15% of lot area over 5,000 sq. ft."
H = [[5, 5], [45, 5], [45, 45], [5, 45]]; P = [[50, 60], [86, 60], [86, 76], [50, 76]]


def test_INT3_registry_reads():
    assert T.TOOLS["coverage_share"].reads == ["plan.outline", "site.lot_area_sqft"]
    assert T.TOOLS["total_building_coverage"].reads == ["plan.outline", "site.structures", "site.house_outline", "site.lot_area_sqft"]
    assert T.TOOLS["check_front_or_behind"].reads == ["plan.outline", "site.front_lot_line", "site.house_rear_wall"]


def test_INT3_perimeter():
    assert T._perimeter(H) == 160.0 and T._perimeter([[0, 0], [3, 0], [3, 4]]) == 12.0


def test_INT3_coverage_reads_structures_as_objects():
    assert T.coverage_share([SEL] + SHED, 5000, 20) == {"covered_sqft": 656.0, "site_sqft": 5000, "pct": 13.12, "covered_tolerance_sqft": 0.0,
        "pct_tolerance": 0.0, "limit_pct": 20, "allowed_sqft": 1000.0, "margin_pct": 6.88, "too_close_to_call": False, "pass": True}


def test_INT3_coverage_without_a_limit():
    assert T.coverage_share([SEL], 5000) == {"covered_sqft": 576.0, "site_sqft": 5000, "pct": 11.52, "covered_tolerance_sqft": 0.0, "pct_tolerance": 0.0}


def test_INT3_coverage_carries_the_outlines_uncertainty():
    exact = T.coverage_share([H, P], 5000.0, 40)
    assert exact["pass"] is False and exact["pct_tolerance"] == 0 and exact["margin_pct"] == -3.52
    loose = T.coverage_share([H, P], 5000.0, 40, [3.0, 0.0])          # I-D8: 160 x 3 + 4 x 3^2 = 516
    assert loose["covered_tolerance_sqft"] == 516.0 and loose["pct_tolerance"] == 10.32 and loose["pass"] is None and loose["too_close_to_call"] is True
    tight = T.coverage_share([H, P], 5000.0, 40, [0.05, 0.0], 5.0)
    assert tight["covered_tolerance_sqft"] == 8.01 and tight["pct_tolerance"] == 0.20372 and tight["pass"] is False and tight["too_close_to_call"] is False


def test_INT3_coverage_tolerance_works_both_ways():
    """Under the limit by less than the bound is too close to call, exactly like over it (never a pass)."""
    under = T.coverage_share([H, P], 5000.0, 50, [3.0, 0.0])
    assert under["margin_pct"] == 6.48 and under["pct_tolerance"] == 10.32 and under["pass"] is None and under["too_close_to_call"] is True


def test_INT3_coverage_bound_includes_the_corners():
    """I-D8 (ADV-9): a 24 x 24 outline with 3 ft edges on a 3,000 sq ft site reads 19.2 %; grown by 3 ft it is 30.0 %,
    over the 29.5 % limit, so the result is too close to call, not a pass (perimeter x t alone gave 28.8 %)."""
    r = T.coverage_share([[[0, 0], [24, 0], [24, 24], [0, 24]]], 3000.0, 29.5, [3.0])
    assert r["pct"] == 19.2 and r["covered_tolerance_sqft"] == 324.0 and r["pct_tolerance"] == 10.8 and r["pass"] is None
    assert T._area_bound([[0, 0], [24, 0], [24, 24], [0, 24]], 3.0) == 30 * 30 - 24 * 24


def test_INT3_a_short_tolerance_list_pads_with_zero():
    assert T.coverage_share([H, P], 5000.0, 40, [3.0]) == T.coverage_share([H, P], 5000.0, 40, [3.0, 0.0])


@pytest.mark.parametrize("row,expect", [
    ("Less than 3,000 sq. ft.", (0.0, 3000.0)), ("3,000 sq. ft. or more but less than 5,000 sq. ft.", (3000.0, 5000.0)),
    (ROW, (5000.0, 20000.0)), ("20,000 sq. ft. or more", (20000.0, math.inf)), ("20,000 sq. ft or more", (20000.0, math.inf)),
    ("LESS THAN 1,000.5", (0.0, 1000.5)),
])
def test_INT3_row_labels(row, expect):
    assert T.parse_row_range(row) == expect


def test_INT3_an_unknown_row_label_is_refused():
    with pytest.raises(ValueError, match=r"^unrecognised row label: 'bogus'$"):
        T.parse_row_range("bogus")


@pytest.mark.parametrize("cell,area,expect", [("50% of lot area", 2000, 1000.0), ("50% of lot area.", 2000, 1000.0),
                                              (CELL, 8000, 2700.0), (CELL, 4000, 2250.0)])
def test_INT3_coverage_cells(cell, area, expect):
    assert T.parse_coverage_cell(cell)(area) == expect


def test_INT3_an_unknown_cell_is_refused():
    with pytest.raises(ValueError, match=r"^unrecognised coverage cell: 'x'$"):
        T.parse_coverage_cell("x")
    with pytest.raises(ValueError):
        T.parse_coverage_cell("1,200 sq.ft. + 22.5% of lot area over 3,000 sq ft")   # Portland wording only (documented)


def test_INT3_total_building_coverage():
    assert T.total_building_coverage([SEL, HOUSE] + SHED, 5000, ROW, CELL) == {"covered_sqft": 1566.0, "max_sqft": 2250.0, "margin_sqft": 684.0,
                                                                                "pass": True, "row": ROW, "cell": CELL, "tolerance_sqft": 0.0, "too_close_to_call": False}
    assert T.total_building_coverage([SEL], 8000, ROW, CELL)["max_sqft"] == 2700.0
    big = T.total_building_coverage([[[0, 0], [60, 0], [60, 60], [0, 60]]], 5000, ROW, CELL)
    assert big["margin_sqft"] == -1350.0 and big["pass"] is False


def test_INT3_total_building_coverage_carries_the_uncertainty():
    """I-D8 (ADV-10): the outlines' area bound plus how far the cap moves with the site area's tolerance."""
    r = T.total_building_coverage([SEL, HOUSE] + SHED, 5000, ROW, CELL, [0.5, 0.5], 50)
    assert r["tolerance_sqft"] == 118.5 and r["pass"] is True and r["too_close_to_call"] is False
    close = T.total_building_coverage([[[0, 0], [47, 0], [47, 47], [0, 47]]], 5000, ROW, CELL, [0.5])
    assert close["margin_sqft"] == 41.0 and close["tolerance_sqft"] == 95.0 and close["pass"] is None and close["too_close_to_call"] is True
    assert T.total_building_coverage([[[0, 0], [47, 0], [47, 47], [0, 47]]], 6000, ROW, CELL, [0.5], 100)["tolerance_sqft"] == 110.0


def test_INT3_the_row_must_hold_the_lot_area():
    with pytest.raises(ValueError, match=r"^row 'Less than 3,000 sq. ft.' does not hold a lot of 5000 sq ft$"):
        T.total_building_coverage([SEL], 5000, "Less than 3,000 sq. ft.", "50% of lot area")
    with pytest.raises(ValueError, match=r"does not hold a lot of 20000 sq ft$"):
        T.total_building_coverage([SEL], 20000, ROW, CELL)                         # the upper bound is exclusive


def test_INT3_front_or_behind_far_from_the_front():
    assert T.check_front_or_behind(SEL, FRONT, 40, [[12, 55], [38, 55]]) == {"front_distance_ft": 65.0, "front_margin_ft": 25.0,
        "behind_margin_ft": 10.0, "branch": "front", "margin_ft": 25.0, "pass": True, "tolerance_ft": 0.0, "too_close_to_call": False}


def test_INT3_a_front_yard_adu_is_not_behind_the_house():
    r = T.check_front_or_behind([[13, 0], [37, 0], [37, 20], [13, 20]], FRONT, 40, [[12, 55], [38, 55]])
    assert r["pass"] is False and r["front_margin_ft"] == -40.0 and r["behind_margin_ft"] == -55.0 and r["branch"] == "front"


def test_INT3_behind_the_rear_wall_counts_even_if_closer_than_40():
    o = [[13, 36], [37, 36], [37, 60], [13, 60]]
    r = T.check_front_or_behind(o, FRONT, 40, [[12, 35], [38, 35]])
    assert r == {"front_distance_ft": 36.0, "front_margin_ft": -4.0, "behind_margin_ft": 1.0, "branch": "behind", "margin_ft": 1.0,
                 "pass": True, "tolerance_ft": 0.0, "too_close_to_call": False}
    assert T.check_front_or_behind(o, FRONT, 40, [[38, 35], [12, 35]]) == r      # the wall's direction does not matter


def test_INT3_straddling_the_wall_line_is_not_behind():
    r = T.check_front_or_behind([[13, 30], [37, 30], [37, 60], [13, 60]], FRONT, 40, [[12, 35], [38, 35]])
    assert r["behind_margin_ft"] == -5.0 and r["branch"] == "behind" and r["pass"] is False


def test_INT3_front_or_behind_tolerance():
    r = T.check_front_or_behind([[13, 40.3], [37, 40.3], [37, 60], [13, 60]], FRONT, 40, [[12, 55], [38, 55]], 0.5)
    assert r["margin_ft"] == 0.3 and r["pass"] is None and r["too_close_to_call"] is True and r["tolerance_ft"] == 0.5


def test_INT3_a_zero_length_rear_wall_is_refused():
    """I-D10: the rear wall's direction is undefined; never a ZeroDivisionError."""
    with pytest.raises(ValueError, match=r"^house_rear_wall has zero length$"):
        T.check_front_or_behind(SEL, FRONT, 40, [[12, 55], [12, 55]])
