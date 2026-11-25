"use strict";

const crypto = require("crypto");
const zlib = require("zlib");
const {DATA} = require("./disc.js");

// Locations and decompressed checksums measured on the five identified images.
const sheets = [
    ["6bd6dd34c6", "name_buttons", "Name entry buttons", ["s2067:952"]],
    ["93bf727d73", "name_buttons_packet", "Name entry buttons, alternate sheet", ["73751:1416"]],
    ["460d957e5d", "main_stats", "Status labels", ["1004:1472", "966:1472", "966:1472", "966:1472", "966:1472"]],
    ["642fc53202", "main_stats_hands", "Status labels, date glyphs and cursors", ["r8364:516 r8395:1688", "r11403:516 r12419:1688", "r11122:516 r11693:1688", "r11451:516 r12114:1688", "r11028:516 r11439:1688"]],
    ["a256f52375", "file_select_date", "New and load buttons, date panel", ["1006:1440", "968:1440", "968:1440", "968:1440", "968:1440"]],
    ["68590248de", "file_select_copy", "Copy and erase buttons", ["1005:1880", "967:1880", "967:1880", "967:1880", "967:1880"]],
    ["ca45b87c63", "file_select_rebuild", "Rebuild system file button", ["1007:360", "969:360", "969:360", "969:360", "969:360"]],
    ["1e3496eace", "title_menu_left", "Title menu, left half", ["766:1988", "728:1988", "728:1988", "728:1988", "728:1988"]],
    ["6ad7e3451f", "title_menu_right", "Title menu, right half", ["768:1820", "730:1820", "730:1820", "730:1820", "730:1820"]],
    ["9059d8176b", "file_select_save", "Save button and slot labels", ["", "s966:152", "s966:152", "s966:152", "s966:152"]]
];
const side = 128, nativeBytes = side * side / 2;
const palette = Buffer.from(Array.from({length: 48}, (_, i) => Math.floor(i / 3) * 17));

function decode(data, start, type, expected = nativeBytes) {
    const out = Buffer.alloc(expected);
    let ptr = start, write = 0, flags = 0, remaining = 0, finished = type === 1;
    const end = type === 1 ? start + 4 + data.readUIntLE(start, 3) : data.length;
    if (end > data.length) throw new Error("Truncated compressed texture.");
    if (type === 1) ptr += 4;
    function byte() {
        if (ptr >= end) throw new Error("Truncated texture stream.");
        return data[ptr++];
    }
    function bit() {
        if (!remaining) { flags = byte(); remaining = 8; }
        remaining--;
        const value = flags & 1;
        flags >>>= 1;
        return value;
    }
    function emit(value) {
        if (write >= out.length) throw new Error("Texture expands beyond its native size.");
        out[write++] = value;
    }
    while (ptr < end) {
        if (!bit()) { emit(byte()); continue; }
        let distance, count;
        if (type === 1) {
            const command = byte();
            if (command >= 192) {
                for (let i = 0; i < (command & 63) + 8; i++) emit(byte());
                continue;
            }
            if (command >= 128) {
                count = ((command >>> 4) & 3) + 2;
                distance = (command & 15) || 1024;
            } else {
                count = (command >>> 2) + 3;
                const ring = ((command & 3) << 8) | byte();
                distance = ((0x3de + write - ring) & 1023) || 1024;
            }
        } else if (bit()) {
            count = 2 + 2 * bit() + bit();
            distance = byte() || 256;
        } else {
            const command = byte() * 256 + byte();
            if (!command) { finished = true; break; }
            distance = command >>> 4;
            count = (command & 15) ? (command & 15) + 2 : byte() + 1;
        }
        if (!distance || (type === 2 && distance > write)) throw new Error("Invalid texture back-reference.");
        for (let i = 0; i < count; i++) emit(write < distance ? 0 : out[write - distance]);
    }
    if (!finished || write !== expected) throw new Error("Texture has an incomplete stream or unexpected size.");
    return {out, consumed: ptr - start};
}

