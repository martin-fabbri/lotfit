// W6 · Model client interface + Baseten OpenAI-compatible implementation + Scripted test implementation
// (ARCHITECTURE.md round 4.1 §5, §17; HANDOFF-AG-W6-HARNESS.md item 7).
//
// Baseten configuration:
//   - baseURL: "https://inference.baseten.co/v1"
//   - model:   "meta-models/muse-spark-open-1026"
//   - apiKey:  process.env.BASETEN_META_API_KEY
//   - temperature: 0
//   - max_tokens: >= 2500 (default 4096)
//   - prior reasoning is NEVER re-sent across turns.

import OpenAI from "openai";
import { z } from "zod";
import { TOOL_DESCRIPTIONS, type RepairErrorType, type RunningLedger, type TurnWindowEntry } from "./context.mts";
import * as C from "./types.mts";

export type UsageRecordType = z.infer<typeof C.UsageRecord>;
export type TargetType = z.infer<typeof C.Target>;

export const DEFAULT_BASETEN_BASE_URL = "https://inference.baseten.co/v1";
export const DEFAULT_BASETEN_MODEL = "meta-models/muse-spark-open-1026";
export const MIN_MAX_TOKENS = 2500;
export const DEFAULT_MAX_TOKENS = 16000; // a full plan plus reasoning overran 4,096 in live S1 run 1 (CC)

export interface ModelToolCallDraft {
  call_id?: string;
  provision_id?: string | null;
  target?: TargetType;
  tool: string;
  args: Record<string, unknown>;
}

export type ReasoningEffort = "low" | "medium" | "high";

export interface ModelRequest {
  phase: "plan" | "execute";
  turn_id: string;
  turn_index: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
  allowed_tools: string[];
  ledger: RunningLedger;
  window_turns: TurnWindowEntry[];
  current_turn_calls: TurnWindowEntry["calls"];
  pending_repairs: RepairErrorType[];
  /** Per-request reasoning effort; overrides the client default. Unset by default. */
  reasoningEffort?: ReasoningEffort;
}

export interface ModelResponse {
  content: string;
  plan?: unknown;
  tool_calls: ModelToolCallDraft[];
  usage: UsageRecordType;
  /** Optional reasoning trace from this single call; recorded for telemetry only and NEVER re-sent. */
  reasoning_content?: string;
}

export interface ModelClient {
  readonly modelId: string;
  readonly providerRoute: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export interface BasetenModelClientOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  costPerMillionPromptUsd?: number;
  costPerMillionCompletionUsd?: number;
  costPerMillionCachedUsd?: number;
  provider?: "baseten" | "fireworks";
  /** Default reasoning effort, sent as reasoning_effort. Unset by default. */
  reasoningEffort?: ReasoningEffort;
}

// Each tool goes to the model with its real description and the JSON Schema of its frozen args contract (C3, and C4
// for record_finding / conclude). Before: blank schemas and a generic description, so the model never learned the
// shape of record_finding (live S1, no finding ever recorded). CC fix.
const toolSchemaCache = new Map<string, Record<string, unknown>>();
function toolParameters(toolName: string): Record<string, unknown> {
  const hit = toolSchemaCache.get(toolName);
  if (hit) return hit;
  const schema =
    toolName === "record_finding" ? C.RecordFinding
    : toolName === "conclude" ? C.Conclude
    : (C.TOOL_ARGS as Record<string, z.ZodType>)[toolName];
  let js: Record<string, unknown> = { type: "object", additionalProperties: true };
  if (schema) {
    try {
      js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
      delete js["$schema"];
      // Trim validation-only keywords: code re-validates every argument against the zod contract anyway, and these
      // (id regexes above all) only cost prompt tokens on every turn.
      const strip = (o: unknown): void => {
        if (Array.isArray(o)) { o.forEach(strip); return; }
        if (o && typeof o === "object") {
          for (const k of ["pattern", "minLength", "maxLength", "minItems", "maxItems", "format", "minimum", "maximum", "exclusiveMinimum"]) delete (o as any)[k];
          Object.values(o).forEach(strip);
        }
      };
      strip(js);
    } catch { /* keep the open schema */ }
  }
  toolSchemaCache.set(toolName, js);
  return js;
}

