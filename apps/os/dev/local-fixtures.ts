/**
 * Zero-account local API lane: deterministic fixtures + per-procedure handlers
 * for every oRPC procedure the Tedix OS SPA calls.
 *
 * `handleLocalRpc` is pure with respect to its module (no Vite/node imports)
 * so it is unit-testable; write-shaped procedures mutate an in-memory store
 * that `resetLocalFixtures()` restores. The wire envelope mirrors the oRPC v2
 * RPC serializer the SPA client uses: success bodies are `{"json": <output>}`,
 * error bodies are `{"json": {defined, inferable, code, message, data?}}` on a
 * >=400 status, and input envelopes may carry a `meta` array whose
 * `"undefined"` entries must be re-applied (the client serializes explicit
 * `undefined` property values as `null` + meta marker).
 */

import { resetAttentionFixtures } from "./attention-fixtures";
import { osShareTitleSlug } from "@tedix/api-contract/utils/share-slug";
import { applyDemoPack, demoPackIsStale } from "./demo-pack";
import { demoSendingBlock } from "@tedix/api-contract/utils/demo-sending-gate";
import {
	documentContent,
	sheetContent,
	deckContent,
} from "./local-output-content";
import {
	API_KEYS,
	localSuspendedAgentSeats,
	ORG_MEMBERSHIP,
	setLocalApiKeys,
} from "./local-fixtures/apps";
import { MCP_PAYMENT_RECEIPT } from "./local-fixtures/billing";
import {
	APP_STOREFRONT,
	BLUEPRINT_DRAFT,
	BLUEPRINT_PUBLISHED,
	BLUEPRINT_SUPPORT,
	CHILD_RUN_DELEGATING,
	COLLAB_PROPOSAL_ACCEPTED,
	COLLAB_PROPOSAL_OPEN,
	CONVERSATION_DELEGATION,
	CONVERSATION_HOME,
	fid,
	GADGET_DASHBOARD,
	HOME_RUN_DELEGATING,
	HOME_RUN_DONE,
	ORG_ID,
	OUTPUT_DECK,
	OUTPUT_DOCUMENT,
	OUTPUT_SHEET,
	RPC_ERROR_STATUS,
	RpcError,
	RUN_CHURN_FAILED,
	RUN_REVENUE_OK,
	setSeq,
	SKILL_CHURN,
	SKILL_REVENUE,
	T0,
	TEDI_MILES,
	TEDI_NOVA,
	WORKSPACE_REVENUE,
	WORKSPACE_SUPPORT,
} from "./local-fixtures/core";
import { latestRevision, localGalleryPage } from "./local-fixtures/lookups";
import { MEMORY_HEALTH } from "./local-fixtures/memory";
import { localSnoozes } from "./local-fixtures/office";
import {
	setLocalPolicyRows,
	setLocalProfileRows,
} from "./local-fixtures/policies";
import {
	delegationConversation,
	delegationRuns,
	seedState,
} from "./local-fixtures/seed-state";
import {
	localCollaboratorLinks,
	localCollaborators,
	localShareLinks,
	setLocalCustomDomain,
} from "./local-fixtures/sharing";
import {
	installWorkViewFixtures,
	localConnectionConsumerGrants,
	localConnectionResourceLimits,
	localConnectTickets,
	runSteeringMessages,
	setState,
	state,
} from "./local-fixtures/state";
import {
	KNOWLEDGE,
	localSkillReactivations,
	RATIONALES,
	seedSkillDrafts,
	setLocalSkillDrafts,
	SKILLS,
	TEDIS,
} from "./local-fixtures/tedis";
import { PROJECTS } from "./local-fixtures/work";
import { appHandlers } from "./local-fixtures/apps-handlers";
import { billingHandlers } from "./local-fixtures/billing-handlers";
import { blueprintHandlers } from "./local-fixtures/blueprints-handlers";
import { gadgetHandlers } from "./local-fixtures/gadgets-handlers";
import { organizationHandlers } from "./local-fixtures/organization-handlers";
import { outputHandlers } from "./local-fixtures/outputs-handlers";
import { runtimeHandlers } from "./local-fixtures/runtime-handlers";
import { sharingHandlers } from "./local-fixtures/sharing-handlers";
import { skillHandlers } from "./local-fixtures/skills-handlers";
import {
	workHandlers,
	localExternalAgentPrincipal,
} from "./local-fixtures/work-handlers";
import { workspaceHandlers } from "./local-fixtures/workspaces-handlers";