function encode(input, type) {
    const size = input.length, costs = new Uint32Array((size + 1) * 8);
    const lengths = new Uint16Array(size * 8), distances = new Uint16Array(size * 8), kinds = new Uint8Array(size * 8);
    const tree = new Map(), previous = new Int32Array(size).fill(-1);
    if (type === 2) for (let i = 0; i < 8; i++) costs[size * 8 + i] = 2 + (i === 0 || i === 7 ? 1 : 0);
    for (let p = 0; p < size - 1; p++) {
        const key = input[p] * 256 + input[p + 1];
        previous[p] = tree.get(key) ?? -1;
        tree.set(key, p);
    }
    for (let p = size - 1; p >= 0; p--) {
        let longest = 0, short = 0, far = 0, near = 0;
        const large = type === 1 ? 1024 : 4095, small = type === 1 ? 15 : 256;
        const max = Math.min(type === 1 ? 34 : 256, size - p);
        for (let at = previous[p]; at >= 0 && p - at <= large; at = previous[at]) {
            const distance = p - at;
            let n = 2;
            while (n < max && input[p + n] === input[at + n]) n++;
            if (n > longest) { longest = n; far = distance; }
            if (distance <= small && n > short) { short = n; near = distance; }
            if (longest === max && (short >= Math.min(max, 5) || distance > small)) break;
        }
        if (type === 1 && p < 1024 && input[p] === 0) {
            let zero = 1;
            while (zero < max && zero < 1024 - p && !input[p + zero]) zero++;
            if (zero > longest) { longest = zero; far = 1024; }
        }
        for (let align = 0; align < 8; align++) {
            const here = p * 8 + align;
            let best = Infinity;
            function offer(kind, len, distance, bits, bytes) {
                const head = Math.floor((align + bits + 7) / 8) - Number(align !== 0);
                const total = bytes + head + costs[(p + len) * 8 + ((align + bits) & 7)];
                if (total >= best) return;
                best = total;
                lengths[here] = len;
                kinds[here] = kind;
                distances[here] = distance;
            }
            for (let n = longest; n >= 3; n--) offer(2, n, far, type === 1 ? 1 : 2, type === 1 || n <= 17 ? 2 : 3);
            for (let n = Math.min(short, 5); n >= 2; n--) offer(1, n, near, type === 1 ? 1 : 4, 1);
            if (type === 1) for (let n = Math.min(71, size - p); n >= 8; n--) offer(3, n, 0, 1, 1 + n);
            offer(0, 1, 0, 1, 1);
            costs[here] = best;
        }
    }
    const output = [];
    let align = 0, flag;
    function bit(value) {
        if (!align) { flag = output.length; output.push(0); }
        output[flag] |= value << align;
        align = (align + 1) & 7;
    }
    for (let p = 0; p < size;) {
        const i = p * 8 + align, kind = kinds[i], n = lengths[i], distance = distances[i];
        bit(Number(Boolean(kind)));
        if (!kind) output.push(input[p]);
        else if (type === 1) {
            if (kind === 1) output.push(128 | ((n - 2) << 4) | distance);
            else if (kind === 3) output.push(192 | (n - 8), ...input.subarray(p, p + n));
            else {
                const pos = (0x3de + p - distance) & 1023;
                output.push(((n - 3) << 2) | (pos >>> 8), pos & 255);
            }
        } else {
            bit(kind === 1 ? 1 : 0);
            if (kind === 1) {
                bit((n - 2) >>> 1);
                bit((n - 2) & 1);
                output.push(distance & 255);
            } else {
                const word = (distance << 4) | (n <= 17 ? n - 2 : 0);
                output.push(word >>> 8, word & 255);
                if (n > 17) output.push(n - 1);
            }
        }
        p += n;
    }
    if (type === 2) { bit(1); bit(0); output.push(0, 0); return Buffer.from(output); }
    const header = Buffer.alloc(4);
    header.writeUIntLE(output.length, 0, 3);
    return Buffer.concat([header, Buffer.from(output)]);
}

