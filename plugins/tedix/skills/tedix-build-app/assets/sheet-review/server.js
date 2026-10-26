export class App {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	async cards() {
		const settings = this.env.CONFIG.settings;
		const { revision } = await this.env.TEDIX.outputsRead(settings.slot, {});
		const sheet = revision.content;
		if (sheet.kind !== "sheet")
			throw new Error("Bitte eine Tabelle verbinden.");
		const columns = ["id", "title", "body", "category"].map((name) =>
			sheet.columns.indexOf(settings.columns[name]),
		);
		if (columns.some((index) => index < 0))
			throw new Error("Bitte die Spalten in den Einstellungen prüfen.");
		const ids = new Set();
		return sheet.rows.map((row) => {
			const [id, title, body, category] = columns.map((index) =>
				String(row[index] ?? ""),
			);
			if (!id || ids.has(id))
				throw new Error("Jede Karte braucht eine eindeutige ID.");
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
			throw new Error("Ungültige Bewertung.");
		if (!(await this.cards()).some((card) => card.id === id))
			throw new Error("Karte nicht gefunden.");
		this.ctx.storage.kv.put(`review:${id}`, verdict);
		return { id, verdict };
	}

	reset() {
		for (const [key] of this.ctx.storage.kv.list({ prefix: "review:" }))
			this.ctx.storage.kv.delete(key);
		return { reset: true };
	}
}
