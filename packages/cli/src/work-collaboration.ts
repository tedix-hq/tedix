import { spawnSync } from "node:child_process";
import { recordLocalSession } from "./hooks/decision-capture";
import { resolveAgentContext } from "./agent-context";
import {
	delegationKey,
	forgetDelegations,
	readDelegations,
	recordDelegation,
} from "./delegation-ledger";
import { green, yellow } from "./format";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	UUID_RE,
	type BoardResult,
	isUuid,
	mutationCallable,
	resolveAgentSession,
	assertUnambiguousSession,
	oauthHarnessGuard,
	withSession,
} from "./work-identity";
import { boardCall } from "./work-native";
import { fail, ok, truncate, itemsFromList } from "./work-render";
import {
	listWorkItems,
	getWorkItem,
	projectArg,
	resolveWorkItemId,
	CREATE_EXCEPTION_CLASSES,
	expiresToIso,
} from "./work-queries";
import type { WorkContext } from "./work";
import {
	buildAcceptanceContract,
	buildSettlementMetadata,
} from "./work-lifecycle";

/**
 * Post a comment as the acting identity implied by `--as` (or the operator).
 * Discussion is deliberately separate from lifecycle events and attempt state.
 */
async function postComment(
	ctx: WorkContext,
	id: string,
	body: string,
	extraMeta?: Record<string, unknown>,
): Promise<BoardResult> {
	const { as } = ctx.work;
	const meta =
		extraMeta && Object.keys(extraMeta).length > 0
			? { metadata: extraMeta }
			: {};
	if (as) {
		return boardCall(
			ctx,
			mutationCallable(as, "work.add_comment"),
			withSession(ctx, {
				id,
				body,
				...meta,
			}),
		);
	}
	return boardCall(
		ctx,
		"work.add_comment",
		withSession(ctx, {
			id,
			body,
			...meta,
		}),
	);
}

export async function workComment(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || !text.trim()) {
		throw new Error("work comment requires a work item id and comment text");
	}
	id = await resolveWorkItemId(ctx, id);
	const call = await postComment(ctx, id, text.trim());
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not comment on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(`${green("Commented", ctx.color)} on ${id}.`),
	);
}

export async function workAuthorizeBlog(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work authorize-blog requires a work item id");
	if (ctx.work.as) {
		throw new Error(
			"work authorize-blog requires an owner/admin user principal; remove --as and use an authenticated user login",
		);
	}
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not authorize blog publishing on ${id}: ${identityError.message}`,
		);
	}
	const campaignKey = ctx.work.campaign?.trim();
	const validUntil = ctx.work.validUntil?.trim();
	const contentIds = [
		...new Set(
			(ctx.work.contentIds ?? "")
				.split(",")
				.map((contentId) => contentId.trim())
				.filter(Boolean),
		),
	];
	if (!campaignKey || contentIds.length === 0 || !validUntil) {
		throw new Error(
			"work authorize-blog requires --campaign, --content-ids, and --valid-until",
		);
	}
	id = await resolveWorkItemId(ctx, id);
	if (ctx.work.operatorOverride) {
		const session = resolveAgentSession(ctx.work.session);
		const override = await postComment(
			ctx,
			id,
			`Owner/admin credential override: blog authorization from ${session?.session ?? "an unidentified harness session"} using ${ctx.authSource ?? "an unknown credential source"}.`,
		);
		if (override.error) {
			return fail(
				ctx,
				override.error,
				`Could not audit the operator override for ${id}: ${override.error.message}`,
			);
		}
	}
	const call = await boardCall(
		ctx,
		"work.authorize_owned_channel",
		{
			id,
			campaignKey,
			contentIds,
			validUntil,
		},
		`Authorize bounded blog publishing for campaign ${campaignKey} on ${id}`,
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not authorize blog campaign on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${green("Authorized", ctx.color)} ${contentIds.length} blog draft${contentIds.length === 1 ? "" : "s"} for campaign ${campaignKey} on ${id} until ${validUntil}.`,
		),
	);
}

