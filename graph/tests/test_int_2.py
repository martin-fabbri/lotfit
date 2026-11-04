"""INT-2: the tool registry, judge() and the simple tools (INS-03). Frozen; pinned values.
Run: python3 -m pytest -q --noconftest graph/tests/test_int_2.py"""
import os, sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tools as T  # noqa: E402

SEL = [[13, 65], [37, 65], [37, 89], [13, 89]]          # S1's selected placement
CLIENT = [[2, 74], [26, 74], [26, 98], [2, 98]]         # S1's client spot
LOT = [[0, 0], [50, 0], [50, 100], [0, 100]]
HOUSE = [[12, 20], [38, 20], [38, 55], [12, 55]]
SHED = [{"id": "shed", "outline": [[40, 85], [48, 85], [48, 95], [40, 95]]}]
FRONT, REAR = [[0, 0], [50, 0]], [[0, 100], [50, 100]]
SIDES = [[[0, 0], [0, 100]], [[50, 0], [50, 100]]]

SIMPLE = {"placed_outline": ["plan.footprint", "plan.placement"],
          "physical_fit": ["site.lot_outline", "site.house_outline", "site.structures", "plan.outline"],
          "distance_to_line": ["plan.outline"], "check_setback": ["plan.outline"], "check_allowed": ["site.zone"],
          "check_max": [], "footprint_dimensions": ["plan.outline"], "adu_max_living_area": ["site.primary_living_area_sqft"]}


def test_INT2_eps_and_registry_reads():
    assert T.EPS == 1e-9
    for name, reads in SIMPLE.items():
        assert T.TOOLS[name] is getattr(T, name) and T.TOOLS[name].reads == reads, name


def test_INT2_tool_decorator_registers_and_returns_the_function():
    @T.tool(reads=["site.zone"])
    def int2_probe_tool():
        return 1
    try:
        assert T.TOOLS["int2_probe_tool"] is int2_probe_tool and int2_probe_tool.reads == ["site.zone"] and int2_probe_tool() == 1
    finally:
        del T.TOOLS["int2_probe_tool"]


@pytest.mark.parametrize("margin,tol,expect", [
    (0.5, 1.0, (None, True)), (-0.5, 1.0, (None, True)), (1.0, 1.0, (True, False)), (-1.0, 1.0, (False, False)),
    (0, 0, (True, False)), (-1e-7, 0, (True, False)), (-0.0000004, 0, (True, False)), (-0.000001, 0, (False, False)),
    (0.9999999995, 1.0, (True, False)),
])
def test_INT2_judge_is_three_valued_after_rounding_to_6_decimals(margin, tol, expect):
    assert T.judge(margin, tol) == expect


def test_INT2_judge_default_tolerance_is_zero():
    assert T.judge(-0.5) == (False, False) and T.judge(0.5) == (True, False)


def test_INT2_placed_outline_tool_wraps_geometry():
    assert T.placed_outline([[0, 0], [24, 0], [24, 24], [0, 24]], {"x": 13, "y": 65, "rotation": 0}) == {"outline": SEL}


def test_INT2_physical_fit():
    assert T.physical_fit(LOT, HOUSE, SHED, SEL) == {"inside_lot": True, "overlaps": [], "pass": True}
    assert T.physical_fit(LOT, HOUSE, SHED, [[10, 30], [20, 30], [20, 40], [10, 40]]) == {"inside_lot": True, "overlaps": ["house"], "pass": False}
    off = T.physical_fit(LOT, HOUSE, SHED + [[[1, 1], [2, 1], [2, 2], [1, 2]]], [[42, 80], [60, 80], [60, 90], [42, 90]])
    assert off == {"inside_lot": False, "overlaps": ["shed"], "pass": False}
    assert T.physical_fit(LOT, [], [], SEL) == {"inside_lot": True, "overlaps": [], "pass": True}
    plain = T.physical_fit(LOT, [], [[[13, 80], [20, 80], [20, 85], [13, 85]]], SEL)
    assert plain == {"inside_lot": True, "overlaps": ["structure"], "pass": False}
    noid = T.physical_fit(LOT, [], [{"outline": [[13, 80], [20, 80], [20, 85], [13, 85]]}], SEL)
    assert noid["overlaps"] == ["structure"]


def test_INT2_physical_fit_unknown_house_or_structures_is_unknown():
    """I-D5: None is unknown, never "none": the overlap is unchecked, so pass is None (a known overlap still fails)."""
    assert T.physical_fit(LOT, None, SHED, SEL) == {"inside_lot": True, "overlaps": [], "pass": None, "reason": "house outline unknown"}
    assert T.physical_fit(LOT, HOUSE, None, SEL) == {"inside_lot": True, "overlaps": [], "pass": None, "reason": "structures unknown"}
    assert T.physical_fit(LOT, None, None, SEL) == {"inside_lot": True, "overlaps": [], "pass": None, "reason": "house outline unknown; structures unknown"}
    assert T.physical_fit(LOT, None, [[[13, 80], [20, 80], [20, 85], [13, 85]]], SEL)["pass"] is False
    assert T.physical_fit(LOT, HOUSE, None, [[[10, 30], [20, 30], [20, 40], [10, 40]]][0])["pass"] is False


def test_INT2_distance_to_line_takes_one_or_several_segments():
    assert T.distance_to_line(SEL, REAR) == {"distance_ft": 11.0}
    assert T.distance_to_line(SEL, SIDES) == {"distance_ft": 13.0}
    assert T.distance_to_line(CLIENT, SIDES) == {"distance_ft": 2.0}


