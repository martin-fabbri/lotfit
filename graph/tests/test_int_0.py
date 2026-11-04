"""INT-0: the repo is ready for the Instruments (check only; writes nothing). Frozen. Martin runs it, no Muse session.
Run from the repo root: python3 -m pytest -q -rA --noconftest graph/tests/test_int_0.py   (-rA shows the INFO lines)"""
import hashlib, importlib.util, json, os, sys

GRAPH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(GRAPH)
CONVENTIONS = os.path.join(GRAPH, "curated", "conventions.json")
CONVENTIONS_SHA256 = "abcd05118e1d881ba78080b662e940476ccb150953f9ac29922c399dffcec3f4"
EXAMPLE = os.path.join(GRAPH, "examples", "pdx-r5-adu-prov.json")
EXAMPLE_SHA256 = "b2fd8ad8f8c7ea79ca1a1f5d18e085bd44581bbacc4a5f827c9c13cbe6baa15f"
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()


def test_INT0_python_is_3_11_or_newer():
    # graph/pyproject.toml: requires-python = ">=3.11"
    assert sys.version_info >= (3, 11), sys.version


def test_INT0_pytest_is_installed():
    assert importlib.util.find_spec("pytest") is not None


def test_INT0_conventions_file_is_the_pinned_one():
    assert os.path.isfile(CONVENTIONS), "graph/curated/conventions.json missing: copy it from the kit"
    assert sha(CONVENTIONS) == CONVENTIONS_SHA256


def test_INT0_conventions_state_the_rotations_the_tools_use():
    c = json.load(open(CONVENTIONS))
    assert sorted(c["placement"]["faces_after_rotation"]) == ["0", "180", "270", "90"]
    assert c["placement"]["faces_after_rotation"]["0"] == {"front": "-y", "rear": "+y", "left": "-x", "right": "+x"}


def test_INT0_example_lot_is_the_pinned_one():
    # the Portland sample lot the INT-4..INT-7 tests and the self-test read (provenance names are "sample")
    assert os.path.isfile(EXAMPLE), "graph/examples/pdx-r5-adu-prov.json missing: copy it from the kit"
    assert sha(EXAMPLE) == EXAMPLE_SHA256
    assert "Martin" not in open(EXAMPLE).read()


def test_INT0_contract_fixtures_folder_exists_for_int7():
    # INT-7's self-test --write-fixtures writes query/contracts/fixtures/valid/C3_Bridge*.self-test.json
    assert os.path.isdir(os.path.join(REPO, "query", "contracts", "fixtures", "valid")), "query/contracts/fixtures/valid/ missing"


def test_INT0_contracts_kit_is_in_place_for_int7():
    # INT-7's TypeScript check parses the bridge's output with the contracts kit (sha256 fed00915…, the Record's RCT-0)
    p = os.path.join(REPO, "query", "src", "types.mts")
    assert os.path.isfile(p) and sha(p) == "fed00915fd224cf6a8e6d5dfd4d727ed62cdef0260df868ba694dd5a2ef63f7a", "the contracts kit is not installed"


def test_INT0_state_of_the_tools_folder_is_reported():
    # information only. Before INT-1, graph/tools/ is absent or empty. If it already holds .py files, tell Martin before
    # INT-1 overwrites them. If the Rulebook's graph/model.py is in the repo, it imports graph/tools and refuses an
    # operator naming a missing tool, so the Rulebook's own tests stay red until INT-5 (expected).
    tools = os.path.join(GRAPH, "tools")
    files = sorted(f for f in os.listdir(tools) if f.endswith(".py")) if os.path.isdir(tools) else []
    print(f"INFO graph/tools/: {files or 'absent or empty'}")
    print(f"INFO graph/model.py present: {os.path.isfile(os.path.join(GRAPH, 'model.py'))}")
