"use strict";

const {createHash} = require("node:crypto");
const {DATA} = require("./disc.js");
const {magic, blank, readPack, rebuild, parseScene} = require("./script.js");
const {decode, encode} = require("./textures.js");

const round = (n, size) => size * Math.ceil(n / size);
function padded(buffer, length) {
    if (length < buffer.length) throw new Error("Disc resource exceeds its allocated size.");
    if (buffer.length === length) return buffer;
    const output = Buffer.alloc(length);
    buffer.copy(output);
    return output;
}

function executable(data, lba) {
    const entry = lba * DATA, offset = entry + DATA;
    if (data.toString("ascii", entry, entry + 8) !== "PS-X EXE") throw new Error("Disc executable signature differs.");
    const size = data.readUInt32LE(entry + 28), base = data.readUInt32LE(entry + 24);
    return {entry, offset, size, base};
}

function locateOverlays(data, exe) {
    const overlays = [], scenePack = new Map(), aliases = new Map();
    const tab = 541 * DATA + 0x440;
    for (let i = 0; i < 8; i++) {
        const at = tab + i * 8, sizeAt = exe.offset + 0x80062178 - exe.base + i * 4;
        if (data.readUInt32LE(at) !== 0x0013dd50 ||
            data.readUInt32LE(sizeAt + 32) !== 0x80010c40 + i * 8) throw new Error("Unexpected overlay map.");
        const offset = data.readUInt32LE(at + 4) * DATA, size = data.readUInt32LE(sizeAt);
        if (!size) continue;
        const overlay = {index: i, offset, size, sizeAt, lbaAt: at + 4};
        overlays.push(overlay);
        const key = offset + "/" + size;
        if (aliases.has(key)) {
            aliases.get(key).destinations.push(overlay);
            continue;
        }
        const owner = {...overlay, destinations: [overlay]};
        aliases.set(key, owner);
        const buffer = data.subarray(offset, offset + size);
        const magic = Buffer.from([128, 53]);
        for (let p = buffer.indexOf(magic); p >= 0; p = buffer.indexOf(magic, p + 2)) {
            if (p % 4 || p + 8 > buffer.length) continue;
            const offsets = readPack(buffer, p, buffer.length - p);
            if (!offsets) continue;
            const pack = {overlay: owner, at: p, offsets};
            for (const rel of offsets) scenePack.set(offset + p + rel, pack);
        }
    }
    return {overlays, scenePack};
}

function groupIndex(data) {
    const groups = new Map(), index = new Map();
    for (let sector = 0; sector * DATA < data.length; sector++) {
        const offset = sector * DATA;
        if (data.readUInt16LE(offset) !== 0x3590) continue;
        const n = data.readUInt16LE(offset + 2);
        if (!n || n > 500) continue;
        const ends = Array.from({length: n + 1}, (_, i) => data.readUInt32LE(offset + 4 + i * 4));
        if (!ends[0] || ends[n] + sector > data.length / DATA || ends[n] - ends[0] > 4096 ||
            ends.some((value, i) => i && value < ends[i - 1])) continue;
        const slots = ends.slice(0, n).map((point, i) => ({start: sector + point, length: ends[i + 1] - point}));
        if (!slots.some(({start, length}) => length && data.subarray(start * DATA, start * DATA + 4).equals(magic))) continue;
        const max = Math.max(...slots.map(item => item.length)), group = {sector, slots, max, caps: []};
        groups.set(sector, group);
        for (const slot of slots) if (slot.length) index.set(slot.start * DATA, {slot, group});
    }
    const jal = Buffer.from([0x04, 0xcf, 0x03, 0x0c]);
    let local = [];
    function account() {
        if (!local.length) return;
        const refs = new Set(), start = Math.max(0, local[0] - 4) * DATA;
        const end = Math.min(local[local.length - 1] + 5, data.length / DATA) * DATA;
        for (let at = start; at < end; at += 4) {
            const group = groups.get(data.readUInt32LE(at));
            if (group) refs.add(group);
        }
        if (refs.size) {
            const cap = Math.max(...[...refs].map(group => group.max));
            for (const group of refs) group.caps.push(cap);
        }
    }
    for (let at = data.indexOf(jal); at >= 0; at = data.indexOf(jal, at + 4)) {
        if (at % 4) continue;
        const sector = Math.floor(at / DATA);
        if (local.length && sector - local[local.length - 1] > 8) { account(); local = []; }
        if (local[local.length - 1] !== sector) local.push(sector);
    }
    account();
    return index;
}

function word(n) {
    const result = Buffer.alloc(4);
    result.writeUInt32LE(n);
    return result;
}

function sceneOverflow(message, byteChanges) {
    const growing = byteChanges.filter(({change}) => change > 0);
    const rows = growing.length ? growing.sort((a, b) => b.change - a.change) : byteChanges;
    const details = rows.map(({edit, change}) => {
        const location = edit.fileId ? edit.fileId + " — " + edit.context : edit.context;
        return location + " (" + (change > 0 ? "+" : "") + change + " encoded bytes)\n" +
            "Original: " + JSON.stringify(edit.source) + "\n" +
            "Translation: " + JSON.stringify(edit.target);
    });
    const error = new Error(message);
    error.scriptOverflowDetails = "Shorten the translations below to fit the available space.\n\n" + details.join("\n\n");
    return error;
}