def test_INT2_check_setback_one_line():
    assert T.check_setback(SEL, REAR, 5) == {"distance_ft": 11.0, "required_ft": 5, "margin_ft": 6.0, "pass": True,
                                             "tolerance_ft": 0.0, "too_close_to_call": False}


def test_INT2_check_setback_takes_both_side_lines():
    r = T.check_setback(SEL, SIDES, 5)
    assert r == {"distance_ft": 13.0, "required_ft": 5, "margin_ft": 8.0, "pass": True, "tolerance_ft": 0.0, "too_close_to_call": False,
                 "nearest_segment": 0, "per_segment": [{"distance_ft": 13.0, "margin_ft": 8.0}, {"distance_ft": 13.0, "margin_ft": 8.0}]}


def test_INT2_check_setback_client_spot_fails_by_3():
    r = T.check_setback(CLIENT, SIDES, 5, 0.5)
    assert r["margin_ft"] == -3.0 and r["pass"] is False and r["too_close_to_call"] is False and r["nearest_segment"] == 0
    assert r["per_segment"] == [{"distance_ft": 2.0, "margin_ft": -3.0}, {"distance_ft": 24.0, "margin_ft": 19.0}]


def test_INT2_check_setback_tolerance_is_three_valued():
    o = [[13, 70.85], [37, 70.85], [37, 94.85], [13, 94.85]]
    assert T.check_setback(o, REAR, 5, 1.6) == {"distance_ft": 5.15, "required_ft": 5, "margin_ft": 0.15, "pass": None,
                                               "tolerance_ft": 1.6, "too_close_to_call": True}
    assert T.check_setback(o, REAR, 5, 0.1)["pass"] is True


@pytest.mark.parametrize("cell,ok", [(True, True), ("true", True), (" Yes ", True), ("y", True), ("allowed", True), ("ALLOWED", True),
                                     (False, False), ("false", False), ("no", False), (" N ", False), ("not allowed", False), ("Not Allowed", False)])
def test_INT2_check_allowed_reads_the_cell(cell, ok):
    assert T.check_allowed(cell, "R5", "p") == {"allowed": ok, "zone": "R5", "param": "p", "cell_value": cell}


@pytest.mark.parametrize("cell", ["", None, 1, 0, "1", "maybe", "see 33.205", []])
def test_INT2_check_allowed_unreadable_cell_is_refused(cell):
    """I-D7: a cell that is not a clear yes or no is never read as "not allowed"."""
    with pytest.raises(ValueError) as e:
        T.check_allowed(cell, "R5", "p")
    assert str(e.value) == f"allowed-use cell not readable: {cell!r}"


def test_INT2_check_max():
    assert T.check_max(15, 20, "ft") == {"value": 15, "limit": 20, "unit": "ft", "margin": 5, "pass": True, "tolerance": 0.0, "too_close_to_call": False}
    assert T.check_max(21, 20, "ft")["margin"] == -1 and T.check_max(21, 20, "ft")["pass"] is False
    assert T.check_max(20, 20, "ft")["pass"] is True
    assert T.check_max(19.5, 20, "ft", 1.0) == {"value": 19.5, "limit": 20, "unit": "ft", "margin": 0.5, "pass": None, "tolerance": 1.0, "too_close_to_call": True}


def test_INT2_footprint_dimensions():
    assert T.footprint_dimensions(SEL) == {"width_ft": 24, "depth_ft": 24, "max_dimension_ft": 24}
    r = T.footprint_dimensions(SEL, 24)
    assert r == {"width_ft": 24, "depth_ft": 24, "max_dimension_ft": 24, "limit_ft": 24, "margin_ft": 0, "too_close_to_call": False, "pass": True}
    assert list(r) == ["width_ft", "depth_ft", "max_dimension_ft", "limit_ft", "margin_ft", "too_close_to_call", "pass"]
    assert T.footprint_dimensions([[0, 0], [30, 0], [30, 10], [0, 10]], 24)["margin_ft"] == -6
    assert T.footprint_dimensions(SEL, 24.5, 1.0)["pass"] is None


def test_INT2_adu_max_living_area():
    assert T.adu_max_living_area(1400, 75, 800) == {"share_sqft": 1050.0, "cap_sqft": 800, "max_sqft": 800, "binding": "cap"}
    assert T.adu_max_living_area(1000, 75, 800, 576) == {"share_sqft": 750.0, "cap_sqft": 800, "max_sqft": 750.0, "binding": "share",
                                                         "plan_sqft": 576, "margin_sqft": 174.0, "pass": True}
    over = T.adu_max_living_area(1400, 75, 800, 900)
    assert over["margin_sqft"] == -100 and over["pass"] is False
    tie = T.adu_max_living_area(1066.6666666667, 75, 800, 800)
    assert tie["binding"] == "cap" and tie["margin_sqft"] == 0 and tie["pass"] is True


def test_INT2_same_call_same_result():
    a = T.check_setback(SEL, REAR, 5)
    assert a == T.check_setback(SEL, REAR, 5) and a["distance_ft"] == 11 and a["margin_ft"] == 6 and a["pass"]


PORCH = [[0, 0], [24, 0], [24, 24], [16, 24], [16, 30], [8, 30], [8, 24], [0, 24]]   # a 6 ft porch on the rear face


def test_INT2_a_porch_can_never_be_read_as_off_the_lot():
    o = T.placed_outline(PORCH, {"x": 13, "y": 72, "rotation": 0})["outline"]          # box to y = 96, porch to y = 102
    assert T.physical_fit(LOT, HOUSE, [], o)["inside_lot"] is False
    assert T.physical_fit(LOT, HOUSE, [], T.placed_outline(PORCH, {"x": 13, "y": 66, "rotation": 0})["outline"])["pass"] is True
