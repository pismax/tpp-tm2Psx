"use strict";

const crypto = require("crypto");
const iconv = require("iconv-lite");
const {DATA} = require("./disc.js");

const magic = Buffer.from([0x38, 0x35, 0, 0]);
const swap = byte => ((byte & 15) << 4) | (byte >>> 4);
const hex = (n, width = 2) => n.toString(16).toUpperCase().padStart(width, "0");
const literals = new Set([0x10, 0x11, 0x18]);
const reset = new Set([0x38, 0x3f, 0x80, 0x81, 0x82]);
const choiceStarts = new Set([0x20, 0x21]);
const choiceEnds = new Set([0x26, 0x27]);
const pageEnds = new Set([...reset, ...choiceStarts, ...choiceEnds, 0x18, 0x90, 0xff]);
const boxEnds = new Set([...pageEnds, 0x30, 0x31]);
const maxBoxRows = 4;
const maxSpeakerCells = 3;
const shirayukiVoices = new Map([[0x06, "美帆"], [0x0b, "真帆"]]);

function codeName(byte, arg) {
    if (byte === 0x0c) return "nobreak";
    if (byte >= 0x1d && byte <= 0x1f) return "name" + (byte - 0x1c);
    if (byte >> 4 === 1) return "you:" + hex(byte);
    if (byte === 0x2e || byte === 0x2f) return "char" + hex(byte) + ":" + hex(arg);
    if (byte >> 4 === 2) return "char:" + hex(byte);
    if (byte >> 4 === 3) return "num" + hex(byte & 15, 1) + ":" + hex(arg);
    return "c" + hex(byte);
}

function readText(data, at, limit) {
    let raw = [], source = "", visible = false;
    const controls = [], controlBytes = [];
    function flush() {
        if (!raw.length) return;
        const text = iconv.decode(Buffer.from(raw), "cp932");
        if (text.includes("\uFFFD")) throw new Error("Invalid script character.");
        visible ||= Boolean(text.trim());
        source += text;
        raw = [];
    }
    for (; at < limit;) {
        const byte = swap(data[at++]);
        if (byte === 0) {
            flush();
            return {source, visible, controls, controlBytes, end: at};
        }
        if (byte >= 128) {
            if (at === limit) break;
            raw.push(byte, swap(data[at++]));
            continue;
        }
        flush();
        const hasArg = byte === 0x2e || byte === 0x2f || byte >> 4 === 3;
        if (hasArg && at === limit) break;
        const arg = hasArg ? swap(data[at++]) : undefined;
        const code = codeName(byte, arg);
        controls.push(code);
        controlBytes.push(hasArg ? [byte, arg] : [byte]);
        source += "{" + code + "}";
    }
    throw new Error("Unterminated script string.");
}

const direct = new Map([
    [0, [0x00, 0x20, 0x21, 0x26, 0x27, 0x38, 0x3e, 0x3f, 0x80, 0x87, 0x89, 0x8a, 0x90, 0xf0, 0xf1, 0xff]],
    [1, [0x17, 0x81, 0x82, 0x98, 0x99, 0x9a, 0x9b, 0xa7, 0xb8]],
    [2, [0x1e, 0x22, 0x23, 0x31, 0x83]],
    [3, [0x1f, 0xb0]], [4, [0xa3]]
].flatMap(([length, ops]) => ops.map(op => [op, length])));
const variable = {
    160: {0: 2, 1: 4, 2: 2, 3: 2, 4: 2, 5: 2, 6: 3, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 32: 2},
    162: {1: 5, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3, 7: 1, 8: 1, 9: 1, 10: 1, 11: 2, 12: 1, 13: 1, 14: 1},
    168: {0: 2, 1: 1, 2: 2, 3: 1, 5: 4, 6: 2, 7: 2, 8: 2, 9: 3, 16: 1, 17: 1, 32: 1, 33: 1, 64: 6}
};

