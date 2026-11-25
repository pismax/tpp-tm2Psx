"use strict";

const iconv = require("iconv-lite");
const {DATA} = require("./disc.js");
const {installNameEntry} = require("./nameEntry.js");
const {R, imm, reg, jump, wordsToBuffer, assemble} = require("./mips.js");

const LOOKUP = 0x8001c5c0;
const SMALL_LOOKUP_RETURN = 0x8001cb20;
const ENTRY = 0x800175c8;
const STACK_SETUP = 0x800175f8;
const RAM_END = 0x80200000;
const FONT_SPACE = 0x1100;
const FONT_ADDRESS = RAM_END - FONT_SPACE;
const NAME_ENTRY_SPACE = 0x200;
const BSS_END = 0x800bffe8;
const alphabet = ` ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?'"-~`;
const narrow = new Map([...alphabet].map((character, index) => [character, index]));
const startupAlphabet = alphabet + "/";
const startupNarrow = new Map([...startupAlphabet].map((character, index) => [character, index]));
const PAIR_TRAIL = 0x40;
const STARTUP_PAIR_TRAIL = 0x90;
const blankHalf = narrow.get(" ");
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, {granularity: "grapheme"}) : null;

function loadAddress(rt, address) {
    return [imm(15, rt, R.z, address >>> 16), imm(13, rt, rt, address)];
}

function fontBootstrap(entry, start, size) {
    const {z, t0, t1, t2, t3} = R;
    const copy = [
        ...loadAddress(t1, start),
        imm(9, t2, t1, size),
        imm(35, t3, t0, 0), imm(9, t0, t0, 4),
        imm(43, t3, t1, 0), imm(9, t1, t1, 4),
        imm(5, t1, t2, -5), 0,
        jump(ENTRY), 0
    ];
    return wordsToBuffer([...loadAddress(t0, entry + (copy.length + 2) * 4), ...copy]);
}

function dispatcher({directCount, pairs, directAddress, narrowAddress, tileAddress, startupAddress}) {
    return assemble((push, label, branch) => {
        const li = (rt, address) => push(...loadAddress(rt, address));
        const {z, v0, v1, a0, t0, t1, t2, t3, t4, t5, t6, t7, t8, ra} = R;
        push(reg(2, t0, z, a0, 8), imm(12, t0, t0, 255));
        if (directCount) {
            push(imm(9, t1, z, 0xa0));
            branch(5, t0, t1, "pairOrOriginal", imm(12, t1, a0, 255));
            push(imm(9, t1, t1, -0x40), imm(11, t2, t1, directCount));
            branch(4, t2, z, "original", reg(0, t2, z, t1, 5));
            push(reg(0, t1, z, t1, 1), reg(35, t2, t2, t1));
            li(v0, directAddress);
            push(reg(8, z, ra, z), reg(33, v0, v0, t2));
        }
        label("pairOrOriginal");
        if (pairs) {
            push(imm(9, t1, t0, -0xa1), imm(11, t2, t1, 63));
            branch(5, t2, z, "compose", imm(12, t3, a0, 255));
            push(imm(9, t1, t0, -0x85), imm(11, t2, t1, 3));
            branch(5, t2, z, "compose", imm(9, t1, t1, 63));
            push(imm(9, t1, t0, -0xeb), imm(11, t2, t1, startupAddress ? 6 : 5));
            branch(4, t2, z, "original", imm(9, t1, t1, 66));
            label("compose");
            li(t6, narrowAddress);
            if (startupAddress) {
                push(reg(33, t0, z, z), imm(11, t2, t3, STARTUP_PAIR_TRAIL));
                branch(5, t2, z, "pairIndex", imm(9, t3, t3, -PAIR_TRAIL));
                li(t2, SMALL_LOOKUP_RETURN);
                branch(5, ra, t2, "pairIndex", imm(9, t3, t3, PAIR_TRAIL - STARTUP_PAIR_TRAIL));
                li(t6, startupAddress);
                push(imm(9, t0, z, 1));
                label("pairIndex");
            } else push(imm(9, t3, t3, -PAIR_TRAIL));
            push(imm(11, t2, t3, startupAddress ? startupAlphabet.length : alphabet.length));
            branch(4, t2, z, "original", reg(0, t4, z, t1, 4));
            push(reg(0, t5, z, t3, 4));
            push(reg(33, t4, t4, t6), reg(33, t5, t5, t6), imm(9, t6, t4, 15));
            li(v0, tileAddress);
            push(reg(33, t3, v0, z));
            label("line");
            push(imm(36, t7, t4, 0), imm(36, t8, t5, 0), imm(40, t7, t3, 0));
            if (startupAddress) {
                // The small renderer samples columns 2 and 4 one bit
                // higher on the right half of its tile.
                branch(4, t0, z, "storeRight");
                push(imm(12, t2, t8, 0x24), imm(12, t8, t8, 0x92),
                    reg(0, t2, z, t2, 1), reg(37, t8, t8, t2));
                label("storeRight");
            }
            push(imm(40, t8, t3, 1), imm(9, t4, t4, 1), imm(9, t5, t5, 1));
            branch(5, t4, t6, "line", imm(9, t3, t3, 2));
            push(reg(8, z, ra, z), 0);
        }
        label("original");
        push(0x3083f000, jump(LOOKUP + 8), 0x3402e000);
    });
}