function repackGroup(plan, group, edits) {
    const payloads = group.slots.map(slot => {
        if (!slot.length) return Buffer.alloc(0);
        const start = slot.start * DATA, end = start + slot.length * DATA;
        const output = edits.get(start);
        if (!output) return plan.read(start, end);
        const {scene, body} = output;
        let tail = end;
        while (tail > scene.end && !plan.original[tail - 1]) tail--;
        if (tail - scene.end > 8 || !blank(plan.original, scene.end, tail, true)) throw new Error(scene.key + ": group variant has unknown trailing data.");
        const data = Buffer.concat([body, plan.read(scene.end, tail)]), count = Math.max(slot.length * DATA, round(data.length, DATA));
        const limit = Math.min(...(group.caps.length ? group.caps : [group.max]));
        if (count / DATA > limit) {
            throw sceneOverflow(scene.key + " needs " + (count / DATA) + " sectors. Its event module can load " + limit + ".", output.byteChanges);
        }
        return padded(data, count);
    });
    if (payloads.every((body, i) => body.length === group.slots[i].length * DATA)) {
        for (const [i, slot] of group.slots.entries()) {
            if (slot.length && edits.has(slot.start * DATA)) plan.put(slot.start * DATA, payloads[i]);
        }
        return;
    }
    let rel = plan.append(Buffer.concat(payloads)) - group.sector;
    const offsets = [];
    for (const body of payloads) { offsets.push(word(rel)); rel += body.length / DATA; }
    offsets.push(word(rel));
    plan.put(group.sector * DATA + 4, Buffer.concat(offsets));
}

function compactOpeningGraphics(part) {
    const originalHash = "02db172475ecd8a4db0c876f514ccf03a8af04aed815a11369bf59eac8053f48";
    if (createHash("sha256").update(part).digest("hex") !== originalHash) return part;

    // This part's last 32-byte transfer descriptor points back to the final
    // LZ2 payload. A separate offset table points forward to the descriptor.
    const descriptorPointer = 0x98;
    const descriptorAt = part.readUInt32LE(descriptorPointer);
    const descriptor = Buffer.from(part.subarray(descriptorAt));
    const payloadAt = descriptor.readUInt32LE(8);
    const {out, consumed} = decode(part.subarray(0, descriptorAt), payloadAt, 2, 16384);
    const stream = encode(out, 2);
    const aligned = round(stream.length, 4);
    if (aligned >= descriptorAt - payloadAt) return part;
    const verified = decode(stream, 0, 2, out.length);
    if (consumed !== descriptor.readUInt32LE(4) || verified.consumed !== stream.length || !verified.out.equals(out)) {
        throw new Error("Opening scene graphics failed lossless compression verification.");
    }
    const header = Buffer.from(part.subarray(0, payloadAt));
    header.writeUInt32LE(payloadAt + aligned, descriptorPointer);
    descriptor.writeUInt32LE(stream.length, 4);
    return Buffer.concat([header, padded(stream, aligned), descriptor]);
}

function repackBundle(plan, bundle, edits) {
    const parts = bundle.parts.map((part, partIndex) => {
        const body = plan.read(part.pos, part.pos + part.size);
        const updates = edits.filter(item => item.scene.bundle.partIndex === partIndex);
        if (!updates.length) return body;
        if (!updates[0].scene.bundle.offsets) return padded(updates[0].body, round(updates[0].body.length, 4));
        const {offsets} = updates[0].scene.bundle;
        const adjusted = new Map(updates.map(item => [item.scene.bundle.index, item.body]));
        const tableEnd = 4 + 4 * offsets.length;
        // Childhood packs have one extra offset before the first script. It
        // points to a sound table after the last script.
        let soundAt;
        if (offsets[0] === tableEnd + 4) {
            const candidate = body.readUInt32LE(tableEnd);
            if (candidate % 4 === 0 && candidate > offsets[offsets.length - 1] &&
                /^m0[0-4]00\.sx$/.test(body.toString("latin1", candidate, candidate + 8))) {
                const end = parseScene(body, offsets[offsets.length - 1], candidate).end;
                if (candidate >= end && candidate - end <= 4 && blank(body, end, candidate, true)) soundAt = candidate;
            }
        }
        const head = Buffer.from(body.subarray(0, offsets[0]));
        let cursor = head.length;
        const pieces = offsets.map((offset, i) => {
            const edited = adjusted.get(i);
            const chosen = edited ? padded(edited, round(edited.length, 4)) : body.subarray(offset, offsets[i + 1] ?? soundAt ?? body.length);
            head.writeUInt32LE(cursor, 4 + i * 4);
            cursor += chosen.length;
            return chosen;
        });
        if (soundAt !== undefined) {
            head.writeUInt32LE(cursor, tableEnd);
            pieces.push(body.subarray(soundAt));
        }
        return Buffer.concat([head, ...pieces]);
    });
    const capacity = round(bundle.end, DATA) - bundle.base;
    const size = parts.reduce((bytes, part) => bytes + part.length, 4 + 4 * parts.length);
    if (size > capacity && bundle.base === 35550 * DATA && parts.length === 4 &&
        edits.some(({scene}) => scene.key === "YG_02506-2a7201b4")) {
        parts[3] = compactOpeningGraphics(parts[3]);
    }
    const output = Buffer.concat([word(parts.length), ...parts.map(part => word(part.length)), ...parts]);
    if (output.length > capacity) {
        throw sceneOverflow(edits[0].scene.key + " and its bundle need " + output.length + " bytes with " + capacity + " available.",
            edits.flatMap(edit => edit.byteChanges));
    }
    plan.put(bundle.base, output);
}

