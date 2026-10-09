import type { AgentReplyDeliveryGatePolicy } from "@tedix/api-contract/schemas/agent-turn-triage";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	evaluateReplyDraftGate,
	guardReplyDraft,
	scoreReplyDraftGate,
} from "./reply-draft-gate";

const GATE: AgentReplyDeliveryGatePolicy = {
	model: "@cf/cloudflare/clef-flash",
	questions: [
		{
			id: "reversible_step",
			instructions: "Reversible?",
			autoWhen: { gte: 0.8 },
		},
		{ id: "needs_human", instructions: "Needs human?", autoWhen: { lte: 0.3 } },
	],
};

function env(run: (...args: unknown[]) => Promise<unknown>) {
	return { AI: { run: vi.fn(run) } } as unknown as Parameters<
		typeof evaluateReplyDraftGate
	>[0];
}

describe("scoreReplyDraftGate", () => {
	it.each([
		[{ reversible_step: 0.8, needs_human: 0.3 }, "pass", [true, true]],
		[{ reversible_step: 0.79, needs_human: 0.3 }, "fail", [false, true]],
		[{ reversible_step: 0.9, needs_human: 0.31 }, "fail", [true, false]],
		[{ reversible_step: 0.9 }, "fail", [true, false]],
	])("scores %o as %s at the thresholds", (labels, status, passes) => {
		const result = scoreReplyDraftGate(GATE, labels);
		expect(result.status).toBe(status);
		expect(result.checks.map((check) => check.pass)).toEqual(passes);
	});
});

describe("evaluateReplyDraftGate", () => {
	it("asks Clef about the agent message and the draft", async () => {
		const e = env(async () => ({
			answers: {
				reversible_step: { type: "noul", noul: 0.9 },
				needs_human: { type: "noul", noul: 0.1 },
			},
		}));
		const result = await evaluateReplyDraftGate(e, {
			gate: GATE,
			agentMessage: "x".repeat(9_000),
			draftReply: "Continue.",
		});
		expect(result).toMatchObject({ status: "pass", model: GATE.model });
		const [model, input] = (e.AI.run as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, { state: Record<string, string> }];
		expect(model).toBe(GATE.model);
		expect(input.state.draft_reply).toBe("Continue.");
		expect(input.state.agent_message).toMatch(/^x{8000}\n\[truncated\]$/);
	});

	it("sends a self-approving Drafter prompt change and push to review without asking Clef", async () => {
		const e = env(async () => ({
			answers: {
				reversible_step: { type: "noul", noul: 0.9 },
				needs_human: { type: "noul", noul: 0.1 },
			},
		}));
		const result = await evaluateReplyDraftGate(e, {
			gate: GATE,
			agentMessage:
				"I tightened the Drafter prompt in agent-turn-triage-defaults.json. Want me to push it?",
			draftReply: "Yes, approve the prompt change and push it to main.",
		});
		expect(result).toMatchObject({ status: "fail" });
		expect(result.checks.map((check) => check.id)).toEqual([
			"self_modification",
			"unvalidated_push",
		]);
		expect(e.AI.run).not.toHaveBeenCalled();
	});

	it("is unavailable on error, timeout, or a missing answer", async () => {
		for (const run of [
			async () => {
				throw new Error("boom");
			},
			() => new Promise(() => undefined),
			async () => ({
				answers: { reversible_step: { type: "noul", noul: 0.9 } },
			}),
		]) {
			const result = await evaluateReplyDraftGate(env(run), {
				gate: GATE,
				agentMessage: "Commit?",
				draftReply: "Yes.",
				timeoutMs: 5,
			});
			expect(result).toMatchObject({ status: "unavailable", checks: [] });
		}
	});
});

