"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const {createHash} = require("crypto");
const {DATA, readOriginal, SectorPlan, abort} = require("./disc.js");
const {scanScenes, maxBoxRows, maxSpeakerCells} = require("./script.js");
const {executable, locateOverlays, replaceScenes} = require("./layout.js");
const {scanMenus, replaceMenus, isLegacyExecutableCode, introBoxes, introFile, introModule, saveContinuePrompt} = require("./menus.js");
const {localizeChildhoodDate, mainDateImage, localizeMainDateTiles, localizeMainDateLayout} = require("./calendar.js");
const textures = require("./textures.js");
const cg = require("./cg.js");
const {createFont} = require("./font.js");
const actorInfo = require("./actor-info.json");
const englishSpeakerNames = require("./speaker-names-en.json");
const englishTwins = new Map([["美帆", "Miho"], ["真帆", "Maho"]]);
const englishChildhoodPlaces = {
    "ひびきの高校前": "Hibikino High",
    "華澄宅前": "Kasumi's House",
    "光宅前": "Hikari's House",
    "ひびきの小学校": "Hibikino Elem.",
    "伊集院邸前大橋": "Ijuin Bridge",
    "大通り": "Main Street",
    "ひびきの駅前": "Hibikino Station",
    "踏切": "Rail Crossing",
    "河川敷き公園": "Riverside Park",
    "河川敷き": "Riverside",
    "自宅前": "Outside Home",
    "駄菓子屋前": "Candy Shop",
    "ひびきの神社": "Hibikino Shrine",
    "小さな公園": "Small Park",
    "図書館公園": "Library Park",
    "ひびきの商店街": "Hibikino Shops",
    "山道": "Mountain Path",
    "教室": "Classroom",
    "道路": "Road",
    "小さな公園前": "Outside Small Park",
    "小さな公園・桜祭り": "Blossom Festival",
    "児童図書館": "Children's Library"
};

const title = "Tokimeki Memorial 2";
const playlistName = title + ".m3u";
const reportName = "report.json";
const playerActor = "MC";
const choiceActor = "choice";
const legacyPlayerActor = "Player (custom name)";
const displayContextSuffix = /\/(message|choice)\/(\d+)$/;
const profiles = [
    [692447616, "c76b7878614d86cc0bb8fe58024b4d88617a7ecba0097957e6a2c646be078f83"],
    [739793376, "d2f781f02455281b72a9e011fbf2bb2766cb01ce272affc43594cc5ae9018896"],
    [747917184, "f462874d3d6af7c081218a75ab12ccae4eaaf9664cd8bc9e8cd2516edd06e68f"],
    [745115952, "63e379cf2fa7564110a6ae306f4adf49ad049e4cf12a9bf0a1e921e5c100bd93"],
    [743427216, "fac09425db4795f85d3cabd72459423a99963e33d32274786b371ee94d07def9"]
];
const sync = Buffer.from("00ffffffffffffffffffff00", "hex");

async function sector(handle, lba) {
    const buffer = Buffer.alloc(2352);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, lba * buffer.length);
    if (bytesRead !== buffer.length || !buffer.subarray(0, 12).equals(sync) ||
        buffer[15] !== 2 || (buffer[18] & 0x20)) throw new Error("Invalid Mode 2 Form 1 sector at LBA " + lba);
    return buffer.subarray(24, 2072);
}

async function identifyBin(bin) {
    const stat = await fsp.stat(bin);
    const profileIndex = profiles.findIndex(([size]) => size === stat.size);
    if (!stat.isFile() || profileIndex < 0) return null;
    const handle = await fsp.open(bin, "r");
    try {
        const pvd = await sector(handle, 16);
        if (pvd[0] !== 1 || pvd.toString("ascii", 1, 6) !== "CD001" || pvd[6] !== 1) return null;
        const lba = pvd.readUInt32LE(158), length = pvd.readUInt32LE(166);
        if (!length || length > 32768 || lba + Math.ceil(length / DATA) > stat.size / 2352) return null;
        const serial = "SLPM_863.5" + (profileIndex + 5);
        let pack = false, executable, exeRecord;
        for (let i = 0; i * DATA < length; i++) {
            const directory = await sector(handle, lba + i);
            for (let offset = 0; directory[offset]; offset += directory[offset]) {
                const size = directory[offset], nameSize = directory[offset + 32];
                if (size < 34 || offset + size > directory.length || nameSize > size - 33) return null;
                const name = directory.toString("ascii", offset + 33, offset + 33 + nameSize).split(";")[0];
                if (name === serial) {
                    executable = directory.readUInt32LE(offset + 2);
                    exeRecord = (lba + i) * DATA + offset;
                }
                if (name === "CDPACK00.BIN") pack = true;
            }
        }
        if (!pack || !executable || executable >= stat.size / 2352 ||
            (await sector(handle, executable)).toString("ascii", 0, 8) !== "PS-X EXE") return null;
        return {number: profileIndex + 1, serial, bin, size: stat.size, exeLba: executable, exeRecord, sha256: profiles[profileIndex][1]};
    } finally {
        await handle.close();
    }
}

