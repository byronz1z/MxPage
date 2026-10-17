import assert from "node:assert/strict";
import { test } from "node:test";
import { billingRulesSchema, calculateBilling, defaultBillingRules } from "../lib/monitor/billing";
import { DEFAULT_USD_TO_CNY, formatCostCny } from "../lib/monitor/currency";

test("CNY display converts dollars using the chosen rate, including historical amounts", () => {
  assert.equal(formatCostCny(1.3228, 7), "¥9.2596");
  assert.equal(formatCostCny(1.3228, 7.2), "¥9.5242");
  assert.equal(formatCostCny(.00588, 7, 5), "¥0.04116");
});

test("unknown amounts stay unknown; zero and tiny positive fees stay distinguishable", () => {
  for (const value of [null, undefined, NaN, Infinity, -1]) assert.equal(formatCostCny(value, 7), "—");
  assert.equal(formatCostCny(0, 7), "¥0.0000");
  assert.equal(formatCostCny(.00001, 7), "¥0.000070");
  assert.equal(formatCostCny(.000000001, 7), "<¥0.000001");
  assert.equal(formatCostCny(.00035, 7, 6), "¥0.002450");
});

test("legacy rules gain an estimated exchange rate without losing custom unit prices", () => {
  const { usdToCny, ...legacy } = structuredClone(defaultBillingRules);
  legacy.luna.input = 1.25;
  legacy.image.output = 22;
  const upgraded = billingRulesSchema.parse(legacy);
  assert.equal(upgraded.usdToCny, DEFAULT_USD_TO_CNY);
  assert.equal(upgraded.luna.input, 1.25);
  assert.equal(upgraded.image.output, 22);
});

test("invalid FX rates cannot be saved or displayed as valid amounts", () => {
  for (const usdToCny of [0, -1, NaN, Infinity, null, "7", 1001]) {
    assert.equal(billingRulesSchema.safeParse({ ...defaultBillingRules, usdToCny }).success, false);
  }
  for (const rate of [0, -1, NaN, Infinity]) assert.equal(formatCostCny(1, rate), "—");
});

test("changing the display rate never reprices the source USD billing", () => {
  const input = { model: "gpt-6-luna", category: "chat", success: true, promptTokens: 1000, completionTokens: 500 };
  const original = calculateBilling(input, defaultBillingRules);
  assert.deepEqual(calculateBilling(input, { ...defaultBillingRules, usdToCny: 7.2 }), original);
  assert.equal(formatCostCny(original.costUsd, 7.2, 6), "¥0.002520");
});
