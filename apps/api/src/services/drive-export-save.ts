import { z } from "zod";
import type {
	SaveExportToDriveInput,
	SaveExportToDriveOutputSchema,
} from "@tedix/api-contract/schemas/connections";
import { OS_OUTPUT_CONTENT_MAX_BYTES } from "@tedix/api-contract/utils/os-output-limits";
import { fetchNamedConnection } from "../rpc/routers/connections/policy-resolution";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";

/** Either scope lets Tedix create a file in the person's Drive. */
const DRIVE_CREATE_SCOPES = [
	"https://www.googleapis.com/auth/drive.file",
	"https://www.googleapis.com/auth/drive",
];

const createdFileSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	webViewLink: z.url().optional(),
});

type Dependencies = {
	resolveToken?: () => Promise<{ accessToken: string; scopes?: string[] }>;
	fetchImpl?: typeof fetch;
};

function exportBytes(content: SaveExportToDriveInput["content"]): Uint8Array {
	const bytes =
		content.encoding === "text"
			? new TextEncoder().encode(content.text)
			: Uint8Array.from(atob(content.data), (char) => char.charCodeAt(0));
	if (bytes.byteLength > OS_OUTPUT_CONTENT_MAX_BYTES)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This file is too large to save to a drive.",
		);
	return bytes;
}

/**
 * The signed-in person's own Google Drive sign-in, never an organization
 * account. The same lookup that serves their personal reads checks that the
 * account is theirs, still the one they connected, and not limited to chosen
 * files or folders.
 */
async function ownDriveToken(
	context: BaseContext,
	connectionInstanceId: string,
) {
	if (context.authType !== "user" || context.tediId || !context.user?.sub)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only a signed-in person can save to their own drive.",
		);
	const token = await fetchNamedConnection(
		context,
		{ userId: context.user.sub },
		"google-drive",
		connectionInstanceId,
	);
	if (!token?.accessToken)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Connect your Google Drive account in Settings → Connections first.",
		);
	return token;
}

/** Save one exported file to the top folder of the person's own Google Drive. */
export async function saveExportToGoogleDrive(
	context: BaseContext,
	input: SaveExportToDriveInput,
	deps: Dependencies = {},
): Promise<z.infer<typeof SaveExportToDriveOutputSchema>> {
	const bytes = exportBytes(input.content);
	const token = deps.resolveToken
		? await deps.resolveToken()
		: await ownDriveToken(context, input.connectionInstanceId);
	if (!token.scopes?.some((scope) => DRIVE_CREATE_SCOPES.includes(scope)))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Your Google Drive connection can only read files. Reconnect it and allow Tedix to create files.",
		);
	const boundary = `tedix-${crypto.randomUUID()}`;
	const body = new Blob([
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
		JSON.stringify({ name: input.fileName, mimeType: input.mimeType }),
		`\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
		bytes,
		`\r\n--${boundary}--`,
	]);
	const response = await (deps.fetchImpl ?? fetch)(
		"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token.accessToken}`,
				"Content-Type": `multipart/related; boundary=${boundary}`,
			},
			body,
			signal: AbortSignal.timeout(30_000),
			redirect: "manual",
		},
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw createError(
			response.status === 401 || response.status === 403
				? ErrorCodes.FORBIDDEN
				: ErrorCodes.BAD_GATEWAY,
			`Google Drive did not save the file (HTTP ${response.status}).`,
		);
	}
	const created = createdFileSchema.safeParse(await response.json());
	if (!created.success)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Google Drive saved the file but did not say where.",
		);
	return {
		fileId: created.data.id,
		name: created.data.name,
		url:
			created.data.webViewLink ??
			`https://drive.google.com/file/d/${encodeURIComponent(created.data.id)}/view`,
	};
}
