"use strict";

const R = {z: 0, v0: 2, v1: 3, a0: 4, a1: 5, a2: 6, t0: 8, t1: 9, t2: 10, t3: 11,
    t4: 12, t5: 13, t6: 14, t7: 15, s0: 16, t8: 24, ra: 31};
const imm = (op, rt, rs, value) => (op << 26) | (rs << 21) | (rt << 16) | (value & 65535);
const reg = (fn, rd, rs, rt, shift = 0) => (rs << 21) | (rt << 16) | (rd << 11) | (shift << 6) | fn;
const jump = address => (2 << 26) | ((address >>> 2) & 0x03ffffff);

function wordsToBuffer(words) {
    const output = Buffer.alloc(words.length * 4);
    words.forEach((word, index) => output.writeUInt32LE(word >>> 0, index * 4));
    return output;
}

function assemble(build) {
    const words = [], labels = new Map(), branches = [];
    const push = (...code) => words.push(...code);
    const label = name => labels.set(name, words.length);
    const branch = (op, rs, rt, name, delay = 0) => {
        branches.push({at: words.length, op, rs, rt, name});
        push(0, delay);
    };
    build(push, label, branch);
    for (const {at, op, rs, rt, name} of branches) {
        const target = labels.get(name);
        if (target === undefined) throw new Error("Unknown MIPS label " + name + ".");
        words[at] = imm(op, rt, rs, target - at - 1);
    }
    return wordsToBuffer(words);
}

module.exports = {R, imm, reg, jump, wordsToBuffer, assemble};
