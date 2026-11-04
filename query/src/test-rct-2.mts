// RCT-2: the EventLog and readEventsJsonl (RCS-04, RCS-05, RCS-06). Frozen. Temp run folders, injected clock and ids.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { EventLog, makeUuid7, readEventsJsonl, sha256Hex } from "./events.mts";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "..", "record", "fixtures");
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const errOf = (f: () => unknown): string => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
const TS = 1762171200000;
const fresh = () => {
  let i = 0, t = 0;
  return {
    runs_root: mkdtempSync(join(tmpdir(), "rct2-")),
    clock: () => new Date(TS + 1000 * t++).toISOString(),
    uuidGenerator: () => makeUuid7(`u${i++}`, TS),
  };
};
const A = "a".repeat(64), G = "94ee5cce@file-graph";
const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim());

// ---- RCS-04 opening a run
{
  const f = fresh();
  const log = new EventLog({ config_hash: A, graph_load_id: G, ...f });
  check("EV1", "thread_id is the first generated id when none is given", log.thread_id === makeUuid7("u0", TS), log.thread_id);
  check("EV2", "run_dir = runs_root/<thread_id>; events.jsonl and artifacts/ exist", log.run_dir === join(f.runs_root, log.thread_id) &&
    log.events_path === join(log.run_dir, "events.jsonl") && log.artifacts_dir === join(log.run_dir, "artifacts") &&
    existsSync(log.events_path) && readFileSync(log.events_path, "utf8") === "" && existsSync(log.artifacts_dir));
  check("EV3", "session_id null when not given; config_hash and graph_load_id kept", log.session_id === null && log.config_hash === A && log.graph_load_id === G);
  check("EV4", "no turn open at the start", log.getTurnId() === null && log.getEvents().length === 0);
  const e1 = log.append("lotfit.verdict_computed", { entailed: "NEEDS_CHECK", proposed: null, agree: false, abnormal_end: false, reasons: [] });
  check("EV5", "the first event has seq 1, turn_id null, the run's fields", e1.seq === 1 && e1.turn_id === null && e1.thread_id === log.thread_id &&
    e1.config_hash === A && e1.graph_load_id === G && e1.session_id === null && e1.id === makeUuid7("u1", TS) && e1.created_at === new Date(TS).toISOString(), JSON.stringify(e1));
  check("EV6", "append writes one JSON line and keeps it in memory", lines(log.events_path).length === 1 && JSON.parse(lines(log.events_path)[0]!).id === e1.id && log.getEvents().length === 1);
  const before = readFileSync(log.events_path, "utf8");
  const bad = errOf(() => log.append("turn_ended", { status: "nope" } as any));
  check("EV7", "an invalid payload throws and writes nothing", bad !== "" && readFileSync(log.events_path, "utf8") === before && log.getEvents().length === 1, bad);
  const unk = errOf(() => log.append("lotfit.custom" as any, { x: 1 } as any));
  check("EV8", "an untyped event kind throws (EN-39)", unk !== "" && log.getEvents().length === 1);
  const copy = log.getEvents(); copy.push(e1);
  check("EV9", "getEvents returns a copy", log.getEvents().length === 1);
  check("EV10", "allocateUuid uses the id generator", C.Uuid7.safeParse(log.allocateUuid()).success);
  rmSync(f.runs_root, { recursive: true, force: true });
}
{
  const f = fresh();
  const given = makeUuid7("given", TS), sess = makeUuid7("sess", TS);
  const log = new EventLog({ thread_id: given, session_id: sess, config_hash: A, graph_load_id: G, ...f });
  check("EV11", "a given thread_id and session_id are used", log.thread_id === given && log.session_id === sess);
  check("EV12", "a thread_id that is not a v7 uuid throws", errOf(() => new EventLog({ thread_id: "not-a-uuid", config_hash: A, graph_load_id: G, ...fresh() })) !== "");
  check("EV13", "a config_hash that is not sha256 hex throws", errOf(() => new EventLog({ config_hash: "xyz", graph_load_id: G, ...fresh() })) !== "");
  // R-D1
  log.append("turn_ended", { status: "ok" });
  const again = errOf(() => new EventLog({ thread_id: given, config_hash: A, graph_load_id: G, runs_root: f.runs_root }));
  check("RD1.1", "reopening a run folder that already has events throws (R-D1/R-D8)", again === `run folder already exists: ${log.run_dir}`, again);
  const g2 = fresh(), t2 = makeUuid7("t2", TS);
  const l2 = new EventLog({ thread_id: t2, config_hash: A, graph_load_id: G, ...g2 });
  check("RD8.1", "an existing events.jsonl, even empty, is refused: two logs on one thread cannot both open (R-D8)",
    errOf(() => new EventLog({ thread_id: t2, config_hash: A, graph_load_id: G, runs_root: g2.runs_root })) === `run folder already exists: ${l2.run_dir}`);
  const g3 = fresh(), t3 = makeUuid7("t3", TS), d3 = join(g3.runs_root, t3);
  mkdirSync(join(d3, "artifacts"), { recursive: true }); writeFileSync(join(d3, "artifacts", "v1-case.json"), "{}");
  check("RD8.2", "a folder with artifacts but no events.jsonl is refused, and its artifact is untouched (R-D8)",
    errOf(() => new EventLog({ thread_id: t3, config_hash: A, graph_load_id: G, runs_root: g3.runs_root })) === `run folder already exists: ${d3}` &&
    readFileSync(join(d3, "artifacts", "v1-case.json"), "utf8") === "{}" && !existsSync(join(d3, "events.jsonl")));
  rmSync(g3.runs_root, { recursive: true, force: true });
  rmSync(f.runs_root, { recursive: true, force: true }); rmSync(g2.runs_root, { recursive: true, force: true });
}