function installFont(plan, exe, record, payload, start) {
    // The BIOS loads one contiguous image. Load the font above the original
    // image, copy it before the game clears BSS, and reserve it above the
    // initial stack. The game's heap ceiling follows that same stack limit.
    const initialStack = plan.original.readUInt32LE(exe.entry + 0x30);
    const endOfImage = exe.base + exe.size;
    const address = at => DATA + at - exe.base;
    const stack = address(STACK_SETUP), hook = address(LOOKUP);
    const retail = plan.original;
    const space = RAM_END - start;
    const ext = Buffer.concat([fontBootstrap(endOfImage, start, payload.length), payload]);
    const extra = Buffer.alloc(Math.ceil(ext.length / DATA) * DATA);
    if (initialStack !== RAM_END - 16 || endOfImage + extra.length > BSS_END ||
        retail.readUInt32LE(exe.entry + 0x10) !== ENTRY ||
        retail.readUInt32LE(exe.entry + stack) !== 0x2042fff8 ||
        retail.readUInt32LE(exe.entry + hook) !== 0x3083f000 ||
        retail.readUInt32LE(exe.entry + hook + 4) !== 0x3402e000) {
        throw new Error("The disc executable does not match the font bootstrap.");
    }
    const fileSize = retail.readUInt32LE(record + 10);
    if (retail.readUInt32LE(record + 2) * DATA !== exe.entry ||
        retail.readUInt32BE(record + 6) * DATA !== exe.entry ||
        retail.readUInt32BE(record + 14) !== fileSize || fileSize % DATA ||
        fileSize < DATA + exe.size || exe.entry + fileSize > retail.length) {
        throw new Error("The disc executable extent does not match the directory.");
    }
    const file = plan.read(exe.entry, exe.entry + fileSize);
    file.writeUInt32LE(endOfImage, 0x10);
    file.writeUInt32LE(exe.size + extra.length, 0x1c);
    file.writeUInt32LE(initialStack - space, 0x30);
    file.writeUInt32LE(imm(8, R.v0, R.v0, -8 - space) >>> 0, stack);
    file.writeUInt32LE(jump(FONT_ADDRESS) >>> 0, hook);
    file.writeUInt32LE(0, hook + 4);
    ext.copy(extra);
    const end = DATA + exe.size;
    const lba = plan.append(Buffer.concat([file.subarray(0, end), extra, file.subarray(end)]));
    const extent = Buffer.alloc(16);
    extent.writeUInt32LE(lba, 0);
    extent.writeUInt32BE(lba, 4);
    extent.writeUInt32LE(fileSize + extra.length, 8);
    extent.writeUInt32BE(fileSize + extra.length, 12);
    plan.put(record + 2, extent);
    plan.setVolumeSize();
}

function nativeCell(character) {
    const point = character.codePointAt(0);
    const full = character === " " ? "　" : /^[!-~]$/.test(character) ? String.fromCodePoint(point + 0xfee0) : character;
    const bytes = iconv.encode(full, "cp932");
    const lead = bytes[0];
    const native = (lead >= 0x81 && lead <= 0x84) || (lead >= 0x88 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xea);
    if (bytes.length === 2 && native && iconv.decode(bytes, "cp932") === full) return bytes;
    return null;
}

function pair(left, right, trail) {
    const lead = left < 63 ? 0xa1 + left : left < 66 ? 0x85 + left - 63 : 0xeb + left - 66;
    return Buffer.from([lead, trail + right]);
}

