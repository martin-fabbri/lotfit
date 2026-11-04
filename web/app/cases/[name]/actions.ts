"use server";
import { redirect } from "next/navigation";
import { checkCaseWithEngine, saveCase, startRun } from "@/lib/engine";
import { currentUser } from "@/lib/supabase/server";
import { engineAvailable } from "@/lib/paths";

async function guard() {
  if (!(await currentUser())) throw new Error("sign in first");
}

/** Runs the engine's own case check (contract, invariants I1–I12, the Python validator) on the case as edited. */
export async function checkAction(caseJson: string): Promise<any> {
  await guard();
  if (!engineAvailable()) return { unavailable: true };
  return checkCaseWithEngine(JSON.parse(caseJson));
}

/** Starts a live run: an edited case is checked and saved under a new name first, then run-live.mts runs it. */
export async function runAction(name: string, caseJson: string | null, reviewer: boolean): Promise<{ error: string } | never> {
  await guard();
  let target = name;
  if (caseJson) {
    const r = await checkCaseWithEngine(JSON.parse(caseJson));
    if (r?.ok !== true) return { error: "the case check refuses this case" };
    target = saveCase(`${name.replace(/\.edit-\d+$/, "")}.edit-${Date.now().toString(36)}`, JSON.parse(caseJson));
  }
  const s = startRun(target, reviewer);
  if ("error" in s) return s;
  redirect("/runs/live");
}