async function readCue(file) {
    const lines = (await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "").trim().split(/\r?\n/)
        .map(line => line.trim()).filter(line => line && !/^REM(?:\s|$)/i.test(line));
    const match = /^FILE\s+"([^"]+)"\s+BINARY$/i.exec(lines[0] || "");
    if (!match || /[\\/:]/.test(match[1]) || !/\.bin$/i.test(match[1]) || !/^TRACK\s+01\s+MODE2\/2352$/i.test(lines[1] || "") ||
        !/^INDEX\s+01\s+00:00:00$/i.test(lines[lines.length - 1] || "") ||
        lines.slice(2, -1).some(line => !/^FLAGS\s+DCP$/i.test(line))) {
        throw new Error("Choose a single-track MODE2/2352 CUE with a BIN beside it.");
    }
    return {bin: path.join(path.dirname(file), match[1]), cue: file, dcp: lines.some(line => /^FLAGS\s+DCP$/i.test(line))};
}

async function discover(entryPoint) {
    const selection = Array.isArray(entryPoint) ? entryPoint : [entryPoint];
    const paths = selection.map(file => path.resolve(file));
    const source = paths[0];
    const directory = !Array.isArray(entryPoint) && (await fsp.stat(source)).isDirectory();
    const files = directory
        ? (await fsp.readdir(source, {withFileTypes: true})).filter(file => file.isFile() && /\.(cue|bin)$/i.test(file.name))
            .map(file => path.join(source, file.name))
        : paths;
    files.sort((a, b) => Number(!/\.cue$/i.test(a)) - Number(!/\.cue$/i.test(b)));
    const discs = new Map(), seen = new Set();
    for (const file of files) {
        try {
            const input = /\.cue$/i.test(file) ? await readCue(file) : {bin: file};
            if (!/\.bin$/i.test(input.bin)) throw new Error("Choose a BIN or CUE disc image: " + path.basename(file));
            input.bin = await fsp.realpath(input.bin);
            if (seen.has(input.bin)) continue;
            seen.add(input.bin);
            const disc = await identifyBin(input.bin);
            if (!disc) throw new Error("This is not a supported Japanese Rev 1 disc: " + path.basename(file));
            if (discs.has(disc.number)) throw new Error("More than one source for Disc " + disc.number + ". Choose one copy of each disc.");
            discs.set(disc.number, {...disc, ...input});
        } catch (error) {
            if (!directory || /^More than one source/.test(error.message)) throw error;
        }
    }
    if (!discs.size) throw new Error("No Japanese Rev 1 Tokimeki Memorial 2 BIN/CUE discs found.");
    return [...discs.values()].sort((a, b) => a.number - b.number);
}

async function detect(entryPoint) {
    try { return (await discover(entryPoint)).length > 0; }
    catch (_) { return false; }
}

async function inspectDiscSelection(selection) {
    const found = (await discover(selection)).map(disc => disc.number);
    const missing = profiles.map((_, index) => index + 1).filter(number => !found.includes(number));
    return {found, missing};
}

async function readJson(file) {
    return JSON.parse(await fsp.readFile(file, "utf8"));
}

