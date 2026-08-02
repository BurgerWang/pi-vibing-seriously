/**
 * P6-A canonical hashing — stable SHA-256 digests for context fingerprints.
 *
 * Canonical serialization rules (documented, tested):
 *   - object keys are sorted (insertion order is ignored)
 *   - array order is preserved (arrays are ordered by definition)
 *   - `undefined` is normalized to the bare token `undefined` (unquoted).
 *     JSON.stringify output is always valid JSON, so no real string can
 *     ever serialize to the unquoted text `undefined` — the marker is
 *     collision-free by construction. The canonical form is a deterministic
 *     TEXT form (it is hashed, never parsed back).
 *   - `null` stays `null`
 *   - numbers must be finite (NaN/±Infinity are rejected — they serialize
 *     unpredictably); -0 normalizes to 0 via JSON.stringify
 *   - `Date` is REJECTED: implicit locale/toString serialization is not
 *     allowed; callers must convert to an ISO string first
 *   - functions, symbols, bigint, Map, Set, WeakMap, WeakSet, typed arrays
 *     and other non-JSON values are rejected (never silently coerced)
 *
 * Everything here is pure and synchronous; node:crypto SHA-256 only.
 */

import { createHash } from "node:crypto";

/** Marker for `undefined` inside canonical text (see file header). */
export const UNDEFINED_TOKEN = "undefined";

/** Thrown when a value cannot be serialized canonically. */
export class NonSerializableValueError extends Error {
	constructor(value: unknown) {
		const kind = value instanceof Date ? "Date" : typeof value;
		super(`non-JSON value of type "${kind}" cannot be hashed canonically (convert it to a JSON-safe form first)`);
		this.name = "NonSerializableValueError";
	}
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 hex digest of raw bytes (binary-safe, e.g. lockfiles). */
export function sha256HexBytes(input: Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}

/** Canonical JSON string: sorted keys, preserved array order, explicit undefined. */
export function canonicalJson(value: unknown): string {
	return serialize(value);
}

/** SHA-256 of the canonical JSON form of a value. */
export function canonicalHash(value: unknown): string {
	return sha256Hex(canonicalJson(value));
}

/** Hash a session id (file path or id string) — truncated for storage. */
export function hashSessionId(id: string): string {
	return sha256Hex(id).slice(0, 16);
}

function serialize(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new NonSerializableValueError(value);
			// JSON.stringify(-0) === "0": -0 canonicalizes to 0.
			return JSON.stringify(value);
		case "undefined":
			// Bare token: JSON.stringify always quotes strings, so no real value
			// can serialize to this unquoted text — collision-free by design.
			return UNDEFINED_TOKEN;
		case "bigint":
		case "function":
		case "symbol":
			throw new NonSerializableValueError(value);
		case "object": {
			if (value instanceof Date) throw new NonSerializableValueError(value);
			if (Array.isArray(value)) {
				return `[${value.map(serialize).join(",")}]`;
			}
			if (
				value instanceof Map ||
				value instanceof Set ||
				value instanceof WeakMap ||
				value instanceof WeakSet ||
				value instanceof ArrayBuffer ||
				value instanceof Uint8Array ||
				value instanceof DataView
			) {
				throw new NonSerializableValueError(value);
			}
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record).sort();
			return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k])}`).join(",")}}`;
		}
		default:
			throw new NonSerializableValueError(value);
	}
}
