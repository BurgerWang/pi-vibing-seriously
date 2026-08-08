#!/usr/bin/env node
/**
 * Deterministic pixel-art banner generator for pi-dev-workbench.
 *
 * Renders `assets/banner.svg` from a 5x7 bitmap font — every "pixel" is an
 * SVG <rect>, so the image has zero font/network dependencies and renders
 * identically everywhere (GitHub included). The version chip is read from
 * package.json, so the banner can never drift from the package version.
 *
 * Design (v0.9 refresh): a "workbench terminal" — solid dark background with
 * top/bottom accent bars, the three mode chips (AUDIT / DEV / VERIFY), the
 * WORKBENCH title with a terminal cursor, and a bottom row carrying a
 * checkmark and the package version chip. No scripts, no external
 * references, no foreignObject, no event handlers — only <rect> elements.
 *
 * Usage:
 *   node tools/make-banner.mjs            # write assets/banner.svg
 *   node tools/make-banner.mjs --out /tmp/banner.svg
 *   node tools/make-banner.mjs --preview  # ASCII preview in the terminal
 *
 * The output is deterministic: same input → byte-identical SVG (tests
 * regenerate it and byte-compare against the committed file).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DEFAULT = join(ROOT, "assets", "banner.svg");

// ---------------------------------------------------------------------------
// 5x7 bitmap font (rows are 5-bit values, MSB = leftmost column)
// ---------------------------------------------------------------------------

const FONT = {
	A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
	B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
	C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
	D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
	E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
	F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
	G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
	H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
	I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
	J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
	K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
	L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
	M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
	N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
	O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
	P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
	Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
	R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
	S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
	T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
	U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
	V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
	W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
	X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
	Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
	Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
	"0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
	"1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
	"2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
	"3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
	"4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
	"5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
	"6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
	"7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
	"8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
	"9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
	"-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
	".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
	"_": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
	">": [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
	"·": [0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00],
	"✓": [0x00, 0x01, 0x01, 0x02, 0x04, 0x18, 0x10],
	" ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

function glyphRows(ch) {
	return FONT[ch] ?? FONT["?"] ?? FONT[" "];
}

// ---------------------------------------------------------------------------
// banner model
// ---------------------------------------------------------------------------

// Pi TUI palette: teal accents on a dark navy background.
const COLORS = {
	bg: "#0e1628", // solid background (no checkerboard)
	chipBg: "#121c33", // mode chip fill
	accent: "#8abeb7", // pi teal — bars, title, VERIFY chip, checkmark
	tag: "#7d93b5", // slate — tagline, AUDIT chip
	cursor: "#e8b64c", // amber — terminal cursor, DEV chip, version chip
};

// The three mode chips mirror the workbench's AUDIT / DEV / VERIFY policy.
const MODES = [
	{ label: "AUDIT", color: "#7d93b5" },
	{ label: "DEV", color: "#e8b64c" },
	{ label: "VERIFY", color: "#8abeb7" },
];

export function buildBanner(version) {
	const title = "WORKBENCH";
	const tag = "RECIPES · GATES · EVIDENCE";
	const versionChip = `V${version}`;

	const titleScale = 9;
	const titlePitchX = (GLYPH_W + 1) * titleScale; // 54
	const tagScale = 3;
	const tagPitchX = (GLYPH_W + 1) * tagScale; // 18
	const margin = 26;
	const barH = 3;
	const cursorW = titleScale * 2; // 2px-wide terminal cursor block

	const titleW = title.length * titlePitchX; // 486
	const tagW = tag.length * tagPitchX; // 468
	const chipW = versionChip.length * tagPitchX; // 108
	const checkW = GLYPH_W * tagScale; // 15

	// The bottom row (tagline + checkmark + version chip) is the widest band.
	const bottomRowW = margin + tagW + 12 + checkW + 6 + chipW + margin;
	const titleRowW = titleW + 12 + cursorW;
	const width = Math.max(bottomRowW, titleRowW); // 661

	// Vertical layout: chips / title / bottom row.
	const chipTop = 24;
	const chipH = GLYPH_H * tagScale + 12; // 33
	const titleTop = chipTop + chipH + 20; // 77
	const bottomTop = titleTop + GLYPH_H * titleScale + 18; // 158
	const height = bottomTop + GLYPH_H * tagScale + margin + 2 + barH; // 210

	const rects = [];

	// solid background + top/bottom accent bars
	rects.push(`<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`);
	rects.push(`<rect width="${width}" height="${barH}" fill="${COLORS.accent}" fill-opacity="0.5"/>`);
	rects.push(`<rect y="${height - barH}" width="${width}" height="${barH}" fill="${COLORS.accent}" fill-opacity="0.5"/>`);

	// mode chips (AUDIT / DEV / VERIFY)
	const chipPadX = 7;
	const chipGap = 16;
	const chipRowW = MODES.reduce((w, m) => w + m.label.length * tagPitchX + 2 * chipPadX, 0) + (MODES.length - 1) * chipGap;
	let chipX = Math.round((width - chipRowW) / 2);
	for (const mode of MODES) {
		const w = mode.label.length * tagPitchX + 2 * chipPadX;
		rects.push(`<rect x="${chipX}" y="${chipTop}" width="${w}" height="${chipH}" fill="${COLORS.chipBg}"/>`);
		rects.push(`<rect x="${chipX + 1}" y="${chipTop + 1}" width="${w - 2}" height="${chipH - 2}" fill="none" stroke="${mode.color}" stroke-width="2"/>`);
		putText(rects, mode.label, tagScale, chipX + chipPadX, chipTop + 6, mode.color);
		chipX += w + chipGap;
	}

	// title + terminal cursor
	const titleX = Math.round((width - titleW) / 2);
	putText(rects, title, titleScale, titleX, titleTop, COLORS.accent);
	rects.push(`<rect x="${titleX + titleW + 12}" y="${titleTop}" width="${cursorW}" height="${GLYPH_H * titleScale}" fill="${COLORS.cursor}"/>`);

	// tagline (left) + checkmark + version chip (right) on one baseline
	const versionChipX = width - margin - chipW;
	const checkX = versionChipX - 6 - checkW;
	putText(rects, tag, tagScale, margin, bottomTop, COLORS.tag);
	putText(rects, "✓", tagScale, checkX, bottomTop, COLORS.accent);
	putText(rects, versionChip, tagScale, versionChipX, bottomTop, COLORS.cursor);

	const viewBox = `0 0 ${width} ${height}`;
	const body = rects.join("\n");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" shape-rendering="crispEdges" role="img" aria-label="pi-dev-workbench v${version} — Pi-native workbench: AUDIT / DEV / VERIFY modes, recipes, gates and evidence">\n${body}\n</svg>\n`;
	return { svg, width, height, version };
}

function putText(rects, text, scale, x0, y0, color) {
	let x = x0;
	for (const ch of text) {
		const rows = glyphRows(ch);
		for (let row = 0; row < GLYPH_H; row++) {
			const bits = rows[row] ?? 0;
			for (let col = 0; col < GLYPH_W; col++) {
				if ((bits >> (GLYPH_W - 1 - col)) & 1) {
					rects.push(`<rect x="${x + col * scale}" y="${y0 + row * scale}" width="${scale}" height="${scale}" fill="${color}"/>`);
				}
			}
		}
		x += (GLYPH_W + 1) * scale;
	}
}

// ---------------------------------------------------------------------------
// ASCII preview (sanity check in the terminal)
// ---------------------------------------------------------------------------

function asciiPreview(version) {
	const title = "WORKBENCH";
	const tag = "RECIPES · GATES · EVIDENCE";
	const chip = `V${version}`;
	const px = GLYPH_W + 1; // 6
	const modesRowW = MODES.reduce((w, m) => w + m.label.length * px, 0) + (MODES.length - 1) * 3;
	const width = Math.max(modesRowW, tag.length * px + 4 + chip.length * px);
	const grid = Array.from({ length: (GLYPH_H + 1) * 3 + 1 }, () => Array(width).fill(" "));
	const draw = (text, row0, col0) => {
		let x = col0;
		for (const ch of text) {
			const rows = glyphRows(ch);
			for (let r = 0; r < GLYPH_H; r++) {
				const bits = rows[r] ?? 0;
				for (let c = 0; c < GLYPH_W; c++) {
					if ((bits >> (GLYPH_W - 1 - c)) & 1) grid[row0 + r][x + c] = "#";
				}
			}
			x += px;
		}
	};
	let col = 0;
	for (const mode of MODES) {
		draw(mode.label, 0, col);
		col += mode.label.length * px + 3;
	}
	draw(title, 8, 0);
	draw(tag, 16, 0);
	draw(chip, 16, tag.length * px + 4);
	return grid.map((row) => row.join("").replace(/\s+$/, "")).join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
	const args = process.argv.slice(2);
	const outFlag = args.indexOf("--out");
	const out = outFlag !== -1 && args[outFlag + 1] ? args[outFlag + 1] : OUT_DEFAULT;
	const preview = args.includes("--preview");

	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const version = pkg.version;
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected version format: ${version}`);

	if (preview) {
		process.stdout.write(asciiPreview(version) + "\n");
		return;
	}

	const { svg, width, height } = buildBanner(version);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, svg, "utf8");
	process.stdout.write(`wrote ${out} (${width}x${height}, v${version})\n`);
}

// Import-safe CLI entry: importing this module (e.g. from the release-asset
// tests) must not execute the CLI. Only a direct `node tools/make-banner.mjs`
// invocation (with or without --preview/--out) runs main().
const isDirectRun =
	process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) main();