function resourcePath(root, id) {
    const parts = typeof id === "string" ? id.replace(/^[\\/]/, "").split(/[\\/]/) : [];
    if (!parts.length || parts.some(part => !part || /[. ]$|[:*?"<>|\u0000-\u001f]/.test(part))) {
        throw new Error("Invalid Tokimeki Memorial 2 resource ID: " + id);
    }
    return path.join(root, ...parts);
}

function sceneFile(scene) {
    // Hex escaping keeps case, Windows device names, and punctuation from
    // collapsing distinct bytecode IDs into the same path.
    const stem = scene.sid.replace(/[^A-Z0-9_]/g, ch => "-" + ch.charCodeAt(0).toString(16).padStart(2, "0"));
    return "Dialogue/scene-" + stem + ".json";
}

function menuContext(number, row) {
    return "Disc " + number + "/" + row.where + "/0x" + row.offset.toString(16);
}

function actorReferenceName({speaker, speakerKind, speakerIdentity, choice}) {
    if (choice) return choiceActor;
    if (speakerIdentity) return speakerIdentity;
    if (speakerKind === "literal") return speaker;
    if (speakerKind === "runtime" && /^\{name[123]\}$/.test(speaker)) return playerActor;
}

function setShirayukiRowActors(occurrences) {
    const identified = occurrences.filter(occurrence => occurrence?.speakerIdentity);
    if (!identified.length) return;
    const identities = new Set(identified.map(occurrence => occurrence.speakerIdentity));
    const shared = identities.size > 1 ||
        occurrences.some(occurrence => occurrence?.speaker === "白雪" && !occurrence.speakerIdentity);
    // A row can share the same source and translation between the twins.
    // Keep each occurrence's identity, but give the shared row a neutral voice.
    for (const occurrence of identified) {
        if (occurrence.rowInfoText === occurrence.speaker ||
            occurrence.rowInfoText === occurrence.speakerIdentity || occurrence.rowInfoText === "白雪") {
            occurrence.rowInfoText = shared ? "白雪" : occurrence.speakerIdentity;
        }
    }
}

function actorReferenceRows(names) {
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, "ja"))
        .map(name => {
            const actor = Object.hasOwn(actorInfo, name) ? actorInfo[name] : undefined;
            let gender = actor?.gender;
            if (gender && gender !== "male" && gender !== "female") gender = "Gender:" + gender;
            const note = actor ? (gender ? gender + ". " : "") + actor.role + " Voice guidance — " + actor.voice : "";
            return [name, "", note];
        });
}

function mergeActorReferenceRows(rows, defaults, infoColumn = 2) {
    const byName = new Map(defaults.map(([name, , info]) => [name, info]));
    const renamePlayer = byName.has(playerActor) && !rows.some(row => row?.[0] === playerActor);
    const merged = rows.map(row => {
        if (renamePlayer && Array.isArray(row) && row[0] === legacyPlayerActor) row = [playerActor, ...row.slice(1)];
        if (!Array.isArray(row) || !byName.has(row[0])) return row;
        const info = byName.get(row[0]);
        byName.delete(row[0]);
        const previous = row[infoColumn];
        if (!info || previous === info) return row;
        if (previous != null && previous !== "" && info !== "Gender:" + previous) {
            // Upgrade exact stock notes from earlier releases.
            const previousInfoHashes = actorInfo[row[0]]?.previousInfoHashes;
            if (!previousInfoHashes || typeof previous !== "string" ||
                !previousInfoHashes.includes(createHash("sha256").update(previous).digest("hex"))) return row;
        }
        const updated = row.slice();
        updated[infoColumn] = info;
        return updated;
    });
    for (const [name, info] of byName) {
        const row = Array(infoColumn + 1).fill("");
        row[0] = name;
        row[infoColumn] = info;
        merged.push(row);
    }
    return merged;
}

