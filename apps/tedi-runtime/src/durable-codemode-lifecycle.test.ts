import assert from "node:assert/strict";
import {
	durableCodeCorrelationKey,
	tediMcpConnectorInstructions,
} from "./durable-codemode-lifecycle";

assert.equal(
	durableCodeCorrelationKey("exec_1"),
	"durable-code:correlation:exec_1",
);

const connectorInstructions = tediMcpConnectorInstructions();
assert.match(connectorInstructions, /Object\.keys\(mcp\) is empty/);
assert.match(connectorInstructions, /mcp\.search_tools/);
assert.match(connectorInstructions, /do not call discover\.\*/);
