"""INT-7 (frozen): the CLI and the self-test (INS-10; I-D1), and the tools' standard-library rule (IN-01). The TypeScript
half of this card is query/src/test-int-7.mts (the self-test's fixtures parsed with the contracts kit). Do not edit.
Run from the repo root: python3 -m pytest -q --noconftest graph/tests/test_int_7.py"""
import ast, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GRAPH = os.path.join(HERE, "..")
sys.path.insert(0, GRAPH)
import tool_runner as B  # noqa: E402

CID = "0190c0de-0000-7000-8000-000000000001"
Z = "0" * 64


def test_INT7_tools_import_only_the_standard_library():
    """IN-01: every import in graph/tools/*.py and graph/tool_runner.py is a standard-library module or the tools package."""
    files = [os.path.join(GRAPH, "tools", f) for f in sorted(os.listdir(os.path.join(GRAPH, "tools"))) if f.endswith(".py")]
    files.append(os.path.join(GRAPH, "tool_runner.py"))
    bad = []
    for f in files:
        for n in ast.walk(ast.parse(open(f).read())):
            mods = [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module] if isinstance(n, ast.ImportFrom) and n.level == 0 else []
            for m in mods:
                top = m.split(".")[0]
                if top not in sys.stdlib_module_names and top != "tools": bad.append(f"{os.path.basename(f)}: {m}")
    assert bad == [], bad


def _cli(stdin, *args, cwd_graph=GRAPH):
    return subprocess.run([sys.executable, "-I", os.path.join(cwd_graph, "tool_runner.py"), *args], input=stdin, capture_output=True, text=True)


def test_INT7_cli_runs_one_batch():
    req = {"config_hash": Z, "batch": [{"call_id": CID, "provision_id": None, "target": "case", "tool": "distance_to_line",
                                        "args": {"outline": [[0, 0], [1, 0], [1, 1], [0, 1]], "line": [[0, 5], [10, 5]]}}]}
    p = _cli(json.dumps(req))
    assert p.returncode == 0
    out = json.loads(p.stdout)
    assert out["results"][0]["result"] == {"distance_ft": 4.0} and out["impl_digest"] == B.impl_digest()


def test_INT7_cli_not_json_exits_2():
    p = _cli("not json")
    assert p.returncode == 2 and json.loads(p.stdout) == {"error": "request is not JSON: Expecting value: line 1 column 1 (char 0)"}


def test_INT7_cli_contract_mismatch_exits_2():
    p = _cli(json.dumps({"config_hash": "x", "batch": []}))
    assert p.returncode == 2 and json.loads(p.stdout) == {
        "error": "request does not match contract C3: config_hash must be a sha256 hex; batch must be a non-empty list"}


def _sandbox(d):
    """A copy of the tools, the runner and the example, with an empty contracts fixtures folder beside it."""
    g = os.path.join(d, "graph")
    os.makedirs(g)
    shutil.copytree(os.path.join(GRAPH, "tools"), os.path.join(g, "tools"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(GRAPH, "examples"), os.path.join(g, "examples"))
    shutil.copy(os.path.join(GRAPH, "tool_runner.py"), g)
    fx = os.path.join(d, "query", "contracts", "fixtures", "valid")
    os.makedirs(fx)
    return g, fx


def test_INT7_self_test_passes_and_writes_nothing():
    with tempfile.TemporaryDirectory() as d:
        g, fx = _sandbox(d)
        p = _cli("", "--self-test", cwd_graph=g)
        assert p.returncode == 0, p.stdout + p.stderr
        lines = p.stdout.strip().splitlines()
        assert len(lines) == 17 and all(l.startswith("ok   ") for l in lines[:16])
        assert lines[-1].startswith("16/16 bridge checks · impl_digest ")
        assert os.listdir(fx) == []                                      # I-D1: a test never rewrites files


def test_INT7_self_test_writes_the_fixtures_only_when_asked():
    with tempfile.TemporaryDirectory() as d:
        g, fx = _sandbox(d)
        p = _cli("", "--self-test", "--write-fixtures", cwd_graph=g)
        assert p.returncode == 0
        assert sorted(os.listdir(fx)) == ["C3_BridgeRequest.self-test.json", "C3_BridgeResponse.self-test.json"]
        req = json.load(open(os.path.join(fx, "C3_BridgeRequest.self-test.json")))
        resp = json.load(open(os.path.join(fx, "C3_BridgeResponse.self-test.json")))
        assert len(req["batch"]) == 15 and len(resp["results"]) == 15
        want = json.load(open(os.path.join(HERE, "fixtures", "int", "self-test-request.json")))
        assert req == want                                                # the 15 calls, argument for argument
        fpr = next(x for x in resp["results"] if x["ok"] and isinstance(x.get("result"), dict) and "summary" in x["result"])
        assert len(fpr["result"]["candidates"]) == 3                       # the search keeps only 3 candidates in the fixture


def test_INT7_self_test_check_names():
    with tempfile.TemporaryDirectory() as d:
        g, _ = _sandbox(d)
        names = [l[5:] for l in _cli("", "--self-test", cwd_graph=g).stdout.strip().splitlines()[:16]]
    assert names == [
        "client spot fails the side setback (margin -3)", "selected spot passes it (margin 8)", "a model-typed limit is refused as a model error",
        "size cap 800, plan 576 passes by 224", "height 15 under 20", "footprint 24 at the 24 limit passes", "accessory coverage 13.12% under 20%",
        "total coverage 1,566 under 2,250", "selected spot is far enough from the front or behind the house",
        "the exception fails at the client spot on the wall and the windows", "no trees: the tree gate is known false",
        "placements found, client spot fails, nearest clear named", "the solar check is a stated tool error", "a malformed request is refused",
        "an ADU allowed in R5 passes the gate (L32)", "a use not allowed fails the gate (L32)"]
