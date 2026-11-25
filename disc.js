"use strict";

const fs = require("fs").promises;
const crypto = require("crypto");

const RAW = 2352, DATA = 2048, START = 24;
const sync = Buffer.from("00ffffffffffffffffffff00", "hex");
const edcTable = new Uint32Array(256), forward = new Uint8Array(256), backward = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    let v = i;
    for (let bit = 0; bit < 8; bit++) v = (v >>> 1) ^ ((v & 1) ? 0xd8018001 : 0);
    edcTable[i] = v;
    forward[i] = (i << 1) ^ ((i & 128) ? 0x11d : 0);
    backward[i ^ forward[i]] = i;
}

function parity(sector, start, major, minor, multiplier, stride) {
    const span = major * minor;
    for (let line = 0; line < major; line++) {
        let p = (line >>> 1) * multiplier + (line & 1), a = 0, b = 0;
        for (let i = 0; i < minor; i++) {
            const byte = p < 4 ? 0 : sector[12 + p];
            p += stride;
            if (p >= span) p -= span;
            a = forward[a ^ byte];
            b ^= byte;
        }
        a = backward[forward[a] ^ b];
        sector[start + line] = a;
        sector[start + line + major] = a ^ b;
    }
}

function fixSector(sector) {
    let checksum = 0;
    for (let i = 16; i < 2072; i++) checksum = (checksum >>> 8) ^ edcTable[(checksum ^ sector[i]) & 255];
    sector.writeUInt32LE(checksum >>> 0, 2072);
    parity(sector, 2076, 86, 24, 2, 86);
    parity(sector, 2248, 52, 43, 86, 88);
}

function makeSector(lba) {
    const sector = Buffer.alloc(RAW);
    sync.copy(sector);
    const msf = lba + 150;
    const bcd = n => (Math.floor(n / 10) << 4) | (n % 10);
    sector[12] = bcd(Math.floor(msf / 4500));
    sector[13] = bcd(Math.floor(msf / 75) % 60);
    sector[14] = bcd(msf % 75);
    sector[15] = 2;
    return sector;
}

function abort(signal) {
    if (signal?.aborted) throw new Error("Disc operation cancelled.");
}

async function writeExact(file, content, at) {
    for (let offset = 0; offset < content.length;) {
        const {bytesWritten} = await file.write(content, offset, content.length - offset, at + offset);
        if (!bytesWritten) throw new Error("Disc write stopped before completion.");
        offset += bytesWritten;
    }
}

async function readOriginal(profile, {copyTo, withData = true, signal} = {}) {
    const original = await fs.open(profile.bin, "r");
    let copy;
    try {
        if (copyTo) copy = await fs.open(copyTo, "wx");
        const size = (await original.stat()).size;
        if (size % RAW || size !== profile.size) throw new Error("Disc " + profile.number + " has an unexpected size.");
        const data = withData ? Buffer.allocUnsafe(size / RAW * DATA) : null;
        const hash = crypto.createHash("sha256"), chunk = Buffer.allocUnsafe(4096 * RAW);
        for (let offset = 0; offset < size;) {
            abort(signal);
            const length = Math.min(chunk.length, size - offset);
            const {bytesRead} = await original.read(chunk, 0, length, offset);
            if (bytesRead !== length) throw new Error("Disc " + profile.number + " ended early.");
            const raw = chunk.subarray(0, length);
            hash.update(raw);
            if (copy) await writeExact(copy, raw, offset);
            if (data) {
                let logical = offset / RAW * DATA;
                for (let p = START; p < length; p += RAW, logical += DATA) raw.copy(data, logical, p, p + DATA);
            }
            offset += length;
        }
        if (hash.digest("hex") !== profile.sha256) throw new Error("Disc " + profile.number + " does not match the clean Japanese Rev 1 image.");
        return data;
    } finally {
        await original.close();
        if (copy) await copy.close();
    }
}

class SectorPlan {
    constructor(original) {
        this.original = original;
        this.modified = new Map();
        this.count = original.length / DATA;
    }

    put(offset, value) {
        for (let at = 0; at < value.length;) {
            const physical = offset + at, lba = Math.floor(physical / DATA), start = physical % DATA;
            let sector = this.modified.get(lba);
            if (!sector) {
                sector = lba < this.original.length / DATA
                    ? Buffer.from(this.original.subarray(lba * DATA, (lba + 1) * DATA)) : Buffer.alloc(DATA);
                this.modified.set(lba, sector);
            }
            const count = Math.min(DATA - start, value.length - at);
            value.copy(sector, start, at, at + count);
            at += count;
        }
    }

    append(value) {
        if (value.length % DATA) throw new Error("An appended disc resource must be sector aligned.");
        const start = this.count;
        this.put(start * DATA, value);
        this.count += value.length / DATA;
        return start;
    }

    setVolumeSize() {
        const descriptor = 16 * DATA;
        if (this.original.toString("ascii", descriptor, descriptor + 7) !== "\x01CD001\x01" ||
            this.original.readUInt32LE(descriptor + 80) !== this.original.length / DATA ||
            this.original.readUInt32BE(descriptor + 84) !== this.original.length / DATA) {
            throw new Error("The original ISO volume size does not match the disc.");
        }
        const extent = Buffer.alloc(8);
        extent.writeUInt32LE(this.count);
        extent.writeUInt32BE(this.count, 4);
        this.put(descriptor + 80, extent);
    }

    read(start, end) {
        const result = Buffer.from(this.original.subarray(start, end));
        for (let lba = Math.floor(start / DATA); lba * DATA < end; lba++) {
            const changed = this.modified.get(lba);
            if (!changed) continue;
            const base = lba * DATA, from = Math.max(start, base), to = Math.min(end, base + DATA);
            changed.copy(result, from - start, from - base, to - base);
        }
        return result;
    }

    async write(target, signal) {
        const file = await fs.open(target, "r+");
        let changed = 0;
        try {
            for (const [lba, content] of [...this.modified].sort((a, b) => a[0] - b[0])) {
                abort(signal);
                const appended = lba >= this.original.length / DATA;
                if (!appended && content.equals(this.original.subarray(lba * DATA, (lba + 1) * DATA))) continue;
                const raw = appended ? makeSector(lba) : Buffer.allocUnsafe(RAW);
                const offset = lba * RAW;
                if (!appended) {
                    const result = await file.read(raw, 0, RAW, offset);
                    if (result.bytesRead !== RAW || !raw.subarray(0, 12).equals(sync) || raw[15] !== 2 || (raw[18] & 0x20)) {
                        throw new Error("Cannot rewrite LBA " + lba + " as Mode 2 Form 1.");
                    }
                }
                content.copy(raw, START);
                fixSector(raw);
                await writeExact(file, raw, offset);
                const verify = Buffer.allocUnsafe(RAW);
                if ((await file.read(verify, 0, RAW, offset)).bytesRead !== RAW || !verify.equals(raw)) throw new Error("Disc sector verification failed at LBA " + lba);
                changed++;
            }
            return changed;
        } finally {
            await file.close();
        }
    }
}

module.exports = {DATA, abort, readOriginal, SectorPlan, fixSector, makeSector};
