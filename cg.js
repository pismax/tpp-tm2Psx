"use strict";

const {createHash} = require("crypto");
const {DATA, abort} = require("./disc.js");
const {readIndexedPng, toPng} = require("./textures.js");

const magic = 0xbc35;
const paletteOffset = 512;
const streamOffset = 1024;
const maxDistance = 4096;
const maxMatch = 272;
const timMagic = Buffer.from([16, 0, 0, 0]);

function decodeCG(stream, size) {
    const output = Buffer.allocUnsafe(size);
    let read = 0, written = 0, bits = 0, remaining = 0;
    function byte() {
        if (read >= stream.length) throw new Error("Truncated CG stream.");
        return stream[read++];
    }
    bits = byte();
    remaining = 8;
    while (written < size) {
        const compressed = bits & 1;
        bits >>>= 1;
        // The decoder reads the new flag byte before token eight's payload.
        if (!--remaining) {
            bits = byte();
            remaining = 8;
        }
        if (!compressed) {
            output[written++] = byte();
            continue;
        }
        const lo = byte(), hi = byte();
        const distance = ((hi & 15) * 256 + lo) + 1;
        const code = hi >>> 4;
        const count = code === 15 ? 17 + byte() : 2 + code;
        if (distance > written || written + count > size) throw new Error("Invalid CG back-reference.");
        for (let i = 0; i < count; i++, written++) output[written] = output[written - distance];
    }
    if (read !== stream.length) throw new Error("Unexpected data after the CG stream.");
    return output;
}

function encodeCG(pixels) {
    const size = pixels.length, previous = new Int32Array(size).fill(-1);
    const lastPair = new Int32Array(65536).fill(-1);
    for (let p = 0; p + 1 < size; p++) {
        const key = pixels[p] * 256 + pixels[p + 1];
        previous[p] = lastPair[key];
        lastPair[key] = p;
    }

    const costs = new Uint32Array((size + 1) * 8);
    const lengths = new Uint16Array(size * 8), distances = new Uint16Array(size);
    for (let p = size - 1; p >= 0; p--) {
        let longest = 1;
        const limit = Math.min(maxMatch, size - p);
        for (let at = previous[p]; at >= 0 && p - at <= maxDistance; at = previous[at]) {
            let length = 2;
            while (length < limit && pixels[p + length] === pixels[at + length]) length++;
            if (length <= longest) continue;
            longest = length;
            distances[p] = p - at;
            if (longest === limit) break;
        }
        for (let flag = 0; flag < 8; flag++) {
            const next = (flag + 1) & 7, here = p * 8 + flag;
            let cost = 1 + costs[(p + 1) * 8 + next], length = 1;
            for (let n = longest; n >= 2; n--) {
                const candidate = (n < 17 ? 2 : 3) + costs[(p + n) * 8 + next];
                if (candidate < cost) { cost = candidate; length = n; }
            }
            costs[here] = cost + Number(next === 0);
            lengths[here] = length;
        }
    }

    const stream = Buffer.alloc(costs[0] + 1);
    let written = 1, flagAt = 0, bit = 0;
    for (let p = 0; p < size;) {
        const length = lengths[p * 8 + bit];
        if (length > 1) stream[flagAt] |= 1 << bit;
        bit = (bit + 1) & 7;
        if (!bit) flagAt = written++;
        if (length === 1) stream[written++] = pixels[p];
        else {
            const distance = distances[p] - 1;
            stream[written++] = distance & 255;
            stream[written++] = (Math.min(15, length - 2) << 4) | (distance >>> 8);
            if (length >= 17) stream[written++] = length - 17;
        }
        p += length;
    }
    return stream;
}

function colorsFromClut(clut) {
    const colors = Buffer.alloc(clut.length / 2 * 3);
    for (let i = 0; i < clut.length / 2; i++) {
        const word = clut.readUInt16LE(i * 2);
        for (let c = 0; c < 3; c++) {
            const value = (word >>> (c * 5)) & 31;
            colors[i * 3 + c] = (value << 3) | (value >>> 2);
        }
    }
    return colors;
}

