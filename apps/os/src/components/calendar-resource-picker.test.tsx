import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	supportedAccounts: vi.fn(),
	listCalendars: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		calendarCoordinator: {
			supportedAccounts: mocks.supportedAccounts,
			listCalendars: mocks.listCalendars,
		},
	},
}));
import { osQuery } from "@/lib/os-query-options";
import {
	CalendarResourcePicker,
	calendarAccountLabel,
	calendarResourceSelection,
} from "./calendar-resource-picker";
const account = {
	adapter: "google" as const,
	providerId: "calendar-provider",
	connectionScope: "user" as const,
	connectionInstanceId: "11111111-1111-4111-8111-111111111111",
	instanceLabel: "Agency account",
	accountSubject: "person@example.test",
};
const calendar = {
	id: "opaque-calendar",
	name: "Agency meetings",
	timeZone: "Europe/Berlin",
	canRead: true,
	canWrite: true,
	ownerEmail: "person@example.test",
	conditionalWrites: true,
};
describe("calendar resource picker", () => {
	it("preserves exact named account identity and calendar ID in a canonical resource selection", () => {
		expect(calendarResourceSelection({ account, calendar })).toMatchObject({
			connectionInstanceId: account.connectionInstanceId,
			providerResourceId: calendar.id,
			providerId: account.providerId,
			connectionScope: "user",
			name: "Agency meetings",
			resourceType: "calendar",
		});
		expect(
			calendarResourceSelection({ account, calendar }).metadata,
		).not.toHaveProperty("connectionInstanceId");
		expect(calendarAccountLabel(account)).toContain("Agency account");
		expect(calendarAccountLabel(account)).toContain("person@example.test");
		expect(
			calendarAccountLabel({ ...account, accountSubject: null }),
		).toContain("Identity unavailable");
	});
	it("offers real account selection without asking users to type IDs", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			osQuery.calendarCoordinator.supportedAccounts.queryOptions({
				input: { scope: "user" },
			}).queryKey,
			[account],
		);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<CalendarResourcePicker onSelect={() => {}} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Choose an account");
		expect(html).not.toContain("Provider resource ID");
		expect(html).not.toContain(account.connectionInstanceId);
	});
	it("keeps the readable account label after selecting an unverified named account", async () => {
		const unverified = { ...account, accountSubject: null };
		const message =
			"This calendar account needs identity verification before its calendars can be read. Open Connections to verify this account.";
		mocks.listCalendars.mockReset().mockRejectedValue(new Error(message));
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		queryClient.setQueryData(
			osQuery.calendarCoordinator.supportedAccounts.queryOptions({
				input: { scope: "user" },
			}).queryKey,
			[unverified],
		);
		const node = document.createElement("div");
		document.body.appendChild(node);
		const root = createRoot(node);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={queryClient}>
						<CalendarResourcePicker onSelect={() => {}} />
					</QueryClientProvider>,
				),
			);
			const trigger = node.querySelector<HTMLButtonElement>(
				'[aria-label="Connected calendar account"]',
			)!;
			await act(async () => trigger.click());
			const option = Array.from(
				document.querySelectorAll<HTMLElement>('[role="option"]'),
			).find((row) => row.textContent?.includes("Agency account"))!;
			expect(option).toBeTruthy();
			await act(async () => {
				option.click();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(trigger.textContent).toContain(
				"Google · Agency account · Identity unavailable",
			);
			expect(trigger.textContent).not.toContain(account.connectionInstanceId);
			expect(mocks.listCalendars).toHaveBeenCalledWith(
				{
					adapter: "google",
					providerId: account.providerId,
					connectionScope: "user",
					connectionInstanceId: account.connectionInstanceId,
				},
				expect.anything(),
			);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
			expect(node.textContent).toContain(message);
			expect(node.textContent).not.toContain(account.connectionInstanceId);
		} finally {
			await act(async () => root.unmount());
			queryClient.clear();
			node.remove();
		}
	});
});

const accountsOptions = () =>
	osQuery.calendarCoordinator.supportedAccounts.queryOptions({
		input: { scope: "user" },
	});
const calendarOptions = () =>
	osQuery.calendarCoordinator.listCalendars.queryOptions({
		input: {
			adapter: account.adapter,
			providerId: account.providerId,
			connectionScope: account.connectionScope,
			connectionInstanceId: account.connectionInstanceId,
		},
	});
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 30));
}
async function mounted(
	run: (ui: {
		client: QueryClient;
		node: HTMLDivElement;
		select: () => Promise<void>;
		render: (
			props?: Partial<Parameters<typeof CalendarResourcePicker>[0]>,
		) => Promise<void>;
		onSelect: ReturnType<typeof vi.fn>;
	}) => Promise<void>,
	cached = true,
) {
	mocks.supportedAccounts.mockReset().mockResolvedValue([account]);
	mocks.listCalendars
		.mockReset()
		.mockResolvedValue({ account, calendars: [calendar] });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	if (cached) client.setQueryData(accountsOptions().queryKey, [account]);
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	const onSelect = vi.fn();
	const render = async (props = {}) => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<CalendarResourcePicker onSelect={onSelect} {...props} />
				</QueryClientProvider>,
			);
			await flush();
		});
	};
	const select = async () => {
		await act(async () =>
			node
				.querySelector<HTMLButtonElement>(
					'[aria-label="Connected calendar account"]',
				)!
				.click(),
		);
		const option = document.querySelector<HTMLElement>('[role="option"]')!;
		await act(async () => {
			option.click();
			await flush();
		});
		await act(flush);
	};
	try {
		await render();
		await run({ client, node, select, render, onSelect });
	} finally {
		await act(async () => root.unmount());
		client.clear();
		node.remove();
	}
}
function button(node: HTMLElement, label: string) {
	return Array.from(node.querySelectorAll<HTMLButtonElement>("button")).find(
		(b) => b.textContent === label,
	)!;
}