// ---- RCS-05 turns
{
  const f = fresh();
  const log = new EventLog({ config_hash: A, graph_load_id: G, ...f });
  const usage = { model: "m", prompt_tokens: 1, completion_tokens: 2 };
  const { turn_id, events } = log.beginTurn({ phase: "plan", input_summary: "plan", initial_events: [{ type: "messages", data: { role: "system", usage } }] });
  check("TU1", "beginTurn allocates the turn id first and returns it with its batch", turn_id === makeUuid7("u1", TS) && events.length === 2 &&
    events[0]!.type === "turn_started" && events[1]!.type === "messages" && events.every((e) => e.turn_id === turn_id), JSON.stringify(events.map((e) => [e.type, e.seq])));
  check("TU2", "turn_started carries phase and input_summary; seq 1 then 2", (events[0] as any).data.phase === "plan" && (events[0] as any).data.input_summary === "plan" && events[0]!.seq === 1 && events[1]!.seq === 2);
  check("TU3", "the turn is open", log.getTurnId() === turn_id);
  const inTurn = log.append("error", { category: "tool", code: "E", message: "m", metadata: {} });
  check("TU4", "an event inside the turn carries its turn_id", inTurn.turn_id === turn_id);
  const outside = log.append("error", { category: "tool", code: "E", message: "m", metadata: {} }, null);
  check("TU5", "turnIdOverride null writes turn_id null even inside a turn", outside.turn_id === null);
  const other = makeUuid7("other", TS);
  check("TU6", "turnIdOverride with an id writes that id", log.append("error", { category: "tool", code: "E", message: "m", metadata: {} }, other).turn_id === other);
  const end = log.endTurn("repair");
  check("TU7", "endTurn writes turn_ended with the status inside the turn, then closes it", end.type === "turn_ended" && (end as any).data.status === "repair" && end.turn_id === turn_id && log.getTurnId() === null);
  const before = readFileSync(log.events_path, "utf8"), nBefore = log.getEvents().length;
  const bad = errOf(() => log.beginTurn({ phase: "execute", input_summary: "x", initial_events: [{ type: "turn_ended", data: { status: "nope" } }] }));
  check("TU8", "a batch with one invalid event throws and writes none of it (atomic)", bad !== "" && readFileSync(log.events_path, "utf8") === before && log.getEvents().length === nBefore, bad);
  const er = log.recordError("database", "GRAPH_LOAD", "load differs", { pinned: "x" });
  check("TU9", "recordError appends an error event", er.type === "error" && (er as any).data.category === "database" && (er as any).data.code === "GRAPH_LOAD" && (er as any).data.metadata.pinned === "x");
  check("TU10", "recordError metadata defaults to {}", (log.recordError("case", "C", "m") as any).data.metadata && Object.keys((log.getEvents().at(-1) as any).data.metadata).length === 0);
  check("TU11", "a bad error category throws", errOf(() => log.recordError("nope" as any, "C", "m")) !== "");
  rmSync(f.runs_root, { recursive: true, force: true });
}

