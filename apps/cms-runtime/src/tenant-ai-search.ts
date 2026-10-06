import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	CmsRestoreFenceUnavailableError,
	withCmsRestorePermit,
} from "./tenant-restore-fence";
import {
	assertTenantAiSearchLogicalName,
	tenantAiSearchCreateConfig,
	tenantAiSearchUpdateConfig,
} from "./tenant-ai-search-policy";

type AiSearchItems = {
	upload(
		name: string,
		content: string,
		options?: { metadata?: Record<string, unknown> },
	): Promise<unknown>;
	delete(itemId: string): Promise<void>;
};
type AiSearchInstance = {
	info(): Promise<unknown>;
	update(config: Record<string, unknown>): Promise<unknown>;
	search(params: Record<string, unknown>): Promise<unknown>;
	items: AiSearchItems;
};
export interface TenantAiSearchNamespace {
	get(instanceId: string): AiSearchInstance;
	create(config: Record<string, unknown>): Promise<AiSearchInstance>;
}

interface TenantAiSearchEnv {
	AI_SEARCH: TenantAiSearchNamespace;
	PLATFORM_DB: D1Database;
}

interface TenantAiSearchProps {
	instanceId: string;
	siteId: string;
	slug: string;
	restoreEpoch: number;
}

async function withAiSearchPermit<T>(
	env: TenantAiSearchEnv,
	identity: TenantAiSearchProps,
	run: () => Promise<T>,
): Promise<T> {
	const result = await withCmsRestorePermit(
		createDbQueryClient(env.PLATFORM_DB),
		identity,
		run,
	);
	if (!result.admitted) throw new CmsRestoreFenceUnavailableError();
	return result.value;
}

class TenantAiSearchItems extends RpcTarget {
	constructor(
		private readonly items: AiSearchItems,
		private readonly env: TenantAiSearchEnv,
		private readonly identity: TenantAiSearchProps,
	) {
		super();
	}
	upload(
		name: string,
		content: string,
		options?: { metadata?: Record<string, unknown> },
	) {
		return withAiSearchPermit(this.env, this.identity, () =>
			this.items.upload(name, content, options),
		);
	}
	delete(itemId: string) {
		return withAiSearchPermit(this.env, this.identity, () =>
			this.items.delete(itemId),
		);
	}
}

class TenantAiSearchInstance extends RpcTarget {
	private readonly itemOperations: TenantAiSearchItems;
	constructor(
		private readonly instance: AiSearchInstance,
		private readonly env: TenantAiSearchEnv,
		private readonly identity: TenantAiSearchProps,
	) {
		super();
		this.itemOperations = new TenantAiSearchItems(
			instance.items,
			env,
			identity,
		);
	}
	get items() {
		// RpcTarget hides instance properties across the RPC boundary. A prototype
		// getter is required so the tenant can pipeline `instance.items.upload()`
		// through this capability without exposing the native namespace itself.
		return this.itemOperations;
	}
	info() {
		return this.instance.info();
	}
	update(config: Record<string, unknown>) {
		const validated = tenantAiSearchUpdateConfig(config);
		return withAiSearchPermit(this.env, this.identity, () =>
			this.instance.update(validated),
		);
	}
	search(params: Record<string, unknown>) {
		return this.instance.search(params);
	}
}

export class TenantAiSearch extends WorkerEntrypoint<
	TenantAiSearchEnv,
	TenantAiSearchProps
> {
	get(logicalName: string) {
		assertTenantAiSearchLogicalName(logicalName);
		return new TenantAiSearchInstance(
			this.env.AI_SEARCH.get(this.ctx.props.instanceId),
			this.env,
			this.ctx.props,
		);
	}
	async create(config: Record<string, unknown>) {
		const validated = tenantAiSearchCreateConfig(
			config,
			this.ctx.props.instanceId,
		);
		return new TenantAiSearchInstance(
			await withAiSearchPermit(this.env, this.ctx.props, () =>
				this.env.AI_SEARCH.create(validated),
			),
			this.env,
			this.ctx.props,
		);
	}
}
