// RCT-1: the Record's helpers (RCS-02 canonicalJson, sha256Hex; RCS-03 makeUuid7, computeConfigHash). Frozen.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { canonicalJson, computeConfigHash, makeUuid7, sha256Hex } from "./events.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(join(here, "..", "record", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const thrown = (f: () => unknown): boolean => { try { f(); return false; } catch { return true; } };

// ---- RCS-02 canonicalJson and sha256Hex
const nested = { b: [{ d: 1, c: 2 }], a: { z: null, y: "x" } };
check("HJ1", "keys sorted at every depth, arrays kept in order", canonicalJson(nested) === '{"a":{"y":"x","z":null},"b":[{"c":2,"d":1}]}', canonicalJson(nested));
check("HJ2", "key order of the input does not matter", canonicalJson({ a: 1, b: 2 }) === canonicalJson({ b: 2, a: 1 }));
check("HJ3", "compact: no spaces, no newline", !/\s/.test(canonicalJson(nested)));
check("HJ4", "undefined object values are dropped; undefined array items become null", canonicalJson({ a: undefined, b: 1 }) === '{"b":1}' && canonicalJson([undefined, 1]) === "[null,1]");
check("HJ5", "scalars and null pass through", canonicalJson("s") === '"s"' && canonicalJson(3.5) === "3.5" && canonicalJson(null) === "null" && canonicalJson(true) === "true");
check("HJ6", "array order is never sorted", canonicalJson([3, 1, 2]) === "[3,1,2]");
check("HJ7", "pinned: sha256 of the canonical nested sample", sha256Hex(canonicalJson(nested)) === "a3d521da527129a0450cde6142f4ca0624d50f713f2be6a730a0abf6412a2749", sha256Hex(canonicalJson(nested)));
check("HS1", "sha256Hex of a string is lowercase hex of its UTF-8 bytes", sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
check("HS2", "a Buffer with the same bytes gives the same hash", sha256Hex(Buffer.from("abc")) === sha256Hex("abc"));
check("HS3", "UTF-8, not UTF-16: a non-ASCII string hashes its UTF-8 bytes", sha256Hex("é") === sha256Hex(Buffer.from([0xc3, 0xa9])));
check("HS4", "the result parses as C.Sha256", C.Sha256.safeParse(sha256Hex("x")).success);

// ---- RCS-03 makeUuid7
const TS = 1762171200000; // 2025-11-03T12:00:00.000Z (any fixed instant works)
const u = makeUuid7();
check("HU1", "a random id parses as C.Uuid7", C.Uuid7.safeParse(u).success, u);
check("HU2", "format: 8-4-4-4-12 lowercase hex, version nibble 7, variant 10xx", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u), u);
const t = makeUuid7(undefined, TS);
check("HU3", "the first 48 bits are the timestamp in ms, big-endian", t.replace(/-/g, "").slice(0, 12) === TS.toString(16).padStart(12, "0"), t);
check("HU4", "seeded with a fixed timestamp: the same id twice", makeUuid7("seed-a", TS) === makeUuid7("seed-a", TS) && makeUuid7("seed-a", TS) === "019a4996-a200-7c45-b314-4d93fda113d9", makeUuid7("seed-a", TS));
check("HU5", "another seed, another id", makeUuid7("seed-b", TS) === "019a4996-a200-7af7-91bb-4641b2e4bd62", makeUuid7("seed-b", TS));
check("HU6", "a seeded id is a valid v7 id", C.Uuid7.safeParse(makeUuid7("seed-a", TS)).success);
{ const ids = Array.from({ length: 200 }, () => makeUuid7(undefined, TS + 5));
  check("HU7", "random ids in one millisecond are distinct and increase (12-bit counter in bytes 6-7)", new Set(ids).size === 200 && ids.every((x, i) => i === 0 || x > ids[i - 1]!), ids.slice(0, 3).join(" ")); }
{ const a = makeUuid7(undefined, TS + 10), b = makeUuid7(undefined, TS + 11);
  check("HU8", "a later millisecond sorts later", b > a && b.replace(/-/g, "").slice(12, 16) === "7000", `${a} ${b}`); }

// ---- RCS-03 computeConfigHash
const M = fx("config-manifest.json");
const ch = computeConfigHash(M);
check("HC1", "pinned: config_hash of the fixture manifest", ch.config_hash === "d0f3600d3f356f7062d73855acaa076dc135ae5be83cffc0f6f2102d457e97e6", ch.config_hash);
check("HC2", "config_hash = sha256Hex(canonicalJson(parsed manifest))", ch.config_hash === sha256Hex(canonicalJson(C.ConfigManifest.parse(M))));
check("HC3", "returns the parsed manifest", canonicalJson(ch.manifest) === canonicalJson(M));
check("HC4", "key order of the manifest does not change the hash", computeConfigHash(Object.fromEntries(Object.entries(M).reverse()) as any).config_hash === ch.config_hash);
check("HC5", "a changed model id changes the hash", computeConfigHash({ ...M, models: { ...M.models, reviewer: "x" } }).config_hash !== ch.config_hash);
check("HC6", "an invalid manifest throws (bad sha, extra key)", thrown(() => computeConfigHash({ ...M, prompt_sha256: "xyz" })) && thrown(() => computeConfigHash({ ...M, extra: 1 } as any)));

console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
