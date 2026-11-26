import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { resolveStoredLoginAuth } from "./auth-resolve";
import { resolveCodeResult } from "./code-result";
import { fileDiscoveryCache } from "./discovery-cache";
import { TedixHomeClient } from "./home-client";
import { tediSlugSchema } from "./lane-routing";
import { machineWriteUnavailable } from "./lane-machine-tools";
import { machineWorkspaceFolder } from "./lane-machine-workspaces";
import { parseOptions } from "./options";
import { resolveOrganizationTarget } from "./organization-target";

const TURN_DEADLINE_MS = 60 * 60_000;
/** Tries per gateway call: pauses of 5, 10, 15 and 20 seconds between them. */
const CALL_ATTEMPTS = 5;

export async function runTediLaneTurn(scope: string[], args: string[]) {
	const fields = ["--tedi", "--session", "--workspace", "--machine"];
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const field = args[i]!;
		const value = args[i + 1];
		if (!fields.includes(field) || !value?.trim() || values.has(field))
			throw new Error(`Invalid tedi-turn option ${field}`);
		values.set(field, value);
	}
	if (values.size !== fields.length)
		throw new Error(
			"tedi-turn needs --tedi, --session, --workspace and --machine",
		);
	const slug = tediSlugSchema.parse(values.get("--tedi"));
	const sessionKey = values.get("--session")!;
	const text = [
		`Use only machine workspace ${JSON.stringify(values.get("--workspace"))} on machine ${JSON.stringify(values.get("--machine"))} for local work.`,
		"Use your own machine tools and pass the workspace ID on every file or command call. Do not open or close workspaces or use Code Mode for machine calls. Commit as the brief says.",
		"Keep your final reply under 1,500 characters and end it with the result line the brief asks for.",
		"",
		readFileSync(0, "utf8"),
	].join("\n");
	const { options } = parseOptions([...scope, "code"]);
	const { workspace, organization } = options;
	if (!workspace || !organization)
		throw new Error(
			"tedi-turn needs a workspace and one explicitly selected organization",
		);
	// A turn is not sent until the workspace it names answers: the machine
	// tools must be serving and the adopted checkout must still resolve.
	const configDir = process.env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
	const unserved = machineWriteUnavailable(process.env, {
		workspace,
		organization,
	});
	if (unserved)
		throw new Error(`The machine workspace is not serving: ${unserved}`);
	await machineWorkspaceFolder(configDir, values.get("--workspace")!);
	const { auth, loginError } = await resolveStoredLoginAuth(workspace, {
		consentPrompt: false,
	});
	if (!auth)
		throw new Error(loginError ?? "tedi-turn needs a stored workspace login");
	const url = options.urlExplicit ? options.url : (auth.mcpUrl ?? options.url);
	const target = resolveOrganizationTarget({
		url,
		command: "code",
		workspace,
		organization,
	});
	const client = new TedixHomeClient({
		url,
		headers: { ...auth.headers, ...target.headers },
		oauthProvider: auth.oauthProvider,
		discoveryCache: fileDiscoveryCache(),
		timeoutMs: 30_000,
	});
	const signal = AbortSignal.timeout(TURN_DEADLINE_MS);
	const namespace = slug.replaceAll("-", "_");
	const code = (source: string) =>
		client.callTool("code", { code: source }, { signal });
	const run = async (method: string, source: string) => {
		try {
			const result = await resolveCodeResult(code, await code(source));
			if (result.failures?.length || result.truncated)
				throw new Error(
					result.failures?.[0]?.error ?? "Incomplete gateway response",
				);
			return result.value;
		} catch (cause) {
			throw new Error(
				`${slug}.${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}
	};
	/**
	 * A turn lasts minutes, so one refused gateway call must not fail the task:
	 * a call is tried again a few times with a growing pause. Sending a turn is
	 * safe to repeat because it carries the same client request id.
	 */
	const patient = async <T>(call: () => Promise<T>): Promise<T> => {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await call();
			} catch (error) {
				if (attempt >= CALL_ATTEMPTS || signal.aborted) throw error;
				await sleep(attempt * 5_000, undefined, { signal });
			}
		}
	};
	/**
	 * The newest message of the conversation. One gateway answer carries about
	 * 3,000 tokens and cannot be narrowed, so the whole conversation, which
	 * holds the brief, does not fit: only the last message is read. An answer
	 * that still does not fit is the brief itself (no reply yet) or a reply
	 * longer than the tedi was asked to write.
	 */
	const latest = async () => {
		const value = await run(
			"messages_read",
			`async () => { const r = await ${namespace}.messages_read(${codeModeLiteral({ session_key: sessionKey, limit: 1 })}); if (r && r.__tedix_truncated) return /"messages":\\[\\{"role":"assistant"/.test(String(r.preview)) ? "long-reply" : null; const m = r && Array.isArray(r.messages) ? r.messages.at(-1) : undefined; return m ? { role: m.role, status: m.status, error: m.error, text: m.text, ts: m.ts } : null; }`,
		);
		return value;
	};
	let runId: string | undefined;
	try {
		// A follow-up turn must not take the previous turn's reply for its own.
		const earlier = await patient(latest);
		const before = isRecord(earlier) ? earlier.ts : undefined;
		const clientRequestId = randomUUID();
		const accepted = await patient(() =>
			run(
				"run_tedi_turn",
				`async () => await ${namespace}.run_tedi_turn(${codeModeLiteral({
					session_key: sessionKey,
					client_request_id: clientRequestId,
					text,
				})})`,
			),
		);
		if (
			!isRecord(accepted) ||
			accepted.accepted !== true ||
			typeof accepted.run_id !== "string" ||
			!accepted.run_id
		)
			throw new Error(
				`Tedi ${slug} did not accept the turn: ${isRecord(accepted) ? String(accepted.error ?? accepted.reason ?? "missing run receipt") : "missing run receipt"}`,
			);
		runId = accepted.run_id;
		for (let delay = 3_000; ; delay = Math.min(delay * 1.5, 10_000)) {
			await sleep(delay, undefined, { signal });
			const reply = await patient(latest);
			if (reply === "long-reply")
				throw new Error(
					`Tedi ${slug} turn ${runId} ended with a reply too long to read back`,
				);
			if (
				!isRecord(reply) ||
				reply.role !== "assistant" ||
				reply.ts === before ||
				reply.status === "pending" ||
				reply.status === "streaming"
			)
				continue;
			if (
				(reply.status !== undefined && reply.status !== "completed") ||
				typeof reply.text !== "string"
			)
				throw new Error(
					`Tedi ${slug} turn ${runId} ended with ${reply.status ?? "no status"}: ${reply.error ?? reply.text ?? "no reply"}`,
				);
			process.stdout.write(reply.text);
			return 0;
		}
	} catch (error) {
		if (signal.aborted)
			throw new Error(
				`Timed out waiting for tedi ${slug}${runId ? ` turn ${runId}` : ""}`,
			);
		throw error;
	} finally {
		await client.close().catch(() => {});
	}
}
