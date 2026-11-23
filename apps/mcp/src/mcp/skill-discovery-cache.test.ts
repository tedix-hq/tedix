import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ApiClient } from "../lib/api-client";
import {
	getCachedOrgSkillDiscovery,
	invalidateOrgSkillDiscovery,
} from "./skill-discovery-cache";

const emptyPage = { entries: [], total: 0 };
function fixture() {
	let now = Date.now();
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const markers = new Map<string, string>();
	const get = vi.fn(async (key: string) => {
		const value = markers.get(key);
		return value ? { text: async () => value } : null;
	});
	const put = vi.fn(async (key: string, value: string) => {
		markers.set(key, value);
	});
	const listByOrg = vi.fn(async () => emptyPage);
	const input = {
		orgId: crypto.randomUUID(),
		env: { AGGREGATE_CACHE: { get, put } } as unknown as CloudflareEnv,
		apiClient: { skills: { listByOrg } } as unknown as ApiClient,
	};
	return {
		input,
		listByOrg,
		get,
		markers,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
afterEach(() => vi.restoreAllMocks());

it("coalesces concurrent discovery across requests, partitions organizations, and expires rows", async () => {
	const { input, listByOrg, advance } = fixture();
	await Promise.all(
		Array.from({ length: 20 }, () => getCachedOrgSkillDiscovery({ ...input })),
	);
	expect(listByOrg).toHaveBeenCalledTimes(1);
	expect(listByOrg).toHaveBeenCalledWith({
		visibility: "org",
		summary: true,
		limit: 200,
	});
	await getCachedOrgSkillDiscovery({ ...input, orgId: crypto.randomUUID() });
	expect(listByOrg).toHaveBeenCalledTimes(2);
	advance(60_001);
	await getCachedOrgSkillDiscovery(input);
	expect(listByOrg).toHaveBeenCalledTimes(3);
});

it("observes a remote write generation within five seconds and invalidates locally during a pending read", async () => {
	const { input, listByOrg, markers, advance } = fixture();
	await getCachedOrgSkillDiscovery(input);
	markers.set(`skill-discovery/v1/${input.orgId}`, "remote-write");
	advance(5_001);
	await getCachedOrgSkillDiscovery(input);
	expect(listByOrg).toHaveBeenCalledTimes(2);
	let finish!: (page: typeof emptyPage) => void;
	listByOrg.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await invalidateOrgSkillDiscovery(input.env, input.orgId);
	const pending = getCachedOrgSkillDiscovery(input);
	await vi.waitFor(() => expect(listByOrg).toHaveBeenCalledTimes(3));
	await invalidateOrgSkillDiscovery(input.env, input.orgId);
	await getCachedOrgSkillDiscovery(input);
	finish(emptyPage);
	await pending;
	await getCachedOrgSkillDiscovery(input);
	expect(listByOrg).toHaveBeenCalledTimes(4);
});

it("does not retain failed reads or use a cached page when its invalidation fence is unavailable", async () => {
	const { input, listByOrg, get, advance } = fixture();
	listByOrg.mockRejectedValueOnce(new Error("read unavailable"));
	await expect(getCachedOrgSkillDiscovery(input)).rejects.toThrow(
		"read unavailable",
	);
	await getCachedOrgSkillDiscovery(input);
	expect(listByOrg).toHaveBeenCalledTimes(2);
	advance(5_001);
	get.mockRejectedValue(new Error("marker unavailable"));
	await getCachedOrgSkillDiscovery(input);
	await getCachedOrgSkillDiscovery(input);
	expect(listByOrg).toHaveBeenCalledTimes(4);
	await getCachedOrgSkillDiscovery({ ...input, orgId: undefined });
	await getCachedOrgSkillDiscovery({ ...input, orgId: undefined });
	expect(listByOrg).toHaveBeenCalledTimes(6);
});
