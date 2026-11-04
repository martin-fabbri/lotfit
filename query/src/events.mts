import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import * as C from "./types.mts";

export type LotFitEventType = z.infer<typeof C.LotFitEvent>;
export type ArtifactRefType = z.infer<typeof C.ArtifactRef>;
export type ConfigManifestType = z.infer<typeof C.ConfigManifest>;
export type UsageRecordType = z.infer<typeof C.UsageRecord>;
export type ToolCallType = z.infer<typeof C.ToolCall>;
export type ErrorCategoryType = z.infer<typeof C.ErrorCategory>;
export type PhaseType = "plan" | "execute" | "sensitivity" | "verdict" | "ask" | "verify" | "propose";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNS_ROOT = join(__dirname, "..", "out", "runs");

export function canonicalJson(x: unknown): string {
  return JSON.stringify(x, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

let lastUuidTimestampMs = 0;
let uuidMonotonicSeq = 0;

export function makeUuid7(seed?: string, timestampMs?: number): string {
  const nowMs = timestampMs ?? Date.now();
  const b = Buffer.alloc(16);
  if (seed !== undefined) {
    createHash("sha256").update(seed, "utf8").digest().copy(b, 0, 0, 16);
  } else {
    randomBytes(16).copy(b);
    if (nowMs === lastUuidTimestampMs) {
      uuidMonotonicSeq = (uuidMonotonicSeq + 1) & 0x0fff;
    } else {
      lastUuidTimestampMs = nowMs;
      uuidMonotonicSeq = 0;
    }
    b[6] = ((uuidMonotonicSeq >> 8) & 0x0f) | 0x70;
    b[7] = uuidMonotonicSeq & 0xff;
  }
  for (let i = 0; i <= 5; i++) {
    b[i] = Number((BigInt(nowMs) >> BigInt(8 * (5 - i))) & 0xffn);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function computeConfigHash(manifest: ConfigManifestType): { manifest: ConfigManifestType; config_hash: string } {
  const parsed = C.ConfigManifest.parse(manifest);
  const config_hash = sha256Hex(canonicalJson(parsed));
  return { manifest: parsed, config_hash };
}

export interface EventLogOptions {
  thread_id?: string;
  session_id?: string | null;
  config_hash: string;
  graph_load_id: string;
  runs_root?: string;
  clock?: () => string;
  uuidGenerator?: (tag?: string) => string;
}

export interface BeginTurnInput {
  phase: PhaseType;
  input_summary: string;
  initial_events?: Array<{ type: LotFitEventType["type"]; data: Record<string, unknown> }>;
}

export function checkArtifactPath(relativePath: string): string {
  const fail = (why: string): never => {
    throw new Error(`artifact path ${why}: ${JSON.stringify(relativePath)}`);
  };
  if (typeof relativePath !== "string" || relativePath === "") fail("is empty");
  if (relativePath.includes("\\")) fail("contains a backslash");
  if (isAbsolute(relativePath) || relativePath.startsWith("/")) fail("is absolute");
  const segments = relativePath.split("/");
  if (segments.some((s) => s === "." || s === "..")) fail('has a "." or ".." segment');
  if (segments.some((s) => s === "")) fail("has an empty segment");
  if (relativePath.includes("__")) fail('contains "__"');
  const rel = posix.normalize(relativePath);
  if (rel === "events.jsonl") fail("is the event log");
  if (rel === "artifacts" || rel.startsWith("artifacts/")) fail("is inside artifacts/");
  return rel;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

export class EventLog {
  public readonly thread_id: string;
  public readonly session_id: string | null;
  public readonly config_hash: string;
  public readonly graph_load_id: string;
  public readonly run_dir: string;
  public readonly events_path: string;
  public readonly artifacts_dir: string;
  private seq = 0;
  private current_turn_id: string | null = null;
  private events: LotFitEventType[] = [];
  private artifactVersions = new Map<string, number>();
  private artifactCase = new Map<string, string>();
  private clock: () => string;
  private nextUuid: (tag?: string) => string;

  constructor(opts: EventLogOptions) {
    this.nextUuid = opts.uuidGenerator ?? ((tag) => makeUuid7(tag));
    this.thread_id = opts.thread_id ? C.Uuid7.parse(opts.thread_id) : this.nextUuid();
    this.session_id = opts.session_id ? C.Uuid7.parse(opts.session_id) : null;
    this.config_hash = C.Sha256.parse(opts.config_hash);
    this.graph_load_id = opts.graph_load_id;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.run_dir = join(opts.runs_root ?? DEFAULT_RUNS_ROOT, this.thread_id);
    this.events_path = join(this.run_dir, "events.jsonl");
    this.artifacts_dir = join(this.run_dir, "artifacts");
    if (existsSync(this.events_path) || (existsSync(this.artifacts_dir) && readdirSync(this.artifacts_dir).length > 0)) {
      throw new Error(`run folder already exists: ${this.run_dir}`);
    }
    mkdirSync(this.artifacts_dir, { recursive: true });
    try {
      writeFileSync(this.events_path, "", { encoding: "utf8", flag: "wx" });
    } catch {
      throw new Error(`run folder already exists: ${this.run_dir}`);
    }
  }

  getTurnId(): string | null {
    return this.current_turn_id;
  }

  getEvents(): LotFitEventType[] {
    return this.events.slice();
  }

  allocateUuid(): string {
    return this.nextUuid();
  }

  append<T extends LotFitEventType["type"]>(
    type: T,
    data: Extract<LotFitEventType, { type: T }>["data"],
    turnIdOverride?: string | null,
  ): Extract<LotFitEventType, { type: T }> {
    const ev = this.buildEvent(type, data as Record<string, unknown>, turnIdOverride) as Extract<
      LotFitEventType,
      { type: T }
    >;
    this.commitBatch([ev]);
    return ev;
  }

  beginTurn(input: BeginTurnInput): { turn_id: string; events: LotFitEventType[] } {
    if (this.current_turn_id !== null) {
      throw new Error(`a turn is already open: ${this.current_turn_id}`);
    }
    const turn_id = this.nextUuid();
    const batch: LotFitEventType[] = [
      this.buildEvent("turn_started", { phase: input.phase, input_summary: input.input_summary }, turn_id),
    ];
    const initial = input.initial_events ?? [];
    for (let i = 0; i < initial.length; i++) {
      const init = initial[i]!;
      batch.push(this.buildEvent(init.type, init.data, turn_id, this.seq + 2 + i));
    }
    this.commitBatch(batch);
    this.current_turn_id = turn_id;
    return { turn_id, events: batch };
  }

  endTurn(status: "ok" | "repair" | "abnormal"): LotFitEventType {
    if (this.current_turn_id === null) {
      throw new Error("no turn is open");
    }
    const ev = this.append("turn_ended", { status });
    this.current_turn_id = null;
    return ev;
  }

  writeArtifact(
    relativePath: string,
    content: unknown,
    scope: "case" | "institutional" = "case",
    emitEvent = true,
  ): ArtifactRefType {
    const rel = checkArtifactPath(relativePath);
    const known = this.artifactCase.get(rel.toLowerCase());
    if (known !== undefined && known !== rel) {
      throw new Error(
        `artifact path differs only in case from one already written in this run: ${relativePath} vs ${known}`,
      );
    }
    const version = (this.artifactVersions.get(rel) ?? 0) + 1;
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
    const buf = Buffer.from(text, "utf8");
    const digest = sha256Hex(buf);
    const ref = C.ArtifactRef.parse({
      artifact_id: this.nextUuid(),
      path: rel,
      version,
      sha256: digest,
      created_at: this.clock(),
      size_bytes: buf.byteLength,
      scope,
    });
    writeFileSync(join(this.artifacts_dir, `v${version}-${rel.replace(/\//g, "__")}`), buf, { flag: "wx" });
    mkdirSync(dirname(join(this.run_dir, rel)), { recursive: true });
    writeFileSync(join(this.run_dir, rel), buf);
    this.artifactVersions.set(rel, version);
    this.artifactCase.set(rel.toLowerCase(), rel);
    if (emitEvent) {
      this.append("artifact_written", { artifact: ref });
    }
    return ref;
  }

  recordError(
    category: ErrorCategoryType,
    code: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): LotFitEventType {
    return this.append("error", { category, code, message, metadata });
  }

  private buildEvent(
    type: LotFitEventType["type"],
    data: Record<string, unknown>,
    turnIdOverride?: string | null,
    seqOverride?: number,
  ): LotFitEventType {
    const raw = {
      id: this.nextUuid(),
      thread_id: this.thread_id,
      session_id: this.session_id,
      turn_id: turnIdOverride !== undefined ? turnIdOverride : this.current_turn_id,
      seq: seqOverride ?? this.seq + 1,
      created_at: this.clock(),
      config_hash: this.config_hash,
      graph_load_id: this.graph_load_id,
      type,
      data,
    };
    return C.LotFitEvent.parse(raw);
  }

  private commitBatch(batch: LotFitEventType[]): void {
    if (batch.length === 0) return;
    appendFileSync(this.events_path, batch.map((ev) => JSON.stringify(ev)).join("\n") + "\n", "utf8");
    for (const ev of batch) {
      this.events.push(deepFreeze(ev));
    }
    this.seq = batch[batch.length - 1]!.seq;
  }
}

export function readEventsJsonl(eventsPath: string): LotFitEventType[] {
  if (!existsSync(eventsPath)) {
    return [];
  }
  const text = readFileSync(eventsPath, "utf8");
  const events = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => C.LotFitEvent.parse(JSON.parse(line)) as LotFitEventType);
  if (events.length === 0) {
    return events;
  }
  const first = events[0]!;
  const seen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.thread_id !== first.thread_id) {
      throw new Error(`events.jsonl mixes threads at line ${i + 1}: ${ev.thread_id} after ${first.thread_id}`);
    }
    if (ev.seq !== i + 1) {
      throw new Error(`events.jsonl sequence breaks at line ${i + 1}: seq ${ev.seq}, expected ${i + 1}`);
    }
    if (seen.has(ev.id)) {
      throw new Error(`events.jsonl repeats event id ${ev.id} at line ${i + 1}`);
    }
    seen.add(ev.id);
  }
  return events;
}
