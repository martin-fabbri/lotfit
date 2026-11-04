"""INT-4 (frozen): exceptions are three-valued (INS-06; EN-17). The 33.110.245.C.2 evaluator, condition by condition,
and check_exception_conditions' Kleene AND. Standard library + pytest only. Do not edit."""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import tools as T  # noqa: E402

EX = json.load(open(os.path.join(HERE, "..", "examples", "pdx-r5-adu-prov.json")))
S = EX["site"]
V = lambda k: S[k]["value"] if isinstance(S[k], dict) and "value" in S[k] else S[k]
CLIENT = [[2, 74], [26, 74], [26, 98], [2, 98]]           # S1's client spot: 2 ft from the west line, 2 ft from the rear
SEL = [[13, 65], [37, 65], [37, 89], [13, 89]]            # S1's selected placement: in no setback
PARAMS = {"zones_allowing_structures_in_side_rear_setbacks": ["R7", "R5", "R2.5"], "min_distance_from_front_lot_line": 40,
          "min_distance_from_side_street_lot_line_corner": 20, "max_footprint_dimension": 24, "max_height_in_setback": 15,
          "max_wall_height_in_setback": 10, "dormer_min_setback_from_side_rear": 5, "max_combined_length_in_setback_per_line": 24}
WEST = {"name": "west", "line": [[0, 0], [0, 100]], "min_ft": 5}
REAR = {"name": "rear", "line": [[0, 100], [50, 100]], "min_ft": 5}
EXC, BASE = "PDX.33.110.245.C.2", "PDX.33.110.220.B"


def facts(**kw):
    f = {"outline": CLIENT, "zone": "R5", "front_lot_line": V("front_lot_line"), "corner_lot": False, "height_ft": 15, "wall_height_ft": 12,
         "plan_kind": "adu", "openings_facing_lot_line": True, "rooftop_deck": False, "dormers": False, "structures": V("structures"),
         "setback_lines": [WEST, REAR]}
    f.update(kw)
    return f


def run(**kw):
    return T.check_exception_conditions(EXC, BASE, facts(**kw), PARAMS)


def cond(item, **kw):
    return next(c for c in run(**kw)["conditions"] if c["clause_id"].endswith("::item:" + item))


# ---------------------------------------------------------------- the Kleene AND
def test_INT4_and_false_dominates():
    assert T._and([True, None, False]) is False


def test_INT4_and_unknown_before_true():
    assert T._and([True, None]) is None


def test_INT4_and_all_true_and_empty():
    assert T._and([True, True]) is True and T._and([]) is True


# ---------------------------------------------------------------- the envelope of the result
def test_INT4_result_shape_and_order():
    r = run()
    assert set(r) == {"exception_id", "base_provision_id", "pass", "conditions"}
    assert r["exception_id"] == EXC and r["base_provision_id"] == BASE
    assert [c["clause_id"] for c in r["conditions"]] == [f"{EXC}#v1::item:{i}" for i in
                                                         ["b.", "b.(1)", "b.(2)", "b.(3)", "b.(4)", "b.(5)", "b.(6)", "b.(7)", "b.(8)"]]
    assert all(set(c) <= {"clause_id", "name", "holds", "measure", "reason", "param"} and {"clause_id", "name", "holds", "measure"} <= set(c) for c in r["conditions"])


def test_INT4_each_measure_names_its_parameter():
    """I-D4: a condition with a measure names the parameter it is compared with (the bridge reads it, then drops it)."""
    r = run(dormers=True, dormer_setback_ft=6)
    got = {c["clause_id"].split("::item:")[1]: c.get("param") for c in r["conditions"]}
    assert got == {"b.": None, "b.(1)": "min_distance_from_front_lot_line", "b.(2)": "max_footprint_dimension",
                   "b.(3)": "max_combined_length_in_setback_per_line", "b.(4)": "max_wall_height_in_setback", "b.(5)": None,
                   "b.(6)": None, "b.(7)": None, "b.(8)": "dormer_min_setback_from_side_rear"}