// ---- RCS-05 artifacts
{
  const f = fresh();
  const log = new EventLog({ config_hash: A, graph_load_id: G, ...f });
  const a1 = log.writeArtifact("plan.json", { v: 1 });
  const text1 = JSON.stringify({ v: 1 }, null, 2) + "\n";
  check("AR1", "an object is written as 2-space JSON plus a newline, at run_dir/<path>", readFileSync(join(log.run_dir, "plan.json"), "utf8") === text1);
  check("AR2", "and as an immutable copy artifacts/v1-<name>", readFileSync(join(log.artifacts_dir, "v1-plan.json"), "utf8") === text1);
  check("AR3", "the ref: path, version 1, sha256 and size of the exact bytes, scope case", a1.path === "plan.json" && a1.version === 1 &&
    a1.sha256 === sha256Hex(Buffer.from(text1, "utf8")) && a1.size_bytes === Buffer.byteLength(text1) && a1.scope === "case" && C.ArtifactRef.safeParse(a1).success, JSON.stringify(a1));
  const ev = log.getEvents().at(-1) as any;
  check("AR4", "artifact_written is appended with the ref", ev.type === "artifact_written" && JSON.stringify(ev.data.artifact) === JSON.stringify(a1));
  const a2 = log.writeArtifact("plan.json", { v: 2 });
  check("AR5", "the same path again is version 2: the latest file is replaced, v1 stays", a2.version === 2 && JSON.parse(readFileSync(join(log.run_dir, "plan.json"), "utf8")).v === 2 &&
    JSON.parse(readFileSync(join(log.artifacts_dir, "v1-plan.json"), "utf8")).v === 1 && JSON.parse(readFileSync(join(log.artifacts_dir, "v2-plan.json"), "utf8")).v === 2);
  check("AR6", "versions count per path", log.writeArtifact("other.json", {}).version === 1);
  const s = log.writeArtifact("notes.txt", "héllo", "institutional", false);
  check("AR7", "a string is written as is (no newline added); scope institutional; emitEvent false writes no event",
    readFileSync(join(log.run_dir, "notes.txt"), "utf8") === "héllo" && s.size_bytes === 6 && s.scope === "institutional" &&
    (log.getEvents().at(-1) as any).data.artifact.path === "other.json");
  const sub = log.writeArtifact("sub/dir/x.json", [1]);
  check("AR8", "a nested path makes its folders; the versioned name maps / to __", existsSync(join(log.run_dir, "sub", "dir", "x.json")) &&
    existsSync(join(log.artifacts_dir, "v1-sub__dir__x.json")) && sub.path === "sub/dir/x.json");
  // R-D2
  const refused: Array<[string, string]> = [["", "is empty"], ["/etc/x.json", "is absolute"], ["../x.json", 'has a "." or ".." segment'],
    ["a/../b.json", 'has a "." or ".." segment'], ["./x.json", 'has a "." or ".." segment'], ["a/./b.json", 'has a "." or ".." segment'],
    ["a\\b.json", "contains a backslash"], ["a//b.json", "has an empty segment"], ["a/", "has an empty segment"], ["a__b.json", 'contains "__"'],
    ["events.jsonl", "is the event log"], ["artifacts/v1-plan.json", "is inside artifacts/"], ["artifacts", "is inside artifacts/"]];
  const msgs = refused.map(([p]) => errOf(() => log.writeArtifact(p, {})));
  check("RD2.1", "refused, one message per rule (R-D2/R-D7)", msgs.every((m, i) => m === `artifact path ${refused[i]![1]}: ${JSON.stringify(refused[i]![0])}`), JSON.stringify(msgs));
  check("RD2.2", "a refused path writes no file and no event", !existsSync(join(f.runs_root, "x.json")) && readdirSync(log.artifacts_dir).length === 5 &&
    (log.getEvents().at(-1) as any).data.artifact.path === "sub/dir/x.json", readdirSync(log.artifacts_dir).join(","));
  check("RD2.3", "a dotted name that is not a .. segment is fine", errOf(() => log.writeArtifact("a..b.json", {})) === "");
  check("RD7.1", "the log is intact after the refusals: every line parses, events.jsonl was never overwritten",
    readEventsJsonl(log.events_path).length === log.getEvents().length);
  log.writeArtifact("Plan2.json", { a: 1 });
  check("RD7.2", "a path that differs only in case from one already written is refused (case-insensitive disks)",
    errOf(() => log.writeArtifact("plan2.json", {})) === "artifact path differs only in case from one already written in this run: plan2.json vs Plan2.json");
  writeFileSync(join(log.artifacts_dir, "v1-pre.json"), "PLANTED");
  const before = log.getEvents().length;
  const pre = errOf(() => log.writeArtifact("pre.json", { real: 1 }));
  check("RD7.3", "a versioned copy is never overwritten: an existing v1 file makes the write fail, nothing recorded, version not used",
    pre !== "" && readFileSync(join(log.artifacts_dir, "v1-pre.json"), "utf8") === "PLANTED" && !existsSync(join(log.run_dir, "pre.json")) &&
    log.getEvents().length === before, pre);
  rmSync(f.runs_root, { recursive: true, force: true });
}

