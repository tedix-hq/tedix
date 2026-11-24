import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { resolveStoredLoginAuth } from "./auth-resolve";
import { resolveCodeResult } from "./code-result";
import { fileDiscoveryCache } from "./discovery-cache";
import { TedixHomeClient } from "./home-client";
import { tediSlugSchema } from "./lane-routing";
import { parseOptions } from "./options";
import { resolveOrganizationTarget } from "./organization-target";

const TURN_DEADLINE_MS = 60 * 60_000;

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
		"",
		readFileSync(0, "utf8"),
	].join("\n");
	const { options } = parseOptions([...scope, "code"]);
	const { workspace, organization } = options;
	if (!workspace || !organization)
		throw new Error(
			"tedi-turn needs a workspace and one explicitly selected organization",
		);
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
	const call = async (method: string, input: Record<string, unknown>) => {
		try {
			const source = `async () => await ${namespace}.${method}(${codeModeLiteral(input)})`;
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
	let runId: string | undefined;
	try {
		const accepted = await call("run_tedi_turn", {
			session_key: sessionKey,
			client_request_id: randomUUID(),
			text,
		});
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
			const result = await call("messages_read", {
				session_key: sessionKey,
				limit: 10,
			});
			if (!isRecord(result) || !Array.isArray(result.messages))
				throw new Error(
					`Tedi ${slug} returned no message list for turn ${runId}`,
				);
			const reply = result.messages
				.slice()
				.reverse()
				.find(
					(message: unknown) =>
						isRecord(message) &&
						message.role === "assistant" &&
						message.runId === runId,
				);
			if (
				!isRecord(reply) ||
				reply.status === "pending" ||
				reply.status === "streaming"
			)
				continue;
			if (reply.status !== "completed" || typeof reply.text !== "string")
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