function buildOpenAiTools(allowedTools: string[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return allowedTools.map((toolName) => ({
    type: "function" as const,
    function: {
      name: toolName,
      description: TOOL_DESCRIPTIONS[toolName]?.description ?? `LotFit deterministic tool '${toolName}'.`,
      parameters: toolParameters(toolName),
    },
  }));
}

/** Request body for one completion. reasoning_effort goes out only when set (per-request wins). */
export function buildCompletionParams(
  req: ModelRequest,
  modelId: string,
  maxTokens: number,
  clientEffort?: ReasoningEffort,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  // Ensure prior reasoning is never re-sent: only plain `{role, content}` strings are transmitted.
  const cleanMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const tools = req.allowed_tools.length > 0 ? buildOpenAiTools(req.allowed_tools) : undefined;
  const effort = req.reasoningEffort ?? clientEffort;
  return {
    model: modelId,
    messages: cleanMessages,
    temperature: 0,
    max_tokens: maxTokens,
    ...(tools ? { tools, tool_choice: "auto" } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    stream: true,
    stream_options: { include_usage: true },
    // The installed SDK's chat types predate reasoning_effort; Fireworks reads it from the body.
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
}

function extractJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Strip markdown code fences if present
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1]!.trim() : trimmed;

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Try locating the outermost `{ ... }`
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const sub = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
        if (sub && typeof sub === "object" && !Array.isArray(sub)) {
          return sub as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Live OpenAI-compatible client targeting Baseten (`https://inference.baseten.co/v1`,
 * model `meta-models/muse-spark-open-1026`, `temperature: 0`, `max_tokens >= 2500`).
 */
export class BasetenModelClient implements ModelClient {
  public readonly modelId: string;
  public readonly providerRoute: string;
  private readonly client: OpenAI;
  private readonly maxTokens: number;
  private readonly reasoningEffort?: ReasoningEffort;
  private readonly costPromptPerM: number;
  private readonly costCompletionPerM: number;
  private readonly costCachedPerM: number;

  constructor(opts: BasetenModelClientOptions = {}) {
    // Provider: Baseten (hackathon key) by default; LOTFIT_PROVIDER=fireworks routes to Fireworks (L29 failover).
    // Same model family, same list price on both: $1.25 / 1M input, $4.25 / 1M output, $0.15 / 1M cached input
    // (third-party rate cards, 2026-11-02; the earlier 0.2 / 0.6 were placeholders that under-reported cost ~4x).
    const fireworks = (opts.provider ?? process.env["LOTFIT_PROVIDER"]) === "fireworks";
    const keyName = fireworks ? "FIREWORKS_API_KEY" : "BASETEN_META_API_KEY";
    const apiKey = opts.apiKey ?? process.env[keyName] ?? "";
    if (!apiKey) {
      throw new Error(`Missing ${keyName} in environment for the model client`);
    }
    const baseURL = opts.baseURL ?? (fireworks ? "https://api.fireworks.ai/inference/v1" : DEFAULT_BASETEN_BASE_URL);
    this.modelId = opts.model ?? (fireworks ? "accounts/fireworks/models/muse-spark-open" : DEFAULT_BASETEN_MODEL);
    this.providerRoute = baseURL;
    this.maxTokens = Math.max(opts.maxTokens ?? DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS);
    this.reasoningEffort = opts.reasoningEffort;
    this.costPromptPerM = opts.costPerMillionPromptUsd ?? 1.25;
    this.costCompletionPerM = opts.costPerMillionCompletionUsd ?? 4.25;
    this.costCachedPerM = opts.costPerMillionCachedUsd ?? 0.15;

    // CC 2026-11-03: Fireworks stalled one call 5 min without headers; undici's 300 s headers timeout then killed the
    // run (no retry). The SDK's own timeout fires first (600 s: a long plan turn took over 4 min), and the SDK
    // retries timeouts and 5xx up to 3 times. Responses stream so a slow turn keeps arriving instead of timing out.
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: 600_000,
      maxRetries: 3,
    });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = Date.now();

    const stream = await this.client.chat.completions.create(
      buildCompletionParams(req, this.modelId, this.maxTokens, this.reasoningEffort),
    );
    const completion = await foldChatCompletionStream(stream);

    const durationMs = Math.max(0, Date.now() - t0);
    return modelResponseFromCompletion(completion, {
      modelId: this.modelId,
      costPromptPerM: this.costPromptPerM,
      costCompletionPerM: this.costCompletionPerM,
      costCachedPerM: this.costCachedPerM,
      durationMs,
    });
  }
}

/** Folded stream: the same shape a non-streamed completion has. */
export interface FoldedCompletion {
  choices: Array<{
    message: {
      content: string;
      reasoning_content?: string;
      tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
    finish_reason: string | null;
  }>;
  usage: Record<string, any>;
}

/** Join stream chunks: content and reasoning concatenate, tool calls join by index, usage comes last. */
export async function foldChatCompletionStream(stream: AsyncIterable<any>): Promise<FoldedCompletion> {
  let content = "";
  let reasoning = "";
  const parts = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | null = null;
  let usage: Record<string, any> = {};
  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta as
      | { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<Record<string, any>> }
      | undefined;
    if (typeof delta?.content === "string") content += delta.content;
    const r = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof r === "string") reasoning += r;
    for (const tc of delta?.tool_calls ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const part = parts.get(idx) ?? { id: "", name: "", args: "" };
      if (!part.id && typeof tc.id === "string") part.id = tc.id;
      const fn = tc.function as Record<string, any> | undefined;
      if (typeof fn?.name === "string") part.name += fn.name;
      if (typeof fn?.arguments === "string") part.args += fn.arguments;
      parts.set(idx, part);
    }
    const fr = chunk?.choices?.[0]?.finish_reason;
    if (typeof fr === "string") finishReason = fr;
    if (chunk && typeof chunk === "object" && (chunk as Record<string, any>).usage) {
      usage = (chunk as Record<string, any>).usage as Record<string, any>;
    }
  }
  return {
    choices: [
      {
        message: {
          content,
          ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
          tool_calls: [...parts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, p]) => ({ id: p.id, type: "function" as const, function: { name: p.name, arguments: p.args } })),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

export interface CompletionCosts {
  modelId: string;
  costPromptPerM: number;
  costCompletionPerM: number;
  costCachedPerM: number;
  durationMs: number;
}

/** Map a completion (folded stream or not) to the harness ModelResponse. Pure. */
export function modelResponseFromCompletion(
  completion: { choices: Array<{ message?: unknown }>; usage?: unknown },
  costs: CompletionCosts,
): ModelResponse {
    const choice = completion.choices[0];
    const msg = (choice?.message ?? {}) as unknown as Record<string, any>;
    const rawContent = typeof msg["content"] === "string" ? msg["content"] : "";
    const reasoningContent =
      typeof msg["reasoning_content"] === "string"
        ? msg["reasoning_content"]
        : typeof msg["reasoning"] === "string"
          ? msg["reasoning"]
          : undefined;

    const toolCalls: ModelToolCallDraft[] = [];
    const rawToolCalls = Array.isArray(msg["tool_calls"]) ? (msg["tool_calls"] as Array<Record<string, any>>) : [];

    for (const tc of rawToolCalls) {
      const fn = tc["function"] as Record<string, any> | undefined;
      if (!fn || typeof fn["name"] !== "string") continue;
      let parsedArgs: Record<string, unknown> = {};
      if (typeof fn["arguments"] === "string" && fn["arguments"].trim().length > 0) {
        try {
          parsedArgs = JSON.parse(fn["arguments"]) as Record<string, unknown>;
        } catch {
          parsedArgs = { _raw_arguments: fn["arguments"] };
        }
      } else if (fn["arguments"] && typeof fn["arguments"] === "object") {
        parsedArgs = fn["arguments"] as Record<string, unknown>;
      }

      const provId =
        typeof parsedArgs["provision_id"] === "string" ? parsedArgs["provision_id"] : null;
      const target =
        parsedArgs["target"] === "case" ||
        parsedArgs["target"] === "client_spot" ||
        parsedArgs["target"] === "selected_placement"
          ? parsedArgs["target"]
          : ("case" as TargetType);

      toolCalls.push({
        tool: fn["name"],
        provision_id: provId,
        target,
        args: parsedArgs,
      });
    }

    let extractedPlan: unknown = undefined;
    const jsonInContent = extractJsonObjectFromText(rawContent);
    if (jsonInContent) {
      if ("applies" in jsonInContent && "excluded_at_index" in jsonInContent && "order" in jsonInContent) {
        extractedPlan = jsonInContent;
      } else if ("plan" in jsonInContent && typeof jsonInContent["plan"] === "object") {
        extractedPlan = jsonInContent["plan"];
      }
      if (toolCalls.length === 0 && Array.isArray(jsonInContent["tool_calls"])) {
        for (const item of jsonInContent["tool_calls"] as Array<Record<string, any>>) {
          if (item && typeof item["tool"] === "string") {
            const args =
              item["args"] && typeof item["args"] === "object"
                ? (item["args"] as Record<string, unknown>)
                : {};
            toolCalls.push({
              tool: item["tool"],
              provision_id:
                typeof item["provision_id"] === "string"
                  ? item["provision_id"]
                  : typeof args["provision_id"] === "string"
                    ? args["provision_id"]
                    : null,
              target:
                item["target"] === "client_spot" ||
                item["target"] === "selected_placement" ||
                item["target"] === "case"
                  ? item["target"]
                  : ("case" as TargetType),
              args,
            });
          }
        }
      }
    }

    const rawUsage = (completion.usage ?? {}) as unknown as Record<string, any>;
    const promptTokens = Number(rawUsage["prompt_tokens"] ?? 0);
    const completionTokens = Number(rawUsage["completion_tokens"] ?? 0);
    const cachedTokens = Number(
      rawUsage["prompt_tokens_details"]?.["cached_tokens"] ?? rawUsage["prompt_cached_tokens"] ?? 0,
    );
    const reasoningTokens = Number(
      rawUsage["completion_tokens_details"]?.["reasoning_tokens"] ??
        rawUsage["completion_reasoning_tokens"] ??
        0,
    );
    const costUsd = Number(
      (
        (Math.max(0, promptTokens - cachedTokens) * costs.costPromptPerM + cachedTokens * costs.costCachedPerM +
          completionTokens * costs.costCompletionPerM) /
        1_000_000
      ).toFixed(6),
    );

    const usage = C.UsageRecord.parse({
      model: costs.modelId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      prompt_cached_tokens: cachedTokens,
      completion_reasoning_tokens: reasoningTokens,
      cost_usd: costUsd,
      duration_ms: costs.durationMs,
    });

    return {
      content: rawContent,
      ...(extractedPlan !== undefined ? { plan: extractedPlan } : {}),
      tool_calls: toolCalls,
      usage,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    };
}

export function createBasetenModelClient(opts?: BasetenModelClientOptions): BasetenModelClient {
  return new BasetenModelClient(opts);
}

// ------------------------------------------------------------------ Scripted Model Client (for offline tests)

export interface ScriptedStepOutput {
  content?: string;
  plan?: unknown;
  tool_calls?: ModelToolCallDraft[];
  usage?: Partial<UsageRecordType>;
  reasoning_content?: string;
}

export type ScriptedResponder =
  | ScriptedStepOutput[]
  | ((req: ModelRequest, callIndex: number) => ScriptedStepOutput | Promise<ScriptedStepOutput>);

export class ScriptedModelClient implements ModelClient {
  public readonly modelId: string;
  public readonly providerRoute: string;
  private readonly responder: ScriptedResponder;
  private callCount = 0;
  public readonly recordedRequests: ModelRequest[] = [];

  constructor(
    responder: ScriptedResponder,
    opts?: { modelId?: string; providerRoute?: string },
  ) {
    this.responder = responder;
    this.modelId = opts?.modelId ?? DEFAULT_BASETEN_MODEL;
    this.providerRoute = opts?.providerRoute ?? "scripted://offline-test";
  }

  public getCallCount(): number {
    return this.callCount;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const idx = this.callCount++;
    this.recordedRequests.push(structuredClone(req));

    let step: ScriptedStepOutput;
    if (typeof this.responder === "function") {
      step = await this.responder(req, idx);
    } else {
      step = this.responder[idx] ?? {
        content: "",
        tool_calls: [],
      };
    }

    const usage = C.UsageRecord.parse({
      model: step.usage?.model ?? this.modelId,
      prompt_tokens: step.usage?.prompt_tokens ?? 1200,
      completion_tokens: step.usage?.completion_tokens ?? 300,
      prompt_cached_tokens: step.usage?.prompt_cached_tokens ?? 800,
      completion_reasoning_tokens: step.usage?.completion_reasoning_tokens ?? 150,
      cost_usd: step.usage?.cost_usd ?? 0.0005,
      ttft_ms: step.usage?.ttft_ms ?? 12,
      duration_ms: step.usage?.duration_ms ?? 25,
    });

    const content =
      step.content ??
      (step.plan !== undefined ? JSON.stringify(step.plan, null, 2) : "");

    return {
      content,
      ...(step.plan !== undefined ? { plan: step.plan } : {}),
      tool_calls: step.tool_calls ?? [],
      usage,
      ...(step.reasoning_content ? { reasoning_content: step.reasoning_content } : {}),
    };
  }
}

export function createScriptedModelClient(
  responder: ScriptedResponder,
  opts?: { modelId?: string; providerRoute?: string },
): ScriptedModelClient {
  return new ScriptedModelClient(responder, opts);
}