function expression(data, p, limit) {
    let pending = 1;
    while (pending && p < limit) {
        const op = data[p++];
        pending--;
        if (op === 0x40 || op === 0x46 || op === 0x5a) pending++;
        else if ((op >= 0x41 && op <= 0x45) || (op >= 0x47 && op <= 0x4c) || op === 0x58 || op === 0x59 || op === 0x5b) pending += 2;
        else if (op === 0x4d) { if (data[p++] !== 0x14) pending++; }
        else if (op >= 0x4e && op <= 0x53) p += op === 0x4e ? 2 : 1;
        else if (!(op >= 0x54 && op <= 0x57) && !(op >= 0x5c && op <= 0x61)) throw new Error("Unknown script expression " + hex(op));
    }
    if (p > limit || pending) throw new Error("Truncated script expression.");
    return p;
}

function instruction(data, start, limit) {
    let end = start + 1;
    const op = data[start];
    if (literals.has(op)) return {...readText(data, end, limit), op};
    if (direct.has(op)) end += direct.get(op);
    else if (op === 0x30 || op === 0x40 || op === 0x88 || op === 0xfd || op === 0xfe) {
        end = expression(data, end, limit) + (op === 0x30 ? 2 : 0);
    } else if (op === 0xa1) end = data[end] === 0 ? expression(data, end + 2, limit) : end + 3;
    else if (op === 0xaf) end += (data[end] & 0xe0) === 0x40 ? 2 : 1;
    else if (variable[op]) end += 1 + (variable[op][data[end]] || 0);
    else throw new Error("Unknown script opcode " + hex(op));
    if (end > limit) throw new Error("Truncated script instruction.");
    return {op, end, jump: op === 0x30 || op === 0x31 ? end + data.readInt16LE(end - 2) : undefined,
        voice: op === 0x1f ? data[start + 1] : undefined};
}

function parseScene(data, origin, limit = Math.min(data.length, origin + 65536)) {
    const start = origin + data.readUInt16LE(origin + 4), queue = [start], ops = new Map();
    let end = start;
    while (queue.length) {
        let at = queue.pop();
        while (!ops.has(at)) {
            if (at < start || at >= limit) throw new Error("Scene execution leaves the script block.");
            const ins = instruction(data, at, limit);
            ops.set(at, ins);
            end = Math.max(end, ins.end);
            if (ins.jump !== undefined) queue.push(ins.jump);
            if (ins.op === 0xff || ins.op === 0x31) break;
            at = ins.end;
        }
    }
    return {start, end, ops};
}

function shirayukiNameplateIdentity(parsed, start) {
    const pending = [{at: start, voice: null, identity: null, shown: false}];
    const seen = new Set(), outcomes = new Set();
    while (pending.length) {
        let {at, voice, identity, shown} = pending.pop();
        const key = [at, voice, identity, shown].join("/");
        if (seen.has(key)) continue;
        seen.add(key);
        const ins = parsed.ops.get(at);
        if (!ins || pageEnds.has(ins.op)) {
            if (shown) outcomes.add(identity);
            if (outcomes.size > 1) return;
            continue;
        }
        if (ins.op === 0x1f) voice = shirayukiVoices.get(ins.voice) || null;
        if ((ins.op === 0x10 || ins.op === 0x11) && ins.visible) {
            shown = true;
            if (voice && identity && voice !== identity) return;
            identity ||= voice;
        }
        if (ins.jump !== undefined) pending.push({at: ins.jump, voice, identity, shown});
        if (ins.op !== 0x31) pending.push({at: ins.end, voice, identity, shown});
    }
    // A visible page with no ordinary voice cue is still ambiguous.
    return outcomes.values().next().value || undefined;
}

