"use strict";

const iconv = require("iconv-lite");
const {DATA} = require("./disc.js");
const {validate} = require("./script.js");
const {R, imm, reg, jump, wordsToBuffer} = require("./mips.js");

const ranges = {
    // Rev 1's executable menu strings are in these data fields. A generic
    // CP932 scan also matches the low bytes of two live JAL instructions.
    EXE: [[0x8006c7cc, 0x8006c7d4], [0x8006c974, 0x8006c9fc]],
    NAME: [[0x800c0188, 0x800c0248], [0x800c2170, 0x800c2908]],
    CHILD: [[0x800c021c, 0x800c0220]],
    EVS: [[0x800c02e0, 0x800c03bc], [0x800c0488, 0x800c0b00], [0x800c17a0, 0x800c1dbc], [0x800e6900, 0x800e6910]]
};
const pools = {
    ENGINE: [
        [0x800c04d4, 0x800c0538], [0x800c132c, 0x800c1424],
        // The name formatters append these suffixes as NUL-terminated strings.
        // The two ranges end before the jump table and fixed-copy pronouns.
        [0x800c1424, 0x800c1434], [0x800c1458, 0x800c1464]
    ],
    EXE: [[0x8006c994, 0x8006c9fc]],
    OV1: [[0x8013de38, 0x8013de9c]]
};
const startupWarning = "メモリーカードのチェック中です\nメモリーカードやコントローラを\n抜き差ししないでください";
const startupNoLoad = "システムファイルをロードしません";
const startupSlot1 = "スロット１", startupSlot2 = "スロット２";
const startupLoaded = "のメモリーカードから\nシステムファイルをロードしました";
const pattern = /(?:[\x81-\x9f\xe0-\xea][\x40-\x7e\x80-\xfc]|[\x20-\x7e\n]){1,160}\0/g;
const childhoodPlaces = {offset: 35335 * DATA + 1120, address: 0x800ebc60, count: 23, cells: 9, stride: 20};
const childhoodMessages = {offset: 35248 * DATA + 0x294a8, count: 8, stride: 132, field: 124};
const discCheck = "ディスクをチェックしています。\n少々、お待ちください・・・。";
const discPromptPrefix = Buffer.from([0x08, 0x37]);
const saveContinuePrompt = "ゲームを続けますか？\nはい…○　いいえ…×";
const saveContinueColors = [Buffer.from([0x08, 0x35]), discPromptPrefix, Buffer.from([0x08, 0x33])];
const saveContinueControlBytes = saveContinueColors.reduce((sum, color) => sum + color.length, 0);
const introModule = "DISC2-INTRO";
const introFile = "Dialogue/scene-" + introModule + ".json";
const rangeAt = (table, name, address) => table[name]?.find(([lo, hi]) => address >= lo && address < hi);
const align4 = value => (value + 3) & ~3;
// Option Room values drawn with a fixed number of glyphs even after NUL.
// These are individual records, not a property of matching text elsewhere.
const optionCells = new Map([[0x8013dedc, 2], [0x8013dee4, 4], [0x8013def0, 4], [0x8013defc, 6],
    [0x8013df1c, 3], [0x8013df24, 3]]);

function isLegacyExecutableCode(row) {
    return row.kind === "menu" && ((row.module === "EXE" &&
        (row.where === "EXE@8003e158" || row.where === "EXE@8003e368")) ||
        (row.module === "OV5" && (row.where === "OV5@80144f20" || row.where === "OV5@8014507c")));
}

function references(body, start, stop) {
    const refs = new Map(), high = new Map();
    const add = (address, ref) => {
        if (address < start || address >= stop) return;
        if (!refs.has(address)) refs.set(address, []);
        refs.get(address).push(ref);
    };
    for (let at = 0; at + 4 <= body.length; at += 4) {
        const word = body.readUInt32LE(at), op = word >>> 26;
        add(word, {at});
        if (op === 15) high.set((word >>> 16) & 31, {at, value: (word & 0xffff) * 65536});
        if (op === 9 || op === 13) {
            const upper = high.get((word >>> 21) & 31), imm = word & 0xffff;
            if (upper && at - upper.at <= 96) {
                const lower = op === 9 && imm >= 32768 ? imm - 65536 : imm;
                add(upper.value + lower, {at, high: upper.value, signed: op === 9});
            }
        }
    }
    return refs;
}

