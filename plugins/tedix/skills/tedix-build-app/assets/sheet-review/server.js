export class App {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	async cards() {
		const settings = this.env.CONFIG.settings;
		const { revision } = await this.env.TEDIX.outputsRead(settings.slot, {});
		const sheet = revision.content;
		if (sheet.kind !== "sheet") throw new Error("not_a_sheet");
		const columns = ["id", "title", "body", "category"].map((name) =>
			sheet.columns.indexOf(settings.columns[name]),
		);
		if (columns.some((index) => index < 0)) throw new Error("columns_missing");
		const ids = new Set();
		return sheet.rows.map((row) => {
			const [id, title, body, category] = columns.map((index) =>
				String(row[index] ?? ""),
			);
			if (!id || ids.has(id)) throw new Error("duplicate_id");
			ids.add(id);
			return {
				id,
				title,
				body,
				category,
				verdict: this.ctx.storage.kv.get(`review:${id}`) ?? null,
			};
		});
	}

	async rate(id, verdict) {
		if (!["useful", "not_useful"].includes(verdict))
			throw new Error("bad_verdict");
		if (!(await this.cards()).some((card) => card.id === id))
			throw new Error("card_not_found");
		this.ctx.storage.kv.put(`review:${id}`, verdict);
		return { id, verdict };
	}

	reset() {
		for (const [key] of this.ctx.storage.kv.list({ prefix: "review:" }))
			this.ctx.storage.kv.delete(key);
		return { reset: true };
	}
}
