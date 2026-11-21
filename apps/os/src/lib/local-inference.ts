declare const __LOCAL_DEMO_ENABLED__: boolean;
declare const __LOCAL_INFERENCE_ENABLED__: boolean;

export function isLocalSession(): boolean {
	return (
		typeof __LOCAL_DEMO_ENABLED__ !== "undefined" && __LOCAL_DEMO_ENABLED__
	);
}

export const LOCAL_AI_UNAVAILABLE =
	"AI replies are off. You can still use your workspaces and saved content. To enable Workers AI, restart Local Tedix with --inference and your Cloudflare account ID. AI Gateway is optional.";

/** Build mode only: enabling inference does not prove provider connectivity. */
export function isLocalAiUnavailable(): boolean {
	return (
		typeof __LOCAL_DEMO_ENABLED__ !== "undefined" &&
		__LOCAL_DEMO_ENABLED__ &&
		(typeof __LOCAL_INFERENCE_ENABLED__ === "undefined" ||
			!__LOCAL_INFERENCE_ENABLED__)
	);
}

declare const __LOCAL_INFERENCE_BACKEND__: string;
declare const __LOCAL_WORKERS_AI_ROUTE__: string;

export function isLocalWorkersAi(): boolean {
	return (
		typeof __LOCAL_DEMO_ENABLED__ !== "undefined" &&
		__LOCAL_DEMO_ENABLED__ &&
		typeof __LOCAL_INFERENCE_BACKEND__ !== "undefined" &&
		__LOCAL_INFERENCE_BACKEND__ === "workers-ai"
	);
}

export function localWorkersAiRouteLabel(): string | null {
	if (!isLocalWorkersAi() || typeof __LOCAL_WORKERS_AI_ROUTE__ === "undefined")
		return null;
	if (__LOCAL_WORKERS_AI_ROUTE__ === "gateway")
		return "Workers AI via AI Gateway";
	if (__LOCAL_WORKERS_AI_ROUTE__ === "direct") return "Direct Workers AI";
	return null;
}