function moduleRecords(mod) {
    const {name, body, base, offset} = mod;
    const refs = references(body, base, base + body.length), all = [], fixedCells = new Map();
    pattern.lastIndex = 0;
    for (const match of body.toString("latin1").matchAll(pattern)) {
        const at = match.index, addr = base + at;
        if (isLegacyExecutableCode({kind: "menu", module: name, where: name + "@" + addr.toString(16)})) continue;
        if (ranges[name] && !rangeAt(ranges, name, addr)) continue;
        const end = at + match[0].length;
        let stop = align4(end);
        if (at % 4 || body.subarray(end, stop).some(Boolean)) {
            if (!refs.has(addr) || (at && body[at - 1])) continue;
            stop = end;
        } else if (at && body[at - 1]) {
            const previous = body.readUInt32LE(at - 4);
            if (previous < base || previous >= base + body.length) continue;
        }
        const text = iconv.decode(body.subarray(at, end - 1), "cp932");
        if (text.includes("\uFFFD") || !/[\u3001-\ufffc]/.test(text) || /[\x00-\x09\x0b-\x1f\x21-\x7e]/.test(text)) continue;
        all.push({text, at, addr, field: stop - at});
    }
    const selected = new Set(all.filter(record => refs.has(record.addr)));
    for (let i = 0; i + 3 < all.length;) {
        const stride = all[i + 1].at - all[i].at;
        let end = i + 2;
        while (end < all.length && all[end].at - all[end - 1].at === stride) end++;
        if (stride <= 64 && end - i >= 4) {
            for (let j = i; j < end; j++) selected.add(all[j]);
            for (let start = i; start < end;) {
                let next = start + 1;
                while (next < end && all[next].text.length === all[start].text.length) next++;
                const entries = all.slice(start, next);
                if (entries.length >= 3 && entries.some(item => item.text.includes("　")) &&
                    entries.every(item => iconv.encode(item.text, "cp932").length === item.text.length * 2)) {
                    for (const item of entries) fixedCells.set(item, item.text.length);
                }
                start = next;
            }
        }
        i = Math.max(i + 1, end - 1);
    }
    return all.filter(record => selected.has(record)).flatMap(record => {
        const source = record.text.replace(/　+$/, "");
        if (!source.trim()) return [];
        const cells = (mod.optionRoom && optionCells.get(record.addr)) || fixedCells.get(record), packedTable = rangeAt(pools, name, record.addr);
        return [{...record, source, offset: offset + record.at, where: name + "@" + record.addr.toString(16), module: name,
            cells, maxBytes: Math.min(record.field - 1, cells ? cells * 2 : Infinity), packedTable: Boolean(packedTable), mod}];
    });
}

function menuModules(data, profile, exe, overlays) {
    const modules = [{name: "EXE", offset: exe.offset, base: exe.base, size: exe.size}];
    modules.push({name: "ENGINE", offset: (profile.number === 1 ? 2252 : 1559) * DATA, base: 0x800c0000, size: 0x60000});
    for (const overlay of overlays) modules.push({name: "OV" + overlay.index, offset: overlay.offset, base: 0x8013dd50, size: overlay.size,
        optionRoom: overlay.index === 5 || (profile.number === 1 && overlay.index === 3)});
    if (profile.number === 1) modules.push(
        {name: "NAME", offset: 2038 * DATA, base: 0x800c0000, size: 0xe000},
        {name: "EVS", offset: 1505 * DATA + 1, base: 0x800c0000, size: 96 * DATA - 1, add: 0x64},
        {name: "CHILD", offset: 35248 * DATA, base: 0x800c0000, size: 0x2bc00}
    );
    return modules.map(mod => {
        const disk = data.subarray(mod.offset, mod.offset + mod.size);
        return {...mod, body: mod.add ? disk.map(byte => byte - mod.add) : disk};
    });
}