def test_INT4_version_is_in_the_clause_ids():
    r = T.check_exception_conditions(EXC, BASE, facts(), PARAMS, version=3)
    assert r["conditions"][0]["clause_id"] == f"{EXC}#v3::item:b."


def test_INT4_en17_example_fails_on_wall_and_windows():
    r = run()
    assert r["pass"] is False
    assert {c["clause_id"].split("::item:")[1] for c in r["conditions"] if c["holds"] is False} == {"b.(4)", "b.(6)"}


def test_INT4_unknown_is_not_no():
    r = run(wall_height_ft=9, openings_facing_lot_line=False, rooftop_deck=None)
    assert r["pass"] is None and cond("b.(7)", rooftop_deck=None)["holds"] is None


def test_INT4_all_conditions_hold():
    assert run(wall_height_ft=9, openings_facing_lot_line=False)["pass"] is True


def test_INT4_unknown_exception_is_refused():
    try:
        T.check_exception_conditions("PDX.33.110.999", BASE, facts(), PARAMS)
        assert False
    except ValueError as e:
        assert str(e) == "no evaluator for exception PDX.33.110.999"


# ---------------------------------------------------------------- b. zone
def test_INT4_b_zone_true_false_unknown():
    assert cond("b.")["holds"] is True
    assert cond("b.", zone="R10")["holds"] is False
    assert cond("b.", zone=None)["holds"] is None
    assert cond("b.")["name"] == "zone is one of R7, R5, R2.5" and cond("b.")["measure"] is None


# ---------------------------------------------------------------- b.(1) front, and the corner lot
def test_INT4_b1_front_distance_measure():
    c = cond("b.(1)")
    assert c["holds"] is True
    assert c["measure"] == {"distance_ft": 74.0, "required_ft": 40, "margin_ft": 34.0, "pass": True, "tolerance_ft": 0.0, "too_close_to_call": False}


def test_INT4_b1_too_close_to_the_front_fails():
    near = [[2, 30], [26, 30], [26, 54], [2, 54]]          # 30 ft from the front line
    assert cond("b.(1)", outline=near)["holds"] is False


def test_INT4_b1_tolerance_makes_it_unknown():
    near = [[2, 40.3], [26, 40.3], [26, 64.3], [2, 64.3]]  # margin 0.3 inside a 0.5 ft tolerance
    c = cond("b.(1)", outline=near, tolerance_ft=0.5)
    assert c["holds"] is None and c["measure"]["too_close_to_call"] is True


def test_INT4_b1_corner_unknown_makes_a_pass_unknown():
    assert cond("b.(1)", corner_lot=None)["holds"] is None


def test_INT4_b1_corner_unknown_keeps_a_fail():
    near = [[2, 30], [26, 30], [26, 54], [2, 54]]
    assert cond("b.(1)", outline=near, corner_lot=None)["holds"] is False


def test_INT4_b1_corner_without_side_street_line_is_unknown():
    assert cond("b.(1)", corner_lot=True)["holds"] is None
    assert cond("b.(1)", corner_lot=True, side_street_lot_line=None)["holds"] is None


def test_INT4_b1_corner_with_side_street_line_ands_both():
    east = [[50, 0], [50, 100]]                            # the client spot is 24 ft from it: >= 20 passes
    assert cond("b.(1)", corner_lot=True, side_street_lot_line=east)["holds"] is True
    west = [[0, 0], [0, 100]]                              # 2 ft from it: < 20 fails
    assert cond("b.(1)", corner_lot=True, side_street_lot_line=west)["holds"] is False


# ---------------------------------------------------------------- b.(2) footprint dimensions
def test_INT4_b2_footprint_24_at_the_limit_holds():
    c = cond("b.(2)")
    assert c["holds"] is True and c["measure"]["max_dimension_ft"] == 24 and c["measure"]["margin_ft"] == 0


