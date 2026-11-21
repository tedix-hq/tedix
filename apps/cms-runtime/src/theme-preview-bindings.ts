import { WorkerEntrypoint } from "cloudflare:workers";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	type EmDashDBStub,
	type DoQueryStatement,
	PLAIN_SELECT_PATTERN,
} from "./emdash-db";
import type { Env } from "./env";
import { withSharedCmsRestorePermit } from "./tenant-restore-fence";
import { CF_API } from "./tenant-media";
import { r2RestHeaders } from "./r2-rest";

export interface ThemePreviewProps {
	siteId: string;
	slug: string;
	restoreEpoch: number;
	expiresAt: string;
	bucketName: string;
}

function requirePreviewSelect(sql: string) {
	if (!PLAIN_SELECT_PATTERN.test(sql) || sql.includes(";"))
		throw new Error("Theme preview database is read-only");
}

export class ThemePreviewDatabase extends WorkerEntrypoint<
	Env,
	ThemePreviewProps
> {
	private stub() {
		if (Date.parse(this.ctx.props.expiresAt) <= Date.now())
			throw new Error("Theme candidate expired");
		return durableObjectStubByName(
			this.env.DB_DO,
			this.env,
			this.ctx.props.slug,
		) as unknown as EmDashDBStub;
	}
	async query(sql: string, params?: unknown[], opts?: { bookmark?: string }) {
		requirePreviewSelect(sql);
		return this.stub().queryWithRestorePermit(
			this.ctx.props,
			sql,
			params,
			opts,
		);
	}
	async batchQuery(
		statements: DoQueryStatement[],
		opts?: { bookmark?: string },
	) {
		for (const statement of statements) requirePreviewSelect(statement.sql);
		return this.stub().batchQueryWithRestorePermit(
			this.ctx.props,
			statements,
			opts,
		);
	}
}

/** No write/list surface and no credentials are exposed to the candidate. */
export class ThemePreviewMedia extends WorkerEntrypoint<
	Env,
	ThemePreviewProps
> {
	async get(key: string) {
		if (Date.parse(this.ctx.props.expiresAt) <= Date.now())
			throw new Error("Theme candidate expired");
		return withSharedCmsRestorePermit(this.env, this.ctx.props, async () => {
			const response = await fetch(
				`${CF_API}/accounts/${this.env.CF_ACCOUNT_ID}/r2/buckets/${this.ctx.props.bucketName}/objects/${encodeURIComponent(key)}`,
				{
					headers: r2RestHeaders(
						this.env.CLOUDFLARE_R2_API_TOKEN,
						this.env.CF_R2_JURISDICTION,
					),
				},
			);
			if (response.status === 404) return null;
			if (!response.ok)
				throw new Error(`Preview media read failed: ${response.status}`);
			const bytes = await response.arrayBuffer();
			return {
				body: new Blob([bytes]).stream(),
				size: bytes.byteLength,
				httpEtag: response.headers.get("etag") ?? "",
				httpMetadata: {
					contentType: response.headers.get("content-type") ?? undefined,
				},
			};
		});
	}
}

/** Astro can use a session, but a preview never reads or persists a live one. */
export class ThemePreviewSession extends WorkerEntrypoint<Env> {
	async get(_key: string): Promise<null> {
		return null;
	}
	async put(_key: string, _value: string): Promise<void> {}
	async delete(_key: string): Promise<void> {}
}
