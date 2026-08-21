#!/usr/bin/env node
/**
 * Deterministic pixel-art banner generator for pi-dev-workbench.
 *
 * Renders `assets/banner.svg` from a 5x7 bitmap font — every "pixel" is an
 * SVG <rect>, so the image has zero font/network dependencies and renders
 * identically everywhere (GitHub included). The version chip is read from
 * package.json, so the banner can never drift from the package version.
 *
 * Design (product refresh): a compact Pi product card beside a development-
 * first terminal. The visual hierarchy is product name first, outcome second,
 * with the AUDIT → DEV → VERIFY pipeline and Sol → Luna collaboration kept as
 * small status chips. No scripts, external references, foreignObject, event
 * handlers, gradients, or fonts — only deterministic <rect> pixels.
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

export function buildBanner(version) {
	const width = 720;
	const height = 240;
	const barH = 4;

	const rects = [];

	// Solid terminal background and restrained frame.
	rects.push(`<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`);
	rects.push(`<rect width="${width}" height="${barH}" fill="${COLORS.accent}" fill-opacity="0.5"/>`);
	rects.push(`<rect y="${height - barH}" width="${width}" height="${barH}" fill="${COLORS.accent}" fill-opacity="0.5"/>`);

	// Left product tile: a small, unmistakable Pi-native mark.
	rects.push(`<rect x="32" y="32" width="146" height="150" fill="${COLORS.chipBg}"/>`);
	rects.push(`<rect x="34" y="34" width="142" height="146" fill="none" stroke="${COLORS.accent}" stroke-width="3"/>`);
	rects.push(`<rect x="32" y="32" width="12" height="12" fill="${COLORS.cursor}"/>`);
	rects.push(`<rect x="166" y="170" width="12" height="12" fill="${COLORS.cursor}"/>`);
	putText(rects, "PI", 9, 51, 51, COLORS.accent);
	putText(rects, "NATIVE", 2, 69, 136, COLORS.tag);
	for (const [x, color] of [[79, COLORS.tag], [99, COLORS.cursor], [119, COLORS.accent]]) {
		rects.push(`<rect x="${x}" y="163" width="8" height="8" fill="${color}"/>`);
	}

	// Pixel connector from the Pi tile into the product terminal.
	putText(rects, ">", 3, 187, 92, COLORS.cursor);

	// Product hierarchy: positioning statement, name, then outcome.
	putText(rects, "DEVELOPMENT FIRST", 3, 218, 28, COLORS.cursor);
	putText(rects, "WORKBENCH", 7, 218, 67, COLORS.accent);
	rects.push(`<rect x="606" y="67" width="14" height="49" fill="${COLORS.cursor}"/>`);
	putText(rects, "SHIP FAST · VERIFY ONCE", 3, 218, 137, COLORS.tag);

	// Small status chips keep implementation detail subordinate to the product.
	const putChip = (x, w, label, color) => {
		rects.push(`<rect x="${x}" y="190" width="${w}" height="29" fill="${COLORS.chipBg}"/>`);
		rects.push(`<rect x="${x + 1}" y="191" width="${w - 2}" height="27" fill="none" stroke="${color}" stroke-width="2"/>`);
		putText(rects, label, 2, x + 8, 198, color);
	};
	putChip(32, 100, `V${version}`, COLORS.cursor);
	putChip(148, 256, "AUDIT > DEV > VERIFY", COLORS.tag);
	putChip(420, 136, "SOL > LUNA", COLORS.accent);
	putChip(572, 116, "✓ PASS", COLORS.accent);

	const viewBox = `0 0 ${width} ${height}`;
	const body = rects.join("\n");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" shape-rendering="crispEdges" role="img" aria-label="pi-dev-workbench v${version} — development-first Pi workbench with Sol and Luna, evidence-backed delivery">\n${body}\n</svg>\n`;
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
	const px = GLYPH_W + 1;
	const lines = [
		"PI  DEVELOPMENT FIRST",
		"WORKBENCH",
		"SHIP FAST · VERIFY ONCE",
		`V${version}  AUDIT > DEV > VERIFY  SOL > LUNA  ✓ PASS`,
	];
	const width = Math.max(...lines.map((line) => line.length * px));
	const grid = Array.from({ length: (GLYPH_H + 1) * lines.length - 1 }, () => Array(width).fill(" "));
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
	lines.forEach((line, index) => draw(line, index * (GLYPH_H + 1), 0));
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
