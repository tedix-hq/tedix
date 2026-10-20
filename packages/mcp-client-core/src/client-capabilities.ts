import { type ClientCapabilities } from "@modelcontextprotocol/client";
import { MCP_TASKS_EXTENSION } from "@tedix/mcp-shared/protocol";
import type { McpServerConfig } from "./types";

/**
 * MCP 2026-07-28 modern protocol revision. When an upstream server advertises
 * it via `server/discover`, the stateless client path declares it and emits the
 * request-bound headers (`Mcp-Method`/`Mcp-Name`) + `_meta` the modern transport
 * enforces. Negotiated per server URL; legacy/external servers stay on the
 * untyped path (the binding headers are harmless extras they ignore).
 */
/** beta.5 requires clientCapabilities; Tedix also sends optional clientInfo. */
export const MODERN_CLIENT_INFO = { name: "tedi-mcp-client", version: "2.3.0" };

/** This client drives the Tasks extension round-trip, so it declares it. */
const MODERN_CLIENT_CAPABILITIES: ClientCapabilities = {
	extensions: { [MCP_TASKS_EXTENSION]: {} },
};

/**
 * Per-request capability declaration for the stateless path. The Tasks
 * extension is always declared (this path polls `tasks/get` and runs the sync
 * MRTR retry loop); form-mode elicitation is declared only when the connection
 * actually carries an `onTaskInputRequired` resolver to answer it. A conformant
 * server MUST NOT offer input a caller did not declare, so omitting elicitation
 * here used to silently fail-close the whole agent-to-agent elicitation
 * feature — while declaring it without a resolver would invite requests the
 * client cannot fulfil. Sampling/roots stay undeclared (deprecated, SEP-2577).
 */
export function statelessClientCapabilities(
	config: Pick<McpServerConfig, "onTaskInputRequired">,
): ClientCapabilities {
	return config.onTaskInputRequired
		? { ...MODERN_CLIENT_CAPABILITIES, elicitation: { form: {} } }
		: MODERN_CLIENT_CAPABILITIES;
}
