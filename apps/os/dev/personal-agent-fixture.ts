import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import type { ExternalAgentPrincipal } from "@tedix/api-contract/schemas/external-agent-identity";

export const PERSONAL_AGENT_OWNER = "fictional-morgan";
export const PERSONAL_AGENT_ORG = "11111111-1111-4111-8111-111111111111";
export const PERSONAL_AGENT_PRINCIPALS: ExternalAgentPrincipal[] = [
	"Juniper",
	"Lark",
].map((name, index) => ({
	id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
	organizationId: PERSONAL_AGENT_ORG,
	key: name.toLowerCase(),
	displayName: name,
	status: "active",
	credentialBindingType: "api_key",
	credentialBindingId: `fictional-key-${index}`,
	createdByType: "user",
	createdById: PERSONAL_AGENT_OWNER,
	metadata: {
		personalAgent: {
			version: 1,
			representedUserId: PERSONAL_AGENT_OWNER,
			imageUrl: `https://assets.example.test/${name.toLowerCase()}.svg`,
		},
	},
	createdAt: "2026-10-19T10:00:00.000Z",
	updatedAt: "2026-10-19T10:00:00.000Z",
}));

export const PERSONAL_AGENT_FINDINGS: ActivityFeedItem[] =
	PERSONAL_AGENT_PRINCIPALS.map((principal, index) => ({
		id: `fictional-finding-${index}`,
		actor: principal.displayName,
		actorIdentity: {
			type: index === 0 ? "external_agent" : "system",
			id: index === 0 ? principal.id : `personal-agent:${principal.id}`,
			contributor:
				index === 0
					? undefined
					: {
							id: principal.id,
							displayName: principal.displayName,
							representedUserId: PERSONAL_AGENT_OWNER,
							imageUrl: `https://assets.example.test/lark.svg`,
						},
			source: {
				channel: "Browser form",
				capturedAt: "2026-10-19T10:15:00.000Z",
				evidenceUrl: `https://evidence.example.test/findings/${index}`,
				externalFindingId: `sample-${index}`,
			},
		},
		sentence:
			index === 0
				? "The supplier moved the delivery date to Friday."
				: "The revised quote includes the delivery charge.",
		source: `https://evidence.example.test/findings/${index}`,
		projectId: null,
		tediId: null,
		workItemId: null,
		kind: "signal",
		classId: "personal-agent-finding",
		importance: "normal",
		at: "2026-10-19T10:15:00.000Z",
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: true,
		explanation:
			"A fictional finding for provenance checks; no external message was sent.",
		reactions: ["why"],
	}));