function startupRecords(data, disc) {
    const positions = [
        {lba: 543, within: 24, source: startupWarning},
        {lba: 543, within: 112, source: startupNoLoad},
        {lba: 543, within: 148, source: startupSlot1},
        {lba: 543, within: 160, source: startupSlot2},
        {lba: 543, within: 172, source: startupLoaded}
    ];
    if (disc === 1) positions.push({lba: 63825, within: 744, source: startupWarning});
    return positions.map(({lba, within, source}) => {
        const raw = iconv.encode(source, "cp932"), field = align4(raw.length + 1);
        const offset = lba * DATA + within, end = offset + raw.length;
        if (offset + field > data.length || !data.subarray(offset, end).equals(raw) ||
            data.subarray(end, offset + field).some(Boolean)) {
            throw new Error("Disc " + disc + " has unexpected startup text at LBA " + lba + " + " + within + ".");
        }
        return {source, text: source, offset, where: "STARTUP/lba-" + lba,
            module: "STARTUP", field, maxBytes: field - 1,
            rowInfoNote: within === 148 || within === 160 ? "Slot label prepended to the system-file load message." :
                within === 172 ? "Follows the selected slot label on the first line." : undefined};
    });
}

function childhoodPlaceRecords(data, disc) {
    if (disc !== 1) return [];
    const {offset, address, count, cells, stride} = childhoodPlaces;
    const rows = [];
    for (let i = 0; i < count; i++) {
        const at = offset + i * stride, field = data.subarray(at, at + stride);
        const raw = field.subarray(0, cells * 2), text = iconv.decode(raw, "cp932");
        if (field.length !== stride || field.readUInt16LE(cells * 2) !== 0 || text.length !== cells ||
            !iconv.encode(text, "cp932").equals(raw)) {
            throw new Error("Unexpected childhood map label at index " + i + ".");
        }
        const source = text.replace(/　+$/, "");
        if (source) rows.push({source, text, offset: at, where: "CHILD@" + (address + i * stride).toString(16),
            module: "CHILD", field: stride, cells, maxBytes: cells * 2});
    }
    return rows;
}

function nativeRecord(data, module, offset, field, rowInfoNote, linePrefixes = []) {
    const bytes = data.subarray(offset, offset + field);
    const end = bytes.indexOf(0), raw = bytes.subarray(0, end);
    const decoded = iconv.decode(raw, "cp932"), lines = decoded.split("\n");
    const source = lines.map((line, index) => line.slice(linePrefixes[index]?.length || 0)).join("\n");
    if (bytes.length !== field || end <= 0 || bytes.subarray(end).some(Boolean) ||
        !iconv.encode(decoded, "cp932").equals(raw) ||
        linePrefixes.some((prefix, i) => !lines[i]?.startsWith(prefix.toString("ascii"))) ||
        /[\x00-\x09\x0b-\x1f\uFFFD]/.test(source)) {
        throw new Error("Unexpected " + module + " text field at 0x" + offset.toString(16) + ".");
    }
    const controlBytes = linePrefixes.reduce((sum, prefix) => sum + prefix.length, 0);
    return {source, text: source, offset, where: module + "@" + offset.toString(16), module,
        field, maxBytes: field - 1 - controlBytes, controlBytes, linePrefixes, rowInfoNote};
}

function encodeSaveContinue([question, choices], encode) {
    const labels = /^([^○×]+)○([^○×]+)×$/.exec(choices);
    if (!labels || /[○×]/.test(question)) throw new Error("Keep ○ after the Yes label and × after the No label on line 2.");
    const [, yes, no] = labels;
    const [confirm, reset, cancel] = saveContinueColors;
    return Buffer.concat([
        encode(question), Buffer.from([10]), encode(yes), confirm, encode("○"), reset, encode(no), cancel, encode("×")
    ]);
}