/** Every procedure the lane serves, assembled from the per-domain handler modules. */
const handlers: Record<string, (input: never) => unknown> = {
	...outputHandlers,
	...blueprintHandlers,
	...gadgetHandlers,
	...workspaceHandlers,
	...sharingHandlers,
	...workHandlers,
	...skillHandlers,
	...runtimeHandlers,
	...appHandlers,
	...organizationHandlers,
	...billingHandlers,
};

/** Set once by the dev server: the sample company replaces the classic fixtures. */
let demoPackBuiltAt: number | null = null;

export function resetLocalFixtures(): void {
	localExternalAgentPrincipal.metadata = {};
	localSkillReactivations.clear();
	setLocalSkillDrafts(seedSkillDrafts());
	localSnoozes.clear();
	runSteeringMessages.clear();
	localConnectTickets.clear();
	localConnectionConsumerGrants.clear();
	localConnectionResourceLimits.clear();
	setLocalPolicyRows([]);
	setLocalProfileRows([]);
	resetAttentionFixtures();
	setState(seedState());
	setSeq(0);
	localCollaborators.clear();
	localCollaboratorLinks.clear();
	localShareLinks.clear();
	setLocalCustomDomain(null);
	setLocalApiKeys([...API_KEYS]);
	localSuspendedAgentSeats.clear();
	if (demoPackBuiltAt !== null) demoPackBuiltAt = installDemoPack();
	else installWorkViewFixtures();
}

/** Serve the sample company (Feed, Deck, tedis, memory) with sending switched off. */
export function enableDemoPack(): void {
	demoPackBuiltAt = installDemoPack();
}

export const isDemoPackEnabled = (): boolean => demoPackBuiltAt !== null;

export const LOCAL_RPC_PROCEDURES: readonly string[] = Object.keys(handlers);

function installDemoPack(): number {
	const { builtAt } = applyDemoPack({
		state: state as unknown as Record<string, unknown>,
		handlers,
		tedis: TEDIS,
		skills: SKILLS,
		knowledge: KNOWLEDGE,
		projects: PROJECTS,
		orgMembership: ORG_MEMBERSHIP,
		rationales: RATIONALES,
		memoryHealth: MEMORY_HEALTH,
	} as unknown as Parameters<typeof applyDemoPack>[0]);
	state.homeRuns.push(...delegationRuns());
	state.conversations.push(delegationConversation());
	// The seeded draft improves the classic revenue skill, which the sample company replaces.
	setLocalSkillDrafts([]);
	installWorkViewFixtures();
	return builtAt;
}

/** Fixture ids the unit tests (and curl probes) address directly. */
export const LOCAL_FIXTURE_IDS = {
	orgId: ORG_ID,
	tediMiles: TEDI_MILES,
	tediNova: TEDI_NOVA,
	workspaceRevenue: WORKSPACE_REVENUE,
	workspaceSupport: WORKSPACE_SUPPORT,
	gadgetDashboard: GADGET_DASHBOARD,
	outputDocument: OUTPUT_DOCUMENT,
	outputSheet: OUTPUT_SHEET,
	outputDeck: OUTPUT_DECK,
	collaborationProposalOpen: COLLAB_PROPOSAL_OPEN,
	collaborationProposalAccepted: COLLAB_PROPOSAL_ACCEPTED,
	blueprintPublished: BLUEPRINT_PUBLISHED,
	blueprintDraft: BLUEPRINT_DRAFT,
	blueprintSupport: BLUEPRINT_SUPPORT,
	conversationHome: CONVERSATION_HOME,
	conversationDelegation: CONVERSATION_DELEGATION,
	homeRunDone: HOME_RUN_DONE,
	homeRunDelegating: HOME_RUN_DELEGATING,
	childRunDelegating: CHILD_RUN_DELEGATING,
	skillRunCompleted: RUN_REVENUE_OK,
	skillRevenue: SKILL_REVENUE,
	skillChurn: SKILL_CHURN,
	skillRunFailed: RUN_CHURN_FAILED,
	appStorefront: APP_STOREFRONT,
	approvalPending: fid("71", 1),
	/** The "CI/CD Pipeline" API key, addressable on /admin/api-keys. */
	apiKeyCicd: fid("96", 1),
	/** The one settled MCP payment event, addressable as a receipt. */
	paymentReceipt: MCP_PAYMENT_RECEIPT,
	documentContent,
	sheetContent,
	deckContent,
} as const;

// ---------------------------------------------------------------------------
// Wire envelope
// ---------------------------------------------------------------------------

type RpcMetaEntry = [string, ...(string | number)[]];

