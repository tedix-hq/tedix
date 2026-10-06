import { readFileSync } from "node:fs";

export type HealthMode = "json" | "fixtures" | "worker";

/** HTTP 200 from Vite's HTML fallback is not a Worker health response. */
export function healthResponseError(
	body: string,
	mode: HealthMode,
): string | null {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return "expected health JSON, received non-JSON (possibly a SPA fallback)";
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return "expected a health object";
	}
	const health = value as Record<string, unknown>;
	if (health.status !== "ok") return "health status is not ok";
	if (mode === "fixtures" && health.runtime !== "fixtures") {
		return "expected OS fixtures; check which dev command owns port 3010";
	}
	if (
		mode === "worker" &&
		(health.runtime === "fixtures" || typeof health.deployedSha !== "string")
	) {
		return "expected OS Worker; stop fixtures and start the Worker-backed OS";
	}
	return null;
}

if (import.meta.main) {
	const [file, mode] = process.argv.slice(2);
	if (!file || !["json", "fixtures", "worker"].includes(mode ?? "")) {
		throw new Error(
			"usage: health-response.ts <body-file> <json|fixtures|worker>",
		);
	}
	const error = healthResponseError(
		readFileSync(file, "utf8"),
		mode as HealthMode,
	);
	if (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
