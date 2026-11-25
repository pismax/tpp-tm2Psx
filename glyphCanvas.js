"use strict";

function rasterizeGlyph(document, text, width) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = 15;
    const ctx = canvas.getContext("2d");
    ctx.font = '14px "Segoe UI", "Noto Sans", sans-serif';
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";
    function draw(value) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, 15);
        const m = ctx.measureText(value);
        const span = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
        const sx = Math.min(1, (width - 1) / (span || 1));
        const sy = Math.min(1, 14 / (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 1));
        ctx.setTransform(sx, 0, 0, sy, 0, 0);
        const left = (width / sx - span) / 2 + m.actualBoundingBoxLeft;
        const baseline = Math.min(12 / sy, 15 / sy - m.actualBoundingBoxDescent);
        ctx.fillText(value, left, Math.max(baseline, m.actualBoundingBoxAscent));
        const pixels = ctx.getImageData(0, 0, width, 15).data;
        const stride = Math.ceil(width / 8), rows = Buffer.alloc(stride * 15);
        for (let y = 0; y < 15; y++) for (let x = 0; x < width; x++) {
            if (pixels[(y * width + x) * 4 + 3] > 92) rows[y * stride + (x >>> 3)] |= 128 >>> (x & 7);
        }
        return rows;
    }
    const bitmap = draw(text);
    if (text.trim() && (!bitmap.some(Boolean) || bitmap.equals(draw("\u{10FFFF}")))) {
        throw new Error("The system fonts cannot draw " + JSON.stringify(text) + ".");
    }
    return bitmap;
}

module.exports = rasterizeGlyph;