/**
 * Re-apply the client serializer's meta markers to the raw json payload. Only
 * the built-in types our SPA can emit matter here; `"undefined"` is the
 * load-bearing one (optional fields sent as explicit `undefined` arrive as
 * `null` + marker and must not fail `.optional()` input schemas).
 */
function decodeRpcInput(body: unknown): unknown {
	if (body === undefined || body === null) return undefined;
	const envelope = body as { json?: unknown; meta?: RpcMetaEntry[] };
	const ref: { data: unknown } = { data: envelope.json };
	for (const entry of envelope.meta ?? []) {
		const type = entry[0];
		let parent: unknown = ref;
		let key: string | number = "data";
		for (let index = 1; index < entry.length; index++) {
			parent = (parent as Record<string | number, unknown>)[key];
			const segment = entry[index];
			if (
				segment === undefined ||
				parent === null ||
				typeof parent !== "object"
			) {
				parent = undefined;
				break;
			}
			key = segment;
		}
		if (parent === undefined || parent === null || typeof parent !== "object")
			continue;
		const holder = parent as Record<string | number, unknown>;
		if (type === "undefined") holder[key] = undefined;
		else if (type === "date") holder[key] = new Date(String(holder[key]));
		else if (type === "bigint") holder[key] = BigInt(String(holder[key]));
	}
	return ref.data;
}

const errorEnvelope = (error: RpcError): { status: number; body: unknown } => ({
	status: RPC_ERROR_STATUS[error.code],
	body: {
		json: {
			defined: true,
			inferable: true,
			code: error.code,
			message: error.message,
			...(error.data !== undefined ? { data: error.data } : {}),
		},
	},
});

/**
 * Route one oRPC request. `path` is the request path (query string tolerated),
 * `body` the parsed JSON envelope (`{"json": ..., "meta": [...]}`) or
 * undefined for body-less calls. Returns null for paths this lane does not
 * handle so the middleware can 404 loudly instead of hanging.
 */
/**
 * The signed-out blueprint landing read (`GET /api/public/blueprints/:id`):
 * the gallery page minus the publisher's name, or the same 404 for anything
 * outside the catalog.
 */
export function handleLocalPublicBlueprint(blueprintId: string): {
	status: number;
	body: unknown;
} {
	try {
		const { organizationName: _publisher, ...blueprint } =
			localGalleryPage(blueprintId);
		return { status: 200, body: { blueprint } };
	} catch {
		return { status: 404, body: { error: "Not found" } };
	}
}

