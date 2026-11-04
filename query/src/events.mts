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