function saveContinueRecords(data, disc, overlays) {
    const overlay = overlays.find(({index}) => index === 6);
    if (!overlay) return [];
    const positions = [{offset: overlay.offset + 0x984, where: "OV6@8013e6d4"}];
    if (disc === 1) positions.push(
        {offset: 2042 * DATA + 996, where: "NAME@800c23e4"},
        {offset: 63826 * DATA + 216, where: "lba-63826"},
        {offset: 134899 * DATA + 1716, where: "lba-134899"},
        {offset: 1505 * DATA + 1805, where: "EVS@800c070c", add: 0x64}
    );
    const field = 48;
    const original = Buffer.concat([
        encodeSaveContinue(saveContinuePrompt.split("\n"), text => iconv.encode(text, "cp932")), Buffer.alloc(1)
    ]);
    return positions.map(({offset, where, add}) => {
        const bytes = data.subarray(offset, offset + field);
        if (!(add ? bytes.map(byte => byte - add) : bytes).equals(original)) {
            throw new Error("Unexpected file-select Continue prompt on Disc " + disc + " at " + where + ".");
        }
        return {source: saveContinuePrompt, text: saveContinuePrompt, offset, where, module: "OV6", field,
            maxBytes: field - 1 - saveContinueControlBytes, controlBytes: saveContinueControlBytes, saveContinue: true,
            mod: add ? {add} : undefined, rowInfoNote: "File Select Room. Keep ○ and × in order on line 2. The game colors the symbols."};
    });
}

function nativeMessageRecords(data, profile, exe) {
    // The disc-change controller appends this suffix to the selected disc's
    // label. Keep the color reset at the beginning of the stored field.
    const check = nativeRecord(data, "DISC-SWAP", exe.offset + 0x90, 64,
        "Disc check in progress. The game colors the first line. Keep both lines.", [Buffer.from([0x08, 0x33]), discPromptPrefix]);
    if (check.source !== discCheck) throw new Error("Unexpected disc check message on Disc " + profile.number + ".");
    const records = [check, nativeRecord(data, "DISC-SWAP", exe.offset + 0x1a8, 28,
        "Displayed immediately after the highlighted disc label. Include any spacing the suffix needs.", [discPromptPrefix])];
    if (profile.number === 1) {
        const {offset, count, stride, field} = childhoodMessages;
        for (let i = 0; i < count; i++) {
            records.push(nativeRecord(data, "CHILD-TEXT", offset + i * stride, field,
                "Childhood map dialogue. The game supplies the opening quote or parenthesis."));
        }
    }
    if (profile.number === 2) {
        // Keep the individual fields available for projects staged before the boxes were grouped.
        const offset = 266524 * DATA;
        for (const [start, size] of [[8, 16], [24, 8], [44, 24], [68, 24]]) {
            records.push(nativeRecord(data, introModule, offset + start, size));
        }
    }
    return records;
}

function introBoxes(records) {
    const [first, continuation, second, school] = records.filter(row => row.module === introModule);
    if (!first) return [];
    // The native calls add the opening quote and standalone ellipses around these fields.
    return [[[first, continuation], [second]], [[school]]].map(parts => ({
        offset: parts[0][0].offset,
        where: parts[0][0].where,
        source: parts.map(line => line.map(part => part.source).join("")).join("\n"),
        parts
    }));
}

function scanMenus(data, profile, exe, overlays, scenes) {
    const known = new Set();
    const list = [...startupRecords(data, profile.number), ...childhoodPlaceRecords(data, profile.number),
        ...nativeMessageRecords(data, profile, exe), ...saveContinueRecords(data, profile.number, overlays),
        ...menuModules(data, profile, exe, overlays).flatMap(moduleRecords)].filter(item => {
        if (known.has(item.offset)) return false;
        known.add(item.offset);
        return true;
    });
    for (const scene of scenes.values()) {
        const begin = data.readUInt16LE(scene.offset + 38), end = data.readUInt16LE(scene.offset + 4);
        if (begin < 48 || begin >= end) continue;
        for (let p = begin; p + 32 <= end; p += 32) {
            const at = scene.offset + p;
            if (data.readUInt16LE(at) === 65535) break;
            const offset = at + 4, payload = data.subarray(offset, offset + 28);
            const stop = payload.indexOf(0), raw = stop < 0 ? payload : payload.subarray(0, stop);
            if (raw.length < 2 || raw.length !== data[at + 3] * 2 || (stop >= 0 && payload.subarray(stop).some(Boolean))) continue;
            const text = iconv.decode(raw, "cp932");
            if (text.length !== raw.length / 2 || /[^\u3001-\ufffc]/.test(text.replace(/　+$/, "")) || !text.trim() || known.has(offset)) continue;
            known.add(offset);
            list.push({source: text.replace(/　+$/, ""), text, offset, where: "SCENE:" + scene.key + "@" + (p + 4).toString(16).padStart(8, "0"),
                module: "SCENE", field: 28, maxBytes: 27, countOffset: at + 3});
        }
    }
    return list;
}