const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const crcTable = new Uint32Array(256);
for (let x = 0; x < 256; x++) {
    let v = x;
    for (let i = 0; i < 8; i++) v = (v >>> 1) ^ ((v & 1) ? 0xedb88320 : 0);
    crcTable[x] = v;
}

function pngChunk(name, bytes) {
    const out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length);
    out.write(name, 4);
    bytes.copy(out, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < out.length - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ out[i]) & 255];
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
}

function toPng(pixels, {width = side, height = side, bpp = 4, colors = palette} = {}) {
    const header = Buffer.alloc(13), stride = width + 1;
    const scan = Buffer.alloc(stride * height);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 3;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            scan[y * stride + x + 1] = bpp === 8 ? pixels[pixel] : (pixels[pixel >>> 1] >>> ((x & 1) * 4)) & 15;
        }
    }
    return Buffer.concat([pngSignature, pngChunk("IHDR", header), pngChunk("PLTE", colors),
        pngChunk("IDAT", zlib.deflateSync(scan)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngPalette(png) {
    if (png && png.subarray(0, 8).equals(pngSignature)) {
        for (let p = 8; p + 12 <= png.length;) {
            const length = png.readUInt32BE(p), end = p + 8 + length;
            if (end + 4 > png.length) break;
            if (length >= 48 && png.toString("ascii", p + 4, p + 8) === "PLTE") return png.subarray(p + 8, p + 56);
            p = end + 4;
        }
    }
    return palette;
}

function fromPng(png, colors = palette, original) {
    return readIndexedPng(png, {colors, original});
}

function readIndexedPng(png, {width = side, height = side, bpp = 4, colors, original, matchPalette = false}) {
    if (!png.subarray(0, 8).equals(pngSignature) || png.length < 33 || png.readUInt32BE(16) !== width ||
        png.readUInt32BE(20) !== height || png[28] !== 0) throw new Error("Use a non-interlaced " + width + " × " + height + " PNG.");
    const depth = png[24], color = png[25], indexed = color === 3;
    const channels = [1, 0, 3, 1, 2, 0, 4][color];
    if (!channels || (indexed ? ![1, 2, 4, 8].includes(depth) : depth !== 8)) throw new Error("Unsupported PNG pixel format.");
    const idat = [];
    let inputPalette, alpha;
    for (let p = 8; p + 12 <= png.length;) {
        const length = png.readUInt32BE(p), end = p + 8 + length;
        if (end + 4 > png.length) throw new Error("Truncated PNG.");
        const name = png.toString("ascii", p + 4, p + 8);
        if (name === "IDAT") idat.push(png.subarray(p + 8, end));
        if (name === "PLTE") inputPalette = png.subarray(p + 8, end);
        if (name === "tRNS") alpha = png.subarray(p + 8, end);
        p = end + 4;
    }
    const size = Math.ceil(width * channels * depth / 8), stride = size + 1;
    const scan = zlib.inflateSync(Buffer.concat(idat), {maxOutputLength: stride * height});
    if (scan.length !== stride * height) throw new Error("PNG has the wrong scanline length.");
    const out = Buffer.alloc(width * height * bpp / 8);
    const colorCount = colors.length / 3, matches = new Map();
    function nearest(r, g, b, old) {
        const distance = i => (r - colors[i * 3]) ** 2 + (g - colors[i * 3 + 1]) ** 2 + (b - colors[i * 3 + 2]) ** 2;
        const oldScore = distance(old);
        if (!oldScore) return old;
        const rgb = (r << 16) | (g << 8) | b;
        let match = matches.get(rgb);
        if (!match) {
            let index = 0, score = distance(0);
            for (let i = 1; i < colorCount && score; i++) {
                const error = distance(i);
                if (error < score) { score = error; index = i; }
            }
            match = {index, score};
            matches.set(rgb, match);
        }
        return oldScore <= match.score ? old : match.index;
    }
    for (let y = 0; y < height; y++) {
        const base = y * stride, filter = scan[base];
        if (filter > 4) throw new Error("Unknown PNG filter.");
        for (let x = 0; x < size; x++) {
            const at = base + 1 + x, a = x >= channels ? scan[at - channels] : 0;
            const b = y ? scan[at - stride] : 0, c = y && x >= channels ? scan[at - stride - channels] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            scan[at] += [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
        }
        for (let x = 0; x < width; x++) {
            const at = base + 1 + x * channels;
            const offset = y * width + x;
            const pixel = bpp === 8 ? offset : offset >>> 1, shift = bpp === 8 ? 0 : (x & 1) * 4;
            const old = original ? (original[pixel] >>> shift) & ((1 << bpp) - 1) : 0;
            let value;
            if (indexed) {
                const bit = x * depth;
                value = (scan[base + 1 + (bit >>> 3)] >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
                if (matchPalette) {
                    const index = value * 3;
                    if (!inputPalette || index + 3 > inputPalette.length) throw new Error("PNG palette index is missing.");
                    const [r, g, b] = inputPalette.subarray(index, index + 3);
                    if (alpha?.[value] < 128) value = 0;
                    else if (r !== colors[index] || g !== colors[index + 1] || b !== colors[index + 2]) value = nearest(r, g, b, old);
                } else if (value >= colorCount) throw new Error("Texture pixels must use palette indices 0–" + (colorCount - 1) + ".");
            } else if ((channels === 2 || channels === 4) && scan[at + channels - 1] < 128) value = 0;
            else {
                const r = scan[at];
                value = nearest(r, channels <= 2 ? r : scan[at + 1], channels <= 2 ? r : scan[at + 2], old);
            }
            out[pixel] |= value << shift;
        }
    }
    return out;
}

function inventory(data, number) {
    return sheets.flatMap(([checksum, name, label, locations]) => {
        if (!locations[number - 1]) return [];
        const at = locations[number - 1].split(" ");
        const copies = at.map(location => {
            const [, prefix, sector, offset] = /^([rs]?)(\d+):(\d+)$/.exec(location);
            const type = prefix === "r" ? 2 : 1;
            const p = Number(sector) * DATA + Number(offset) + (type === 2 ? 12 : prefix ? 0 : 32);
            const {out, consumed} = decode(data, p, type);
            if (!crypto.createHash("sha1").update(out).digest("hex").startsWith(checksum)) throw new Error(name + ": original texture checksum mismatch.");
            return {p, type, size: consumed, limit: type === 2 ? (consumed + 3) & ~3 : consumed, out};
        });
        return [{key: "pic-" + checksum, name: name + ".png", label, locations: at, width: side, height: side, copies}];
    });
}

function replace(plan, image, png, preview, editPixels) {
    const original = image.copies[0].out;
    const pixels = png ? fromPng(png, pngPalette(preview), original) : Buffer.from(original);
    editPixels?.(pixels);
    if (pixels.equals(original)) return 0;
    const encodings = new Map();
    for (const copy of image.copies) {
        if (!encodings.has(copy.type)) {
            const stream = encode(pixels, copy.type);
            if (!decode(stream, 0, copy.type).out.equals(pixels)) throw new Error(image.name + ": texture compression verification failed.");
            encodings.set(copy.type, stream);
        }
        const stream = encodings.get(copy.type);
        if (stream.length > copy.limit) throw new Error(image.name + " needs " + stream.length + " compressed bytes with " + copy.limit + " available.");
        const block = Buffer.alloc(Math.max(copy.size, stream.length));
        stream.copy(block);
        plan.put(copy.p, block);
    }
    return image.copies.length;
}

module.exports = {inventory, toPng, fromPng, readIndexedPng, replace, decode, encode};