async function scan(entryPoint, options = {}) {
    const discs = options.discs ? await resolveDiscs(options.discs, entryPoint) : await discover(entryPoint);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tpp-tm2-import-"));
    try {
        const files = new Map(), images = new Map(), speakerNames = new Set();
        function add(file, row) {
            if (!files.has(file)) files.set(file, []);
            files.get(file).push(row);
        }
        for (const disc of discs) {
            const {number} = disc;
            options.progress?.("Reading Disc " + number);
            const data = await readOriginal(disc, {signal: options.signal});
            const scenes = scanScenes(data), exe = executable(data, disc.exeLba);
            const {overlays} = locateOverlays(data, exe);
            for (const scene of scenes.values()) {
                if (!scene.rows.length) continue;
                const file = sceneFile(scene);
                const prefix = "Disc " + number + "/" + scene.key + "/0x" + scene.offset.toString(16);
                for (const row of scene.rows) {
                    const actor = actorReferenceName(row);
                    if (actor) speakerNames.add(actor);
                    add(file, {...row, disc: number, offset: scene.offset, key: scene.key, container: scene.container,
                        context: prefix + "/" + (row.choice ? "choice" : row.kind) + "/" + row.at});
                }
            }
            const menus = scanMenus(data, disc, exe, overlays, scenes);
            for (const {source, offset, where, module, maxBytes, cells, packedTable, rowInfoNote} of menus) {
                if (module === introModule) continue;
                add("Menus/" + module + ".json", {source, offset, where, module, maxBytes, cells, packedTable,
                    rowInfoNote, disc: number, kind: "menu", context: menuContext(number, {where, offset})});
            }
            for (const {parts, ...box} of introBoxes(menus)) {
                speakerNames.add(playerActor);
                add(introFile, {...box, disc: number, module: introModule, kind: "message", context: menuContext(number, box),
                    speaker: playerActor, speakerKind: "runtime", speakerIdentity: playerActor,
                    speakerSource: "TM2 Disc 2 intro overlay", controls: [], reflow: false,
                    lines: parts.map(line => ({parts: line.map((part, i) => ({source: part.source,
                        context: menuContext(number, part), joinNext: i < line.length - 1})),
                    maxCells: line.reduce((sum, part) => sum + Math.floor(part.maxBytes / 2), 0)}))});
            }
            if (options.includeImages === false) continue;
            for (const image of textures.inventory(data, number)) {
                if (!images.has(image.key)) {
                    const {locations, copies, ...metadata} = image;
                    await fsp.writeFile(path.join(dir, image.name), textures.toPng(copies[0].out));
                    images.set(image.key, {...metadata, file: "images/tm2/" + image.name, discs: {}});
                }
                images.get(image.key).discs[number] = image.locations;
            }
            options.progress?.("Extracting CG from Disc " + number);
            for (const image of cg.inventory(data, options.signal)) {
                if (!images.has(image.key)) {
                    const {key, name, kind, width, height, bpp, label} = image;
                    await fsp.writeFile(path.join(dir, name), cg.preview(image));
                    images.set(key, {key, name, kind, width, height, bpp, label, file: "images/tm2/cg/" + name, discs: {}});
                }
                const locations = images.get(image.key).discs;
                (locations[number] ||= []).push(image.location);
            }
        }
        for (const [file, rows] of files) {
            const filename = resourcePath(dir, file);
            await fsp.mkdir(path.dirname(filename), {recursive: true});
            await fsp.writeFile(filename, JSON.stringify({version: 1, rows}));
        }
        const actors = actorReferenceRows(speakerNames);
        return {sourceDir: dir, files: [...files.keys()].sort(), discs, images: [...images.values()], actors};
    } catch (error) {
        await fsp.rm(dir, {recursive: true, force: true});
        throw error;
    }
}

async function readDescriptor(file) {
    const value = await readJson(file);
    if (value.version !== 1 || !Array.isArray(value.rows)) throw new Error("Invalid Tokimeki Memorial 2 staged resource.");
    return value.rows;
}

function applyChoiceMetadata(metadata) {
    const note = "One option per line. Keep the option count and order.";
    metadata.choice = true;
    metadata.reflow = false;
    metadata.messageType = "choice";
    metadata.rowInfoText = choiceActor;
    metadata.translationConstraints = {...metadata.translationConstraints, preserveLineCount: true, maxLines: metadata.lines.length};
    metadata.rowInfoNote = [note, metadata.rowInfoNote].filter(Boolean).join(" ");
}

function seedSpeakerNames(files, targetLanguage) {
    const english = /^en(?:[-_]|$)/i.test(targetLanguage);
    for (const [id, file] of Object.entries(files)) {
        if (!id.startsWith("/Dialogue/")) continue;
        for (const [index, occurrences] of file.parameters.entries()) {
            if (!Array.isArray(occurrences)) continue;
            const speakers = occurrences.filter(row => row?.kind === "speaker");
            if (!speakers.length) continue;
            const tags = file.tags[index] ||= [];
            if (!tags.includes("yellow")) tags.push("yellow");
            const cells = file.data[index];
            if (cells[0] === "白雪" && speakers.some(row => !row.nameplateIdentity) && !tags.includes("blue")) tags.push("blue");
            if (!english || !Object.hasOwn(englishSpeakerNames, cells[0])) continue;
            const target = englishSpeakerNames[cells[0]];
            const editable = speakers.filter(row => row.speakerKind === "literal" && !row.controls?.length);
            if (cells[0] === "白雪" && editable.some(row => row.nameplateIdentity)) {
                if ((cells[1] && cells[1] !== target) || cells.slice(2).some(Boolean)) continue;
                const names = editable.map(row => englishTwins.get(row.nameplateIdentity) || target);
                if (editable.length === occurrences.length) cells[1] = names.includes(target) ? target : names[0];
                for (const [i, row] of editable.entries()) {
                    if (!row.translation && names[i] !== cells[1]) row.translation = names[i];
                }
                continue;
            }
            if (editable.length === occurrences.length && editable.every(row => !row.translation)) {
                if (!cells[1]) cells[1] = target;
            } else if (!cells.slice(1).some(Boolean)) {
                // A source string can be both a nameplate and dialogue in the same file.
                for (const row of editable) if (!row.translation) row.translation = target;
            }
        }
    }
}