function createFont(rasterize, {latinNames = false} = {}) {
    const cells = new Map();
    let pairs = latinNames;
    let startupPairs = false;
    if (latinNames && !rasterize) throw new Error("Export Latin name entry in Translator++ to use the system font renderer.");
    function glyph(character, width) {
        const bytes = Buffer.from(rasterize(character, width) || []);
        if (bytes.length !== Math.ceil(width / 8) * 15) throw new Error("No usable font glyph for " + JSON.stringify(character) + ".");
        return bytes;
    }
    function encode(text, {startup = false} = {}) {
        const normal = text.normalize("NFC");
        const characters = segmenter ? Array.from(segmenter.segment(normal), part => part.segment) : [...normal];
        const indices = startup ? startupNarrow : narrow;
        const bytes = [];
        for (let i = 0; i < characters.length; i++) {
            const character = characters[i];
            const left = indices.get(character), right = indices.get(characters[i + 1]);
            if (rasterize && left !== undefined && (right !== undefined || left !== blankHalf)) {
                // Keep an unpaired character in the same font and position as
                // the left half of a pair. The padding stays inside the tile.
                pairs = true;
                if (startup) startupPairs = true;
                bytes.push(pair(left, right ?? blankHalf, startup ? STARTUP_PAIR_TRAIL : PAIR_TRAIL));
                if (right !== undefined) i++;
                continue;
            }
            const native = nativeCell(character);
            if (native) bytes.push(native);
            else {
                if (!rasterize) throw new Error("Export " + JSON.stringify(character) + " in Translator++ to use the system font renderer.");
                if (!cells.has(character)) cells.set(character, glyph(character, 16));
                const index = [...cells.keys()].indexOf(character);
                if (index >= 190) throw new Error("This disc exceeds the custom glyph index range.");
                bytes.push(Buffer.from([0xa0, 0x40 + index]));
            }
        }
        return Buffer.concat(bytes);
    }
    function startupGlyph(character) {
        // The small renderer takes five foreground samples from each byte.
        // Leave its other three bits clear so they contribute no blend pixels.
        const foregroundBits = [0x80, 0x20, 0x10, 0x04, 0x02];
        return glyph(character, 5).map(row => foregroundBits.reduce((bits, bit, x) =>
            bits | ((row & (0x80 >>> x)) ? bit : 0), 0));
    }
    function install(plan, exe, record, {nameEntry = false} = {}) {
        if (!cells.size && !pairs) return;
        const characters = startupPairs ? startupAlphabet : alphabet;
        const nameSpace = nameEntry ? NAME_ENTRY_SPACE : 0;
        const startupSpace = startupPairs ? startupAlphabet.length * 16 : 0;
        const start = FONT_ADDRESS - nameSpace - startupSpace;
        const assembler = {directCount: cells.size, pairs, startupAddress: startupPairs ? start : 0};
        const codeSize = dispatcher(assembler).length;
        assembler.tileAddress = FONT_ADDRESS + codeSize;
        assembler.narrowAddress = assembler.tileAddress + (pairs ? 32 : 0);
        assembler.directAddress = assembler.narrowAddress + (pairs ? characters.length * 16 : 0);
        const capacity = Math.floor((RAM_END - assembler.directAddress) / 30);
        if (cells.size > capacity) throw new Error("This disc needs " + cells.size + " additional glyphs with room for " + capacity + ".");
        const font = pairs ? [...characters].map(character => Buffer.concat([glyph(character, 8), Buffer.alloc(1)])) : [];
        const startupFont = startupPairs ? [...startupAlphabet].map(character =>
            Buffer.concat([startupGlyph(character), Buffer.alloc(1)])) : [];
        const prefix = Buffer.alloc(nameSpace);
        if (nameEntry) {
            // Keep the font at its normal address on every disc. Only Disc 1
            // needs the input routines, below the font and above the stack.
            const code = installNameEntry(plan, FONT_ADDRESS - nameSpace);
            if (code.length > prefix.length) throw new Error("Name-entry routines exceed their reserved space.");
            code.copy(prefix);
        }
        const payload = Buffer.concat([...startupFont, prefix, dispatcher(assembler),
            Buffer.alloc(pairs ? 32 : 0), ...font, ...cells.values()]);
        const wordAligned = Buffer.alloc(Math.ceil(payload.length / 4) * 4);
        payload.copy(wordAligned);
        installFont(plan, exe, record, wordAligned, start);
    }
    return {encode, install};
}

module.exports = {createFont, nativeCell};
