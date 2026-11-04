// Model client streaming: a fake streamed response (no network) folds into the right ModelResponse.
import { foldChatCompletionStream, modelResponseFromCompletion } from "./model-client.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };

async function* fakeStream(): AsyncGenerator<Record<string, any>> {
  yield { choices: [{ delta: {
    content: "Checking ",
    reasoning_content: "First, ",
    tool_calls: [{ index: 0, id: "call_a1", function: { name: "read_layer", arguments: '{"city_layer":' } }],
  }, finish_reason: null }] };
  yield { choices: [{ delta: {
    content: "the rules.",
    reasoning: "then measure.",
    tool_calls: [
      { index: 0, function: { name: "_index", arguments: '"EUG"}' } },
      { index: 1, id: "call_b2", function: { name: "check_setback", arguments: '{"provis' } },
    ],
  }, finish_reason: null }] };
  yield { choices: [{ delta: {
    tool_calls: [{ index: 1, function: { arguments: 'ion_id": "EUG.9.2751", "target": "client_spot"}' } }],
  }, finish_reason: "tool_calls" }] };
  yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } };
}

const folded = await foldChatCompletionStream(fakeStream());
ok("finish_reason folds", folded.choices[0]!.finish_reason === "tool_calls", String(folded.choices[0]!.finish_reason));
const res = modelResponseFromCompletion(folded, {
  modelId: "test-model", costPromptPerM: 1.25, costCompletionPerM: 4.25, costCachedPerM: 0.15, durationMs: 7,
});
ok("content joins across chunks", res.content === "Checking the rules.", JSON.stringify(res.content));
ok("reasoning joins across chunks and keys", (res as { reasoning_content?: string }).reasoning_content === "First, then measure.");
const names = res.tool_calls.map((c) => c.tool);
ok("tool names join across chunks", names.join(",") === "read_layer_index,check_setback", names.join(","));
ok("split args parse", JSON.stringify(res.tool_calls[0]!.args) === JSON.stringify({ city_layer: "EUG" }),
  JSON.stringify(res.tool_calls[0]!.args));
ok("provision_id lifts from args", res.tool_calls[1]!.provision_id === "EUG.9.2751", String(res.tool_calls[1]!.provision_id));
ok("target lifts from args, else case",
  res.tool_calls[1]!.target === "client_spot" && res.tool_calls[0]!.target === "case",
  `${res.tool_calls[0]!.target},${res.tool_calls[1]!.target}`);
ok("tokens fold from the last chunk",
  res.usage.prompt_tokens === 100 && res.usage.completion_tokens === 50 && res.usage.prompt_cached_tokens === 0,
  JSON.stringify(res.usage));
ok("cost folds from tokens", res.usage.cost_usd === 0.000338, String(res.usage.cost_usd));

console.log(`${n}/${t} model-client checks passed`);
process.exit(n === t ? 0 : 1);