function seedMenuTranslations(files, targetLanguage) {
    if (!/^en(?:[-_]|$)/i.test(targetLanguage)) return;
    const defaults = {
        "/Menus/CHILD.json": englishChildhoodPlaces,
        "/Menus/OV6.json": {[saveContinuePrompt]: "Continue the game?\nYes...○  No...×"}
    };
    for (const [id, strings] of Object.entries(defaults)) {
        for (const cells of files[id]?.data || []) {
            if (cells && Object.hasOwn(strings, cells[0]) && !cells.slice(1).some(Boolean)) cells[1] = strings[cells[0]];
        }
    }
}

function displayContext(context, choice) {
    return choice ? context.replace(displayContextSuffix, "/choice/$2") : context;
}

async function parseFile(file) {
    const rows = await readDescriptor(file);
    const menu = rows[0]?.kind === "menu";
    const result = {data: [], context: [], parameters: [], tags: [], indexIds: Object.create(null),
        translationConstraintType: menu ? "table" : "scenario"};
    for (const {source, context: storedContext, ...row} of rows) {
        const context = displayContext(storedContext, row.choice);
        if (result.indexIds[source] === undefined) {
            result.indexIds[source] = result.data.length;
            result.data.push([source, ""]);
            result.context.push([]);
            result.parameters.push([]);
            result.tags.push([]);
        }
        const index = result.indexIds[source];
        result.context[index].push(context);
        const metadata = {...row, contextStr: context};
        if (row.kind !== "menu") {
            metadata.speakerSource = row.speakerSource || (row.speaker ? "TM2 script opcode 0x18" : undefined);
            metadata.messageType = row.kind === "speaker" ? "speakerLabel" : "messageBox";
            if (row.kind === "message") {
                metadata.translationConstraints = {
                    preserveLineCount: !row.reflow,
                    maxLines: row.reflow ? maxBoxRows : row.lines.length
                };
                if (row.module === introModule) {
                    const [first, second] = row.lines;
                    metadata.rowInfoNote = second
                        ? "Use up to " + first.maxCells + " glyph cells on line 1 and " + second.maxCells +
                            " on line 2. The game adds the opening quote and its standalone ellipses."
                        : "Use up to " + first.maxCells + " glyph cells. The game adds the opening quote.";
                } else if (!row.reflow && !row.choice) {
                    metadata.rowInfoNote = "This box keeps its native line count for script-controlled display.";
                }
            } else if (row.speakerKind === "literal") {
                metadata.rowInfoNote = "Speaker nameplate. Use up to " + maxSpeakerCells + " full-width glyph cells.";
            }
            if (row.speakerKind === "literal" || row.speakerKind === "runtime") {
                metadata.rowInfoText = actorReferenceName(row) || row.speaker;
                if (row.speakerKind === "runtime" && metadata.rowInfoText === playerActor) metadata.speakerNameIsVariable = true;
            }
            if (row.choice) applyChoiceMetadata(metadata);
            if (row.controls.length) metadata.rowInfoNote = [metadata.rowInfoNote, "Keep " + row.controls.map(code => "{" + code + "}").join(" ")].filter(Boolean).join(" ");
        } else if (!row.packedTable) {
            metadata.rowInfoNote = "Up to " + row.maxBytes + " encoded bytes.";
            if (row.rowInfoNote) {
                metadata.rowInfoNote += " " + row.rowInfoNote;
                metadata.translationConstraints = {preserveLineCount: true, maxLines: source.split("\n").length};
            }
            if (row.where === "CHILD@800c021c" && !result.tags[index].includes("red")) {
                result.tags[index].push("red");
            }
            if (row.module === "STARTUP") {
                const maxLines = source.split("\n").length;
                metadata.translationConstraints = {preserveLineCount: true, maxLines};
                metadata.rowInfoNote += " Keep the " + maxLines + (maxLines === 1 ? " line." : " lines.");
            }
        }
        result.parameters[index].push(metadata);
    }
    for (const occurrences of result.parameters) setShirayukiRowActors(occurrences);
    return result;
}

