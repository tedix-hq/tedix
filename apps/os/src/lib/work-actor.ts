import type { WorkActorReference } from "@tedix/api-contract/schemas/os-work-actor";

export interface ActorProfile {
	name: string;
	image?: string | null;
	for?: ActorProfile;
}
export type ActorDirectory = ReadonlyMap<string, ActorProfile>;

export function sessionHarness(harness: unknown, sessionKey?: string | null) {
	if (typeof harness === "string" && harness) return harness;
	// Historical attempts retain the server-stamped <harness>:<session> key.
	return sessionKey?.split(":")[0] ?? null;
}
export function workActorReference(
	type: string,
	id: string | null | undefined,
	metadata: Record<string, unknown> | null = {},
	sessionKey?: string | null,
): WorkActorReference {
	return {
		type,
		id,
		harness: sessionHarness(
			metadata?.agentHarness ?? metadata?.host,
			sessionKey ??
				(typeof metadata?.agentSession === "string"
					? metadata.agentSession
					: null),
		),
	};
}
export function resolveWorkActor(
	ref: WorkActorReference | undefined,
	fallback: string,
	directory: ActorDirectory,
) {
	const profile = ref?.id ? directory.get(`${ref.type}:${ref.id}`) : undefined;
	const harness: "codex" | "claude-code" | undefined =
		ref?.harness === "codex" || ref?.harness === "claude-code"
			? ref.harness
			: undefined;
	const name =
		harness === "codex"
			? "Codex"
			: harness === "claude-code"
				? "Claude Code"
				: (profile?.name ??
					(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\s|$)/i.test(
						fallback,
					)
						? "Agent"
						: fallback));
	const represented = harness
		? ref?.type === "user" || ref?.type === "tedi"
			? profile
			: profile?.for
		: undefined;
	return {
		name,
		harness,
		image: harness ? undefined : profile?.image,
		represented,
		label: represented ? `${name} for ${represented.name}` : name,
	};
}
