import test from "node:test";
import assert from "node:assert/strict";
import { reflectBoolean, reflectNumber, reflectString } from "./reflect-readers.js";

test("scalar returns arrive as bare primitives", () => {
  assert.equal(reflectNumber({ returned: 3 }), 3);
  assert.equal(reflectBoolean({ returned: false }), false);
  assert.equal(reflectString({ returned: "Alpha" }), "Alpha");
});

test("an enum arrives as its bare case name", () => {
  assert.equal(reflectString({ returned: "SOUTH" }), "SOUTH");
});

test("an opaque object exposes its `$string`", () => {
  const result = { returned: { $class: "net.minecraft.server.level.ServerLevel", $string: "ServerLevel[flat]" } };
  assert.equal(reflectString(result), "ServerLevel[flat]");
});

test("a path walks nested `$fields`", () => {
  const result = {
    returned: {
      $class: "CarriageContraptionEntity",
      $fields: {
        contraption: {
          $class: "CarriageContraption",
          $fields: { blockConductors: true, stalled: false },
        },
      },
    },
  };
  assert.equal(reflectBoolean(result, "contraption.blockConductors"), true);
  assert.equal(reflectBoolean(result, "contraption.stalled"), false);
  assert.throws(() => reflectBoolean(result, "contraption.missing"), /at contraption\.missing/);
});

test("a missing path throws instead of yielding undefined", () => {
  const result = { returned: { $fields: { a: { $fields: { b: 1 } } } } };
  assert.throws(() => reflectNumber(result, "a.nope"), /does not hold a number at a\.nope/);
  assert.throws(() => reflectNumber(result, "totally.absent"), /does not hold a number/);
});

test("a type mismatch throws and reports what was actually there", () => {
  assert.throws(() => reflectNumber({ returned: "not a number" }), /does not hold a number/);
  assert.throws(() => reflectBoolean({ returned: 1 }), /does not hold a boolean/);
  assert.throws(() => reflectString({ returned: { $fields: { a: 1 } } }), /does not hold a string/);
});

test("NaN is rejected as a number", () => {
  assert.throws(() => reflectNumber({ returned: Number.NaN }), /does not hold a number/);
});
