"use strict";

const {createHash} = require("crypto");
const {DATA} = require("./disc.js");
const {decode, encode} = require("./textures.js");

const sheetOffset = 35516 * DATA + 308;
const sheetChecksum = "786508a56089ab97f7d80c30df6801f83c39cf4e";
const childhoodModule = 35248 * DATA;
const markerLayouts = [{offset: 0x2baa8, v: 128}, {offset: 0x2bb98, v: 144}];
const weekdays = ["Fr", "Sa", "Su", "Mo", "Tu", "We", "Th"];
const mainDateImage = "pic-642fc53202";
const mainMarkers = Buffer.from([
    "c40016007800081000000000", // Closing parenthesis
    "ad0016007000081000000000", // Opening parenthesis
    "9d0016000000101000000000", // Day marker
    "750016001000101000000000", // Month marker
    "4e0016002010101000008000"  // Year marker
].join(""), "hex");
const glyphs = {
    F: ["11110", "10000", "10000", "11100", "10000", "10000", "10000"],
    r: ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
    S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
    u: ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
    M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
    T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    e: ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
    h: ["10000", "10000", "10110", "11001", "10001", "10001", "10001"],
    "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"]
};

function drawDateTile(sheet, x, y, text, ink) {
    const tile = new Uint8Array(16 * 16);
    for (const [i, char] of [...text].entries()) {
        const left = text.length === 1 ? 5 : 2 + i * 7;
        for (const [r, row] of glyphs[char].entries()) {
            for (const [col, pixel] of [...row].entries()) {
                if (pixel !== "1") continue;
                const p = (1 + r * 2) * 16 + left + col;
                for (const dy of [-16, 0, 16, 32]) {
                    for (const dx of [-1, 0, 1]) tile[p + dy + dx] ||= 1;
                }
                tile[p] = tile[p + 16] = ink;
            }
        }
    }
    for (let row = 0; row < 16; row++) {
        for (let col = 0; col < 16; col += 2) {
            sheet[(y + row) * 64 + (x + col) / 2] = tile[row * 16 + col] | (tile[row * 16 + col + 1] << 4);
        }
    }
}

function localizeChildhoodDate(plan) {
    const {out: sheet, consumed} = decode(plan.original, sheetOffset, 2);
    if (createHash("sha1").update(sheet).digest("hex") !== sheetChecksum) {
        throw new Error("Unexpected childhood calendar texture on Disc 1.");
    }
    for (const {v} of markerLayouts) {
        weekdays.forEach((day, i) => drawDateTile(sheet, i * 16, v - 128, day, 6));
        drawDateTile(sheet, 112, v - 128, "/", 6);
    }
    const stream = encode(sheet, 2);
    if (stream.length > consumed || !decode(stream, 0, 2).out.equals(sheet)) {
        throw new Error("The childhood calendar texture exceeds its original packet or failed verification.");
    }
    const packet = Buffer.alloc(consumed);
    stream.copy(packet);
    plan.put(sheetOffset, packet);

    for (const {offset, v} of markerLayouts) {
        const month = childhoodModule + offset + 20, day = month + 20;
        for (const [at, u] of [[month, 48], [day, 32]]) {
            if (plan.original[at + 4] !== u || plan.original[at + 5] !== v ||
                plan.original.readUInt32LE(at + 8) !== 0x00100010) {
                throw new Error("Unexpected childhood calendar sprite layout on Disc 1.");
            }
        }
        // Year and month use the slash tile. The day marker draws one
        // transparent pixel from the upper-left corner of that same tile.
        plan.put(month + 4, Buffer.from([112]));
        plan.put(day + 4, Buffer.from([112]));
        plan.put(day + 8, Buffer.from([1, 0, 1, 0]));
    }
}

function localizeMainDateTiles(sheet) {
    // The main screen indexes Sunday first and uses its own palette.
    for (let i = 0; i < weekdays.length; i++) {
        drawDateTile(sheet, i * 16, 0, weekdays[(i + 2) % weekdays.length], 8);
    }
    drawDateTile(sheet, 32, 16, "/", 8);
}

function localizeMainDateLayout(plan, disc) {
    const markerOffset = (disc === 1 ? 2425 : 1732) * DATA + 592;
    const weekdayX = markerOffset - 0x2c998;
    if (!plan.original.subarray(markerOffset, markerOffset + mainMarkers.length).equals(mainMarkers) ||
        plan.original.readUInt32LE(weekdayX) !== 0x2402ffb5) {
        throw new Error("Unexpected main calendar layout on Disc " + disc + ".");
    }
    const markers = Buffer.from(mainMarkers);
    // Close up the weekday group after dropping the marker after the day.
    markers.writeInt16LE(187, 0);
    markers.writeInt16LE(164, 12);
    // Sample the transparent top-left pixel of the slash tile for the day.
    markers.set([32, 16, 1, 1], 24 + 4);
    markers.set([32, 16], 36 + 4);
    plan.put(markerOffset, markers);
    // addiu v0, zero, -87. Keep the game's weekday and holiday palette selection.
    plan.put(weekdayX, Buffer.from([0xa9, 0xff, 0x02, 0x24]));
}

module.exports = {localizeChildhoodDate, mainDateImage, localizeMainDateTiles, localizeMainDateLayout};