function migrateDialogueRows(files, oldFiles, {legacySceneRows = true} = {}) {
    const filled = value => typeof value === "string" && value.length > 0;
    const join = (parts, value) => parts.map((part, i) => {
        const text = value(part) || part.source;
        return part.joinNext ? text.replace(/\{nobreak\}$/, "") : text + (i + 1 < parts.length ? "\n" : "");
    }).join("");
    const latest = cells => cells?.slice(1).reverse().find(filled);
    for (const [id, file] of Object.entries(files)) {
        const nativeIntro = id === "/" + introFile;
        const previous = nativeIntro ? oldFiles["/Menus/" + introModule + ".json"] : legacySceneRows && oldFiles[id];
        if (!id.startsWith("/Dialogue/") || !previous) continue;
        const byContext = new Map(), bySource = new Map();
        for (const [index, cells] of previous.data.entries()) {
            if (!cells) continue;
            bySource.set(cells[0], cells);
            const overrides = new Map((previous.parameters?.[index] || []).filter(parameter => parameter?.translation)
                .map(parameter => [parameter.contextStr, parameter.translation]));
            for (const context of previous.context?.[index] || []) {
                byContext.set(context, {cells, tags: previous.tags?.[index] || [], override: overrides.get(context)});
            }
        }
        for (const [index, params] of file.parameters.entries()) {
            const source = file.data[index][0];
            if (params[0]?.kind !== "message") continue;
            const occurrences = params.map(param => {
                const stem = param.contextStr.replace(displayContextSuffix, "/dialogue/");
                const lines = nativeIntro ? param.lines.flatMap(line => line.parts) : param.lines;
                return {param, parts: lines.map(line => ({...byContext.get(line.context || stem + line.at), ...line}))};
            });
            const parts = occurrences.find(item => item.parts.some(part => latest(part.cells)))?.parts;
            const direct = bySource.get(source);
            const defaults = filled(latest(direct)) ? [...direct] : [source];
            if (parts && defaults.length === 1) {
                const columns = Math.max(...parts.map(part => part.cells?.length || 0));
                for (let col = 1; col < columns; col++) {
                    if (parts.some(part => filled(part.cells?.[col]))) {
                        defaults[col] = join(parts, part => part.cells?.slice(1, col + 1).reverse().find(filled));
                    }
                }
            }
            if (defaults.length > 1) file.data[index] = defaults;
            const base = latest(defaults) || source;
            const tags = new Set(file.tags[index]);
            for (const {param, parts} of occurrences) {
                for (const part of parts) for (const tag of part.tags || []) tags.add(tag);
                const target = join(parts, part => part.override || latest(part.cells));
                if (target !== base || parts.some(part => filled(part.override))) param.translation = target;
            }
            file.tags[index] = [...tags];
        }
    }
}

function migrateChoiceTranslations(files, oldFiles) {
    for (const [id, file] of Object.entries(files)) {
        const previous = oldFiles[id];
        if (!id.startsWith("/Dialogue/") || !previous) continue;
        const overrides = new Map();
        for (const [index, params] of (previous.parameters || []).entries()) {
            for (const param of Array.isArray(params) ? params : []) {
                if (param?.translation && displayContextSuffix.test(param.contextStr)) {
                    overrides.set(param.contextStr, {source: previous.data[index]?.[0], translation: param.translation});
                }
            }
        }
        if (!overrides.size) continue;
        for (const [index, params] of file.parameters.entries()) {
            for (const param of params) {
                if (!param.choice) continue;
                const previousContext = param.contextStr.replace(displayContextSuffix, "/message/$2");
                const override = overrides.get(param.contextStr) || overrides.get(previousContext);
                if (override && override.source === file.data[index][0]) param.translation = override.translation;
            }
        }
    }
}

function resolveTranslationMatch(row, selected = {}) {
    const pair = selected.translationPair || {};
    const info = selected.info || {};
    const contexts = [row.context];
    if (row.kind === "message") {
        const alias = row.context.replace(displayContextSuffix, (_suffix, kind, at) =>
            "/" + (kind === "choice" ? "message" : "choice") + "/" + at);
        if (alias !== row.context) contexts.push(alias);
    }
    const match = (context, source) => {
        const key = context === null ? row.source : context + "\n" + row.source;
        if (Object.hasOwn(pair, key) && typeof pair[key] === "string") {
            return {value: pair[key], source, matchedContext: context};
        }
    };
    for (const [index, context] of contexts.entries()) {
        const result = match(context, index === 0 ? "context" : "alias");
        if (result) return result;
    }
    if (info.groupLevel > 0) {
        for (const context of contexts) {
            const result = match(context.split("/").slice(0, info.groupLevel).join("/"), "group");
            if (result) return result;
        }
    }
    return match(null, "row");
}

function resolveTranslation(row, selected) {
    return resolveTranslationMatch(row, selected)?.value;
}