describe("calendar discovery recovery", () => {
	it("recovers a cold accounts error only through Retry accounts without selecting", async () => {
		await mounted(async ({ client, node, onSelect }) => {
			mocks.supportedAccounts.mockRejectedValueOnce(
				new Error("accounts offline"),
			);
			await act(async () => {
				await client.resetQueries(accountsOptions());
				await flush();
			});
			expect(button(node, "Retry accounts")).toBeTruthy();
			expect(
				node.querySelector<HTMLButtonElement>(
					'[aria-label="Connected calendar account"]',
				)!.disabled,
			).toBe(true);
			await act(async () => {
				button(node, "Retry accounts").click();
				await flush();
			});
			await act(flush);
			expect(button(node, "Retry accounts")).toBeUndefined();
			expect(onSelect).not.toHaveBeenCalled();
			expect(mocks.listCalendars).not.toHaveBeenCalled();
		}, false);
	});
	it.each(["accounts", "calendars"])(
		"fences cached %s errors and pending retries, preserving exact choice after recovery",
		async (read) => {
			await mounted(async ({ client, node, select, onSelect }) => {
				await select();
				expect(button(node, "Choose calendar").disabled).toBe(false);
				const mock =
					read === "accounts" ? mocks.supportedAccounts : mocks.listCalendars;
				mock.mockRejectedValueOnce(new Error(`${read} offline`));
				await act(async () => {
					if (read === "accounts")
						await client.refetchQueries(accountsOptions());
					else await client.refetchQueries(calendarOptions());
					await flush();
				});
				expect(node.textContent).toContain(calendar.name);
				expect(button(node, "Choose calendar").disabled).toBe(true);
				let resolve!: (value: unknown) => void;
				mock.mockImplementationOnce(
					() =>
						new Promise((r) => {
							resolve = r;
						}),
				);
				await act(async () => {
					button(node, `Retry ${read}`).click();
					await flush();
				});
				expect(button(node, "Choose calendar").disabled).toBe(true);
				expect(button(node, `Retry ${read}`).disabled).toBe(true);
				await act(async () => {
					resolve(
						read === "accounts"
							? [account]
							: { account, calendars: [calendar] },
					);
					await flush();
				});
				await act(flush);
				expect(onSelect).not.toHaveBeenCalled();
				expect(button(node, "Choose calendar").disabled).toBe(false);
				await act(async () => button(node, "Choose calendar").click());
				expect(onSelect).toHaveBeenCalledExactlyOnceWith({ account, calendar });
			});
		},
	);
	it("retries a cold calendars error independently and respects disabled on every control", async () => {
		await mounted(async ({ node, select, render, onSelect }) => {
			mocks.listCalendars.mockRejectedValueOnce(new Error("calendar offline"));
			await select();
			expect(button(node, "Retry calendars")).toBeTruthy();
			await render({ disabled: true });
			expect(
				Array.from(node.querySelectorAll("button")).every((b) => b.disabled),
			).toBe(true);
			await render();
			await act(async () => {
				button(node, "Retry calendars").click();
				await flush();
			});
			await act(flush);
			expect(onSelect).not.toHaveBeenCalled();
			expect(button(node, "Choose calendar").disabled).toBe(false);
			await render({ disabled: true });
			expect(button(node, "Choose calendar").disabled).toBe(true);
		});
	});
	it("rejects a response whose account identity differs from the selected account", async () => {
		await mounted(async ({ node, select, onSelect }) => {
			mocks.listCalendars.mockResolvedValueOnce({
				account: { ...account, connectionScope: "tenant" },
				calendars: [calendar],
			});
			await select();
			expect(button(node, "Choose calendar")).toBeUndefined();
			expect(onSelect).not.toHaveBeenCalled();
		});
	});
	it.each(["provider", "scope", "tokenScope"])(
		"does not reuse a deferred old account response after changing %s",
		async (change) => {
			await mounted(async ({ node, select, render, onSelect }) => {
				let resolve!: (value: unknown) => void;
				mocks.listCalendars.mockImplementationOnce(
					() =>
						new Promise((r) => {
							resolve = r;
						}),
				);
				await select();
				if (change === "scope")
					await act(async () => {
						button(node, "Organization accounts").click();
						await flush();
					});
				else
					await render(
						change === "provider"
							? { providerId: "other-provider" }
							: { tokenScope: "tenant" },
					);
				await act(async () => {
					resolve({ account, calendars: [calendar] });
					await flush();
				});
				await act(flush);
				expect(button(node, "Choose calendar")).toBeUndefined();
				expect(node.textContent).not.toContain(calendar.name);
				expect(onSelect).not.toHaveBeenCalled();
			});
		},
	);
});

it("ignores delayed account discovery from the previous scope", async () => {
	await mounted(async ({ client, node, onSelect }) => {
		let resolve!: (value: unknown) => void;
		mocks.supportedAccounts.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		let pending!: Promise<void>;
		await act(async () => {
			pending = client.refetchQueries(accountsOptions());
			await flush();
		});
		await act(async () => {
			button(node, "Organization accounts").click();
			await flush();
		});
		await act(async () => {
			resolve([account]);
			await pending;
			await flush();
		});
		expect(
			node.querySelector('[aria-label="Connected calendar account"]')!
				.textContent,
		).toContain("Choose an account");
		expect(button(node, "Choose calendar")).toBeUndefined();
		expect(onSelect).not.toHaveBeenCalled();
		expect(mocks.listCalendars).not.toHaveBeenCalled();
	});
});
