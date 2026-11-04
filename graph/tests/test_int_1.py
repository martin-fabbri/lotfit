"""INT-1: graph/tools/geometry.py (INS-02). Frozen; pinned values; standard library only (no shapely).
Run: python3 -m pytest -q --noconftest graph/tests/test_int_1.py"""
import os, sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import geometry as G  # noqa: E402

SQ = [[0, 0], [10, 0], [10, 10], [0, 10]]
L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]          # non-convex: the notch is x > 4 and y > 4
PORCH = [[0, 0], [24, 0], [24, 24], [16, 24], [16, 30], [8, 30], [8, 24], [0, 24]]


def test_INT1_eps_is_one_nanofoot():
    assert G.EPS == 1e-9


def test_INT1_area_is_unsigned_shoelace():
    assert G.area(SQ) == 100.0 and G.area(SQ[::-1]) == 100.0 and G.area(L) == 64.0 and G.area(PORCH) == 624.0


def test_INT1_edges_close_the_ring():
    assert G.edges([[0, 0], [1, 0], [0, 1]]) == [([0, 0], [1, 0]), ([1, 0], [0, 1]), ([0, 1], [0, 0])]


def test_INT1_boundary_points():
    assert G.on_boundary([5, 0], SQ) and G.on_boundary([10, 10], SQ) and not G.on_boundary([5, 5], SQ)


def test_INT1_strictly_inside_excludes_the_boundary_and_the_notch():
    assert G.strictly_inside([5, 5], SQ) and not G.strictly_inside([5, 0], SQ) and not G.strictly_inside([11, 5], SQ)
    assert G.strictly_inside([2, 2], L) and not G.strictly_inside([7, 7], L)


def test_INT1_touching_is_not_overlapping():
    assert not G.overlaps(SQ, [[10, 0], [20, 0], [20, 10], [10, 10]])        # shared edge
    assert not G.overlaps(SQ, [[10, 10], [20, 10], [20, 20], [10, 20]])      # shared corner


def test_INT1_overlaps():
    assert G.overlaps(SQ, [[5, 5], [15, 5], [15, 15], [5, 15]])              # partial
    assert G.overlaps(SQ, [[2, 2], [3, 2], [3, 3], [2, 3]])                  # contained
    assert G.overlaps([[0, 4], [10, 4], [10, 6], [0, 6]], [[4, 0], [6, 0], [6, 10], [4, 10]])  # a cross: no vertex inside
    assert not G.overlaps(L, [[6, 6], [9, 6], [9, 9], [6, 9]])               # sits in the notch


def test_INT1_within():
    assert G.within([[2, 2], [3, 2], [3, 3], [2, 3]], SQ) and G.within(SQ, SQ)
    assert not G.within([[5, 5], [15, 5], [15, 15], [5, 15]], SQ)
    assert not G.within([[6, 6], [9, 6], [9, 9], [6, 9]], L)
    assert not G.within(SQ, [[2, 2], [3, 2], [3, 3], [2, 3]])


def test_INT1_within_refuses_a_lot_whose_notch_pokes_into_the_outline():
    """No edge crosses and every probe point of the outline is inside the lot, but the lot's notch vertex (7, 6) lies
    strictly inside the outline: the outline is not within the lot (the outer-vertex step)."""
    notched = [[0, 0], [10, 0], [10, 10], [7.5, 10], [7.5, 9], [7, 6], [6.5, 9], [6.5, 10], [0, 10]]
    assert not G.within([[1, 1], [9, 1], [9, 9], [1, 9]], notched)
    assert G.within([[1, 1], [6, 1], [6, 5], [1, 5]], notched)


def test_INT1_point_segment_distance():
    assert G.point_segment_distance([3, 4], [0, 0], [0, 0]) == 5.0          # degenerate segment
    assert G.point_segment_distance([5, 5], [0, 0], [10, 0]) == 5.0
    assert G.point_segment_distance([-3, 4], [0, 0], [10, 0]) == 5.0        # beyond the end: to the endpoint


def test_INT1_distance_to_segment():
    assert G.distance_to_segment(SQ, [[0, 15], [10, 15]]) == 5.0
    assert G.distance_to_segment(SQ, [[-5, 5], [15, 5]]) == 0.0               # crosses
    assert G.distance_to_segment(SQ, [[5, 5], [6, 6]]) == 0.0                 # inside
    assert G.distance_to_segment(SQ, [[10, 0], [20, 0]]) == 0.0               # touches
    assert G.distance_to_segment(SQ, [[13, 14], [20, 20]]) == 5.0
    assert G.distance_to_segment(L, [[7, 7], [12, 12]]) == 3.0                 # into the notch


@pytest.mark.parametrize("r,expect", [
    (0, [[13, 65], [37, 65], [37, 89], [29, 89], [29, 95], [21, 95], [21, 89], [13, 89]]),
    (90, [[13, 65], [13, 89], [-11, 89], [-11, 81], [-17, 81], [-17, 73], [-11, 73], [-11, 65]]),
    (180, [[13, 65], [-11, 65], [-11, 41], [-3, 41], [-3, 35], [5, 35], [5, 41], [13, 41]]),
    (270, [[13, 65], [13, 41], [37, 41], [37, 49], [43, 49], [43, 57], [37, 57], [37, 65]]),
    (360, [[13, 65], [37, 65], [37, 89], [29, 89], [29, 95], [21, 95], [21, 89], [13, 89]]),
    (-90, [[13, 65], [13, 41], [37, 41], [37, 49], [43, 49], [43, 57], [37, 57], [37, 65]]),
])
def test_INT1_placed_outline_rotates_counterclockwise_then_moves(r, expect):
    assert G.placed_outline(PORCH, {"x": 13, "y": 65, "rotation": r}) == expect


def test_INT1_placed_outline_default_rotation_is_zero():
    assert G.placed_outline([[0, 0], [1, 0], [0, 1]], {"x": 1, "y": 2}) == [[1, 2], [2, 2], [1, 3]]


def test_INT1_placed_outline_refuses_45_degrees():
    with pytest.raises(ValueError, match="^rotation must be a multiple of 90 degrees$"):
        G.placed_outline(PORCH, {"x": 0, "y": 0, "rotation": 45})


def test_INT1_bbox_dims():
    assert G.bbox_dims(PORCH) == (24, 30) and G.bbox_dims(L) == (10, 10)


def test_INT1_probe_points_skip_an_outside_vertex_average():
    assert G._probe_points(L) == [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [5.0, 0.0], [10.0, 2.0], [7.0, 4.0],
                                  [4.0, 7.0], [2.0, 10.0], [0.0, 5.0]]
    assert G._probe_points(SQ)[-1] == [5.0, 5.0]