def test_INT4_b2_footprint_over_fails():
    big = [[2, 70], [27, 70], [27, 98], [2, 98]]           # 25 x 28
    c = cond("b.(2)", outline=big)
    assert c["holds"] is False and c["measure"]["margin_ft"] == -4


# ---------------------------------------------------------------- b.(3) combined length in a setback
def test_INT4_b3_unknown_structures_or_lines_is_unknown():
    """I-D5 (ADV-4): an unknown list (None) is not "no other structure"."""
    for kw in ({"structures": None}, {"setback_lines": None}):
        c = cond("b.(3)", **kw)
        assert c["holds"] is None and c["reason"] == "structures or setback lines unknown", kw


def test_INT4_b3_a_structure_in_no_setback_says_so():
    assert cond("b.(3)", outline=SEL)["reason"] == "this structure is in no setback"


def test_INT4_b1_shows_the_failing_side_street_measure():
    """I-D4 (ADV-3): when the side street fails and the front passes, the measure is the side street's."""
    c = cond("b.(1)", corner_lot=True, side_street_lot_line=[[0, 0], [0, 100]])
    assert c["holds"] is False and c["param"] == "min_distance_from_side_street_lot_line_corner"
    assert c["measure"]["distance_ft"] == 2.0 and c["measure"]["required_ft"] == 20 and c["measure"]["pass"] is False
    ok = cond("b.(1)", corner_lot=True, side_street_lot_line=[[50, 0], [50, 100]])
    assert ok["param"] == "min_distance_from_front_lot_line" and ok["measure"]["distance_ft"] == 74.0


def test_INT4_b3_only_this_structure():
    c = cond("b.(3)")
    assert c["holds"] is True and c["measure"] is None and c["reason"] == "only this structure is in the setback"


def test_INT4_b3_combined_length_within_24_holds():
    shed = {"id": "shed", "outline": [[30, 97], [40, 97], [40, 99], [30, 99]]}   # 10 ft along the rear line, inside its 5 ft setback
    adu = [[2, 90], [12, 90], [12, 98], [2, 98]]                                # 10 ft along the rear line
    c = cond("b.(3)", outline=adu, structures=[shed], setback_lines=[REAR])
    assert c["holds"] is True and c["reason"] == "rear: combined 20.0 ft"


def test_INT4_b3_combined_length_over_24_fails():
    shed = {"id": "shed", "outline": [[30, 97], [46, 97], [46, 99], [30, 99]]}   # 16 ft
    adu = [[2, 90], [12, 90], [12, 98], [2, 98]]                                # 10 ft
    c = cond("b.(3)", outline=adu, structures=[shed], setback_lines=[REAR])
    assert c["holds"] is False and c["reason"] == "rear: combined 26.0 ft"


def test_INT4_b3_on_the_setback_line_is_not_inside():
    shed = {"id": "shed", "outline": [[30, 85], [46, 85], [46, 95], [30, 95]]}   # exactly 5 ft from the rear line: not in the setback
    adu = [[2, 90], [12, 90], [12, 98], [2, 98]]
    assert cond("b.(3)", outline=adu, structures=[shed], setback_lines=[REAR])["reason"] == "only this structure is in the setback"


# ---------------------------------------------------------------- b.(4) heights
def test_INT4_b4_wall_over_fails_with_a_measure():
    c = cond("b.(4)")
    assert c["holds"] is False
    assert c["measure"] == {"value": 12, "limit": 10, "unit": "ft", "margin": -2, "pass": False, "tolerance": 0.0, "too_close_to_call": False}


def test_INT4_b4_height_over_fails():
    assert cond("b.(4)", wall_height_ft=9, height_ft=16)["holds"] is False


def test_INT4_b4_both_within_hold():
    assert cond("b.(4)", wall_height_ft=10, height_ft=15)["holds"] is True


def test_INT4_b4_unknown_height_is_unknown():
    assert cond("b.(4)", wall_height_ft=9, height_ft=None)["holds"] is None


