"use strict";

const {createHash} = require("crypto");
const {DATA} = require("./disc.js");
const {R, imm, reg, jump, wordsToBuffer, assemble} = require("./mips.js");

const moduleBase = 0x800c0000;
const moduleOffset = 2038 * DATA;
const moduleSize = 0xe000;
const revision = "c7632ee16dc374183ea2e2a46aa6269e0db31492fac87687703954562e7140ae";
const symbolsOffset = 0x500;
const symbolsEnd = 0x88a;
const appendAt = 0x800c8804;
const appendFinish = 0x800c884c;
const capacitySound = 0x800c8870;
const appendExit = 0x800c896c;
const backspaceAt = 0x800c8644;
const backspaceExit = 0x800c86d8;
const cursor = 0x1fc;
const latinLetters = 52;
// For letter indices 1–52, the existing pair renderer uses lead 0xA1 + index
// and trail 0x40 + index. A trail of 0x40 leaves the right half blank.
const pairLead = 0xa1;
const pairTrail = 0x40;
const uppercase = 0x60;
const lowercase = 0x81;
const {z, v0, v1, a0, a1, a2, t0, t1, t2, t3, t4, t5, t6, t7, s0} = R;

function appendCode() {
    return assemble((push, label, branch) => {
        // a2 is the selected key. a1 points to the active seven-byte field.
        push(imm(35, t0, a2, 4), imm(33, t1, a2, 0x10), 0, reg(0, t1, z, t1, 1),
            reg(33, t0, t0, t1), imm(36, t1, t0, 0), imm(36, t2, t0, 1),
            imm(9, t1, t1, -0x82));
        branch(5, t1, z, "native", imm(9, t3, t2, -uppercase));
        push(imm(11, t4, t3, 26));
        branch(5, t4, z, "letter", imm(9, t3, t3, 1));
        push(imm(9, t3, t2, -lowercase), imm(11, t4, t3, 26));
        branch(4, t4, z, "native", imm(9, t3, t3, 27));

        label("letter");
        // The cursor stops at cell 2. Its cell can already be occupied.
        push(imm(33, t0, s0, cursor), 0, reg(0, t1, z, t0, 1), reg(33, t1, t1, a1),
            imm(36, t2, t1, 0), imm(11, t4, t0, 1));
        branch(5, t2, z, "checkLast", reg(33, t5, t1, z));
        branch(5, t4, z, "newCell", imm(9, t5, t1, -2));
        label("checkLast");
        push(imm(36, t6, t5, 0), imm(36, t7, t5, 1),
            imm(9, t6, t6, -(pairLead + 1)), imm(11, t6, t6, latinLetters));
        branch(4, t6, z, "newCell", imm(9, t7, t7, -pairTrail));
        branch(5, t7, z, "newCell", imm(9, t4, t3, pairTrail));
        push(jump(appendExit), imm(40, t4, t5, 1));

        label("newCell");
        branch(5, t2, z, "full", imm(9, t4, t3, pairLead));
        push(imm(40, t4, t1, 0), imm(9, t4, z, pairTrail), jump(appendFinish), imm(40, t4, t1, 1));
        label("full");
        push(jump(capacitySound), 0);
        label("native");
        push(imm(33, v1, s0, cursor), jump(appendAt + 8), imm(33, v0, a2, 0x10));
    });
}

function backspaceCode() {
    return assemble((push, label, branch) => {
        // a2 is the name-entry state. a0 points to the active name field.
        push(imm(33, t0, a2, cursor), reg(33, t1, a0, z));
        branch(4, t0, z, "removeCell", reg(33, t2, t0, z));
        push(imm(9, t2, t0, -1), imm(9, t3, z, 2));
        branch(5, t0, t3, "checkLast", imm(36, t4, a0, 4));
        push(0);
        branch(4, t4, z, "checkLast");
        push(reg(33, t2, t0, z));
        label("checkLast");
        push(reg(0, t1, z, t2, 1), reg(33, t1, a0, t1),
            imm(36, t3, t1, 0), imm(36, t4, t1, 1),
            imm(9, t3, t3, -(pairLead + 1)), imm(11, t3, t3, latinLetters));
        branch(4, t3, z, "removeCell", imm(9, t5, z, pairTrail));
        branch(4, t4, t5, "removeCell");
        push(jump(backspaceExit), imm(40, t5, t1, 1));
        label("removeCell");
        push(imm(41, t2, a2, cursor), jump(backspaceExit), imm(40, z, t1, 0));
    });
}

function installNameEntry(plan, address) {
    const original = plan.original.subarray(moduleOffset, moduleOffset + moduleSize);
    if (createHash("sha256").update(original).digest("hex") !== revision) {
        throw new Error("Unexpected name-entry module on Disc 1.");
    }
    const symbols = [], letters = [];
    for (let at = symbolsOffset; at < symbolsEnd; at += 2) {
        const code = original.readUInt16BE(at);
        const isLetter = (code >= 0x8200 + uppercase && code < 0x8200 + uppercase + 26) ||
            (code >= 0x8200 + lowercase && code < 0x8200 + lowercase + 26);
        (isLetter ? letters : symbols).push(original.subarray(at, at + 2));
    }
    // Keep the game's keys, grid, and text renderer. Put its Latin keys first.
    plan.put(moduleOffset + symbolsOffset, Buffer.concat([...letters, ...symbols]));
    const append = appendCode(), backspace = backspaceCode();
    plan.put(moduleOffset + appendAt - moduleBase, wordsToBuffer([jump(address), 0]));
    plan.put(moduleOffset + backspaceAt - moduleBase, wordsToBuffer([jump(address + append.length), 0]));
    return Buffer.concat([append, backspace]);
}

module.exports = {installNameEntry};