function describe(kind, p, width, height, bpp, clut, pixels, copy) {
    const dimensions = Buffer.alloc(4);
    dimensions.writeUInt16LE(width, 0);
    dimensions.writeUInt16LE(height, 2);
    const hash = createHash("sha256").update(dimensions).update(clut).update(pixels).digest("hex").slice(0, 20);
    const key = kind + "-" + hash;
    const location = (p >>> 11) + ":" + (p % DATA);
    return {key, name: key + ".png", kind, width, height, bpp, location, pixels,
        colors: colorsFromClut(clut), copy};
}

function sceneCG(data, p) {
    if (data.readUInt32LE(p) !== magic || data.readUInt16LE(p + 8) !== 512 ||
        data.readUInt16LE(p + 10) !== 232 || data[p + 7] > 1) return null;
    // The canvas is 512 × 232. Only the rectangle at +88 is stored.
    const x = data.readUInt16LE(p + 88), y = data.readUInt16LE(p + 90);
    const width = data.readUInt16LE(p + 92), height = data.readUInt16LE(p + 94);
    const end = p + data.readUInt32LE(p + 12), start = p + streamOffset;
    if (!width || !height || width + x > 512 || height + y > 232 || end <= start || end > data.length) {
        throw new Error("Invalid CG header at LBA " + p / DATA + ".");
    }
    const pixels = decodeCG(data.subarray(start, end), width * height);
    const clut = data.subarray(p + paletteOffset, start);
    const image = describe("cg", p, width, height, 8, clut, pixels, {p, start, end});
    image.label = "Scene CG " + data.readUInt16LE(p + 5) + " (LBA " + p / DATA + ")";
    return image;
}

function indexedTim(data, p) {
    if (p + 20 > data.length || p % 4) return null;
    const flags = data.readUInt32LE(p + 4);
    if (flags !== 8 && flags !== 9) return null;
    const bpp = flags === 8 ? 4 : 8, colorCount = 1 << bpp;
    const image = p + 20 + colorCount * 2;
    if (image + 12 > data.length || data.readUInt32LE(p + 8) !== 12 + colorCount * 2 ||
        data.readUInt16LE(p + 16) !== colorCount || data.readUInt16LE(p + 18) !== 1) return null;
    const words = data.readUInt16LE(image + 8), height = data.readUInt16LE(image + 10);
    const width = words * 16 / bpp, bytes = words * height * 2;
    const start = image + 12, end = start + bytes;
    if (width < 16 || width > 1024 || height < 8 || height > 512 || end > data.length ||
        data.readUInt32LE(image) !== bytes + 12) return null;
    const asset = describe("tim", p, width, height, bpp, data.subarray(p + 20, image),
        data.subarray(start, end), {p, start, end});
    asset.label = "TIM artwork (LBA " + asset.location + ")";
    return asset;
}

function* inventory(data, signal) {
    const start = 536 * DATA;
    for (let p = start; p + streamOffset < data.length; p += DATA) {
        if (p % (DATA * 4096) === 0) abort(signal);
        const image = sceneCG(data, p);
        if (image) yield image;
    }
    for (let p = data.indexOf(timMagic, start); p >= 0; p = data.indexOf(timMagic, p + 1)) {
        const image = indexedTim(data, p);
        if (image) yield image;
    }
}

function preview(image) {
    return toPng(image.pixels, image);
}

function replace(plan, image, stream) {
    const {p, start, end} = image.copy;
    if (!stream) return 0;
    if (image.kind === "tim") {
        plan.put(start, stream);
        return 1;
    }
    const capacity = end - start;
    if (stream.length > capacity) {
        throw new Error(image.name + " needs " + stream.length + " compressed bytes with " + capacity + " available at LBA " + p / DATA + ".");
    }
    const length = Buffer.alloc(4);
    length.writeUInt32LE(streamOffset + stream.length);
    const block = Buffer.alloc(capacity);
    stream.copy(block);
    plan.put(p + 12, length);
    plan.put(start, block);
    return 1;
}

function readReplacement(image, png) {
    let pixels;
    try {
        pixels = readIndexedPng(png, {...image, original: image.pixels, matchPalette: true});
    } catch (error) {
        throw new Error(image.name + ": " + error.message);
    }
    if (pixels.equals(image.pixels)) return null;
    if (image.kind === "tim") return pixels;
    const stream = encodeCG(pixels);
    if (!decodeCG(stream, pixels.length).equals(pixels)) throw new Error(image.name + ": CG compression verification failed.");
    return stream;
}

module.exports = {inventory, preview, readReplacement, replace, decodeCG, encodeCG};
