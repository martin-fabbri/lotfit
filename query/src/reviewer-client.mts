import OpenAI from "openai";
import type { z } from "zod";
import type * as C from "./types.mts";

export type UsageRecordType = z.infer<typeof C.UsageRecord>;
export type ReviewItemType = z.infer<typeof C.ReviewItem>;

export interface ReviewerCall { item: ReviewItemType; system: string; user: string; timeoutMs: number }
export interface ReviewerReply { content: string; usage: UsageRecordType }
export interface ReviewerClient {
  readonly modelId: string;
  readonly providerRoute: string;
  answer(call: ReviewerCall): Promise<ReviewerReply>;
}

export const DEFAULT_META_BASE_URL = "https://api.meta.ai/v1";
export const DEFAULT_REVIEWER_MODEL = "muse-spark-1.3";

export interface MetaReviewerClientOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  costPerMillionPromptUsd?: number;      // USD per million tokens; unset until checked on Meta's price list
  costPerMillionCompletionUsd?: number;
  /** Tests only (D14, REP-28): passed to the OpenAI SDK as its `fetch`, so a test can check the request without network. */
  fetch?: typeof globalThis.fetch;
}

export class MetaReviewerClient implements ReviewerClient {
  readonly modelId: string;
  readonly providerRoute: string;
  private readonly openai: OpenAI;
  private readonly maxTokens: number;
  private readonly costPerMillionPromptUsd?: number;
  private readonly costPerMillionCompletionUsd?: number;

  constructor(opts?: MetaReviewerClientOptions) {
    const apiKey = opts?.apiKey ?? process.env["META_API_KEY"] ?? "";
    if (apiKey === "") {
      throw new Error("META_API_KEY is not set (read from the environment only, MM-04)");
    }
    this.providerRoute = opts?.baseURL ?? DEFAULT_META_BASE_URL;
    this.modelId = opts?.model ?? DEFAULT_REVIEWER_MODEL;
    if (/contributor/i.test(this.modelId) || /contributor/i.test(this.providerRoute)) {
      throw new Error(`the Reviewer sends a client's case facts; ${this.modelId} is a contributor endpoint (L27)`);
    }
    this.openai = new OpenAI({ apiKey, baseURL: this.providerRoute, maxRetries: 0, ...(opts?.fetch ? { fetch: opts.fetch } : {}) });
    this.maxTokens = opts?.maxTokens ?? 2500;
    this.costPerMillionPromptUsd = opts?.costPerMillionPromptUsd;
    this.costPerMillionCompletionUsd = opts?.costPerMillionCompletionUsd;
  }

  async answer(call: ReviewerCall): Promise<ReviewerReply> {
    const t0 = Date.now();
    const res = await this.openai.chat.completions.create(
      {
        model: this.modelId,
        temperature: 0,
        max_tokens: this.maxTokens,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
      },
      { timeout: call.timeoutMs },
    );
    const prompt = res.usage?.prompt_tokens ?? 0;
    const out = res.usage?.completion_tokens ?? 0;
    const costIn = this.costPerMillionPromptUsd;
    const costOut = this.costPerMillionCompletionUsd;
    const usage: UsageRecordType = {
      model: this.modelId,
      prompt_tokens: prompt,
      completion_tokens: out,
      duration_ms: Date.now() - t0,
      ...(costIn !== undefined && costOut !== undefined ? { cost_usd: (prompt * costIn + out * costOut) / 1e6 } : {}),
    };
    return { content: res.choices[0]?.message?.content ?? "", usage };
  }
}

export class ScriptedReviewerClient implements ReviewerClient {
  readonly modelId: string;               // set from the constructor's first argument
  readonly providerRoute: "scripted" = "scripted";
  calls = 0;                              // public, starts at 0
  private readonly handler: (item: ReviewItemType, attempt: number) => string | Promise<string>;

  constructor(modelId: string, handler: (item: ReviewItemType, attempt: number) => string | Promise<string>) {
    this.modelId = modelId;
    this.handler = handler;
  }

  async answer(call: ReviewerCall): Promise<ReviewerReply> {
    this.calls++;
    const content = await this.handler(call.item, this.calls);
    return { content, usage: { model: this.modelId, prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 } };
  }
}
