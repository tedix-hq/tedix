import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { formsCreateHandler as createTedixForm } from "../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/handlers/forms.ts";
import { handleCleanup as cleanupTedixForms } from "../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/handlers/cron.ts";
import { submitHandler as submitTedixForm } from "../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/handlers/submit.ts";
import {
	formCreateSchema as tedixCreateSchema,
	formUpdateSchema as tedixUpdateSchema,
} from "../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/schemas.ts";
import { formsCreateHandler as createMarketingForm } from "../templates/marketing/node_modules/@emdash-cms/plugin-forms/src/handlers/forms.ts";
import { handleCleanup as cleanupMarketingForms } from "../templates/marketing/node_modules/@emdash-cms/plugin-forms/src/handlers/cron.ts";
import { submitHandler as submitMarketingForm } from "../templates/marketing/node_modules/@emdash-cms/plugin-forms/src/handlers/submit.ts";
import {
	formCreateSchema as marketingCreateSchema,
	formUpdateSchema as marketingUpdateSchema,
} from "../templates/marketing/node_modules/@emdash-cms/plugin-forms/src/schemas.ts";

const formInput = {
	name: "Contact",
	slug: "contact",
	pages: [
		{
			fields: [
				{
					id: "message",
					type: "text",
					label: "Message",
					name: "message",
					required: true,
				},
			],
		},
	],
	settings: {},
};

const starters = [
	{
		name: "tedix",
		createSchema: tedixCreateSchema,
		updateSchema: tedixUpdateSchema,
		createForm: createTedixForm,
		submitForm: submitTedixForm,
		cleanupForms: cleanupTedixForms,
	},
	{
		name: "marketing",
		createSchema: marketingCreateSchema,
		updateSchema: marketingUpdateSchema,
		createForm: createMarketingForm,
		submitForm: submitMarketingForm,
		cleanupForms: cleanupMarketingForms,
	},
] as const;

describe.each(starters)(
	"$name Forms patch",
	({
		name,
		createSchema,
		updateSchema,
		createForm,
		submitForm,
		cleanupForms,
	}) => {
		it("emits the configured submit label for native client restoration after submission", async () => {
			const { transform } = await import(
				new URL(
					`../templates/${name}/node_modules/@astrojs/compiler/dist/node/index.js`,
					import.meta.url,
				).href
			);
			const source = readFileSync(
				new URL(
					`../templates/${name}/node_modules/@emdash-cms/plugin-forms/src/astro/FormEmbed.astro`,
					import.meta.url,
				),
				"utf8",
			);
			const { code } = await transform(source, { filename: "FormEmbed.astro" });
			expect(code).toContain(
				'$$addAttribute(form.settings.submitLabel, "data-submit-label")',
			);
		});

		it("defaults only new forms to 30 days and keeps explicit retention settings", async () => {
			const input = createSchema.parse(formInput);
			expect(input.settings.retentionDays).toBe(30);
			expect(
				createSchema.parse({ ...formInput, settings: { retentionDays: 0 } })
					.settings.retentionDays,
			).toBe(0);
			expect(
				updateSchema.parse({ id: "existing", settings: {} }).settings,
			).toEqual({});

			let stored: unknown;
			const ctx = {
				input,
				storage: {
					forms: {
						query: async () => ({ items: [] }),
						put: async (_id: string, form: unknown) => {
							stored = form;
						},
					},
				},
			};
			await createForm(ctx as unknown as Parameters<typeof createForm>[0]);
			expect(stored).toMatchObject({ settings: { retentionDays: 30 } });
		});

		it("uses the request IP for Turnstile but does not store it", async () => {
			const input = createSchema.parse(formInput);
			let stored: unknown;
			let verificationBody: unknown;
			const form = {
				name: input.name,
				slug: input.slug,
				pages: input.pages,
				settings: { ...input.settings, spamProtection: "turnstile" },
				status: "active",
				submissionCount: 0,
			};
			const ctx = {
				input: {
					formId: "contact-id",
					data: { message: "Hello", "cf-turnstile-response": "token" },
				},
				kv: { get: async () => "secret" },
				http: {
					fetch: async (_url: string, init: RequestInit) => {
						verificationBody = JSON.parse(String(init.body));
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
						});
					},
				},
				requestMeta: {
					ip: "203.0.113.44",
					userAgent: "test-agent",
					referer: null,
					geo: { country: "DE" },
				},
				storage: {
					forms: { get: async () => form, put: async () => undefined },
					submissions: {
						put: async (_id: string, submission: unknown) => {
							stored = submission;
						},
						count: async () => 1,
					},
				},
			};
			await submitForm(ctx as unknown as Parameters<typeof submitForm>[0]);
			expect(verificationBody).toMatchObject({
				remoteip: "203.0.113.44",
				response: "token",
			});
			expect(stored).toMatchObject({
				meta: { ip: null, userAgent: "test-agent", country: "DE" },
			});
			expect(JSON.stringify(stored)).not.toContain("203.0.113.44");
		});

		it("expires older submissions for default-30 forms and preserves newer and explicit-zero forms", async () => {
			const input = createSchema.parse(formInput);
			const defaultForm = {
				name: input.name,
				settings: input.settings,
				submissionCount: 2,
			};
			const foreverForm = {
				name: "Archive",
				settings: { ...input.settings, retentionDays: 0 },
				submissionCount: 1,
			};
			const age = (days: number) =>
				new Date(Date.now() - days * 86_400_000).toISOString();
			const entries = [
				{ id: "old", data: { formId: "default", createdAt: age(31) } },
				{ id: "recent", data: { formId: "default", createdAt: age(29) } },
				{ id: "forever", data: { formId: "forever", createdAt: age(90) } },
			];
			const deleted: string[] = [];
			const ctx = {
				kv: { list: async () => [] },
				storage: {
					forms: {
						query: async () => ({
							items: [
								{ id: "default", data: defaultForm },
								{ id: "forever", data: foreverForm },
							],
						}),
						put: async () => undefined,
					},
					submissions: {
						query: async ({
							where,
						}: {
							where: { formId: string; createdAt: { lt: string } };
						}) => ({
							items: entries.filter(
								(entry) =>
									entry.data.formId === where.formId &&
									entry.data.createdAt < where.createdAt.lt,
							),
						}),
						deleteMany: async (ids: string[]) => {
							deleted.push(...ids);
						},
						count: async () => 1,
					},
				},
				log: { info: () => undefined },
			};
			await cleanupForms(ctx as unknown as Parameters<typeof cleanupForms>[0]);
			expect(deleted).toEqual(["old"]);
		});
	},
);