export async function workRevokeBlog(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work revoke-blog requires a work item id");
	if (ctx.work.as) {
		throw new Error(
			"work revoke-blog requires an owner/admin user principal; remove --as and use an authenticated user login",
		);
	}
	const identityError = oauthHarnessGuard(ctx);
	if (identityError) {
		return fail(
			ctx,
			identityError,
			`Could not revoke blog publishing on ${id}: ${identityError.message}`,
		);
	}
	const campaignKey = ctx.work.campaign?.trim();
	const reason = ctx.work.reason?.trim();
	if (!campaignKey || !reason) {
		throw new Error("work revoke-blog requires --campaign and --reason");
	}
	id = await resolveWorkItemId(ctx, id);
	if (ctx.work.operatorOverride) {
		const session = resolveAgentSession(ctx.work.session);
		const override = await postComment(
			ctx,
			id,
			`Owner/admin credential override: blog authorization revocation from ${session?.session ?? "an unidentified harness session"} using ${ctx.authSource ?? "an unknown credential source"}.`,
		);
		if (override.error) {
			return fail(
				ctx,
				override.error,
				`Could not audit the operator override for ${id}: ${override.error.message}`,
			);
		}
	}
	const call = await boardCall(
		ctx,
		"work.revoke_owned_channel",
		{
			id,
			campaignKey,
			reason,
		},
		`Revoke blog publishing for campaign ${campaignKey} on ${id}: ${reason}`,
	);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not revoke blog campaign on ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${yellow("Revoked", ctx.color)} blog campaign ${campaignKey} on ${id}.`,
		),
	);
}

/**
 * Corroborate an EXISTING item you independently hit, instead of filing a
 * duplicate. Calls the canonical credential-derived corroboration ledger; a
 * stable principal counts once across every session and API key. Evidence is
 * mandatory because raw comments never affect ranking.
 */
export async function workConfirm(
	ctx: WorkContext,
	id: string,
): Promise<number> {
	if (!id) throw new Error("work confirm requires a work item id");
	id = await resolveWorkItemId(ctx, id);
	const body =
		ctx.work.note?.trim() ||
		(ctx.work.contradicts
			? "independently checked this settled claim and it does not hold"
			: "independently reproduced this issue");
	const evidence = ctx.work.evidence?.trim();
	if (!evidence) {
		throw new Error("work confirm requires --evidence <ref>");
	}
	if (ctx.work.as && isUuid(ctx.work.as)) {
		throw new Error(
			"work confirm cannot impersonate a tedi UUID; use its slug namespace or the tedi credential",
		);
	}
	const callable = mutationCallable(ctx.work.as, "work.corroborate_work_items");
	const call = await boardCall(ctx, callable, {
		id,
		evidenceRef: evidence,
		stance: ctx.work.contradicts ? "contradicts" : "corroborates",
		body,
	});
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not confirm ${id}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(
			`${green("Confirmed", ctx.color)} ${id} (corroboration recorded).`,
		),
	);
}

const HANDOFF_ENV_TO_CLEAR = [
	"TEDIX_AGENT_SESSION",
	"TEDIX_EXTERNAL_AGENT",
	"TEDIX_MCP_BEARER_TOKEN",
	"TEDIX_MCP_API_KEY",
] as const;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One accepted item and an explicit host destination; never transfer a fence. */
export async function workHandoff(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || text)
		throw new Error("work handoff requires exactly one Work Item id");
	if (ctx.work.as)
		throw new Error(
			"work handoff uses the credential-scoped item; --as is not supported",
		);
	const host = ctx.work.host;
	if (host !== "codex" && host !== "claude")
		throw new Error("work handoff requires --host codex|claude");
	const target = ctx.work.to?.trim().toLowerCase();
	const targetChat = target?.startsWith("codex:") ? target.slice(6) : undefined;
	if (
		ctx.work.to !== undefined &&
		(host !== "codex" || !targetChat || !UUID_RE.test(targetChat))
	)
		throw new Error(
			"handoff --to requires --host codex and an exact codex:<chat UUID>",
		);
	if (!/^[a-zA-Z0-9_-]+$/.test(ctx.workspace))
		throw new Error("work handoff requires a named CLI workspace");
	id = await resolveWorkItemId(ctx, id);
	const call = await getWorkItem(ctx, id);
	if (call.error)
		return fail(ctx, call.error, `Could not read ${id}: ${call.error.message}`);
	const item =
		isRecord(call.value) && isRecord(call.value.workItem)
			? call.value.workItem
			: call.value;
	if (!isRecord(item) || item.id !== id || item.disposition !== "accepted")
		throw new Error(
			`work handoff requires an accepted Work Item; inspect ${id} with work context`,
		);
	let prompt = `Continue Tedix Work Item ${id} in CLI workspace ${ctx.workspace}. Read its current context and readiness through tedix first. Establish your own verified external-agent identity and Agent-Session before any Work mutation. Start or resume only your own admitted Attempt, then heartbeat, settle, and complete it under the Work protocol. The launcher did not transfer an Attempt, credential, or permission to act.`;
	const { prefixLaneBrief } = await import("./lane");
	const recalled = await prefixLaneBrief(
		`${String(item.title ?? "")}\n${String(item.description ?? "")}`,
		[
			"-w",
			ctx.workspace,
			...(process.env.TEDIX_ORGANIZATION
				? ["--organization", process.env.TEDIX_ORGANIZATION]
				: []),
		],
		host === "claude" ? "claude-code" : "codex",
		ctx.organizationId,
	);
	if (recalled.recall) prompt = `${recalled.recall}\n\n${prompt}`;
	if (targetChat) {
		const target = `codex:${targetChat}`;
		const binding = ctx.resolveContext
			? ctx.resolveContext(targetChat)
			: resolveAgentContext({ sessionId: targetChat });
		if (
			binding.status !== "bound" ||
			binding.contextSource !== "chat" ||
			binding.contextSessionId !== targetChat ||
			binding.workspace !== ctx.workspace ||
			!ctx.mcpUrl ||
			binding.mcpUrl !== ctx.mcpUrl ||
			binding.projectId !== item.projectId ||
			(ctx.organizationId !== undefined &&
				binding.organization !== ctx.organizationId)
		)
			throw new Error(
				"Target chat must be explicitly bound to this profile and Work project in this checkout",
			);
		const prior = readDelegations(process.env, target).find((e) => e.id === id);
		if (
			ctx.work.launch &&
			!(
				prior?.launch &&
				prior.to === target &&
				prior.projectId === item.projectId &&
				prior.organization === binding.organization
			)
		)
			recordDelegation(process.env, target, {
				id,
				title: String(item.title ?? id),
				via: "session",
				to: target,
				workspace: ctx.workspace,
				createdAt: new Date().toISOString(),
				launch: true,
				projectId: String(item.projectId),
				organization: binding.organization,
				orgId: String(item.orgId),
				...(prior?.deliveredAt ? { deliveredAt: prior.deliveredAt } : {}),
			});
		if (ctx.work.launch)
			recordLocalSession(process.env, targetChat, "codex", process.cwd());
		return ok(
			ctx,
			{
				workItemId: id,
				target,
				registered: !!ctx.work.launch,
				note: "Exact-chat supervisor handoff; the recipient must obtain its own admission.",
			},
			() =>
				console.log(
					`${ctx.work.launch ? "Registered" : "Preview"} ${id} for ${target}`,
				),
		);
	}
	// The shared Codex daemon can retain a session without dispatching the
	// plugin SessionStart hook. A fresh host process delivers this opt-in brief.
	const args =
		host === "codex" ? ["--no-daemon", "-C", process.cwd(), prompt] : [prompt];
	const command = [
		"env",
		...HANDOFF_ENV_TO_CLEAR.flatMap((name) => ["-u", name]),
		`TEDIX_PLUGIN_PREFLIGHT=1`,
		`TEDIX_WORKSPACE=${ctx.workspace}`,
		`TEDIX_WORK_ITEM_ID=${id}`,
		host,
		...(host === "codex"
			? ["--no-daemon", "-C", shellQuote(process.cwd())]
			: []),
		shellQuote(prompt),
	].join(" ");
	if (!ctx.work.launch) {
		const preview = {
			workItemId: id,
			workspace: ctx.workspace,
			host,
			command,
			note: "Read-only preview. Add --launch to start a new host session; the host must establish its own identity and Attempt.",
		};
		console.log(
			ctx.json ? JSON.stringify(preview) : `${command}\n${preview.note}`,
		);
		return 0;
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TEDIX_PLUGIN_PREFLIGHT: "1",
		TEDIX_WORKSPACE: ctx.workspace,
		TEDIX_WORK_ITEM_ID: id,
	};
	for (const name of HANDOFF_ENV_TO_CLEAR) delete env[name];
	if (ctx.launchHost) return ctx.launchHost(host, args, env);
	const result = spawnSync(host, args, {
		cwd: process.cwd(),
		env,
		stdio: "inherit",
	});
	if (result.error)
		throw new Error(`Could not launch ${host}: ${result.error.message}`);
	return result.status ?? 1;
}

// ─── Delegation ledger ───────────────────────────────────────────────────────

/** Default purpose window of a delegation filed without --objective. */
const DELEGATION_EXPIRES = "14d";

/**
 * `tedix work delegate "<title>" --done-when "…" --via subagent|session`:
 * the lead session registers work it handed off as one accepted Work Item
 * (reused when an open item has the same title), with the brief as a comment,
 * and remembers the id locally so its prompt context names it until settled.
 * `--done <id> --note "…"` records the outcome and completes the item.
 */
export async function workDelegate(
	ctx: WorkContext,
	title: string,
): Promise<number> {
	mutationCallable(ctx.work.as?.trim(), "work.create_work_items");
	const lead = resolveAgentSession(ctx.work.session);
	assertUnambiguousSession(lead);
	if (!lead || lead.derived || !delegationKey(lead.session))
		throw new Error(
			"work delegate needs the lead session's id: run it inside Claude Code or Codex, or pass --session <id>",
		);
	if (ctx.work.done?.trim()) return settleDelegation(ctx, lead.session);
	const t = title.trim();
	const via = ctx.work.via?.trim();
	const doneWhen = ctx.work.doneWhen?.trim();
	if (!t || !doneWhen || (via !== "subagent" && via !== "session"))
		throw new Error(
			'work delegate requires "<title>" --done-when "<what done looks like>" --via subagent|session',
		);
	const to = ctx.work.to?.trim() || undefined;
	const delegation = {
		via,
		...(to ? { to } : {}),
		leadSession: lead.session,
	};
	const search = await listWorkItems(ctx, {
		titleContains: t.slice(0, 200),
		limit: 20,
		...projectArg(ctx.work.project),
	});
	if (search.error)
		return fail(
			ctx,
			search.error,
			`Could not search work items: ${search.error.message}`,
		);
	const existing = itemsFromList(search.value).find(
		(row) =>
			String(row.title ?? "").toLowerCase() === t.toLowerCase() &&
			(row.disposition === "proposed" || row.disposition === "accepted"),
	);
	let id = typeof existing?.id === "string" ? existing.id : "";
	let disposition = String(existing?.disposition ?? "proposed");
	if (!id) {
		const { objective, workClass } = ctx.work;
		if (workClass && !CREATE_EXCEPTION_CLASSES.has(workClass))
			throw new Error(
				`--class must be one of maintenance|incident|hygiene, got "${workClass}"`,
			);
		const created = await boardCall(
			ctx,
			"work.create_work_items",
			withSession(ctx, {
				title: t,
				description: `Delegated by lead session ${lead.session} via ${via}${to ? ` to ${to}` : ""}.\n\nDone when: ${doneWhen}`,
				...(ctx.work.kind ? { workKind: ctx.work.kind } : {}),
				// A project carries its own purpose; an unparented delegation is a
				// time-bounded maintenance exception unless told otherwise.
				...(objective
					? { objectiveId: objective.trim() }
					: workClass || !ctx.work.project
						? {
								workClass: workClass ?? "maintenance",
								purposeExceptionExpiresAt: expiresToIso(
									ctx.work.expires ?? DELEGATION_EXPIRES,
								),
							}
						: {}),
				...projectArg(ctx.work.project),
				metadata: { delegation },
			}),
		);
		if (created.error)
			return fail(
				ctx,
				created.error,
				`Could not create the delegation: ${created.error.message}`,
			);
		const item = isRecord(created.value)
			? isRecord(created.value.workItem)
				? created.value.workItem
				: created.value
			: {};
		id = typeof item.id === "string" ? item.id : "";
		disposition = String(item.disposition ?? "proposed");
		if (!id)
			return fail(
				ctx,
				{ code: "MISSING_ID", message: "create returned no id" },
				"Could not create the delegation: the board returned no id.",
			);
	}
	if (disposition === "proposed") {
		const accepted = await boardCall(ctx, "work.accept_work_item", {
			id,
			acceptanceContract: buildAcceptanceContract(doneWhen),
		});
		if (accepted.error)
			return fail(
				ctx,
				accepted.error,
				`Created ${id} but could not accept it: ${accepted.error.message}`,
			);
	}
	const brief = await postComment(
		ctx,
		id,
		`Delegation brief (via ${via}${to ? ` → ${to}` : ""}; lead session ${lead.session}): ${t}\nDone when: ${doneWhen}\nSettle with: tedix work delegate --done ${id} --note "<outcome and evidence>"`,
		{ delegation },
	);
	if (brief.error)
		return fail(
			ctx,
			brief.error,
			`Could not comment the brief on ${id}: ${brief.error.message}`,
		);
	recordDelegation(process.env, lead.session, {
		id,
		title: t,
		via,
		...(to ? { to } : {}),
		workspace: ctx.workspace,
		createdAt: new Date().toISOString(),
	});
	const reused = Boolean(existing);
	return ok(ctx, { id, reused, via, ...(to ? { to } : {}) }, () =>
		console.log(
			`${green(reused ? "Reused" : "Delegated", ctx.color)} ${id}  via ${via}${to ? ` → ${to}` : ""}  ${truncate(t, 60)}`,
		),
	);
}

async function settleDelegation(
	ctx: WorkContext,
	leadSession: string,
): Promise<number> {
	const note = ctx.work.note?.trim();
	if (!note)
		throw new Error(
			'work delegate --done <id> requires --note "<outcome and evidence>"',
		);
	const id = await resolveWorkItemId(ctx, ctx.work.done!.trim());
	const settlement = buildSettlementMetadata(ctx.work.commit);
	const comment = await postComment(ctx, id, `Delegation settled: ${note}`, {
		delegation: { settled: true },
		...settlement,
	});
	if (comment.error)
		return fail(
			ctx,
			comment.error,
			`Could not record the outcome on ${id}: ${comment.error.message}`,
		);
	const call = await boardCall(ctx, "work.complete_work_item", { id });
	if (call.error)
		return fail(
			ctx,
			call.error,
			`Recorded the outcome on ${id} but could not complete it: ${call.error.message}`,
		);
	forgetDelegations(process.env, leadSession, [id]);
	return ok(ctx, call.value, () =>
		console.log(`${green("Settled delegation", ctx.color)} ${id}.`),
	);
}