describe("guardReplyDraft", () => {
	it("allows a push only after the agent reports validation passed", () => {
		const draft = "Commit and push to main.";
		expect(
			guardReplyDraft("Tests pass and type-check is green.", draft),
		).toEqual([]);
		expect(guardReplyDraft("The change is ready.", draft)).toEqual([
			{ id: "unvalidated_push", p: 1, pass: false },
		]);
		expect(guardReplyDraft("Two tests failed; others pass.", draft)).toEqual([
			{ id: "unvalidated_push", p: 1, pass: false },
		]);
		expect(guardReplyDraft("The change is ready.", "Continue.")).toEqual([]);
	});

	const ids = (agentMessage: string, draft: string) =>
		guardReplyDraft(agentMessage, draft).map((check) => check.id);

	it.each([
		["destructive_delete", "Go ahead and delete the old branch."],
		["destructive_delete", "Yes, drop the users table."],
		["destructive_delete", "Run rm -rf ~/scratch/build."],
		["destructive_delete", "Then git reset --hard origin/main."],
		["destructive_delete", "Ja, lösch den alten Branch."],
		["destructive_delete", "Entferne die Daten aus der Tabelle."],
		["destructive_delete", "Sí, borra la rama vieja."],
		["destructive_delete", "Elimina los registros de la base de datos."],
		["deploy_or_publish", "Deploy it now."],
		["deploy_or_publish", "Run wrangler deploy after the merge."],
		["deploy_or_publish", "Publish the new docs."],
		["deploy_or_publish", "Cut the release today."],
		["deploy_or_publish", "Bitte jetzt deployen."],
		["deploy_or_publish", "Veröffentliche die Seite."],
		["deploy_or_publish", "Despliega a producción."],
		["deploy_or_publish", "Publica la versión nueva."],
		["force_push", "Force-push the rebased branch."],
		["force_push", "git push origin main --force"],
		["force_push", "Push with --no-verify, the hook is slow."],
		["force_push", "Haz un push forzado."],
		["external_message", "Send the summary to the customer."],
		["external_message", "Email the team about it."],
		["external_message", "Post it in the Slack channel."],
		["external_message", "Reply to adriana@example.com with the fix."],
		["external_message", "Schick dem Kunden die Antwort."],
		["external_message", "Benachrichtige das Team."],
		["external_message", "Envía el correo al cliente."],
		["external_message", "Manda el mensaje a todos."],
		["payment_or_credential", "Pay the invoice."],
		["payment_or_credential", "Rotate the API key."],
		["payment_or_credential", "Put the password in the config."],
		["payment_or_credential", "Überweise den Betrag."],
		["payment_or_credential", "Trag das Passwort ein."],
		["payment_or_credential", "Paga la factura."],
		["payment_or_credential", "Cambia la contraseña."],
		["cancel_others_work", "Cancel the other agent's attempt."],
		["cancel_others_work", "Close their work item."],
		["cancel_others_work", "Brich die Arbeit von anderen ab."],
		["cancel_others_work", "Cancela la tarea de otro agente."],
		["cancel_others_work", "Cierra el ticket ajeno."],
	])("holds %s: %s", (id, draft) => {
		expect(ids("Tests pass and type-check is green.", draft)).toContain(id);
	});

	it("holds a bare yes to an agent asking for a risky step", () => {
		expect(
			ids(
				"Cleanup is done. Should I delete the old branch feature/x?",
				"Yes, go ahead.",
			),
		).toEqual(["destructive_delete"]);
		expect(
			ids("Soll ich die Kundin per E-Mail informieren?", "Ja, mach."),
		).toEqual(["external_message"]);
		expect(ids("¿Despliego a producción?", "Sí, dale.")).toEqual([
			"deploy_or_publish",
		]);
	});

	const handoff = "Thanks, carry on with the handoff to LEARN.";

	it.each([
		"LEARN also made the product call I'd flagged: brand-new tenant workshops can't email customers until they're reviewed or reach a trust threshold.",
		"Your only remaining part is the Authorize and MFA clicks when LEARN asks.",
		"We will not deploy until the review lands.",
		"Agents are no longer allowed to delete the customer records.",
		"Wir werden den Kunden nicht benachrichtigen.",
		"Nunca borramos los datos de clientes.",
		"You need to rotate the API key yourself in the dashboard.",
	])(
		"ignores a negated or user-assigned step in the agent message: %s",
		(agentMessage) => {
			expect(ids(agentMessage, handoff)).toEqual([]);
		},
	);

	it.each([
		["external_message", "Shall I email the customer?"],
		["external_message", "Next: I'll send the invoice to billing@example.com."],
		["payment_or_credential", "Approve and I'll rotate the API key."],
		["payment_or_credential", "When you approve, I'll rotate the API key."],
		["destructive_delete", "Can't I just delete the old branch?"],
		[
			"destructive_delete",
			"Nothing is blocked, so should I drop the users table?",
		],
	])("still holds %s asked by the agent: %s", (id, agentMessage) => {
		expect(ids(agentMessage, handoff)).toContain(id);
	});

	it("still checks a draft that names a step the agent called negated", () => {
		expect(
			ids(
				"Workshops can't email customers yet.",
				"Email the customers anyway.",
			),
		).toEqual(["external_message"]);
	});

	it.each([
		"Continue with the next test.",
		"Remove the unused import and rerun type-check.",
		"Release the lease when you are done.",
		"Close the issue you just fixed, with the commit as evidence.",
		"Commit and push to main.",
		"Run bun run scan:secrets before pushing.",
		"Sí, sigue con el borrador.",
		"Ja, prüf die Zahlen nochmal.",
	])("lets a routine step through: %s", (draft) => {
		expect(ids("Tests pass and type-check is green.", draft)).toEqual([]);
	});
});