function sceneRows(parsed, origin) {
    const states = new Map([[parsed.start, {label: null, voice: null, choice: false}]]), work = [parsed.start], rows = [];
    for (let i = 0; i < work.length; i++) {
        const at = work[i], ins = parsed.ops.get(at);
        let {label, voice, choice} = states.get(at);
        if (ins.op === 0x18) label = ins.source;
        if (reset.has(ins.op)) label = null;
        if (pageEnds.has(ins.op)) voice = null;
        if (ins.op === 0x1f) voice = shirayukiVoices.get(ins.voice) || null;
        if (choiceStarts.has(ins.op)) choice = true;
        if (choiceEnds.has(ins.op) || reset.has(ins.op) || ins.op === 0x90) choice = false;
        if (ins.op === 0xff) continue;
        const successors = [];
        if (ins.op !== 0x31) successors.push(ins.end);
        if (ins.jump !== undefined) successors.push(ins.jump);
        for (const dest of successors) {
            const old = states.get(dest);
            const next = {
                label: !old || old.label === label ? label : null,
                voice: !old || old.voice === voice ? voice : null,
                choice: choice && (!old || old.choice)
            };
            if (!old || next.label !== old.label || next.voice !== old.voice || next.choice !== old.choice) {
                states.set(dest, next);
                work.push(dest);
            }
        }
    }
    const jumpTargets = new Set([...parsed.ops.values()].map(ins => ins.jump).filter(Number.isInteger));
    const events = [];
    let box = [];
    function metadata(label) {
        return {speaker: label || "", speakerKind: label ? (label.includes("{") ? "runtime" : "literal") : label === "" ? "none" : "unknown"};
    }
    function endBox() {
        if (box.length) events.push({box});
        box = [];
    }
    for (const [at, ins] of [...parsed.ops].sort((a, b) => a[0] - b[0])) {
        if (boxEnds.has(ins.op) || jumpTargets.has(at)) endBox();
        if (ins.op === 0x18 && ins.visible) {
            events.push({speaker: ins, at});
        } else if (ins.op === 0x10 || ins.op === 0x11) {
            box.push({at, ins});
        }
    }
    endBox();

    const displayOwners = new Map();
    for (const event of events) for (const line of event.box || []) displayOwners.set(line.at, event);
    for (const event of events) {
        if (!event.box) continue;
        // A jump can select another fragment of the same on-screen page.
        // Keep the native row count for both fragments along such edges.
        const pending = [event.box[event.box.length - 1].ins.end], seen = new Set();
        while (pending.length) {
            const at = pending.pop(), ins = parsed.ops.get(at);
            if (!ins || pageEnds.has(ins.op) || seen.has(at)) continue;
            seen.add(at);
            const next = displayOwners.get(at);
            if (next) { event.sharedPage = next.sharedPage = true; continue; }
            if (ins.jump !== undefined) pending.push(ins.jump);
            if (ins.op !== 0x31) pending.push(ins.end);
        }
    }
    for (const event of events) {
        if (event.speaker) {
            const {at, speaker: ins} = event;
            const nameplateIdentity = ins.source === "白雪" ? shirayukiNameplateIdentity(parsed, ins.end) : undefined;
            rows.push({source: ins.source, kind: "speaker", at: at - origin, controls: ins.controls,
                ...metadata(ins.source), nameplateIdentity});
            continue;
        }
        const {box} = event;
        if (!box.some(line => line.ins.visible)) continue;
        // The two display opcodes share a handler, with bit 0 passed as a
        // render flag. Preserve internal flags and commands between lines.
        const startsNewRow = ({ins}) => !ins.source.endsWith("{nobreak}");
        const retailRows = 1 + box.slice(0, -1).filter(startsNewRow).length;
        const choice = box.every(({at}) => states.get(at).choice);
        const reflow = !choice && !event.sharedPage && retailRows <= maxBoxRows &&
            box.every(({at, ins}, i) => i === 0 || (ins.op === 0x10 && box[i - 1].ins.end === at));
        let source = "";
        const controls = [], lines = [];
        for (const [index, {at, ins}] of box.entries()) {
            const internalJoin = reflow && index < box.length - 1 && ins.controls[ins.controls.length - 1] === "nobreak" &&
                ins.source.endsWith("{nobreak}");
            const display = internalJoin ? ins.source.slice(0, -"{nobreak}".length) : ins.source;
            source += display + (index < box.length - 1 && !internalJoin ? "\n" : "");
            controls.push(...(internalJoin ? ins.controls.slice(0, -1) : ins.controls));
            lines.push({at: at - origin, source: ins.source, joinNext: internalJoin});
        }
        const {label, voice} = states.get(box[0].at);
        // The sisters share the displayed label. Use the ordinary voiced line,
        // not the EVS player-name cue, which can still use Miho's ID for Maho.
        const speakerIdentity = voice && (label === "白雪" || label === "？？？") ? voice : undefined;
        rows.push({source, kind: "message", at: lines[0].at, controls, lines, reflow, choice: choice || undefined,
            maxRows: event.sharedPage ? retailRows : Math.max(retailRows, maxBoxRows),
            ...metadata(label), speakerIdentity});
    }
    return rows;
}