async function describeOccurrences(file, rows, selected) {
    const bySource = new Map();
    for (const descriptor of await readDescriptor(file)) {
        if (isLegacyExecutableCode(descriptor)) continue;
        if (!bySource.has(descriptor.source)) bySource.set(descriptor.source, new Map());
        const contexts = bySource.get(descriptor.source);
        contexts.set(descriptor.context, descriptor);
        contexts.set(displayContext(descriptor.context, descriptor.choice), descriptor);
    }
    return rows.map(({source, contexts}) => contexts.map(context => {
        const descriptor = bySource.get(source)?.get(context);
        const result = descriptor && resolveTranslationMatch(descriptor, selected);
        return {context, ...(result || {value: null, source: descriptor ? "untranslated" : "unmatched", matchedContext: null})};
    }));
}

async function writeFile(source, output, selected) {
    const edits = [];
    for (const row of await readDescriptor(source)) {
        if (isLegacyExecutableCode(row)) continue;
        const value = resolveTranslation(row, selected);
        const target = row.kind === "message" ? value?.replace(/\r\n?/g, "\n") : value;
        if (target && target !== row.source) edits.push({...row, target});
    }
    if (output) await fsp.writeFile(output, JSON.stringify(edits), {flag: "wx"});
    return edits;
}

async function resolveDiscs(expected, source) {
    if (!Array.isArray(expected) || !expected.length || new Set(expected.map(disc => disc?.number)).size !== expected.length ||
        expected.some(disc => !Number.isInteger(disc?.number) || !profiles[disc.number - 1] ||
            profiles[disc.number - 1][1] !== disc.sha256 || typeof disc.bin !== "string")) {
        throw new Error("The project's original Japanese Rev 1 disc list is missing or invalid.");
    }
    const candidates = source ? await discover(source) : await Promise.all(expected.map(async disc => {
        const current = await identifyBin(disc.bin);
        if (!current) throw new Error("Original Disc " + disc.number + " could not be identified.");
        return {...disc, ...current};
    }));
    return expected.map(disc => {
        const candidate = candidates.find(item => item.number === disc.number && item.sha256 === disc.sha256);
        if (!candidate) throw new Error("Choose a source containing the original Disc " + disc.number + ".");
        return candidate;
    });
}

async function replaceCG(plan, images, signal) {
    const wanted = [...images.keys()].filter(key => /^(cg|tim)-/.test(key));
    if (!wanted.length) return 0;
    const found = new Map(wanted.map(key => [key, []]));
    for (const asset of cg.inventory(plan.original, signal)) found.get(asset.key)?.push(asset);
    let copies = 0;
    for (const [key, assets] of found) {
        abort(signal);
        const edit = images.get(key);
        if (!assets.length || assets.map(asset => asset.location).join("/") !== edit.locations.join("/")) {
            throw new Error("Original CG locations differ from the project for " + key + ".");
        }
        const stream = cg.readReplacement(assets[0], await fsp.readFile(edit.png));
        for (const asset of assets) copies += cg.replace(plan, asset, stream);
    }
    return copies;
}