function repack(plan, mod, range, edits) {
    const [lo, hi] = range, refs = references(mod.body, lo, hi), locations = new Map();
    const output = Buffer.alloc(hi - lo), reserved = new Set();
    const strings = [];
    for (let address = lo; address < hi;) {
        const at = address - mod.base;
        if (!mod.body[at]) { address++; continue; }
        const end = mod.body.indexOf(0, at);
        if (end < 0 || end + mod.base >= hi) throw new Error(mod.name + ": invalid string pool.");
        strings.push([address, mod.body.subarray(at, end)]);
        address = end + mod.base + 1;
    }
    const starts = new Set(strings.map(pair => pair[0]));
    for (const address of refs.keys()) {
        if (starts.has(address)) continue;
        if (mod.body[address - mod.base]) throw new Error(mod.name + ": a reference enters a name.");
        reserved.add(address);
    }
    const written = new Map();
    for (let pos = lo, i = 0; i < strings.length; i++) {
        const [address, original] = strings[i], raw = edits.get(address) || original;
        const signature = raw.toString("hex");
        if (written.has(signature)) { locations.set(address, written.get(signature)); continue; }
        while ([...reserved].some(point => point >= pos && point < pos + raw.length)) pos++;
        if (pos + raw.length >= hi) throw new Error(mod.name + ": the edited name table exceeds " + (hi - lo) + " bytes.");
        raw.copy(output, pos - lo);
        locations.set(address, pos);
        written.set(signature, pos);
        pos += raw.length + 1;
    }
    const word = Buffer.alloc(4);
    for (const [old, address] of locations) {
        for (const ref of refs.get(old) || []) {
            if (ref.high === undefined) word.writeUInt32LE(address);
            else {
                const delta = address - ref.high;
                if (ref.signed ? delta < -32768 || delta > 32767 : delta < 0 || delta > 65535) throw new Error("Relocated name pointer exceeds its instruction range.");
                word.writeUInt16LE(delta & 65535);
                word.writeUInt16LE(mod.body.readUInt16LE(ref.at + 2), 2);
            }
            plan.put(mod.offset + ref.at, word);
        }
    }
    plan.put(mod.offset + lo - mod.base, output);
}

function fixFriendNameCopies(plan, mod) {
    // Jun and Takumi originally fit in two bytes. The native special cases
    // copy exactly three bytes, including the original terminator; packed
    // English names can be longer and leave stale bytes in the shared buffer.
    const expected = Buffer.from("0000268101002781000006a1010007a10200268100000000020006a16a8c030870b34224", "hex");
    const {z, v0, a0, a1, t0, t1} = R;
    const replacement = wordsToBuffer([
        reg(33, a0, t0, z), reg(33, a1, t1, z),
        (3 << 26) | ((0x8005a074 >>> 2) & 0x03ffffff), 0,
        imm(15, v0, z, 0x8012), jump(0x800e31a8), imm(9, v0, v0, -0x4c90), 0, 0
    ]);
    for (const address of [0x800e2f14, 0x800e2f54]) {
        const at = address - mod.base;
        if (!mod.body.subarray(at, at + expected.length).equals(expected)) {
            throw new Error("Unexpected friend name copy routine at 0x" + address.toString(16) + ".");
        }
        plan.put(mod.offset + at, replacement);
    }
}

function writeField(plan, item, bytes) {
    const field = Buffer.alloc(item.field);
    bytes.copy(field);
    plan.put(item.offset, item.mod?.add ? field.map(byte => byte + item.mod.add) : field);
}