function blank(data, start, end, allowMarkers = false) {
    for (let i = start; i < end; i++) if (data[i] && !(allowMarkers && data[i] === 255)) return false;
    return true;
}

function readPack(data, at, size) {
    if (size < 8 || data.readUInt16LE(at) !== 0x3580) return null;
    const n = data.readUInt16LE(at + 2);
    if (!n || n > 255 || 4 + 4 * n >= size) return null;
    const offsets = [];
    let previous = 4 + 4 * n - 1;
    for (let i = 0; i < n; i++) {
        const next = data.readUInt32LE(at + 4 + 4 * i);
        if (next <= previous || next + 4 > size || !data.subarray(at + next, at + next + 4).equals(magic)) return null;
        offsets.push(next);
        previous = next;
    }
    return offsets;
}

function bundles(data, scene) {
    for (let base = scene.offset - scene.offset % DATA, i = 0; base >= 0 && i < 96; base -= DATA, i++) {
        const count = data.readUInt32LE(base);
        if (!count || count > 64) continue;
        let pos = base + 4 + 4 * count;
        const parts = [];
        for (let j = 0; j < count; j++) {
            const size = data.readUInt32LE(base + 4 + j * 4);
            if (!size || size > 0x200000 || pos + size > data.length) break;
            parts.push({pos, size});
            pos += size;
        }
        if (parts.length !== count) continue;
        const partIndex = parts.findIndex(part => scene.offset >= part.pos && scene.end <= part.pos + part.size);
        if (partIndex < 0) continue;
        const part = parts[partIndex];
        if (scene.offset === part.pos && blank(data, scene.end, part.pos + part.size, true)) return {base, parts, end: pos, partIndex};
        // A sector inside a resource can resemble a bundle header. Keep
        // searching unless this candidate's pack actually indexes the scene.
        const offsets = readPack(data, part.pos, part.size);
        const index = offsets?.indexOf(scene.offset - part.pos);
        if (index >= 0) return {base, parts, end: pos, partIndex, offsets, index};
    }
    return null;
}

function scanScenes(data) {
    const scenes = new Map();
    for (let origin = data.indexOf(magic); origin >= 0; origin = data.indexOf(magic, origin + 4)) {
        if (origin + 32 > data.length) break;
        const code = data.readUInt16LE(origin + 4);
        const sid = data.toString("latin1", origin + 24, origin + 32).replace(/\0+$/, "");
        if (code < 0x20 || code >= 0x8000 || data.readUInt16LE(origin + 6) >= 16 || !/^[!-~][ -~]{0,7}$/.test(sid)) continue;
        try {
            const parsed = parseScene(data, origin);
            const key = sid + "-" + crypto.createHash("sha1").update(data.subarray(origin, parsed.end)).digest("hex").slice(0, 8);
            const scene = {sid, key, offset: origin, end: parsed.end, rows: sceneRows(parsed, origin)};
            scene.bundle = bundles(data, scene);
            const boundary = Math.ceil(scene.end / DATA) * DATA;
            let tail = boundary;
            while (tail > scene.end && !data[tail - 1]) tail--;
            scene.container = scene.bundle ? (scene.bundle.offsets ? "pack" : "bundle")
                : origin % DATA === 0 && tail - scene.end <= 4 ? "file" : "packed";
            scene.tail = tail;
            scenes.set(origin, scene);
        } catch (error) {
            // The signature also occurs in data that does not contain a valid VM program.
            if (!(error instanceof Error)) throw error;
        }
    }
    return scenes;
}