def test_INT4_b4_unknown_wall_is_unknown_and_shows_the_height():
    c = cond("b.(4)", wall_height_ft=None)
    assert c["holds"] is None and c["param"] == "max_height_in_setback"
    assert c["measure"] == {"value": 15, "limit": 15, "unit": "ft", "margin": 0, "pass": True, "tolerance": 0.0, "too_close_to_call": False}
    nothing = cond("b.(4)", wall_height_ft=None, height_ft=None)
    assert nothing["holds"] is None and nothing["measure"] is None and "param" not in nothing


def test_INT4_b4_over_height_shows_the_height_not_the_wall():
    """I-D4 (ADV-3): an over-height structure with a passing wall shows the failing height, never a passing wall."""
    c = cond("b.(4)", height_ft=17, wall_height_ft=9)
    assert c["holds"] is False and c["param"] == "max_height_in_setback"
    assert c["measure"]["value"] == 17 and c["measure"]["limit"] == 15 and c["measure"]["margin"] == -2 and c["measure"]["pass"] is False


# ---------------------------------------------------------------- b.(5) screening
def test_INT4_b5_an_adu_is_enclosed():
    c = cond("b.(5)", screening=False)
    assert c["holds"] is True and c["reason"] == "enclosed structure: \"Screening is not required for enclosed structures.\""


def test_INT4_b5_not_enclosed_reads_screening():
    assert cond("b.(5)", enclosed=False, screening=True)["holds"] is True
    assert cond("b.(5)", enclosed=False, screening=False)["holds"] is False
    assert cond("b.(5)", enclosed=False)["holds"] is None


def test_INT4_b5_not_an_adu_and_not_stated_reads_screening():
    assert cond("b.(5)", plan_kind="shed")["holds"] is None


# ---------------------------------------------------------------- b.(6) openings
def test_INT4_b6_openings_facing_flag():
    assert cond("b.(6)")["holds"] is False
    assert cond("b.(6)", openings_facing_lot_line=False)["holds"] is True


def test_INT4_b6_not_stated_is_unknown():
    c = cond("b.(6)", openings_facing_lot_line=None)
    assert c["holds"] is None and c["reason"] == "openings per face not stated"


def test_INT4_b6_by_face_at_rotation_0():
    # the client spot is within the west and rear setbacks; at rotation 0 the left face looks west, the rear face at the rear line
    ok = {"front": True, "rear": False, "left": False, "right": True}
    bad = {"front": True, "rear": True, "left": False, "right": True}
    assert cond("b.(6)", openings_facing_lot_line=None, openings_by_face=ok, rotation=0)["holds"] is True
    c = cond("b.(6)", openings_facing_lot_line=None, openings_by_face=bad, rotation=0)
    assert c["holds"] is False and c["reason"] == "openings toward rear"


def test_INT4_b6_by_face_follows_rotation_90():
    # at rotation 90 the west line faces the plan's rear (-x) and the rear line faces its right (+y)
    assert cond("b.(6)", openings_facing_lot_line=None, openings_by_face={"rear": True}, rotation=90)["reason"] == "openings toward west"
    assert cond("b.(6)", openings_facing_lot_line=None, openings_by_face={"right": True}, rotation=90)["reason"] == "openings toward rear"
    assert cond("b.(6)", openings_facing_lot_line=None, openings_by_face={"front": True, "left": True}, rotation=90)["holds"] is True


def test_INT4_b6_by_face_180_and_270():
    assert cond("b.(6)", openings_facing_lot_line=None, openings_by_face={"right": True}, rotation=180)["reason"] == "openings toward west"
    assert cond("b.(6)", openings_facing_lot_line=None, openings_by_face={"left": True}, rotation=270)["reason"] == "openings toward rear"


def test_INT4_b6_by_face_list_is_the_faces_with_openings():
    c = cond("b.(6)", openings_facing_lot_line=None, openings_by_face=["left", "front"], rotation=0)
    assert c["holds"] is False and c["reason"] == "openings toward west"


