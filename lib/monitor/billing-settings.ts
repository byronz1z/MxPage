import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { env } from "@/lib/utils/env";
import { billingRulesSchema, defaultBillingRules } from "./billing";

const filename = () => path.resolve(process.cwd(), env.STORAGE_ROOT, "monitor", "billing-rules.json");
export async function getBillingRules() {
  try { return billingRulesSchema.parse(JSON.parse(await fs.readFile(filename(), "utf8"))); }
  catch { return structuredClone(defaultBillingRules); }
}
export async function saveBillingRules(raw: unknown) {
  const rules = billingRulesSchema.parse(raw);
  const file = filename();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const content = JSON.stringify(rules, null, 2);
    await fs.writeFile(temporary, content, "utf8");
    try { await fs.rename(temporary, file); }
    catch (error) {
      // Some Windows hosts allow file writes but deny replacement by rename.
      if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      await fs.writeFile(file, content, "utf8");
    }
  }
  finally { await fs.rm(temporary, { force: true }); }
  return rules;
}