it("ships the same Forms patch to both standalone starters", () => {
	const patch = (slug: string) =>
		readFileSync(
			new URL(
				`../templates/${slug}/patches/@emdash-cms/plugin-forms@0.2.9.patch`,
				import.meta.url,
			),
			"utf8",
		);
	expect(patch("tedix")).toBe(patch("marketing"));
});

import createNativeForms from "../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/index.ts";
import { validateSubmission } from "../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/validation.ts";

describe("native Forms permissions and consent", () => {
	it("declares only supported private native tools with plugins:manage permission", () => {
		const plugin = createNativeForms();
		expect(plugin.routes?.["submissions/import"]).toBeUndefined();
		expect(plugin.mcp?.tools?.import_submissions).toBeUndefined();
		for (const tool of Object.values(plugin.mcp?.tools ?? {})) {
			expect(plugin.routes?.[tool.route]?.permission).toBe("plugins:manage");
			expect(plugin.routes?.[tool.route]?.public).not.toBe(true);
		}
	});
	it("requires true for required consent and accepts the native HTML checked value", () => {
		const fields = [
			{
				id: "consent",
				name: "consent",
				label: "Consent",
				type: "checkbox" as const,
				required: true,
				width: "full" as const,
			},
		];
		for (const value of [false, "false", "0", undefined, ""])
			expect(validateSubmission(fields, { consent: value }).valid).toBe(false);
		for (const value of [true, "true", "on", "1"])
			expect(validateSubmission(fields, { consent: value })).toMatchObject({
				valid: true,
				data: { consent: true },
			});
	});
});

it("rate limits native submissions with atomic pseudonym buckets and suppresses spam notifications", async () => {
	const parsed = tedixCreateSchema.parse(formInput);
	const form = {
		...parsed,
		settings: {
			...parsed.settings,
			rateLimitPerHour: 1,
			spamKeywords: ["spam"],
		},
		status: "active",
		submissionCount: 0,
	};
	const state = new Map<string, { value: unknown; revision: string }>();
	const stored: unknown[] = [];
	let notifications = 0;
	const ctx = {
		input: { formId: "contact", data: { message: "spam message" } },
		request: new Request("https://tenant.test", {
			headers: { "X-Tedix-Lead-IP-Hash": `h1:${"a".repeat(32)}` },
		}),
		requestMeta: { ip: "203.0.113.42", userAgent: "test", referer: null },
		kv: {
			getVersioned: async (key: string) => state.get(key) ?? null,
			compareAndSet: async (
				key: string,
				revision: string | null,
				value: unknown,
			) => {
				const current = state.get(key);
				if ((current?.revision ?? null) !== revision) return { applied: false };
				state.set(key, {
					value,
					revision: String(Number(current?.revision ?? "0") + 1),
				});
				return { applied: true };
			},
		},
		storage: {
			forms: { get: async () => form, put: async () => undefined },
			submissions: {
				put: async (_id: string, value: unknown) => {
					stored.push(value);
				},
				count: async () => stored.length,
			},
		},
		email: {
			send: async () => {
				notifications++;
			},
		},
		log: { error: () => undefined },
	};
	const results = await Promise.allSettled([
		submitTedixForm(ctx as never),
		submitTedixForm(ctx as never),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({ status: "archived", meta: { ip: null } });
	expect(JSON.stringify(stored)).not.toContain("h1:");
	expect(notifications).toBe(0);
	ctx.request = new Request("https://tenant.test");
	await expect(submitTedixForm(ctx as never)).rejects.toThrow(
		"temporarily unavailable",
	);
});
