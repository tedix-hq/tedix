import assert from "node:assert/strict";
import { validateRuntimeStateChange } from "./runtime-state-validation";

validateRuntimeStateChange({}, "server");

assert.throws(
	() => validateRuntimeStateChange({}, "client" as never),
	/State update rejected: client-originated state mutation is not permitted on a tedi runtime/,
);