function replaceIntroBox(plan, box, target, font) {
    const original = box.source.split("\n");
    const writes = target.split("\n").flatMap((line, index) => {
        if (line === original[index]) return [];
        const parts = box.parts[index];
        const capacities = parts.map(part => part.maxBytes & ~1);
        const max = capacities.reduce((sum, capacity) => sum + capacity, 0);
        const bytes = font.encode(line);
        if (bytes.length > max) {
            throw new Error("Line " + (index + 1) + " of " + introFile + " uses " + bytes.length / 2 +
                " glyph cells. Shorten it to " + max / 2 + " cells and export again.");
        }
        if (parts.length === 1) return [[parts[0], bytes]];
        // Each glyph is two bytes. Keep the original cue position when both slots can fit it.
        const originalSplit = iconv.encode(parts[0].source, "cp932").length;
        const minSplit = Math.max(2, bytes.length - capacities[1]);
        const maxSplit = Math.min(capacities[0], Math.max(2, bytes.length - 2));
        const split = Math.min(maxSplit, Math.max(minSplit, originalSplit));
        return [[parts[0], bytes.subarray(0, split)], [parts[1], bytes.subarray(split)]];
    });
    for (const [part, bytes] of writes) writeField(plan, part, bytes);
}

function replaceMenus(plan, original, edits, font) {
    const menu = new Map(original.map(row => [row.offset, row])), pending = new Map();
    const intro = new Map(introBoxes(original).map(row => [row.offset, row]));
    for (const edit of edits) {
        const introBox = edit.kind === "message" && edit.module === introModule;
        const item = (introBox ? intro : menu).get(edit.offset);
        if (item?.source !== edit.source) throw new Error(edit.context + ": original system text differs.");
        try {
            const target = validate(item.source, edit.target);
            if (introBox) {
                replaceIntroBox(plan, item, target, font);
                continue;
            }
            const encode = line => font.encode(line, {
                startup: item.module === "STARTUP" || item.module === "DISC-SWAP"
            });
            // The background selector indexes each of these strings as five
            // separate two-byte cells; Latin pairs would merge two choices.
            const selector = item.mod?.optionRoom && (item.addr === 0x8013df3c || item.addr === 0x8013df48);
            const selectorTarget = selector ? target.replace(/[!-~]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).replace(/ /g, "　") : target;
            if (selector && [...selectorTarget].length !== 5) throw new Error("The background selector requires exactly five characters.");
            const lines = selectorTarget.split("\n");
            let bytes = item.saveContinue ? encodeSaveContinue(lines, encode) : Buffer.concat(lines.flatMap((line, i) => {
                const prefix = item.linePrefixes?.[i];
                return [...(i ? [Buffer.from([10])] : []), ...(prefix ? [prefix] : []), encode(line)];
            }));
            if (item.packedTable) {
                const range = rangeAt(pools, item.module, item.addr), id = item.module + ":" + range[0];
                if (!pending.has(id)) pending.set(id, {mod: item.mod, range, edits: new Map()});
                pending.get(id).edits.set(item.addr, bytes);
                continue;
            }
            const width = item.cells || (item.text.endsWith("　") ? item.text.length : 0);
            if (bytes.length < width * 2) {
                const padding = Buffer.alloc(width * 2 - bytes.length);
                // The native full-width space (8140) can draw garbage in
                // fixed-width menus. A pair of narrow spaces is a blank tile
                // composed by the installed font dispatcher instead.
                const blank = font.encode("  ");
                if (blank.length !== 2) throw new Error("Export fixed-width menu padding in Translator++ to use the system font renderer.");
                for (let i = 0; i < padding.length; i += 2) blank.copy(padding, i);
                bytes = Buffer.concat([bytes, padding]);
            }
            const used = bytes.length - (item.controlBytes || 0);
            if (used > item.maxBytes) {
                throw new Error("Translation is too long: " + used + " encoded bytes; maximum " + item.maxBytes +
                    ". Open Menus/" + item.module + ".json and search the Original Text column for " + JSON.stringify(item.source) +
                    ". Shorten its translation by at least " + (used - item.maxBytes) +
                    " encoded bytes, then export again. Check for extra spaces, including at the end; characters can use different numbers of bytes.");
            }
            writeField(plan, item, bytes);
            if (item.countOffset !== undefined) plan.put(item.countOffset, Buffer.from([bytes.length / 2]));
        } catch (error) {
            throw new Error(edit.context + ": " + error.message);
        }
    }
    for (const {mod, range, edits: table} of pending.values()) {
        repack(plan, mod, range, table);
        if (mod.name === "ENGINE" && range[0] === 0x800c132c) fixFriendNameCopies(plan, mod);
    }
}

module.exports = {scanMenus, replaceMenus, isLegacyExecutableCode, introBoxes, introFile, introModule, saveContinuePrompt, fixFriendNameCopies};
