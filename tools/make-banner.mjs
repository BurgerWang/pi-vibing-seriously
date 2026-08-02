#!/usr/bin/env node
/**
 * Deterministic pixel-art banner generator for pi-dev-workbench.
 *
 * Renders `assets/banner.svg` from a 5x7 bitmap font — every "pixel" is an
 * SVG <rect>, so the image has zero font/network dependencies and renders
 * identically everywhere (GitHub included). The version chip is read from
 * package.json, so the banner can never drift from the package version.
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
import { dirname, join } from "node:path";
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

// pi TUI accent color (rgb(138,190,183)) as the theme.
const COLORS = {
	bgA: "#0e1628", // checkerboard tone A
	bgB: "#121c33", // checkerboard tone B
	border: "#8abeb7",
	titleA: "#8abeb7", // "PI-DEV"
	titleB: "#d9f2ee", // "WORKBENCH"
	tag: "#7d93b5", // tagline
	cursor: "#e8b64c", // amber terminal cursor
	corner: "#8abeb7",
};

export function buildBanner(version) {
	const title1 = "PI-DEV";
	const title2 = "WORKBENCH";
	const tag = "PI-NATIVE DEV WORKBENCH";
	const versionChip = `V${version}`;

	const titleScale = 9;
	const titlePitchX = (GLYPH_W + 1) * titleScale; // 54
	const titlePitchY = (GLYPH_H + 1) * titleScale; // 72
	const tagScale = 3;
	const tagPitchX = (GLYPH_W + 1) * tagScale; // 18
	const tagPitchY = (GLYPH_H + 1) * tagScale; // 24
	const chipScale = 3;

	const margin = 26;
	const innerW = Math.max(title1.length, title2.length) * titlePitchX;
	const tagW = tag.length * tagPitchX;
	const chipW = versionChip.length * tagPitchX;
	const width = Math.max(innerW, tagW + chipW + 12) + 2 * margin;
	const titleTop = margin + 10;
	const line2Top = titleTop + titlePitchY;
	const tagTop = line2Top + titlePitchY + 8;
	const height = tagTop + GLYPH_H * tagScale + margin + 8;

	const rects = [];

	// checkerboard background via a 24x24 pattern tile (keeps the SVG small)
	const cell = 12;
	rects.push(`<defs><pattern id="checker" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">`);
	rects.push(`<rect width="${cell}" height="${cell}" fill="${COLORS.bgA}"/>`);
	rects.push(`<rect x="${cell}" width="${cell}" height="${cell}" fill="${COLORS.bgB}"/>`);
	rects.push(`<rect y="${cell}" width="${cell}" height="${cell}" fill="${COLORS.bgB}"/>`);
	rects.push(`<rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="${COLORS.bgA}"/>`);
	rects.push(`</pattern></defs>`);
	rects.push(`<rect width="${width}" height="${height}" fill="url(#checker)"/>`);
	// border (1px inside the canvas)
	rects.push(`<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="${COLORS.border}" stroke-opacity="0.45" stroke-width="2"/>`);

	// corner blocks
	const corner = 7;
	for (const [cx, cy] of [
		[5, 5],
		[width - 5 - corner, 5],
		[5, height - 5 - corner],
		[width - 5 - corner, height - 5 - corner],
	]) {
		rects.push(`<rect x="${cx}" y="${cy}" width="${corner}" height="${corner}" fill="${COLORS.corner}"/>`);
	}

	// title lines
	putText(rects, title1, titleScale, centerX(width, title1.length * titlePitchX), titleTop, COLORS.titleA);
	putText(rects, title2, titleScale, centerX(width, title2.length * titlePitchX), line2Top, COLORS.titleB);

	// tagline (left) + version chip (right) on the same baseline
	putText(rects, tag, tagScale, centerX(width - chipW - 12, tagW), tagTop, COLORS.tag);
	putText(rects, versionChip, chipScale, width - margin - chipW, tagTop, COLORS.cursor);

	// terminal cursor block after the tagline
	const cursorX = centerX(width - chipW - 12, tagW) + tagW + 2;
	rects.push(`<rect x="${cursorX}" y="${tagTop}" width="${tagScale * 3}" height="${GLYPH_H * tagScale}" fill="${COLORS.cursor}"/>`);

	const viewBox = `0 0 ${width} ${height}`;
	const body = rects.join("\n");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" shape-rendering="crispEdges" role="img" aria-label="pi-dev-workbench v${version} — a Pi-native development workbench">\n${body}\n</svg>\n`;
	return { svg, width, height, version };
}

function centerX(canvasW, textW) {
	return Math.round((canvasW - textW) / 2);
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
	const title1 = "PI-DEV";
	const title2 = "WORKBENCH";
	const tag = "PI-NATIVE DEV WORKBENCH";
	const chip = `V${version}`;
	const scale = 1;
	const px = (GLYPH_W + 1) * scale;
	const width = Math.max(title2.length, tag.length + chip.length) * px;
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
	draw(title1, 0, 0);
	draw(title2, 8, 0);
	draw(tag, 16, 0);
	draw(chip, 16, tag.length * px + 2);
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	main();
}