// ---- golden run: a fixed scripted sequence gives a fixed events.jsonl
{
  const f = fresh();
  const log = new EventLog({ config_hash: A, graph_load_id: G, ...f });
  const art = log.writeArtifact("case.json", { case: 1 });
  log.append("thread_created", { case_hash: "b".repeat(64), case_artifact: art });
  log.beginTurn({ phase: "plan", input_summary: "plan", initial_events: [{ type: "messages", data: { role: "system", usage: { model: "m", prompt_tokens: 1, completion_tokens: 2 } } }] });
  log.recordError("tool", "E1", "boom", { a: 1 });
  log.writeArtifact("plan.json", { v: 1 });
  log.writeArtifact("plan.json", { v: 2 });
  log.endTurn("repair");
  log.append("lotfit.verdict_computed", { entailed: "NEEDS_CHECK", proposed: null, agree: false, abnormal_end: false, reasons: ["x"] });
  log.writeArtifact("notes.txt", "hello", "institutional", false);
  const text = readFileSync(log.events_path, "utf8");
  const golden = readFileSync(join(FX, "expected-events.jsonl"), "utf8");
  check("GL1", "events.jsonl equals the golden file byte for byte", text === golden, `sha ${sha256Hex(text)}`);
  check("GL2", "pinned sha256 of the golden events.jsonl", sha256Hex(text) === "2bc534d323bf60aa1d3308ee840b7348b57bdbdf8bae34e0ffaf8ee2f099b12f", sha256Hex(text));
  check("GL3", "seq runs 1..n without gaps; one line per event; LF line ends", lines(log.events_path).map((l) => JSON.parse(l).seq).join(",") === Array.from({ length: lines(log.events_path).length }, (_, i) => i + 1).join(",") && !text.includes("\r") && text.endsWith("\n"));
  // ---- RCS-06 readEventsJsonl
  const back = readEventsJsonl(log.events_path);
  check("RE1", "reading back gives the same events, parsed", JSON.stringify(back) === JSON.stringify(log.getEvents()));
  check("RE2", "a missing file reads as []", readEventsJsonl(join(f.runs_root, "none.jsonl")).length === 0);
  const p2 = join(f.runs_root, "blank.jsonl"); writeFileSync(p2, "\n" + lines(log.events_path)[0] + "\n\n   \n");
  check("RE3", "blank lines are skipped", readEventsJsonl(p2).length === 1);
  const p3 = join(f.runs_root, "bad.jsonl"); writeFileSync(p3, lines(log.events_path)[0] + "\n{not json\n");
  check("RE4", "a line that is not JSON throws", errOf(() => readEventsJsonl(p3)) !== "");
  const p4 = join(f.runs_root, "bad2.jsonl"); writeFileSync(p4, JSON.stringify({ ...JSON.parse(lines(log.events_path)[0]!), type: "lotfit.custom" }) + "\n");
  check("RE5", "a line that is not a valid event throws (never skipped)", errOf(() => readEventsJsonl(p4)) !== "");
  appendFileSync(log.events_path, "");
  rmSync(f.runs_root, { recursive: true, force: true });
}

