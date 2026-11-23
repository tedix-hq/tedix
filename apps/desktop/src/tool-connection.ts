export type Connection = "signed-in" | "signed-out" | "unknown";

export function toolConnection(
	live: Connection | undefined,
	reported: unknown,
	remembered: boolean,
): Connection {
	// A tool that reports its state must not be masked by an earlier sign-in.
	if (live === "signed-out" || reported === false) return "signed-out";
	if (live !== undefined) return live;
	if (typeof reported === "boolean")
		return reported ? "signed-in" : "signed-out";
	return remembered ? "signed-in" : "unknown";
}
