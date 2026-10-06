declare const __LOCAL_DEMO_ENABLED__: boolean;
declare const __LOCAL_INFERENCE_ENABLED__: boolean;

export function isLocalSession(): boolean {
	return (
		typeof __LOCAL_DEMO_ENABLED__ !== "undefined" && __LOCAL_DEMO_ENABLED__
	);
}

export const LOCAL_AI_UNAVAILABLE =
	"AI replies are off in this local session. You can explore workspaces and saved content, or enable paid inference with your Cloudflare account.";

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

export function isLocalWorkersAi(): boolean {
	return (
		typeof __LOCAL_DEMO_ENABLED__ !== "undefined" &&
		__LOCAL_DEMO_ENABLED__ &&
		typeof __LOCAL_INFERENCE_BACKEND__ !== "undefined" &&
		__LOCAL_INFERENCE_BACKEND__ === "workers-ai"
	);
}
