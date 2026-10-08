import { strict as assert } from "node:assert";
import test from "node:test";
import { globMatches } from "./glob.js";

test("globMatches is anchored and only * is a wildcard", () => {
  assert.equal(globMatches("row.*", "row.12"), true);
  assert.equal(globMatches("row.*", "xrow.12"), false);
  assert.equal(globMatches("slot#*", "slot#12"), true);
  assert.equal(globMatches("slot#*", "xslot#12"), false);
  assert.equal(globMatches("*button", "save_button"), true);
  assert.equal(globMatches("save", "save_button"), false);
  assert.equal(globMatches("a.b", "axb"), false);
  assert.equal(globMatches("a.b", "a.b"), true);
});