function validate(source, target) {
    const normalized = target.replace(/\r\n?/g, "\n");
    const lines = source.split("\n"), edits = normalized.split("\n");
    if (!normalized.trim() || normalized.includes("\0") ||
        lines.length !== edits.length || lines.some((line, i) => !line.trim() !== !edits[i].trim())) {
        throw new Error("Preserve the line breaks and blank lines.");
    }
    return normalized;
}

function encodeScene(ins, target, font) {
    return encodeLines([validate(ins.source, target)], ins.controls, ins.controlBytes, font)[0];
}

function encodeLines(lines, controls, controlBytes, font) {
    const chunks = lines.map(line => line.split(/(\{[^{}]+\})/));
    const tags = chunks.flatMap(line => line.filter((_, i) => i % 2));
    if (tags.length !== controls.length || tags.some((code, i) => code !== "{" + controls[i] + "}")) {
        throw new Error("Preserve the original control tokens in order.");
    }
    let nextCode = 0;
    return chunks.map(line => {
        // A full-width space renders a deliberate blank row even on paths
        // where the text routine skips a zero-length display instruction.
        const raw = Buffer.concat(line.map((text, i) => i % 2 ? Buffer.from(controlBytes[nextCode++])
            : font.encode(!text && line.length === 1 ? "　" : text)));
        if (raw.length >= 256) throw new Error("Encoded script string exceeds the 256-byte expander buffer.");
        return Buffer.from([...raw.map(swap), 0]);
    });
}

function renderedCells(stored) {
    let cells = 0;
    for (let at = 0; at + 1 < stored.length;) {
        const byte = swap(stored[at++]);
        if (byte >= 128) { cells++; at++; }
        else if (byte >> 4 === 3) { cells += 2; at++; }
        else if (byte === 0x2e || byte === 0x2f) { cells += 4; at++; }
        else if (byte >> 4 === 2 || (byte >= 0x1d && byte <= 0x1f)) cells += 4;
        else if (byte >> 4 === 1) cells += 6;
    }
    return cells;
}

function warnLayout(warnings, edit, issue) {
    const {fileId, context, source, target} = edit;
    warnings.push({fileId, context, source, target, issue});
}

function messageSpans(message, edit, parsed, offset, font, warnings) {
    if (message?.source !== edit.source) throw new Error("Original text box differs.");
    const target = edit.target.replace(/\r\n?/g, "\n");
    if (!target.trim() || target.includes("\0")) throw new Error("Text box translation is blank or contains a null byte.");
    const lines = target.split("\n");
    if (lines.some(line => line.includes("{nobreak}") && !line.endsWith("{nobreak}")) ||
        (message.reflow && message.source.endsWith("{nobreak}") && !target.endsWith("{nobreak}"))) {
        throw new Error("Keep the continuation token at the end of its display line.");
    }
    const native = message.lines.map(line => parsed.ops.get(offset + line.at));
    if (!message.reflow && lines.length !== native.length) {
        throw new Error(message.choice ? "Keep one line per choice option, in the original order." :
            "Keep the original line count for this text box. The script uses separate display slots.");
    }
    const encoded = message.reflow
        ? encodeLines(lines, message.controls,
            native.flatMap((ins, index) => message.lines[index].joinNext ? ins.controlBytes.slice(0, -1) : ins.controlBytes), font)
        : native.map((ins, i) => encodeLines([lines[i]], ins.controls, ins.controlBytes, font)[0]);
    let width = 0, rows = 0;
    for (const [index, bytes] of encoded.entries()) {
        width += renderedCells(bytes);
        if (!lines[index].endsWith("{nobreak}") || index === encoded.length - 1) {
            rows += Math.max(1, Math.ceil(width / 20));
            width = 0;
        }
    }
    if (rows > message.maxRows) {
        const layoutRows = message.maxRows === 1 ? "1 row" : message.maxRows + " rows";
        warnLayout(warnings, edit, "May wrap to " + rows + " display rows. Aim for " + layoutRows + ".");
    }
    if (!message.reflow) return encoded.map((bytes, i) => ({at: offset + message.lines[i].at + 1, end: native[i].end, bytes}));
    const bytes = Buffer.concat(encoded.flatMap((line, i) => [Buffer.from([i ? 0x10 : native[0].op]), line]));
    return [{at: offset + message.at, end: native[native.length - 1].end, bytes}];
}

