/** Append-only session cost aggregation used by frequent footer refreshes. */

import {
	buildCostBreakdown,
	mergeCostBreakdowns,
	type CostBreakdown,
} from "./cost-breakdown.ts";

export class RuntimeCostBreakdownCache {
	private entryCount = 0;
	private lastEntry: unknown;
	private value = buildCostBreakdown([]);
	private persistedMessageObjects = new WeakSet<object>();
	private persistedMessageFacts = new Map<unknown, Set<unknown>>();
	private scannedEntries = 0;
	private rebuilds = 0;

	private rememberMessages(entries: readonly unknown[]): void {
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			if (record.type !== "message" || typeof record.message !== "object" || record.message === null) continue;
			const message = record.message as Record<string, unknown>;
			this.persistedMessageObjects.add(message);
			if (message.timestamp === undefined) continue;
			const roles = this.persistedMessageFacts.get(message.timestamp) ?? new Set<unknown>();
			roles.add(message.role);
			this.persistedMessageFacts.set(message.timestamp, roles);
		}
	}

	private pendingPersisted(pendingMessage: unknown): boolean {
		if (typeof pendingMessage !== "object" || pendingMessage === null) return false;
		if (this.persistedMessageObjects.has(pendingMessage)) return true;
		const pending = pendingMessage as Record<string, unknown>;
		return pending.timestamp !== undefined
			&& this.persistedMessageFacts.get(pending.timestamp)?.has(pending.role) === true;
	}

	read(entries: readonly unknown[], pendingMessage?: unknown): CostBreakdown {
		const appendOnly = this.entryCount === 0 || (
			entries.length >= this.entryCount && entries[this.entryCount - 1] === this.lastEntry
		);
		if (!appendOnly) {
			this.value = buildCostBreakdown(entries);
			this.persistedMessageObjects = new WeakSet<object>();
			this.persistedMessageFacts = new Map<unknown, Set<unknown>>();
			this.rememberMessages(entries);
			this.scannedEntries += entries.length;
			this.rebuilds += 1;
		} else if (entries.length > this.entryCount) {
			const suffix = entries.slice(this.entryCount);
			this.rememberMessages(suffix);
			// Fold entries in their original order. Aggregating a multi-entry
			// suffix first would change floating-point grouping, making the exact
			// result depend on refresh batch boundaries (.1 + (.2 + .3) versus
			// (.1 + .2) + .3).
			for (const entry of suffix) {
				this.value = mergeCostBreakdowns(this.value, buildCostBreakdown([entry]));
			}
			this.scannedEntries += suffix.length;
		}
		this.entryCount = entries.length;
		this.lastEntry = entries.at(-1);
		const pendingPersisted = pendingMessage !== undefined && this.pendingPersisted(pendingMessage);
		return pendingMessage !== undefined && !pendingPersisted
			? mergeCostBreakdowns(this.value, buildCostBreakdown([], pendingMessage))
			: this.value;
	}

	inspectWork(): Readonly<{ scannedEntries: number; rebuilds: number }> {
		return Object.freeze({ scannedEntries: this.scannedEntries, rebuilds: this.rebuilds });
	}
}
