import type { z } from "zod";
import {
	AppDraftRoomSnapshotSchema,
	AppDraftRoomSubmitResultSchema,
	type AppDraftRoomSubmissionSchema,
} from "@tedix/api-contract/schemas/os-app-runtime";
import type {
	OsAppDraftContent,
	OsCreatedByKind,
} from "@tedix/api-contract/schemas/os-workspaces";
import { appDraftRoomName } from "@tedix/api-contract/utils/app-draft-room";
import { createError, ErrorCodes } from "../rpc/orpc";

export async function requestAppDraftRoom(input: {
	rooms: DurableObjectNamespace | undefined;
	organizationId: string;
	tenantSlug: string;
	workspaceId: string;
	gadgetId: string;
	proposalId: string;
	baseRevisionId: string;
	sequence: number;
	content: OsAppDraftContent;
	actor: { kind: OsCreatedByKind; id: string };
	submission?: z.infer<typeof AppDraftRoomSubmissionSchema>;
}) {
	if ("manifest.json" in input.content.files)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Shared editing is unavailable for an app source file named manifest.json; use the source APIs to preserve it",
		);
	if (!input.rooms)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Shared app editing is unavailable",
		);
	const hash = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`${input.organizationId}:${input.actor.kind}:${input.actor.id}`,
			),
		),
	);
	const actor = {
		key: `p_${[...hash.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
		kind:
			input.actor.kind === "user"
				? "human"
				: input.actor.kind === "tedi"
					? "tedi"
					: "external_agent",
		displayName: input.actor.kind === "user" ? "Builder" : "Agent",
		role: "build",
		verified: true,
	};
	const room = input.rooms.get(input.rooms.idFromName(appDraftRoomName(input)));
	const response = await room.fetch(
		new Request("https://room.internal/__internal/app-draft", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				actor,
				canonical: {
					revision: input.sequence,
					revisionId: input.baseRevisionId,
					files: Object.entries({
						...input.content.files,
						"manifest.json": JSON.stringify(input.content.manifest, null, 2),
					}),
				},
				...(input.submission ? { submission: input.submission } : {}),
			}),
			signal: AbortSignal.timeout(10_000),
		}),
	);
	if (!response.ok)
		throw createError(
			response.status === 409 ? ErrorCodes.CONFLICT : ErrorCodes.BAD_REQUEST,
			"Shared draft changed or the submitted change was refused; read the room again",
		);
	const body = (await response.json()) as {
		snapshot: unknown;
		result?: unknown;
	};
	return {
		snapshot: AppDraftRoomSnapshotSchema.parse(body.snapshot),
		...(body.result === undefined
			? {}
			: { result: AppDraftRoomSubmitResultSchema.parse(body.result) }),
	};
}