function rebuild(data, scene, edits, font, warnings = [], byteChanges) {
    const {offset, end} = scene;
    const parsed = parseScene(data, offset, end);
    const messages = new Map(edits.some(edit => edit.kind === "message")
        ? sceneRows(parsed, offset).filter(row => row.kind === "message").map(row => [row.at, row]) : []);
    const spans = [];
    for (const edit of edits) {
        try {
            let replacements;
            if (edit.kind === "message") {
                replacements = messageSpans(messages.get(edit.at), edit, parsed, offset, font, warnings);
            } else {
                const at = offset + edit.at, ins = parsed.ops.get(at);
                if (ins?.source !== edit.source) throw new Error("Original script occurrence differs.");
                const bytes = encodeScene(ins, edit.target, font);
                const width = renderedCells(bytes);
                if (ins.op === 0x18 && !ins.controls.length && width > maxSpeakerCells) {
                    warnLayout(warnings, edit, "Speaker nameplate uses " + width + " glyph cells. Aim for " + maxSpeakerCells + " cells.");
                } else if (ins.op !== 0x18 && width > 20) {
                    warnLayout(warnings, edit, "About " + width + " glyph cells in a 20-cell dialogue row.");
                }
                replacements = [{at: at + 1, end: ins.end, bytes}];
            }
            let change = 0;
            for (const span of replacements) {
                spans.push({...span, context: edit.context});
                change += span.bytes.length - (span.end - span.at);
            }
            byteChanges?.push({edit, change});
        } catch (error) {
            throw new Error(edit.context + ": " + error.message);
        }
    }
    spans.sort((a, b) => a.at - b.at);
    const pieces = [], changes = [];
    let cursor = offset, delta = 0;
    for (const span of spans) {
        if (span.at < cursor) throw new Error(span.context + ": script edits overlap.");
        for (const field of [4, 8, 10, 12, 14, 16, 18, 20, 22, 34, 36, 38]) {
            if (data.readUInt16LE(offset + field) > span.at - offset) throw new Error(span.context + ": an unmodeled offset points beyond this text.");
        }
        pieces.push(data.subarray(cursor, span.at), span.bytes);
        cursor = span.end;
        delta += span.bytes.length - (span.end - span.at);
        changes.push({at: span.at, end: span.end, delta});
    }
    pieces.push(data.subarray(cursor, end));
    const out = Buffer.concat(pieces);
    function map(at) {
        let lo = 0, hi = changes.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (changes[mid].at < at) lo = mid + 1;
            else hi = mid;
        }
        if (!lo) return at - offset;
        if (at < changes[lo - 1].end) throw new Error("A branch enters a replaced string.");
        return at - offset + changes[lo - 1].delta;
    }
    for (const ins of parsed.ops.values()) {
        if (ins.jump === undefined) continue;
        const next = map(ins.end), target = map(ins.jump);
        if (target - next < -32768 || target - next > 32767) throw new Error(scene.key + ": relocated branch exceeds its signed 16-bit range.");
        out.writeInt16LE(target - next, next - 2);
    }
    return out;
}

module.exports = {magic, blank, readPack, scanScenes, rebuild, validate, parseScene, sceneRows, readText, maxBoxRows, maxSpeakerCells};
