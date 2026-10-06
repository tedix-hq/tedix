export const MESSAGE_QUEUE_LIMIT = 5;

export class MessageQueue {
	#items: string[] = [];
	#cancelArmed = false;

	get size(): number {
		return this.#items.length;
	}

	get cancelArmed(): boolean {
		return this.#cancelArmed;
	}

	list(): string[] {
		return [...this.#items];
	}

	enqueue(message: string): boolean {
		if (!message.trim() || this.#items.length >= MESSAGE_QUEUE_LIMIT)
			return false;
		this.#items.push(message);
		this.#cancelArmed = false;
		return true;
	}

	takeNext(): string | undefined {
		this.#cancelArmed = false;
		return this.#items.shift();
	}

	restoreNext(message: string): void {
		this.#items.unshift(message);
	}

	armCancel(): boolean {
		if (this.#cancelArmed) return false;
		this.#cancelArmed = true;
		return true;
	}

	disarmCancel(): void {
		this.#cancelArmed = false;
	}
}
