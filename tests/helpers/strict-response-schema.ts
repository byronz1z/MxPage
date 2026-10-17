import assert from "node:assert/strict";

// Model stubs must also enforce the provider's request contract, rather than
// accepting malformed JSON Schemas and only checking mocked response content.
export function assertStrictResponseSchema(schema: any, path = "root") {
  assert.ok(schema && typeof schema === "object", `${path}: schema object`);
  if (schema.type === "object" || schema.properties) {
    assert.equal(schema.additionalProperties, false, `${path}: closed object`);
    assert.deepEqual([...(schema.required || [])].sort(), Object.keys(schema.properties || {}).sort(), `${path}: every property must be required`);
    for (const [key, value] of Object.entries(schema.properties || {})) assertStrictResponseSchema(value, `${path}.${key}`);
  }
  if (schema.items) assertStrictResponseSchema(schema.items, `${path}[]`);
  for (const keyword of ["anyOf", "allOf", "oneOf"]) for (const [index, value] of (schema[keyword] || []).entries()) assertStrictResponseSchema(value, `${path}.${keyword}[${index}]`);
  for (const keyword of ["$defs", "definitions"]) for (const [key, value] of Object.entries(schema[keyword] || {})) assertStrictResponseSchema(value, `${path}.${keyword}.${key}`);
}