async function build(partial, discs, edits, options) {
    const report = [];
    for (const disc of discs) {
        abort(options.signal);
        options.progress?.("Building Disc " + disc.number);
        const stem = "Disc " + disc.number, target = path.join(partial, stem + ".bin");
        const changes = edits[disc.number];
        const imageKeys = new Set([...changes.images.keys()].filter(key => key.startsWith("pic-")));
        const hasText = changes.scenes.length || changes.menus.length;
        const hasChildhoodDate = disc.number === 1 && options.englishChildhoodDate;
        const hasMainDate = options.englishMainDate === true;
        if (hasMainDate) imageKeys.add(mainDateImage);
        const latinNames = options.latinNameEntry === true;
        const nameEntry = latinNames && disc.number === 1;
        const data = await readOriginal(disc, {copyTo: target,
            withData: Boolean(hasText || changes.images.size || hasMainDate || hasChildhoodDate || latinNames), signal: options.signal});
        const result = {disc: disc.number, changedSectors: 0, textureCopies: 0, writtenScenes: 0, warnings: [], layoutWarnings: []};
        if (data) {
            const plan = new SectorPlan(data);
            result.textureCopies = await replaceCG(plan, changes.images, options.signal);
            // The childhood texture lives in a scene bundle. Apply it to the
            // source part so scene repacking carries the edited bytes along.
            if (hasChildhoodDate) localizeChildhoodDate(plan);
            if (hasMainDate) localizeMainDateLayout(plan, disc.number);
            if (imageKeys.size) {
                const assets = new Map(textures.inventory(data, disc.number).map(image => [image.key, image]));
                for (const key of imageKeys) {
                    const asset = assets.get(key), edit = changes.images.get(key);
                    if (!asset || (edit && asset.locations.join("/") !== edit.locations.join("/"))) {
                        throw new Error("Original texture locations differ from the project.");
                    }
                    const png = edit && await fsp.readFile(edit.png);
                    const preview = edit?.preview && await fsp.readFile(edit.preview);
                    const editPixels = hasMainDate && key === mainDateImage ? localizeMainDateTiles : undefined;
                    result.textureCopies += textures.replace(plan, asset, png, preview, editPixels);
                }
            }
            const exe = hasText || latinNames ? executable(data, disc.exeLba) : null;
            const font = exe && createFont(options.rasterizeGlyph, {latinNames});
            if (hasText) {
                const {overlays, scenePack} = locateOverlays(data, exe);
                const scenes = scanScenes(data);
                if (changes.menus.length) replaceMenus(plan, scanMenus(data, disc, exe, overlays, scenes), changes.menus, font);
                result.writtenScenes = replaceScenes(plan, scenes, scenePack, changes.scenes, font, result.layoutWarnings);
                result.warnings = result.layoutWarnings.map(({context, issue}) => context + ": " + issue);
            }
            if (font) font.install(plan, exe, disc.exeRecord, {nameEntry});
            if (latinNames) result.latinNames = {keyboard: nameEntry, font: true};
            result.changedSectors = await plan.write(target, options.signal);
        }
        report.push(result);
        await fsp.writeFile(path.join(partial, stem + ".cue"),
            'FILE "' + stem + '.bin" BINARY\n  TRACK 01 MODE2/2352\n' + (disc.dcp ? "    FLAGS DCP\n" : "") + "    INDEX 01 00:00:00\n");
    }
    await fsp.writeFile(path.join(partial, playlistName), discs.map(disc => "Disc " + disc.number + ".cue\n").join(""));
    await fsp.writeFile(path.join(partial, reportName), JSON.stringify(report, null, 2));
    return report;
}

async function exportDiscs(destination, options) {
    const discs = await resolveDiscs(options.discs, options.sourceMaterial);
    await fsp.mkdir(destination, {recursive: true});
    const partial = await fsp.mkdtemp(path.join(destination, ".tm2-"));
    const edits = Object.fromEntries(discs.map(({number}) => [number, {scenes: [], menus: [], images: new Map()}]));
    try {
        for (const [id, selected] of Object.entries(options.translations || {})) {
            for (const row of await writeFile(resourcePath(options.stage, id), null, selected)) {
                if (!edits[row.disc]) throw new Error("No source for " + row.context + ".");
                if (row.kind === "menu" || row.module === introModule) edits[row.disc].menus.push(row);
                else edits[row.disc].scenes.push({...row, fileId: id});
            }
        }
        for (const {key, discs: copies, png, preview} of options.images || []) {
            if (!/^(?:pic-[0-9a-f]{10}|(?:cg|tim)-[0-9a-f]{20})$/.test(key)) throw new Error("Invalid Tokimeki Memorial 2 artwork key.");
            for (const [number, locations] of Object.entries(copies)) {
                if (!edits[number]) throw new Error("No source Disc " + number + " for the edited texture " + key + ".");
                edits[number].images.set(key, {png, locations, preview});
            }
        }
        const report = await build(partial, discs, edits, options);
        const name = title + " [Translated]";
        let index = 1;
        for (;;) {
            const output = path.join(destination, name + (index > 1 ? " " + index : ""));
            try {
                await fsp.lstat(output);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                try {
                    await fsp.rename(partial, output);
                    return {output, report, discs, playlist: path.join(output, playlistName), reportPath: path.join(output, reportName)};
                } catch (renameError) {
                    if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(renameError.code)) throw renameError;
                    if (!fs.existsSync(output)) throw renameError;
                }
            }
            index++;
        }
    } finally {
        await fsp.rm(partial, {recursive: true, force: true});
    }
}

module.exports = {detect, discover, inspectDiscSelection, scan, parseFile, writeFile, resolveTranslation, describeOccurrences, resourcePath, exportDiscs,
    migrateDialogueRows, migrateChoiceTranslations, introFile, actorReferenceRows, mergeActorReferenceRows, setShirayukiRowActors, applyChoiceMetadata,
    seedSpeakerNames, seedMenuTranslations};
