import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const LCO_BASELINE_AGGREGATOR_VERSION = 1 as const;

interface SessionRecord {
	type?: string;
	message?: { role?: string; toolName?: string };
}

interface ReplayFixture {
	streams?: readonly { stream_id?: string; path?: string; pages?: number }[];
}

export function aggregateCommanderSessionJsonl(text: string) {
	let commanderRequests = 0;
	let toolResults = 0;
	const toolCalls: Record<string, number> = {};
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const record = JSON.parse(line) as SessionRecord;
		if (record.type !== "message") continue;
		if (record.message?.role === "assistant") commanderRequests += 1;
		if (record.message?.role !== "toolResult") continue;
		toolResults += 1;
		const name = record.message.toolName ?? "unknown";
		toolCalls[name] = (toolCalls[name] ?? 0) + 1;
	}
	return Object.freeze({ commander_requests: commanderRequests, tool_results: toolResults, tool_calls: Object.freeze(toolCalls) });
}

export function summarizeReplayFixture(value: ReplayFixture) {
	const streams = value.streams ?? [];
	const uniquePaths = new Set(streams.map((stream) => stream.path));
	const pages = streams.reduce((total, stream) => total + (Number.isInteger(stream.pages) ? stream.pages! : 0), 0);
	const syntheticOnly = streams.every((stream) => stream.path?.startsWith("synthetic/") === true);
	return Object.freeze({ streams: streams.length, unique_paths: uniquePaths.size, pages, synthetic_only: syntheticOnly });
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function main(argv: readonly string[]): Promise<void> {
	const option = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index < 0 ? undefined : argv[index + 1];
	};
	const sessionPath = option("--session");
	const retrospectivePath = option("--retrospective");
	const fixturePath = option("--fixture");
	if (!sessionPath || !retrospectivePath || !fixturePath) {
		throw new Error("usage: lco-throughput-baseline --session <jsonl> --retrospective <json> --fixture <json>");
	}
	const [sessionBytes, retrospectiveBytes, fixtureBytes] = await Promise.all([
		readFile(resolve(sessionPath)),
		readFile(resolve(retrospectivePath)),
		readFile(resolve(fixturePath)),
	]);
	const session = aggregateCommanderSessionJsonl(sessionBytes.toString("utf8"));
	const retrospective = JSON.parse(retrospectiveBytes.toString("utf8")) as {
		snapshot?: { datasets?: { time_allocation?: readonly { minutes?: number }[]; commander_cost?: readonly { requests?: number }[] } };
	};
	const time = retrospective.snapshot?.datasets?.time_allocation ?? [];
	const requests = retrospective.snapshot?.datasets?.commander_cost ?? [];
	const fixture = summarizeReplayFixture(JSON.parse(fixtureBytes.toString("utf8")) as ReplayFixture);
	process.stdout.write(`${JSON.stringify({
		aggregator_version: LCO_BASELINE_AGGREGATOR_VERSION,
		source_hashes: { session: sha256(sessionBytes), retrospective: sha256(retrospectiveBytes), fixture: sha256(fixtureBytes) },
		commander: session,
		review_calls: session.tool_calls.workbench_review_worker_diff ?? 0,
		reviewed_request_classification_total: requests.reduce((sum, row) => sum + (row.requests ?? 0), 0),
		wall_clock_minutes: Number(time.reduce((sum, row) => sum + (row.minutes ?? 0), 0).toFixed(1)),
		fixture,
	}, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
	await main(process.argv.slice(2));
}