const J = (x: unknown) => JSON.stringify(x);
// ---- R-D9: a reordered, duplicated or mixed log is refused when read back
{
  const f = fresh();
  const log = new EventLog({ config_hash: A, graph_load_id: G, ...f });
  for (let i = 0; i < 3; i++) log.append("turn_ended", { status: "ok" });
  const L = lines(log.events_path);
  const write = (ls: string[]) => { const p = join(f.runs_root, "probe.jsonl"); writeFileSync(p, ls.join("\n") + "\n"); return p; };
  check("RD9.1", "a reordered log throws", errOf(() => readEventsJsonl(write([L[0]!, L[2]!, L[1]!]))) === "events.jsonl sequence breaks at line 2: seq 3, expected 2");
  check("RD9.2", "a duplicated line throws", errOf(() => readEventsJsonl(write([L[0]!, L[0]!]))) === "events.jsonl sequence breaks at line 2: seq 1, expected 2");
  const other = JSON.parse(L[1]!); other.thread_id = makeUuid7("other", TS);
  check("RD9.3", "a log mixing two threads throws", errOf(() => readEventsJsonl(write([L[0]!, JSON.stringify(other)]))) === `events.jsonl mixes threads at line 2: ${other.thread_id} after ${log.thread_id}`);
  const dupId = JSON.parse(L[1]!); dupId.id = JSON.parse(L[0]!).id;
  check("RD9.4", "a repeated event id throws", errOf(() => readEventsJsonl(write([L[0]!, JSON.stringify(dupId)]))) === `events.jsonl repeats event id ${dupId.id} at line 2`);
  check("RD9.5", "the real log reads back", readEventsJsonl(log.events_path).length === 3);
  // R-D10: turns do not nest; endTurn needs an open turn
  check("RD10.1", "endTurn with no open turn throws", errOf(() => log.endTurn("ok")) === "no turn is open");
  const t = log.beginTurn({ phase: "plan", input_summary: "x" });
  check("RD10.2", "beginTurn while a turn is open throws, and writes nothing", errOf(() => log.beginTurn({ phase: "plan", input_summary: "y" })) === `a turn is already open: ${t.turn_id}` && lines(log.events_path).length === 4);
  log.endTurn("ok");
  // R-D11: the record in memory cannot be edited
  const evs = log.getEvents();
  check("RD11.1", "events are frozen, deep", Object.isFrozen(evs[0]) && Object.isFrozen((evs[0] as any).data) && errOf(() => { (evs[0] as any).seq = 99; }) !== "");
  evs.pop();
  check("RD11.2", "getEvents returns a new array each time", log.getEvents().length === 5);
  rmSync(f.runs_root, { recursive: true, force: true });
}
// ---- R-D4, R-D5: a refused event leaves no gap; a refused turn leaves no open turn
{
  const f = fresh();
  const log = new EventLog({ config_hash: A, graph_load_id: G, ...f });
  log.append("turn_ended", { status: "ok" });
  const bad = errOf(() => log.append("turn_ended", { status: "nope" } as never));
  const e2 = log.append("turn_ended", { status: "ok" });
  check("RD4.1", "a refused append uses no sequence number: 1, then 2", bad !== "" && e2.seq === 2 && lines(log.events_path).length === 2, `${e2.seq}`);
  const badTurn = errOf(() => log.beginTurn({ phase: "plan", input_summary: "x", initial_events: [{ type: "turn_ended", data: { status: "nope" } }] }));
  check("RD5.1", "a refused beginTurn writes nothing and leaves no turn open", badTurn !== "" && log.getTurnId() === null && lines(log.events_path).length === 2);
  const e3 = log.append("turn_ended", { status: "ok" });
  check("RD5.2", "the next event carries no turn id and the next sequence number", e3.turn_id === null && e3.seq === 3);
  const t = log.beginTurn({ phase: "plan", input_summary: "y", initial_events: [{ type: "turn_ended", data: { status: "ok" } }, { type: "turn_ended", data: { status: "repair" } }] });
  check("RD4.2", "a turn batch is numbered 4, 5, 6 and the turn is open after it", J(t.events.map((e) => e.seq)) === "[4,5,6]" && log.getTurnId() === t.turn_id, J(t.events.map((e) => e.seq)));
  rmSync(f.runs_root, { recursive: true, force: true });
}
console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
