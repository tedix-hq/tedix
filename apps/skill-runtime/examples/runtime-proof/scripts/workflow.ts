import { NonRetryableError } from "cloudflare:workflows";

const HOME_READ = {
	conversationId: "home:main",
	limit: 1,
};
const APPROVAL_AUDIT_REASON =
	"Approve Workflow Runtime Certification v2 checkpoint";

function certificationResult(scenario, output, assertions) {
	return {
		certification: {
			schemaVersion: 1,
			scenario,
			status: assertions.every((assertion) => assertion.passed)
				? "passed"
				: "failed",
			assertions,
		},
		output,
	};
}

export default {
	async run(event, step, env) {
		const mode = String(event.payload?.mode ?? "retry");

		if (mode === "retry") {
			return step.do(
				"retry-proof",
				{
					retries: { limit: 3, delay: "1 second", backoff: "exponential" },
					timeout: "15 seconds",
				},
				async (ctx) => {
					if (ctx.attempt < 3) {
						throw new Error(`intentional transient attempt ${ctx.attempt}`);
					}
					return { succeededOnAttempt: ctx.attempt };
				},
			);
		}

		if (mode === "nonretryable") {
			return step.do(
				"nonretryable-proof",
				{ retries: { limit: 3, delay: "1 second" }, timeout: "15 seconds" },
				async () => {
					throw new NonRetryableError("intentional permanent proof failure");
				},
			);
		}

		if (mode === "sensitive") {
			const value = await step.do(
				"sensitive-proof",
				{ sensitive: "output", timeout: "15 seconds" },
				async () => ({
					secretMarker: "TEDIX_SENSITIVE_PROOF_MUST_NOT_PERSIST",
				}),
			);
			return { receivedByWorkflow: Boolean(value?.secretMarker) };
		}

		if (mode === "sensitive-error") {
			return step.do(
				"sensitive-error-proof",
				{ sensitive: "output", timeout: "15 seconds" },
				async () => {
					throw new NonRetryableError("TEDIX_SENSITIVE_ERROR_MUST_NOT_PERSIST");
				},
			);
		}

		if (mode === "sleep") {
			await step.sleep("sleep-proof", "1 second");
			await step.sleepUntil("sleep-until-proof", Date.now() + 1_000);
			return { slept: true };
		}

		if (mode === "mcp") {
			return step.do(
				"mcp-identity-proof",
				{ retries: { limit: 1, delay: "1 second" }, timeout: "45 seconds" },
				async () => {
					const result = await env.MCP.home.read_home_run_set(HOME_READ);
					return {
						readSucceeded: result != null,
						runCount: Array.isArray(result?.runs) ? result.runs.length : null,
					};
				},
			);
		}

		if (mode === "network") {
			const request = fetch;
			let outsideError = null;
			try {
				await request("https://example.com", { method: "HEAD" });
			} catch (error) {
				outsideError = error instanceof Error ? error.message : String(error);
			}
			const insideStatus = await step.do(
				"network-gate-proof",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "15 seconds" },
				async () => {
					const response = await fetch("https://example.com", {
						method: "HEAD",
					});
					return response.status;
				},
			);
			return {
				outsideBlocked:
					typeof outsideError === "string" &&
					outsideError.includes("WORKFLOW_NETWORK_OUTSIDE_STEP"),
				insideStatus,
			};
		}

		if (mode === "isolation") {
			const originalPromiseReject = Promise.reject;
			const originalDateNow = Date.now;
			const originalRunId = env.__RUN_CONTEXT__.runId;
			let cacheBlocked = false;
			let contextMutationBlocked = false;
			let dateMutationBlocked = false;
			let eventSourceBlocked = false;
			let outsideMcpBlocked = false;
			let primordialMutationBlocked = false;
			let prototypeFetchBlocked = false;
			let sendBeaconBlocked = false;
			let webSocketBlocked = false;
			let webSocketPairBlocked = false;
			const globalPrototype = Object.getPrototypeOf(globalThis) as Record<
				string,
				any
			>;
			try {
				void globalThis.caches.default;
			} catch (error) {
				cacheBlocked = String(error).includes("WORKFLOW_CACHE_API_DISABLED");
			}
			try {
				env.__RUN_CONTEXT__.runId = "tampered";
			} catch {
				contextMutationBlocked = true;
			}
			try {
				(Promise as any).reject = () => Promise.resolve(undefined);
			} catch {
				primordialMutationBlocked = true;
			}
			try {
				(Date as any).now = () => 0;
			} catch {
				dateMutationBlocked = true;
			}
			try {
				await globalPrototype["fetch"]("https://example.com", {
					method: "HEAD",
				});
			} catch (error) {
				prototypeFetchBlocked = String(error).includes(
					"WORKFLOW_NETWORK_OUTSIDE_STEP",
				);
			}
			try {
				new globalPrototype.WebSocket("wss://example.com");
			} catch (error) {
				webSocketBlocked = String(error).includes(
					"WORKFLOW_WEBSOCKET_DISABLED",
				);
			}
			try {
				new globalPrototype.WebSocketPair();
			} catch (error) {
				webSocketPairBlocked = String(error).includes(
					"WORKFLOW_WEBSOCKET_DISABLED",
				);
			}
			try {
				new globalPrototype.EventSource("https://example.com/events");
			} catch (error) {
				eventSourceBlocked = String(error).includes(
					"WORKFLOW_EVENT_SOURCE_DISABLED",
				);
			}
			try {
				Object.getPrototypeOf(navigator).sendBeacon.call(
					navigator,
					"https://example.com/beacon",
					"proof",
				);
			} catch (error) {
				sendBeaconBlocked = String(error).includes("WORKFLOW_BEACON_DISABLED");
			}
			try {
				try {
					await env.MCP.home.read_home_run_set(HOME_READ);
				} catch (error) {
					outsideMcpBlocked = String(error).includes("MCP_OUTSIDE_STEP");
				}
				const result = await step.do(
					"isolation-proof",
					{ retries: { limit: 1, delay: "1 second" }, timeout: "45 seconds" },
					async () => {
						const response = await fetch("https://example.com", {
							method: "HEAD",
						});
						const home = await env.MCP.home.read_home_run_set(HOME_READ);
						return {
							networkStatus: response.status,
							homeReadSucceeded: home != null,
						};
					},
				);
				return {
					cacheBlocked,
					contextFrozen: Object.isFrozen(env.__RUN_CONTEXT__),
					contextMutationBlocked,
					contextPreserved: env.__RUN_CONTEXT__.runId === originalRunId,
					dateMutationBlocked,
					eventSourceBlocked,
					globalPrototypeFrozen: Object.isFrozen(globalPrototype),
					outsideMcpBlocked,
					primordialMutationBlocked,
					prototypeFetchBlocked,
					sendBeaconBlocked,
					webSocketBlocked,
					webSocketPairBlocked,
					...result,
				};
			} finally {
				try {
					(Promise as any).reject = originalPromiseReject;
				} catch {}
				try {
					(Date as any).now = originalDateNow;
				} catch {}
			}
		}

		if (mode === "buffered-response") {
			let retainedResponse: Response | null = null;
			const status = await step.do(
				"buffered-response-proof",
				{ timeout: "15 seconds" },
				async () => {
					retainedResponse = await fetch("https://example.com");
					return retainedResponse.status;
				},
			);
			if (!retainedResponse) throw new Error("buffered response missing");
			const body = await retainedResponse.text();
			return {
				status,
				readableAfterStep: body.length > 0,
				bodyBytes: body.length,
			};
		}

		if (mode === "path") {
			const names = [".", "..", "hidden..step", "report.publish"];
			const values: Array<{ name: string }> = [];
			for (const name of names) {
				values.push(await step.do(name, async () => ({ name })));
			}
			return { names: values.map((value) => value.name) };
		}

		if (mode === "floated-failure") {
			return step.do(
				"floated-failure-proof",
				{ retries: { limit: 1, delay: "1 second" }, timeout: "15 seconds" },
				async () => {
					void fetch("http://[invalid");
					return { falseSuccess: true };
				},
			);
		}

		if (mode === "approval") {
			const approval = await step.waitForEvent("approval-proof", {
				type: "approval",
				timeout: "10 minutes",
			});
			const output = {
				approved: approval.payload?.approved === true,
				reason: approval.payload?.reason ?? null,
				metadataReason: approval.payload?.metadata?.reason ?? null,
			};
			return certificationResult("approval", output, [
				{
					id: "approval_decision",
					description:
						"The human approval decision preserved its audit reason and custom metadata.",
					passed:
						output.approved &&
						output.reason === APPROVAL_AUDIT_REASON &&
						output.metadataReason === "certification",
					expected: {
						approved: true,
						reason: APPROVAL_AUDIT_REASON,
						metadataReason: "certification",
					},
					actual: output,
				},
			]);
		}

		if (mode === "rollback") {
			await step.do(
				"rollback-proof",
				{ timeout: "15 seconds" },
				async () => ({ registered: true }),
				{
					rollbackConfig: { timeout: "45 seconds" },
					rollback: async () => {
						await env.MCP.home.read_home_run_set(HOME_READ);
					},
				},
			);
			await step.waitForEvent("rollback-cancel-proof", {
				type: "finish-without-rollback",
				timeout: "10 minutes",
			});
			return { canceledBeforeThisResult: false };
		}

		if (mode === "parallel") {
			const values = await Promise.all([
				step.do("parallel-left", async () => ({ value: 20 })),
				step.do("parallel-right", async () => ({ value: 22 })),
			]);
			const total = values.reduce((sum, value) => sum + value.value, 0);
			return certificationResult("parallel", { total }, [
				{
					id: "parallel_join",
					description: "Both durable branches joined with the expected value.",
					passed: total === 42,
					expected: 42,
					actual: total,
				},
			]);
		}

		if (mode === "dynamic") {
			const requested = Array.isArray(event.payload?.items)
				? event.payload.items.slice(0, 8).map(String)
				: ["alpha", "beta", "gamma"];
			const values = [];
			for (let index = 0; index < requested.length; index++) {
				values.push(
					await step.do(`dynamic-${index + 1}`, async () => ({
						index,
						value: requested[index],
					})),
				);
			}
			return certificationResult("dynamic", { values }, [
				{
					id: "bounded_dynamic_steps",
					description:
						"Every requested bounded item produced one durable step.",
					passed:
						values.length === requested.length &&
						values.every((value, index) => value.index === index),
					expected: requested.length,
					actual: values.length,
				},
			]);
		}

		if (mode === "timeout") {
			return step.do(
				"timeout-proof",
				{ retries: { limit: 1, delay: "1 second" }, timeout: "1 second" },
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 5_000));
					return { falseSuccess: true };
				},
			);
		}

		if (mode === "artifact") {
			const marker = `workflow-certification:${env.__RUN_CONTEXT__.runId}`;
			const result = await step.do(
				"artifact-publish-proof",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "60 seconds" },
				async () =>
					await env.MCP.cognitive.record_artifact({
						name: `workflow-certification-${env.__RUN_CONTEXT__.runId}.json`,
						kind: "document",
						mimeType: "application/json",
						conversationId: "workflow-certification",
						content: JSON.stringify({ marker }),
					}),
			);
			const artifactId = result?.artifact?.id ?? result?.id ?? null;
			return certificationResult("artifact", { artifactId, marker }, [
				{
					id: "authoritative_artifact_identity",
					description:
						"Artifact publication succeeded without tenant-supplied tediId.",
					passed: typeof artifactId === "string" && artifactId.length > 0,
					expected: "non-empty artifact id",
					actual: artifactId,
				},
			]);
		}

		if (mode === "tedi") {
			const marker = `WORKFLOW_TEDI_LOOP_${env.__RUN_CONTEXT__.runId}`;
			const result = await step.do(
				"tedi-interpretation-proof",
				{ retries: { limit: 1, delay: "2 seconds" }, timeout: "180 seconds" },
				async () =>
					await env.MCP.tedi.run_tedi_turn({
						session_key: "workflow-certification",
						client_request_id: `workflow-certification:${env.__RUN_CONTEXT__.runId}`,
						text: `Reply with this exact marker and nothing else: ${marker}`,
					}),
			);
			const content = String(
				result?.assistant?.content ?? result?.result?.assistant?.content ?? "",
			).trim();
			return certificationResult("tedi", { marker, content }, [
				{
					id: "tedi_in_the_loop",
					description:
						"A durable workflow step received a non-empty result from its owning tedi.",
					passed: content === marker,
					expected: marker,
					actual: content,
				},
			]);
		}

		if (mode === "research") {
			const job = await step.do(
				"firecrawl-agent-start",
				{ retries: { limit: 2, delay: "2 seconds" }, timeout: "60 seconds" },
				async () =>
					await env.MCP.firecrawl_tedix.firecrawl_agent({
						prompt:
							"Find the official Cloudflare Workflows documentation page and return its title and URL.",
						schema: {
							type: "object",
							properties: {
								title: { type: "string" },
								url: { type: "string" },
							},
						},
					}),
			);
			const jobId = String(job?.id ?? job?.jobId ?? "");
			if (!jobId)
				throw new NonRetryableError("firecrawl agent returned no job id");
			const result = await step.do(
				"firecrawl-agent-poll",
				{ retries: { limit: 2, delay: "5 seconds" }, timeout: "6 minutes" },
				async () => {
					for (let attempt = 0; attempt < 24; attempt++) {
						const status = await env.MCP.firecrawl_tedix.firecrawl_agent_status(
							{
								id: jobId,
							},
						);
						if (status?.status === "completed") return status;
						if (status?.status === "failed") {
							throw new NonRetryableError("firecrawl agent research failed");
						}
						await new Promise((resolve) => setTimeout(resolve, 15_000));
					}
					throw new Error(
						"firecrawl agent research did not complete in six minutes",
					);
				},
			);
			return certificationResult("research", { jobId, result }, [
				{
					id: "firecrawl_agent_completed",
					description:
						"The preferred autonomous research tool reached completed state.",
					passed: result?.status === "completed",
					expected: "completed",
					actual: result?.status ?? null,
				},
			]);
		}

		if (mode === "lifecycle") {
			const signal = await step.waitForEvent("lifecycle-proof", {
				type: "certification-finish",
				timeout: "10 minutes",
			});
			return certificationResult("lifecycle", { signal: signal.payload }, [
				{
					id: "resume_and_event",
					description:
						"The paused/resumed workflow consumed the post-resume event.",
					passed: signal.payload?.finished === true,
					expected: true,
					actual: signal.payload?.finished === true,
				},
			]);
		}

		throw new NonRetryableError(`unknown runtime proof mode: ${mode}`);
	},
};