def test_INT4_b6_by_face_needs_the_rotation():
    # without a rotation the per-face rule is skipped and the plain flag decides
    assert cond("b.(6)", openings_facing_lot_line=False, openings_by_face={"left": True})["holds"] is True


def test_INT4_b6_by_face_out_of_any_setback_holds():
    assert cond("b.(6)", outline=SEL, openings_facing_lot_line=None, openings_by_face={"left": True, "rear": True}, rotation=0)["holds"] is True


# ---------------------------------------------------------------- b.(7) rooftop deck
def test_INT4_b7_rooftop_deck():
    assert cond("b.(7)")["holds"] is True
    assert cond("b.(7)", rooftop_deck=True)["holds"] is False
    assert cond("b.(7)", rooftop_deck=None)["holds"] is None


# ---------------------------------------------------------------- b.(8) dormers
def test_INT4_b8_no_dormers_holds():
    c = cond("b.(8)")
    assert c["holds"] is True and c["reason"] == "no dormers"


def test_INT4_b8_dormer_setback_given():
    c = cond("b.(8)", dormers=True, dormer_setback_ft=6)
    # I-D4 (ADV-3): a minimum: the measured value is the dormer's setback, the limit is the 5 ft minimum
    assert c["holds"] is True and c["measure"] == {"value": 6, "limit": 5, "unit": "ft", "margin": 1, "pass": True, "tolerance": 0.0,
                                                   "too_close_to_call": False}
    short = cond("b.(8)", dormers=True, dormer_setback_ft=3)
    assert short["holds"] is False and short["measure"]["value"] == 3 and short["measure"]["limit"] == 5 and short["measure"]["margin"] == -2


def test_INT4_b8_dormers_not_stated_is_unknown():
    for kw in ({"dormers": True}, {"dormers": None}):
        c = cond("b.(8)", **kw)
        assert c["holds"] is None and c["reason"] == "dormer positions not stated"


# ---------------------------------------------------------------- missing inputs
def test_INT4_missing_outline_is_a_key_error():
    f = facts()
    del f["outline"]
    try:
        T.check_exception_conditions(EXC, BASE, f, PARAMS)
        assert False
    except KeyError:
        pass


def test_INT4_b6_by_face_with_unknown_setback_lines_is_unknown():
    """I-D5: the per-face rule needs to know which walls are in a setback."""
    c = cond("b.(6)", openings_by_face={"rear": True}, rotation=0, setback_lines=None)
    assert c["holds"] is None and c["reason"] == "setback lines unknown"


def test_INT4_face_toward_a_diagonal_tie_is_an_x_face():
    """A lot line whose nearest point is as far across as along (|dx| == |dy|) faces the x side (the >= rule)."""
    sq = [[0, 0], [10, 0], [10, 10], [0, 10]]
    assert T._face_toward([[8, 8], [20, -4]], sq, 0) == "right" and T._face_toward([[8, 8], [20, -4]], sq, 90) == "front"


def test_INT4_face_toward_refuses_a_rotation_off_the_quarter_turns():
    """I-D11: a clear message, never a bare KeyError."""
    import pytest
    with pytest.raises(ValueError, match=r"^rotation must be a multiple of 90 degrees$"):
        T._face_toward([[0, 0], [0, 10]], [[1, 1], [5, 1], [5, 5], [1, 5]], 45)


def test_INT4_registry_reads_of_check_exception_conditions():
    """The facts the exception tool declares it reads (the Rulebook's placement check relies on them)."""
    assert T.TOOLS["check_exception_conditions"].reads == ["plan.outline", "site.front_lot_line", "site.side_street_lot_line", "site.corner_lot",
        "site.zone", "plan.height_ft", "plan.wall_height_ft", "plan.rooftop_deck", "plan.openings_facing_lot_line", "plan.dormers",
        "site.screening", "site.structures"]
    assert T.EXCEPTIONS == {"PDX.33.110.245.C.2": T._exc_245c2}