function repackOverlay(plan, overlay, packs) {
    const original = plan.read(overlay.offset, overlay.offset + overlay.size);
    const header = Buffer.from(original), additions = [];
    let extra = round(overlay.size, 4);
    for (const [pack, edits] of packs) {
        const {at, offsets} = pack, last = offsets[offsets.length - 1];
        const stop = parseScene(original, at + last).end;
        let cursor = at + offsets[0];
        for (const [i, rel] of offsets.entries()) {
            const start = at + rel, next = offsets[i + 1] === undefined ? stop : at + offsets[i + 1];
            const payload = edits.get(start + overlay.offset)?.body || original.subarray(start, next);
            const body = padded(payload, round(payload.length, 4));
            if (cursor + body.length <= stop) {
                header.writeUInt32LE(cursor - at, at + 4 + i * 4);
                body.copy(header, cursor);
                cursor += body.length;
            } else {
                header.writeUInt32LE(extra - at, at + 4 + i * 4);
                additions.push(body);
                extra += body.length;
            }
        }
        header.fill(0, cursor, stop);
    }
    if (!additions.length) { plan.put(overlay.offset, header); return; }
    const body = Buffer.concat([padded(header, round(header.length, 4)), ...additions]);
    const size = round(body.length, DATA);
    if (size > 0x80180000 - 0x8013dd50) {
        const edits = [...packs.values()].flatMap(packEdits => [...packEdits.values()]);
        throw sceneOverflow("Overlay " + overlay.index + " exceeds the measured RAM budget.", edits.flatMap(edit => edit.byteChanges));
    }
    const lba = plan.append(padded(body, size));
    for (const entry of overlay.destinations) {
        plan.put(entry.lbaAt, word(lba));
        plan.put(entry.sizeAt, word(size));
    }
}

function replaceScenes(plan, scenes, overlayMap, edits, font, warnings) {
    if (!edits.length) return 0;
    const byScene = new Map(), bundles = new Map(), groups = new Map(), overlays = new Map();
    for (const edit of edits) {
        if (!byScene.has(edit.offset)) byScene.set(edit.offset, []);
        byScene.get(edit.offset).push(edit);
    }
    const variants = groupIndex(plan.original);
    for (const [offset, rows] of byScene) {
        const scene = scenes.get(offset);
        if (!scene || rows.some(row => row.key !== scene.key)) throw new Error(rows[0].context + ": scene identity differs.");
        const input = plan.read(offset, scene.end);
        const byteChanges = [];
        const body = rebuild(input, {...scene, offset: 0, end: input.length}, rows, font, warnings, byteChanges);
        const replacement = {scene, body, byteChanges};
        const variant = variants.get(offset);
        const pack = overlayMap.get(offset);
        if (variant && scene.container === "file") {
            const {group} = variant;
            if (!groups.has(group)) groups.set(group, new Map());
            groups.get(group).set(offset, replacement);
        } else if (scene.bundle) {
            const {base} = scene.bundle;
            if (!bundles.has(base)) bundles.set(base, []);
            bundles.get(base).push(replacement);
        } else if (pack) {
            if (!overlays.has(pack.overlay)) overlays.set(pack.overlay, new Map());
            const packs = overlays.get(pack.overlay);
            if (!packs.has(pack)) packs.set(pack, new Map());
            packs.get(pack).set(offset, replacement);
        } else {
            const output = scene.container === "file" ? Buffer.concat([body, plan.read(scene.end, scene.tail)]) : body;
            const stop = scene.container === "file" ? round(scene.end, DATA) : scene.end;
            if (output.length > stop - offset) {
                throw sceneOverflow(scene.key + " needs " + output.length + " bytes with " + (stop - offset) + " available.", byteChanges);
            }
            plan.put(offset, padded(output, stop - offset));
        }
    }
    for (const [group, entries] of groups) repackGroup(plan, group, entries);
    for (const entries of bundles.values()) repackBundle(plan, entries[0].scene.bundle, entries);
    for (const [overlay, packs] of overlays) repackOverlay(plan, overlay, packs);
    return byScene.size;
}

module.exports = {executable, locateOverlays, replaceScenes};