export function handleLocalRpc(
	path: string,
	method: string,
	body: unknown,
): { status: number; body: unknown } | null {
	const cleanPath = path.split("?")[0] ?? path;
	const match = cleanPath.match(/^\/api\/rpc\/(.+)$/);
	if (!match?.[1]) return null;
	const key = match[1].split("/").map(decodeURIComponent).join("/");
	// A sample company older than a week is rebuilt so it still reads as today.
	if (demoPackBuiltAt !== null && demoPackIsStale(demoPackBuiltAt, Date.now()))
		resetLocalFixtures();
	// Sending and scheduling are refused before any handler, covered or not.
	if (demoPackBuiltAt !== null) {
		const block = demoSendingBlock(key, decodeRpcInput(body));
		if (block) return errorEnvelope(new RpcError("FORBIDDEN", block.message));
	}
	const handler = handlers[key];
	if (!handler) return null;
	if (method !== "POST" && method !== "GET") {
		return errorEnvelope(
			new RpcError("BAD_REQUEST", `Unsupported method ${method}`),
		);
	}
	const input = decodeRpcInput(body);
	try {
		return {
			status: 200,
			body: { json: (handler as (value: unknown) => unknown)(input) },
		};
	} catch (error) {
		if (error instanceof RpcError) return errorEnvelope(error);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Share-link guests on a runtime app (`/api/os-shared/*`). The fixture lane
// has no share links of its own: any well-formed link token opens the first
// runtime app of the sample company for a guest, and the guest's verdicts are
// kept here the way the app host's storage would.
// ---------------------------------------------------------------------------
const GUEST_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;
/** The permanent `/s/<id>` address of the fixture's one shared app. */
export const LOCAL_GUEST_SHARE_PUBLIC_ID = "PricePilotOpportunity1";
/**
 * The "Anyone with the link" address of that app's workspace: its files and
 * apps, read-only. One fictional file is counted as left out, the way a file
 * holding connected-account data would be.
 */
export const LOCAL_GUEST_WORKSPACE_PUBLIC_ID = "PricePilotWorkspace001";
/** Each guest session, and whether it came from the app or the workspace link. */
const guestSessions = new Map<string, "gadget" | "workspace">();
const guestVerdicts: Record<string, { value: string; at: number }> = {};

function localGuestApp() {
	const gadget = state.gadgets.find((row) => {
		const revision = state.gadgetRevisions.find(
			(candidate) => candidate.id === row.currentRevisionId,
		);
		return revision?.manifest.entry === "tedix:runtime/v1";
	});
	const revision = gadget
		? state.gadgetRevisions.find((row) => row.id === gadget.currentRevisionId)
		: undefined;
	const files = revision ? state.gadgetCode[revision.id] : undefined;
	if (!gadget || !revision || !files) return null;
	return { gadget, revision, files };
}

function guestSheet(slot: string) {
	const app = localGuestApp();
	const grant = app?.revision.manifest.resourceGrants?.find(
		(row) => row.slot === slot && row.operations.includes("outputs.read"),
	);
	const resource = state.workspaceResources.find(
		(row) =>
			row.slot === slot &&
			row.workspaceId === app?.gadget.workspaceId &&
			row.resourceType === "output",
	);
	if (!app || !grant || !resource) return null;
	const output = state.outputs.find(
		(row) => row.id === resource.providerResourceId,
	);
	const revision = output
		? latestRevision(
				state.outputRevisions.filter((row) => row.outputId === output.id),
			)
		: null;
	if (!output || !revision) return null;
	return {
		output: { id: output.id, title: output.title, kind: output.kind },
		revision: {
			id: revision.id,
			revision: revision.revision,
			content: revision.content,
		},
	};
}

/** Answer one guest share call; null for a path this lane does not serve. */
export function handleLocalGuestShare(
	path: string,
	body: unknown,
): { status: number; body: unknown } | null {
	const refused = { status: 404, body: "Share link not found" };
	const field = (name: string) =>
		typeof body === "object" && body !== null && name in body
			? (body as Record<string, unknown>)[name]
			: undefined;
	const sessionOf = () => {
		const token = field("sessionToken");
		return typeof token === "string" && guestSessions.has(token) ? token : null;
	};
	const sessionKind = () => {
		const token = sessionOf();
		return token ? guestSessions.get(token) : undefined;
	};
	// A workspace link names the app it opens; an app link names none.
	const appAllowed = () => {
		const appId = field("appId");
		return sessionKind() === "workspace"
			? appId === app?.gadget.id
			: appId === undefined;
	};
	const app = localGuestApp();
	const share = {
		organization: { name: "PricePilot", logoUrl: null },
		// A guest opens the app signed out; only a signed-in author or admin of
		// the organization gets the Share button on this page.
		canManage: false,
		share: {
			id: "00000039-0000-4000-8000-000000000001",
			publicId: LOCAL_GUEST_SHARE_PUBLIC_ID,
			access: "anyone_with_link",
			resourceType: "gadget",
			role: "use",
			effectiveRole: "use",
			revisionMode: "living",
			note: null,
			expiresAt: null,
			createdAt: T0,
			sharedByName: "Maya Chen",
			slug: app ? osShareTitleSlug(app.gadget.name) : "",
			policyReason: null,
		},
		resource: app
			? {
					type: "gadget",
					gadget: {
						id: app.gadget.id,
						workspaceId: app.gadget.workspaceId,
						name: app.gadget.name,
						description: app.gadget.description,
					},
					revision: {
						id: app.revision.id,
						revision: app.revision.revision,
						manifest: { entry: app.revision.manifest.entry },
					},
					openPath: null,
				}
			: null,
	};
	const startSession = (
		seed: string,
		kind: "gadget" | "workspace" = "gadget",
	) => {
		const sessionToken = `guest-${seed.slice(0, 16)}-${guestSessions.size + 1}`;
		guestSessions.set(sessionToken, kind);
		return sessionToken;
	};
	const workspace = app
		? state.workspaces.find((row) => row.id === app.gadget.workspaceId)
		: undefined;
	const workspaceFiles = workspace
		? state.outputs.filter(
				(row) => row.workspaceId === workspace.id && row.status === "active",
			)
		: [];
	const workspaceShare = workspace
		? {
				...share,
				share: {
					...share.share,
					id: "00000039-0000-4000-8000-000000000002",
					publicId: LOCAL_GUEST_WORKSPACE_PUBLIC_ID,
					resourceType: "workspace",
					slug: osShareTitleSlug(workspace.name),
				},
				resource: {
					type: "workspace",
					workspace: {
						id: workspace.id,
						name: workspace.name,
						description: workspace.description,
					},
					gadgets: state.gadgets
						.filter(
							(row) =>
								row.workspaceId === workspace.id && row.status === "active",
						)
						.map((row) => ({
							id: row.id,
							name: row.name,
							description: row.description,
							revision:
								row.id === app?.gadget.id
									? {
											id: app.revision.id,
											revision: app.revision.revision,
											manifest: { entry: app.revision.manifest.entry },
										}
									: null,
							opensWithoutSignIn: row.id === app?.gadget.id,
						})),
					files: workspaceFiles.map((row) => ({
						id: row.id,
						title: row.title,
						kind: row.kind,
						updatedAt: row.updatedAt,
					})),
					hiddenFileCount: 1,
					openPath: null,
				},
			}
		: null;
	switch (path) {
		case "/api/os-shared/open": {
			// A permanent link open to anyone: the fixture's one shared app, or
			// its workspace.
			const id = field("id");
			if (id === LOCAL_GUEST_WORKSPACE_PUBLIC_ID && workspaceShare)
				return {
					status: 200,
					body: {
						...workspaceShare,
						needsSignIn: false,
						access: "anyone_with_link",
						sessionToken: startSession(id, "workspace"),
					},
				};
			if (!app || id !== LOCAL_GUEST_SHARE_PUBLIC_ID) return refused;
			return {
				status: 200,
				body: {
					...share,
					needsSignIn: false,
					access: "anyone_with_link",
					sessionToken: startSession(id),
				},
			};
		}
		case "/api/os-shared/redeem": {
			const token = field("token");
			if (!app || typeof token !== "string" || !GUEST_TOKEN_SHAPE.test(token))
				return refused;
			return {
				status: 200,
				body: { ...share, sessionToken: startSession(token) },
			};
		}
		case "/api/os-shared/session":
			if (sessionKind() === "workspace" && workspaceShare)
				return { status: 200, body: workspaceShare };
			return app && sessionOf() ? { status: 200, body: share } : refused;
		case "/api/os-shared/output": {
			const output = workspaceFiles.find((row) => row.id === field("outputId"));
			const revision = output
				? latestRevision(
						state.outputRevisions.filter((row) => row.outputId === output.id),
					)
				: null;
			if (sessionKind() !== "workspace" || !output || !revision) return refused;
			return {
				status: 200,
				body: {
					output: { id: output.id, title: output.title, kind: output.kind },
					revision: {
						id: revision.id,
						revision: revision.revision,
						content: revision.content,
					},
				},
			};
		}
		case "/api/os-shared/app/open": {
			if (!app || !sessionOf() || !appAllowed()) return refused;
			const config = app.revision.manifest.config ?? {};
			return {
				status: 200,
				body: {
					session: `fixture-guest:${app.gadget.id}:${app.revision.id}`,
					expiresAt: Math.floor(Date.now() / 1000) + 300,
					role: "use",
					revisionId: app.revision.id,
					app: {
						id: app.gadget.id,
						name: app.gadget.name,
						description: app.gadget.description,
						workspaceId: app.gadget.workspaceId,
						revision: app.revision.revision,
						client: app.files["client.js"] ?? "",
						workspaceName: workspace?.name,
						recordsGuestInput:
							"recordsGuestInput" in config &&
							config.recordsGuestInput === true,
						settings:
							"settings" in config && typeof config.settings === "object"
								? config.settings
								: {},
						grants: app.revision.manifest.resourceGrants ?? [],
					},
				},
			};
		}
		case "/api/os-shared/app/call": {
			if (!app || !sessionOf() || !appAllowed()) return refused;
			const method = field("method");
			const args = Array.isArray(field("args"))
				? (field("args") as unknown[])
				: [];
			if (method === "verdicts")
				return { status: 200, body: { result: guestVerdicts } };
			if (method === "recordVerdict") {
				const number = String(args[0]);
				const value = String(args[1]);
				if (value !== "yes" && value !== "no") return refused;
				guestVerdicts[number] = { value, at: Date.now() };
				// A guest's role can only read the sheet: the verdict stays with the app.
				return {
					status: 200,
					body: { result: { number, value, storedIn: "app" } },
				};
			}
			return refused;
		}
		case "/api/os-shared/app/read": {
			const slot = field("slot");
			if (!app || !sessionOf() || !appAllowed() || typeof slot !== "string")
				return refused;
			const read = guestSheet(slot);
			return read ? { status: 200, body: read } : refused;
		}
		default:
			return null;
	}
}
