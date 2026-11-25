"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {test} = require("node:test");
const {Worker} = require("node:worker_threads");
const parser = require("../tm2Psx.module.js");
const cg = require("../cg.js");
const textures = require("../textures.js");
const {createFont} = require("../font.js");
const {DATA, SectorPlan} = require("../disc.js");
const {executable, replaceScenes} = require("../layout.js");
const {scanMenus, replaceMenus, introBoxes, fixFriendNameCopies} = require("../menus.js");
const iconv = require("iconv-lite");

test("friend-name copy patches are guarded and installed for both native paths", () => {
    const base = 0x800c0000, body = Buffer.alloc(0x60000);
    const signature = Buffer.from("0000268101002781000006a1010007a10200268100000000020006a16a8c030870b34224", "hex");
    const positions = [0x800e2f14 - base, 0x800e2f54 - base];
    positions.forEach(at => signature.copy(body, at));
    const writes = [];
    fixFriendNameCopies({put: (at, bytes) => writes.push({at, bytes})}, {base, offset: 100, body});
    assert.deepEqual(writes.map(row => row.at), positions.map(at => at + 100));
    for (const {bytes} of writes) {
        assert.equal(bytes.readUInt32LE(8), 0x0c01681d); // jal native strcpy
        assert.equal(bytes.readUInt32LE(20), 0x08038c6a); // return to shared epilogue
        assert.equal(bytes.readUInt32LE(24), 0x2442b370); // return buffer address
    }
    body[positions[0]] ^= 1;
    assert.throws(() => fixFriendNameCopies({put() {}}, {base, offset: 0, body}), /Unexpected friend name copy/);
});

test("ENGINE honorifics share space without changing the adjacent fixed-copy strings", () => {
    const base = 0x800c0000, body = Buffer.alloc(0x24000);
    const originals = [[0x1424, "さん"], [0x142c, "ちゃん"], [0x1450, "あなた"],
        [0x1458, "君"], [0x145c, "くん"], [0x1464, "出ちゃ駄目"]];
    for (const [at, text] of originals) iconv.encode(text, "cp932").copy(body, at);
    const refs = [[0x23184, 0x1424], [0x23194, 0x142c], [0x2327c, 0x1458], [0x232f8, 0x145c], [0x23330, 0x1458]];
    for (const [at, source] of refs) {
        body.writeUInt32LE(0x3c05800c, at - 4);
        body.writeUInt32LE(0x24a50000 | source, at);
    }
    body.writeUInt32LE(0x800e3098, 0x1434);
    const mod = {name: "ENGINE", body, base, offset: 0};
    const rows = originals.filter(([at]) => at !== 0x1450 && at !== 0x1464).map(([at, source]) => ({
        addr: base + at, offset: at, module: "ENGINE", source, mod, packedTable: true
    }));
    const targets = new Map([["さん", "-san"], ["ちゃん", "-chan"], ["君", "-kun"]]);
    const edits = rows.filter(row => targets.has(row.source)).map(row => ({...row, context: row.source, target: targets.get(row.source)}));
    const plan = new SectorPlan(body), font = createFont(() => Buffer.alloc(15));
    replaceMenus(plan, rows, edits, font);
    for (const [at, address] of refs) {
        const source = originals.find(([original]) => original === address)[1];
        const ref = plan.read(at, at + 4).readUInt32LE();
        assert.equal(ref >>> 16, 0x24a5);
        const expected = targets.has(source) ? font.encode(targets.get(source)) : iconv.encode(source, "cp932");
        const start = ref & 0xffff;
        assert.deepEqual(plan.read(start, start + expected.length + 1), Buffer.concat([expected, Buffer.alloc(1)]));
    }
    assert.deepEqual(plan.read(0x1434, 0x1458), body.subarray(0x1434, 0x1458));
    assert.deepEqual(plan.read(0x1464, 0x1470), body.subarray(0x1464, 0x1470));
});
const {rebuild, parseScene, scanScenes} = require("../script.js");

const source = "{name1}さん。{nobreak}";
const occurrences = [
    {disc: 1, context: "Disc 1/SCENE/dialogue/42", speaker: "葵", speakerKind: "literal"},
    {disc: 2, context: "Disc 2/SCENE/dialogue/42", speaker: "{name1}", speakerKind: "runtime"}
].map(row => ({...row, source, kind: "dialogue", offset: 2048, at: 42, controls: ["name1", "nobreak"]}));

async function fixture(t, descriptor = {version: 1, rows: occurrences}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm2-test-"));
    t.after(() => fs.rm(dir, {recursive: true, force: true}));
    const file = path.join(dir, "script.json");
    await fs.writeFile(file, JSON.stringify(descriptor));
    return {file, dir};
}

test("duplicate sources retain each occurrence and its evidenced speaker", async t => {
    const {file} = await fixture(t);
    const result = await parser.parseFile(file);
    assert.deepEqual(result.data, [[source, ""]]);
    assert.deepEqual(result.context, [occurrences.map(row => row.context)]);
    assert.deepEqual(result.parameters[0].map(row => row.rowInfoText), ["葵", "MC"]);
    assert.deepEqual(result.parameters[0].map(row => row.controls), [["name1", "nobreak"], ["name1", "nobreak"]]);
    assert.equal(result.parameters[0][1].speakerNameIsVariable, true);
});

test("shared Shirayuki text keeps each identity and uses a neutral row speaker", async t => {
    const rows = ["美帆", "真帆"].map((speakerIdentity, i) => ({
        kind: "message", source: "そうですね。", context: "Twin/" + i, lines: [{}],
        speaker: "白雪", speakerKind: "literal", speakerIdentity, controls: []
    }));
    rows.push({...rows[1], source: "待ってたの。", context: "Twin/2"});
    const {file} = await fixture(t, {version: 1, rows});
    const result = await parser.parseFile(file);
    assert.deepEqual(result.parameters[0].map(row => row.speakerIdentity), ["美帆", "真帆"]);
    assert.deepEqual(result.parameters[0].map(row => row.rowInfoText), ["白雪", "白雪"]);
    assert.equal(result.parameters[1][0].rowInfoText, "真帆");
});

test("choice rows publish the choice context and fixed option count", async t => {
    const row = {kind: "message", source: "はい\nいいえ", context: "Fixture/message/1",
        choice: true, reflow: false, lines: [{}, {}], controls: []};
    const {file} = await fixture(t, {version: 1, rows: [row]});
    const result = await parser.parseFile(file);
    const metadata = result.parameters[0][0];
    assert.equal(metadata.contextStr, "Fixture/choice/1");
    assert.deepEqual(result.context[0], [metadata.contextStr]);
    assert.equal(metadata.messageType, "choice");
    assert.equal(metadata.rowInfoText, "choice");
    assert.deepEqual(metadata.translationConstraints, {preserveLineCount: true, maxLines: 2});
    assert.match(parser.actorReferenceRows(["choice"])[0][2], /MC’s \(male\) possible thoughts or replies/);
});

test("speaker defaults seed English nameplates and tag speaker occurrences", async t => {
    const label = (source, context, speakerKind = "literal", controls = []) => ({
        source, context, kind: "speaker", speaker: source, speakerKind, controls
    });
    const mixed = {
        source: "？？？", context: "Fixture/message/3", kind: "message",
        reflow: true, lines: [{}], controls: []
    };
    const rows = [label("陽ノ下", "Fixture/speaker/1"), label("？？？", "Fixture/speaker/2"), mixed,
        label("{name1}", "Fixture/speaker/4", "runtime", ["name1"]), label("麻生", "Fixture/speaker/5")];
    const {file} = await fixture(t, {version: 1, rows});
    const id = "/Dialogue/scene-test.json";
    const english = await parser.parseFile(file);
    english.data[3][1] = "Kasumi";
    english.tags[0].push("blue");
    parser.seedSpeakerNames({[id]: english}, "en-US");
    assert.deepEqual(english.data.map(row => row[1]), ["Hikari", "", "", "Kasumi"]);
    assert.deepEqual(english.tags, [["blue", "yellow"], ["yellow"], ["yellow"], ["yellow"]]);
    assert.deepEqual(english.parameters[1].map(row => row.translation), ["???", undefined]);
    const otherLanguage = await parser.parseFile(file);
    parser.seedSpeakerNames({[id]: otherLanguage}, "fr");
    assert.equal(otherLanguage.data[0][1], "");
    assert.deepEqual(otherLanguage.tags[0], ["yellow"]);
});

test("Shirayuki nameplates use the right twin for each occurrence", async t => {
    const rows = ["美帆", "真帆", undefined].map((nameplateIdentity, at) => ({
        kind: "speaker", source: "白雪", speaker: "白雪", speakerKind: "literal",
        context: "Fixture/speaker/" + at, nameplateIdentity, controls: []
    }));
    const {file} = await fixture(t, {version: 1, rows});
    const result = await parser.parseFile(file);
    result.data[0][1] = "Shir";
    parser.seedSpeakerNames({"/Dialogue/scene-test.json": result}, "en");
    assert.deepEqual(result.data[0], ["白雪", "Shir"]);
    assert.deepEqual(result.parameters[0].map(row => row.translation), ["Miho", "Maho", undefined]);
    assert.deepEqual(result.tags[0], ["yellow", "blue"]);
    const allKnown = await parser.parseFile(file);
    allKnown.parameters[0].pop();
    parser.seedSpeakerNames({"/Dialogue/scene-test.json": allKnown}, "en");
    assert.deepEqual(allKnown.data[0], ["白雪", "Miho"]);
    assert.deepEqual(allKnown.parameters[0].map(row => row.translation), [undefined, "Maho"]);
    assert.deepEqual(allKnown.tags[0], ["yellow"]);
});

test("Actor Reference seeds known speakers and keeps existing names and notes on update", () => {
    const defaults = parser.actorReferenceRows(["麻生", "麻生", "陽ノ下", "不明なラベル", "MC"]);
    const seed = new Map(defaults.map(([name, translation, info]) => [name, {translation, info}]));
    assert.equal(seed.size, 4);
    assert.equal(seed.get("麻生").translation, "");
    assert.match(seed.get("麻生").info, /^female\. Kasumi Aso.*Voice guidance — Warm/);
    assert.match(seed.get("MC").info, /^male\..*name tokens/);
    assert.equal(seed.get("不明なラベル").info, "");

    const previous = [["麻生", "Aso", "Another draft", "My own note"], ["陽ノ下", "Hinomoto", "Draft", ""], ["追加", "Custom"]];
    const updated = parser.mergeActorReferenceRows(previous, defaults, 3);
    assert.deepEqual(updated[0], previous[0]);
    assert.deepEqual(updated[1], ["陽ノ下", "Hinomoto", "Draft", seed.get("陽ノ下").info]);
    assert.deepEqual(updated[2], previous[2]);
    assert.deepEqual(updated.find(row => row[0] === "MC"), ["MC", "", "", seed.get("MC").info]);
    assert.deepEqual(parser.mergeActorReferenceRows([["Player (custom name)", "", "Custom voice note"]], parser.actorReferenceRows(["MC"])),
        [["MC", "", "Custom voice note"]]);
    assert.equal(previous[1][3], "");
    assert.deepEqual(parser.mergeActorReferenceRows(updated, defaults, 3), updated);
});

test("Actor Reference upgrades a stock description and preserves a custom revision", () => {
    const defaults = parser.actorReferenceRows(["ロボ"]);
    const legacy = "Robot label. Preserve mechanical delivery and sound effects where the script uses them.";
    const verbose = "Gender — Unspecified (animal). Role — Robo, the dog who comes to fetch the child in scene YG_07504. Speaking tone — Lively, short barks. Translation guidance — Keep Robo as a name and render the lines as barks.";
    const row = ["ロボ", "Robo", legacy, "other draft"];
    const revised = ["ロボ", "Robo", legacy + " My note.", "other draft"];
    assert.deepEqual(parser.mergeActorReferenceRows([row], defaults), [
        ["ロボ", "Robo", defaults[0][2], "other draft"]
    ]);
    assert.equal(parser.mergeActorReferenceRows([["ロボ", "Robo", verbose]], defaults)[0][2], defaults[0][2]);
    assert.match(defaults[0][2], /^Gender:unspecified\. Robo, the dog.*Voice guidance/);
    assert.match(parser.actorReferenceRows(["注意"])[0][2], /^Gender:n\/a\./);
    const unlabeled = defaults[0][2].replace(/^Gender:/, "");
    assert.deepEqual(parser.mergeActorReferenceRows([["ロボ", "Robo", unlabeled]], defaults),
        [["ロボ", "Robo", defaults[0][2]]]);
    const userNote = ["ロボ", "Robo", unlabeled + " My note."];
    assert.deepEqual(parser.mergeActorReferenceRows([userNote], defaults), [userNote]);
    assert.deepEqual(parser.mergeActorReferenceRows([revised], defaults), [revised]);
});

test("the writer resolves exact, grouped and default translations in order", async t => {
    const {file, dir} = await fixture(t);
    const output = path.join(dir, "edits.json");
    const pair = {
        [occurrences[0].context + "\n" + source]: "Dear {name1}.{nobreak}",
        ["Disc 2\n" + source]: "Hello {name1}.{nobreak}",
        [source]: "{name1}, hey.{nobreak}"
    };
    const edits = await parser.writeFile(file, output, {translationPair: pair, info: {groupLevel: 1}});
    assert.deepEqual(edits.map(row => row.target), ["Dear {name1}.{nobreak}", "Hello {name1}.{nobreak}"]);
    assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), edits);
    assert.equal(parser.resolveTranslation(occurrences[1], {translationPair: pair}), pair[source]);
    assert.deepEqual(await parser.writeFile(file, null, {translationPair: {[source]: source}}), []);
    assert.deepEqual(await parser.writeFile(file), []);
});

test("choice context aliases retain overrides through export and source updates", async t => {
    const id = "/Dialogue/scene-test.json";
    const source = "はい\nいいえ", oldContext = "Disc 1/SCENE/0x0/message/100";
    const context = "Disc 1/SCENE/0x0/choice/100", translation = "Sure\nNo thanks";
    const old = {source, context: oldContext, kind: "message"};
    const newRow = {...old, context, choice: true, reflow: false, lines: [{}, {}], controls: []};
    const {file} = await fixture(t, {version: 1, rows: [newRow]});
    const fresh = await parser.parseFile(file);
    const [param] = fresh.parameters[0];
    const pairs = {[oldContext + "\n" + source]: translation, [source]: "Yes\nNo"};
    assert.equal((await parser.writeFile(file, null, {translationPair: pairs}))[0].target, translation);
    assert.equal(parser.resolveTranslation(old, {translationPair: {[context + "\n" + source]: translation}}), translation);
    assert.equal(parser.resolveTranslation(newRow, {translationPair: {...pairs, [context + "\n" + source]: "Yes please\nNo"}}), "Yes please\nNo");
    parser.migrateChoiceTranslations({[id]: fresh}, {
        [id]: {data: [[source]], parameters: [[{contextStr: oldContext, translation}]]}
    });
    assert.equal(param.contextStr, context);
    assert.equal(param.translation, translation);
});

test("occurrence reporting follows the staged writer's context precedence", async t => {
    const exact = "Disc 1/SCENE/message/100";
    const alias = "Disc 1/SCENE/choice/101";
    const grouped = "Disc 2/SCENE/message/102";
    const fallback = "Disc 3/SCENE/message/103";
    const descriptors = [exact, alias.replace("/choice/", "/message/"), grouped, fallback].map(context =>
        ({source, context, kind: "message"}));
    descriptors[1].choice = true;
    const {file} = await fixture(t, {version: 1, rows: descriptors});
    const selected = {info: {groupLevel: 1}, translationPair: {
        [exact + "\n" + source]: "Exact", [alias + "\n" + source]: "Alias",
        ["Disc 2\n" + source]: "Grouped", [source]: "Default"
    }};
    const missing = "Disc 4/SCENE/message/104";
    const [result] = await parser.describeOccurrences(file, [{source, contexts: [exact, alias, grouped, fallback, missing]}], selected);
    assert.deepEqual(result, [
        {context: exact, value: "Exact", source: "context", matchedContext: exact},
        {context: alias, value: "Alias", source: "alias", matchedContext: alias},
        {context: grouped, value: "Grouped", source: "group", matchedContext: "Disc 2"},
        {context: fallback, value: "Default", source: "row", matchedContext: null},
        {context: missing, value: null, source: "unmatched", matchedContext: null}
    ]);
    const edits = await parser.writeFile(file, null, selected);
    assert.deepEqual(edits.map(row => row.target), result.slice(0, -1).map(row => row.value));
    const [empty] = await parser.describeOccurrences(file, [{source, contexts: [exact]}]);
    assert.deepEqual(empty, [{context: exact, value: null, source: "untranslated", matchedContext: null}]);
});

test("invalid descriptors, non-game inputs, and escaping resource IDs are rejected", async t => {
    const {file, dir} = await fixture(t, {version: 2, rows: []});
    await assert.rejects(parser.parseFile(file), /staged resource/);
    assert.equal(await parser.detect(file), false);
    for (const invalid of ["../original.bin", "Menu/../original.bin", "//server/test", "C:/test", "/"]) {
        assert.throws(() => parser.resourcePath(dir, invalid), /Invalid/);
    }
    assert.equal(parser.resourcePath(dir, "/images/Krita edits/original.png"), path.join(dir, "images", "Krita edits", "original.png"));
});

test("a worker loads the portable parser and returns occurrence metadata", async t => {
    const {file} = await fixture(t);
    const worker = new Worker(require.resolve("../tm2Psx.worker.js"), {workerData: {command: "parse", sourcePath: file}});
    t.after(() => worker.terminate());
    const message = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", code => reject(new Error("Worker exited before responding: " + code)));
    });
    assert.deepEqual(message.errors, []);
    assert.equal(message.result.parameters[0][0].rowInfoText, "葵");
});

test("the independent texture codecs preserve every packed pixel", () => {
    const source = Buffer.from(Array.from({length: 8192}, (_, i) => i % 191 < 77 ? 0 : ((i >>> 4) * 11) & 255));
    assert.deepEqual(textures.fromPng(textures.toPng(source)), source);
    for (const kind of [1, 2]) {
        const encoded = textures.encode(source, kind);
        assert.deepEqual(textures.decode(encoded, 0, kind).out, source);
        assert.throws(() => textures.decode(encoded.subarray(0, encoded.length - 7), 0, kind));
    }
});

test("font encodes Latin pairs and distinct text beyond the original character map", () => {
    const font = createFont((_glyph, width) => Buffer.alloc(width * 15 / 8, 0x55));
    assert.deepEqual(font.encode("ABé汉あ"), Buffer.from([0xa2, 0x42, 0xa0, 0x40, 0xa0, 0x41, 0x82, 0xa0]));
    assert.deepEqual(font.encode("e\u0301"), Buffer.from([0xa0, 0x40]));
    assert.throws(() => createFont().encode("é"), /system font renderer/);
});

test("an unpaired Latin letter or punctuation stays narrow", () => {
    const font = createFont((_glyph, width) => Buffer.alloc(width * 15 / 8, 0x55));
    assert.deepEqual(font.encode("Aso"), Buffer.from([0xa2, 0x6d, 0xca, 0x40]));
    assert.deepEqual(font.encode("Go?"), Buffer.from([0xa8, 0x69, 0xeb, 0x40]));
    assert.deepEqual(font.encode("oあ"), Buffer.from([0xca, 0x40, 0x82, 0xa0]));
    assert.deepEqual(font.encode(" "), Buffer.from([0x81, 0x40]));
});

const startupWarning = "メモリーカードのチェック中です\nメモリーカードやコントローラを\n抜き差ししないでください";
const startupNoLoad = "システムファイルをロードしません";
const startupSlot1 = "スロット１", startupSlot2 = "スロット２";
const startupLoaded = "のメモリーカードから\nシステムファイルをロードしました";
const discCheck = "ディスクをチェックしています。\n少々、お待ちください・・・。";

function writeStartupFields(data) {
    iconv.encode(startupWarning, "cp932").copy(data, 543 * DATA + 24);
    iconv.encode(startupNoLoad, "cp932").copy(data, 543 * DATA + 112);
    iconv.encode(startupSlot1, "cp932").copy(data, 543 * DATA + 148);
    iconv.encode(startupSlot2, "cp932").copy(data, 543 * DATA + 160);
    iconv.encode(startupLoaded, "cp932").copy(data, 543 * DATA + 172);
}

function writeNativeFields(data, number) {
    iconv.encode("\x083" + discCheck.replace("\n", "\n\x087"), "cp932").copy(data, 0x90);
    Buffer.from([0x08, 0x37]).copy(data, 0x1a8);
    iconv.encode("交換してください", "cp932").copy(data, 0x1aa);
    if (number === 1) {
        for (let i = 0; i < 8; i++) {
            iconv.encode("会話", "cp932").copy(data, 35248 * DATA + 0x294a8 + i * 132);
        }
    } else {
        for (const [at, text] of [[8, "あれから７年"], [24, "か…"], [44, "帰ってきたんだなぁ。"], [68, "あっ、ひびきの高校だ。"]]) {
            iconv.encode(text, "cp932").copy(data, 266524 * DATA + at);
        }
    }
}

test("executable menu extraction and legacy export preserve the voice routine calls", async t => {
    const base = 0x80015800;
    const data = Buffer.alloc(266525 * DATA);
    writeStartupFields(data);
    writeNativeFields(data, 2);
    const entries = [
        [0x8003e158, "偸", "St"],
        [0x8003e368, "尾", "Tl"],
        [0x8006c7cc, "マウス", "Mouse"]
    ];
    const rows = entries.map(([address, source], index) => {
        const offset = address - base;
        data.writeUInt32LE(address, index * 4);
        iconv.encode(source, "cp932").copy(data, offset);
        if (index < 2) data[offset + 3] = 0x0c;
        const where = "EXE@" + address.toString(16);
        return {source, offset, where, kind: "menu", module: "EXE", disc: 2, context: "Disc 2/" + where};
    });
    const exe = {offset: 0, base, size: 0x58000};
    const menu = scanMenus(data, {number: 2}, exe, [], new Map());
    assert.deepEqual(menu.filter(row => row.module === "EXE").map(row => row.source), ["マウス"]);

    const {file} = await fixture(t, {version: 1, rows});
    const translationPair = Object.fromEntries(entries.map(([, source, target]) => [source, target]));
    assert.deepEqual(await parser.writeFile(file, null, {translationPair}), [{...rows[2], target: "Mouse"}]);
});

test("option room code is excluded from old projects and selector letters keep separate cells", async t => {
    const bad = ["OV5@80144f20", "OV5@8014507c"].map((where, i) =>
        ({kind: "menu", module: "OV5", where, source: "貯", offset: i, context: where}));
    const {file} = await fixture(t, {version: 1, rows: bad});
    assert.deepEqual(await parser.writeFile(file, null, {translationPair: {"貯": "Sv"}}), []);
    const data = Buffer.alloc(64), plan = new SectorPlan(data);
    const item = {kind: "menu", module: "OV5", where: "OV5@8013df48", source: "ＡＢＣＤＥ",
        text: "ＡＢＣＤＥ", offset: 0, field: 12, maxBytes: 11, addr: 0x8013df48, mod: {optionRoom: true}};
    const font = createFont(() => Buffer.alloc(15));
    replaceMenus(plan, [item], [{...item, target: "ABCDE", context: item.where}], font);
    assert.deepEqual(plan.read(0, 10), iconv.encode("ＡＢＣＤＥ", "cp932"));
    assert.throws(() => replaceMenus(plan, [item], [{...item, target: "AB", context: item.where}], font), /exactly five/);
});

test("Disc 1 overlay 3 applies Option Room widths and keeps its selector cells separate", () => {
    const data = Buffer.alloc(63826 * DATA), base = 0x8013dd50, offset = 1000 * DATA;
    writeStartupFields(data);
    writeNativeFields(data, 1);
    iconv.encode(startupWarning, "cp932").copy(data, 63825 * DATA + 744);
    const blank = iconv.encode("　".repeat(9), "cp932");
    for (let i = 0; i < 23; i++) blank.copy(data, 35335 * DATA + 1120 + i * 20);
    const fields = [[0x8013dedc, "あり", "On", 2], [0x8013dee4, "モノラル", "Mono", 4],
        [0x8013def0, "ステレオ", "Stereo", 4], [0x8013defc, "マウスライク", "Mouse-like", 6],
        [0x8013df1c, "左利き", "Left", 3], [0x8013df24, "右利き", "Right", 3],
        [0x8013df48, "ＡＢＣＤＥ", "ABCDE", undefined]];
    for (const [i, [address, source]] of fields.entries()) {
        data.writeUInt32LE(address, offset + i * 4);
        iconv.encode(source, "cp932").copy(data, offset + address - base);
    }
    const rows = scanMenus(data, {number: 1}, {offset: 0, base: 0x80015800, size: 0},
        [{index: 3, offset, size: 0x800}], new Map());
    const font = createFont(() => Buffer.alloc(15)), plan = new SectorPlan(data);
    for (const [address, source, target, cells] of fields) {
        const item = rows.find(row => row.module === "OV3" && row.addr === address);
        assert.equal(item.cells, cells);
        replaceMenus(plan, [item], [{...item, target, context: item.where}], font);
        if (cells) {
            const encoded = font.encode(target);
            assert.deepEqual(plan.read(item.offset + encoded.length, item.offset + cells * 2),
                Buffer.from("a140".repeat(cells - encoded.length / 2), "hex"));
        } else assert.deepEqual(plan.read(item.offset, item.offset + 10), iconv.encode(source, "cp932"));
    }
});

test("option room scanner does not mistake instructions for menu text", () => {
    const data = Buffer.alloc(266525 * DATA), base = 0x8013dd50, offset = 2048 * 1000;
    writeStartupFields(data);
    writeNativeFields(data, 2);
    for (const address of [0x80144f20, 0x8014507c]) {
        const at = offset + address - base;
        data.writeUInt32LE(address, offset + (address === 0x80144f20 ? 0 : 4));
        Buffer.from("929900103e440010", "hex").copy(data, at);
    }
    const rows = scanMenus(data, {number: 2}, {offset: 0, base: 0x80015800, size: 0},
        [{index: 5, offset, size: 0x8000}], new Map());
    assert.equal(rows.some(row => row.module === "OV5" && row.source === "貯"), false);
});

test("option room fixed-width values are padded without changing their translations", () => {
    const data = Buffer.alloc(266525 * DATA), base = 0x8013dd50, offset = 1000 * DATA;
    writeStartupFields(data);
    writeNativeFields(data, 2);
    const fields = [
        [0x8013dedc, "あり", "On", 2], [0x8013dee4, "モノラル", "Mono", 4],
        [0x8013def0, "ステレオ", "Stereo", 4], [0x8013defc, "マウスライク", "Mouse-like", 6],
        [0x8013df1c, "左利き", "Left", 3], [0x8013df24, "右利き", "Right", 3]
    ];
    for (const [i, [address, source]] of fields.entries()) {
        data.writeUInt32LE(address, offset + i * 4);
        iconv.encode(source, "cp932").copy(data, offset + address - base);
    }
    const rows = scanMenus(data, {number: 2}, {offset: 0, base: 0x80015800, size: 0},
        [{index: 5, offset, size: 0x800}], new Map());
    const font = createFont(() => Buffer.alloc(15)), plan = new SectorPlan(data);
    for (const [address, source, target, cells] of fields) {
        const item = rows.find(row => row.module === "OV5" && row.addr === address);
        assert.equal(item.cells, cells);
        assert.equal(item.maxBytes, cells * 2);
        replaceMenus(plan, [item], [{...item, target, context: item.where}], font);
        const encoded = font.encode(target), actual = plan.read(item.offset, item.offset + cells * 2 + 1);
        assert.deepEqual(actual.subarray(0, encoded.length), encoded);
        assert.deepEqual(actual.subarray(encoded.length, cells * 2), Buffer.from("a140".repeat(cells - encoded.length / 2), "hex"));
        assert.equal(actual[cells * 2], 0);
    }
});

test("startup memory-card messages use compact Latin and preserve adjacent fields", async t => {
    const offset = 543 * DATA + 24;
    const data = Buffer.alloc(266525 * DATA);
    writeStartupFields(data);
    writeNativeFields(data, 2);
    data.writeUInt32LE(0x800c0550, 543 * DATA + 228);
    const menu = scanMenus(data, {number: 2}, {offset: 0, base: 0x80015800, size: 0}, [], new Map())
        .filter(row => row.module === "STARTUP");
    assert.deepEqual(menu.map(({source, module, maxBytes}) => [source, module, maxBytes]),
        [[startupWarning, "STARTUP", 87], [startupNoLoad, "STARTUP", 35],
            [startupSlot1, "STARTUP", 11], [startupSlot2, "STARTUP", 11], [startupLoaded, "STARTUP", 55]]);
    const {file} = await fixture(t, {version: 1, rows: menu.map(row =>
        ({...row, kind: "menu", context: "Disc 2/" + row.where + "/" + row.offset}))});
    const parsed = await parser.parseFile(file);
    assert.deepEqual(parsed.parameters.map(([row]) => row.translationConstraints),
        [{preserveLineCount: true, maxLines: 3}, {preserveLineCount: true, maxLines: 1},
            {preserveLineCount: true, maxLines: 1}, {preserveLineCount: true, maxLines: 1},
            {preserveLineCount: true, maxLines: 2}]);
    const font = createFont(() => { throw new Error("Writing menu fields only assigns glyph codes."); });
    const plan = new SectorPlan(data);
    const edit = {offset, source: startupWarning, target: "AB\nA/\n/B", context: "Disc 2/STARTUP/lba-543"};
    replaceMenus(plan, menu, [edit], font);
    assert.deepEqual(plan.read(offset, offset + 88), Buffer.from("a2920aa2d70af092".padEnd(176, "0"), "hex"));
    assert.deepEqual(plan.read(offset + 88, offset + 128), data.subarray(offset + 88, offset + 128));
    const noLoad = {offset: offset + 88, source: startupNoLoad, target: "No", context: edit.context};
    replaceMenus(plan, menu, [noLoad], font);
    const changed = plan.read(offset + 88, offset + 128);
    assert.equal(changed.subarray(0, 36).toString("hex"), "afb9".padEnd(72, "0"));
    assert.deepEqual(changed.subarray(36), data.subarray(offset + 124, offset + 128));
    const loaded = {offset: 543 * DATA + 172, source: startupLoaded, target: " card\nLoaded", context: edit.context};
    replaceMenus(plan, menu, [loaded], font);
    assert.equal(plan.read(543 * DATA + 228, 543 * DATA + 232).readUInt32LE(), 0x800c0550);
    assert.deepEqual(plan.read(543 * DATA + 148, 543 * DATA + 172), data.subarray(543 * DATA + 148, 543 * DATA + 172));
    assert.throws(() => replaceMenus(plan, menu, [{...loaded, target: "One line"}], font), /line breaks/);
    const slot = {offset: 543 * DATA + 148, source: startupSlot1, target: "Slot 1", context: edit.context};
    replaceMenus(plan, menu, [slot], font);
    assert.deepEqual(plan.read(slot.offset, slot.offset + 12), Buffer.concat([font.encode("Slot 1", {startup: true}), Buffer.alloc(6)]));
    assert.deepEqual(plan.read(slot.offset + 12, slot.offset + 24), data.subarray(slot.offset + 12, slot.offset + 24));
    assert.throws(() => replaceMenus(plan, menu, [{...noLoad, target: "Two\nlines"}], font), /line breaks/);
    assert.throws(() => replaceMenus(plan, menu, [{...edit, target: "One line"}], font), /line breaks/);
    assert.throws(() => replaceMenus(plan, menu, [{...edit, target: "A".repeat(86) + "\nB\nCCCC"}], font), error => {
        assert.match(error.message, /Disc 2\/STARTUP\/lba-543/);
        assert.match(error.message, /maximum 87/);
        assert.match(error.message, /Menus\/STARTUP\.json/);
        assert.ok(error.message.includes(JSON.stringify(startupWarning)));
        assert.match(error.message, /Shorten its translation by at least \d+ encoded bytes/);
        assert.match(error.message, /extra spaces/);
        return true;
    });
});

test("childhood map labels preserve their fixed cells and the red dialogue opener stays editable", async t => {
    const base = 35335 * DATA + 1120, disc = Buffer.alloc(63826 * DATA);
    writeStartupFields(disc);
    writeNativeFields(disc, 1);
    iconv.encode(startupWarning, "cp932").copy(disc, 63825 * DATA + 744);
    const blank = iconv.encode("　".repeat(9), "cp932");
    for (let i = 0; i < 23; i++) blank.copy(disc, base + i * 20);
    iconv.encode("自宅前" + "　".repeat(6), "cp932").copy(disc, base + 11 * 20);
    const openerOffset = 35248 * DATA + 0x21c;
    disc.writeUInt32LE(0x800c021c, 35248 * DATA);
    iconv.encode("「", "cp932").copy(disc, openerOffset);
    const rows = scanMenus(disc, {number: 1}, {offset: 0, base: 0x80015800, size: 0}, [], new Map());
    const places = rows.filter(row => row.module === "CHILD");
    assert.deepEqual(places.map(row => [row.source, row.where, row.maxBytes]),
        [["自宅前", "CHILD@800ebd3c", 18], ["「", "CHILD@800c021c", 3]]);
    const grid = {"/Menus/CHILD.json": {data: [["自宅前", ""]]}};
    parser.seedMenuTranslations(grid, "en");
    const target = grid["/Menus/CHILD.json"].data[0][1];
    assert.equal(target, "Outside Home");
    const staged = places.map(({source, where, module, offset, maxBytes}) => ({
        source, where, module, offset, maxBytes, kind: "menu", context: "Disc 1/" + where
    }));
    const {file} = await fixture(t, {version: 1, rows: staged});
    const parsed = await parser.parseFile(file);
    assert.deepEqual(parsed.data, [["自宅前", ""], ["「", ""]]);
    assert.deepEqual(parsed.tags, [[], ["red"]]);
    const edits = await parser.writeFile(file, null, {translationPair: {"自宅前": target}});
    const plan = new SectorPlan(disc), font = createFont(() => Buffer.alloc(15));
    replaceMenus(plan, rows, edits, font);
    const offset = places[0].offset;
    assert.deepEqual(plan.read(offset, offset + 20), Buffer.from("b06fcf6dc45ec040a969c85fa140a140a1400000", "hex"));
    assert.deepEqual(plan.read(offset - 20, offset), disc.subarray(offset - 20, offset));
    assert.deepEqual(plan.read(offset + 20, offset + 40), disc.subarray(offset + 20, offset + 40));
    assert.deepEqual(plan.read(openerOffset, openerOffset + 4), Buffer.from("81750000", "hex"));
    const openerEdit = await parser.writeFile(file, null, {translationPair: {"「": '"'}});
    assert.deepEqual(openerEdit, [{...staged[1], target: '"'}]);
    replaceMenus(plan, rows, openerEdit, font);
    assert.deepEqual(plan.read(openerOffset, openerOffset + 4), Buffer.concat([font.encode('"'), Buffer.alloc(2)]));
    const thoughts = rows.filter(row => row.module === "CHILD-TEXT");
    assert.equal(thoughts.length, 8);
    const last = thoughts.at(-1);
    disc.writeUInt32LE(0x01020304, last.offset + 124);
    replaceMenus(plan, rows, [{...last, target: "A thought.", context: last.where}], font);
    assert.deepEqual(plan.read(last.offset, last.offset + 10), font.encode("A thought."));
    assert.equal(plan.read(last.offset + 124, last.offset + 128).readUInt32LE(), 0x01020304);
});

test("disc checking keeps both lines, the color controls, and adjacent data", () => {
    const data = Buffer.alloc(266525 * DATA);
    writeStartupFields(data);
    writeNativeFields(data, 2);
    data.writeUInt32LE(0x01020304, 0xd0);
    const rows = scanMenus(data, {number: 2}, {offset: 0, base: 0x80015800, size: 0}, [], new Map());
    const [check, prompt] = rows.filter(row => row.module === "DISC-SWAP");
    assert.equal(check.source, discCheck);
    assert.equal(check.maxBytes, 59);
    assert.equal(prompt.source, "交換してください");
    const font = createFont((_glyph, width) => Buffer.alloc(width * 15 / 8));
    const plan = new SectorPlan(data);
    const edit = (row, target) => ({...row, target, context: row.where});
    replaceMenus(plan, rows, [edit(check, "Checking disc.\r\nPlease wait..."), edit(prompt, " Please insert.")], font);
    const encoded = Buffer.concat([Buffer.from([8, 51]), font.encode("Checking disc.", {startup: true}),
        Buffer.from([10, 8, 55]), font.encode("Please wait...", {startup: true})]);
    assert.deepEqual(plan.read(0x90, 0xd0), Buffer.concat([encoded, Buffer.alloc(64 - encoded.length)]));
    assert.equal(plan.read(0xd0, 0xd4).readUInt32LE(), 0x01020304);
    assert.deepEqual(plan.read(prompt.offset, prompt.offset + 4),
        Buffer.concat([Buffer.from([8, 55]), font.encode(" P", {startup: true})]));
    assert.throws(() => replaceMenus(plan, rows, [edit(check, "One line")], font), /line breaks/);
});

test("the Disc 2 intro writes one translation per box and keeps its native cues", () => {
    const data = Buffer.alloc(266525 * DATA);
    writeStartupFields(data);
    writeNativeFields(data, 2);
    const intro = 266524 * DATA;
    const cues = [4, 32, 36, 92];
    for (const at of cues) data.writeUInt32LE(0x01020304, intro + at);
    const rows = scanMenus(data, {number: 2}, {offset: 0, base: 0x80015800, size: 0}, [], new Map());
    const [first, second] = introBoxes(rows);
    assert.equal(first.source, "あれから７年か…\n帰ってきたんだなぁ。");
    assert.equal(second.source, "あっ、ひびきの高校だ。");
    const font = createFont((_glyph, width) => Buffer.alloc(width * 15 / 8));
    const plan = new SectorPlan(data);
    const edit = (row, target) => ({...row, target, context: row.where, module: "DISC2-INTRO", kind: "message"});
    const line = "Seven years gone now";
    replaceMenus(plan, rows, [edit(first, line + "\nI'm home."), edit(second, "Hibikino High.")], font);
    assert.deepEqual(plan.read(intro + 8, intro + 24), Buffer.concat([font.encode(line.slice(0, 14)), Buffer.alloc(2)]));
    assert.deepEqual(plan.read(intro + 24, intro + 32), Buffer.concat([font.encode(line.slice(14)), Buffer.alloc(2)]));
    assert.deepEqual(plan.read(intro + 44, intro + 54), font.encode("I'm home."));
    assert.deepEqual(plan.read(intro + 68, intro + 82), font.encode("Hibikino High."));
    for (const at of cues) assert.equal(plan.read(intro + at, intro + at + 4).readUInt32LE(), 0x01020304);
    assert.throws(() => replaceMenus(plan, rows, [edit(first, line + "!")], font), /line breaks/);
    assert.throws(() => replaceMenus(plan, rows, [edit(first, line + "!\nI'm home.")], font), /Shorten it to 10 cells/);

    const unchangedLine = new SectorPlan(data);
    replaceMenus(unchangedLine, rows, [edit(first, first.source.split("\n")[0] + "\nI'm home.")], font);
    assert.deepEqual(unchangedLine.read(intro, intro + 44), data.subarray(intro, intro + 44));
    const legacy = first.parts[0][1];
    replaceMenus(plan, rows, [{...legacy, kind: "menu", target: "Yes", context: legacy.where}], font);
    assert.deepEqual(plan.read(legacy.offset, legacy.offset + 4), font.encode("Yes"));
});

test("the colored Continue prompt preserves both labels, button colors, and adjacent fields", async t => {
    const data = Buffer.alloc(266525 * DATA);
    writeStartupFields(data);
    writeNativeFields(data, 2);
    const overlay = {index: 6, offset: 935 * DATA, size: 0x2000};
    const offset = overlay.offset + 0x984;
    const source = "ゲームを続けますか？\nはい…○　いいえ…×";
    const raw = source.replace("○", "\x085○\x087").replace("×", "\x083×");
    iconv.encode(raw + "\0", "cp932").copy(data, offset);
    data.writeUInt32LE(0x01020304, offset + 48);
    const rows = scanMenus(data, {number: 2}, {offset: 0, base: 0x80015800, size: 0}, [overlay], new Map());
    const [prompt] = rows.filter(row => row.where === "OV6@8013e6d4");
    assert.equal(prompt.source, source);
    assert.equal(prompt.maxBytes, 41);
    const context = "Disc 2/OV6@8013e6d4/0x" + offset.toString(16);
    const {file} = await fixture(t, {version: 1, rows: [{...prompt, disc: 2, kind: "menu", context}]});
    const parsed = await parser.parseFile(file);
    const grid = {"/Menus/OV6.json": parsed};
    assert.deepEqual(parsed.parameters[0][0].translationConstraints, {preserveLineCount: true, maxLines: 2});
    parser.seedMenuTranslations(grid, "ja");
    assert.equal(parsed.data[0][1], "");
    parser.seedMenuTranslations(grid, "en");
    const sample = parsed.data[0][1];
    assert.equal(sample, "Continue the game?\nYes...○  No...×");
    const edits = await parser.writeFile(file, null, {translationPair: {[source]: sample}});
    const plan = new SectorPlan(data), font = createFont(() => Buffer.alloc(15));
    replaceMenus(plan, rows, edits, font);
    const expected = Buffer.concat([font.encode("Continue the game?"), Buffer.from([10]), font.encode("Yes..."),
        Buffer.from("0835819b0837", "hex"), font.encode("  No..."), Buffer.from("0833817e", "hex")]);
    assert.deepEqual(plan.read(offset, offset + 48), Buffer.concat([expected, Buffer.alloc(48 - expected.length)]));
    assert.equal(plan.read(offset + 48, offset + 52).readUInt32LE(), 0x01020304);
    assert.throws(() => replaceMenus(plan, rows, [{...edits[0], target: "Continue?\nYes / No"}], font), /Keep ○.*×/);
    assert.throws(() => replaceMenus(plan, rows, [{...edits[0], target: "文".repeat(20) + "\nYes○ No×"}], font), /maximum 41/);
    parsed.data[0][1] = "Resume?\nYes○ No×";
    parser.seedMenuTranslations(grid, "en-US");
    assert.equal(parsed.data[0][1], "Resume?\nYes○ No×");
});

test("menu overflow guidance identifies each affected file and source", () => {
    const font = createFont();
    for (const [module, source, context] of [
        ["NAME", "誕生日：　　月　　日", "Disc 1/NAME@800c01fc/0x3fb1fc"],
        ["OV6", "別の項目", "Disc 2/OV6@8013de00/0x1234"]
    ]) {
        const row = {offset: 0, module, source, text: source, field: 24, maxBytes: 23};
        assert.throws(() => replaceMenus({}, [row], [{offset: 0, source, target: "A".repeat(13), context}], font), error => {
            assert.ok(error.message.includes(context));
            assert.ok(error.message.includes("Menus/" + module + ".json"));
            assert.ok(error.message.includes(JSON.stringify(source)));
            assert.match(error.message, /26 encoded bytes; maximum 23/);
            assert.match(error.message, /at least 3 encoded bytes/);
            return true;
        });
    }
});

test("font export keeps the retail interrupt state and reserves space above the stack", () => {
    const exeLba = 24, record = 22 * DATA + 70;
    const original = Buffer.alloc(exeLba * DATA + 0x100000);
    const entry = exeLba * DATA;
    original.write("\x01CD001\x01", 16 * DATA, "ascii");
    original.writeUInt32LE(original.length / DATA, 16 * DATA + 80);
    original.writeUInt32BE(original.length / DATA, 16 * DATA + 84);
    original.writeUInt32LE(exeLba, record + 2);
    original.writeUInt32BE(exeLba, record + 6);
    original.writeUInt32LE(0x100000, record + 10);
    original.writeUInt32BE(0x100000, record + 14);
    original.write("PS-X EXE", entry, "ascii");
    original.writeUInt32LE(0x800175c8, entry + 0x10);
    original.writeUInt32LE(0x80015800, entry + 0x18);
    original.writeUInt32LE(0x57800, entry + 0x1c);
    original.writeUInt32LE(0x801ffff0, entry + 0x30);
    const exe = executable(original, exeLba);
    const offset = address => exe.offset + address - exe.base;
    original.writeUInt32LE(0x2042fff8, offset(0x800175f8));
    original.writeUInt32LE(0x3083f000, offset(0x8001c5c0));
    original.writeUInt32LE(0x3402e000, offset(0x8001c5c4));
    const payloadEnd = exe.offset + exe.size;
    original.fill(0x5a, payloadEnd);

    const font = createFont((_glyph, width) => Buffer.alloc(width * 15 / 8, 0x55));
    const plan = new SectorPlan(original);
    font.encode("記録");
    font.install(plan, exe, record);
    assert.equal(plan.modified.size, 0);
    font.encode("ABé");
    font.install(plan, exe, record);
    const directory = plan.read(record + 2, record + 18);
    const newLba = directory.readUInt32LE();
    const newSize = directory.readUInt32LE(8);
    assert.equal(newLba, original.length / DATA);
    assert.equal(directory.readUInt32BE(4), newLba);
    assert.equal(directory.readUInt32BE(12), newSize);
    const volume = plan.read(16 * DATA + 80, 16 * DATA + 88);
    assert.equal(volume.readUInt32LE(), plan.count);
    assert.equal(volume.readUInt32BE(4), plan.count);
    const movedExe = Buffer.concat(Array.from({length: newSize / DATA}, (_, i) => plan.modified.get(newLba + i)));
    const movedOffset = address => offset(address) - entry;
    assert.equal(movedExe.readUInt32LE(0x10), exe.base + exe.size);
    assert.equal(movedExe.readUInt32LE(0x30), 0x801feef0);
    assert.equal(movedExe.readUInt32LE(movedOffset(0x800175f8)), 0x2042eef8);
    assert.equal(movedExe.readUInt32LE(movedOffset(0x8001c5c0)), 0x0807fbc0);
    assert.deepEqual(movedExe.subarray(movedOffset(0x800654e8), movedOffset(0x80066550)), Buffer.alloc(0x1068));
    const movedPayloadEnd = DATA + movedExe.readUInt32LE(0x1c);
    assert.deepEqual(movedExe.subarray(movedPayloadEnd), original.subarray(payloadEnd));

    // A later disc with no translated rows still needs the font for saved names.
    const nameFont = createFont((_glyph, width) => Buffer.alloc(width * 15 / 8, 0x55), {latinNames: true});
    const namePlan = new SectorPlan(original);
    nameFont.install(namePlan, exe, record);
    const nameLba = namePlan.read(record + 2, record + 6).readUInt32LE();
    assert.equal(nameLba, original.length / DATA);
    const hookOffset = movedOffset(0x8001c5c0);
    assert.equal(namePlan.modified.get(nameLba + Math.floor(hookOffset / DATA)).readUInt32LE(hookOffset % DATA), 0x0807fbc0);
    assert.throws(() => nameFont.install(new SectorPlan(original), exe, record, {nameEntry: true}), /Unexpected name-entry module/);
});

test("the script writer preserves control bytes and remaps a branch after a longer string", () => {
    const header = Buffer.alloc(40);
    Buffer.from([0x38, 0x35, 0, 0, 40]).copy(header);
    // If-expression with a constant, a six-byte dialogue instruction and FF.
    const original = Buffer.concat([header, Buffer.from([0x30, 0x4e, 0, 0, 5, 0, 0x10, 0x28, 0x0a, 0xd1, 0, 0xff])]);
    const scene = {offset: 0, end: original.length, key: "fixture"};
    const edit = {at: 46, source: "あ{name1}", target: "学校{name1}", context: "Fixture/line"};
    const out = rebuild(original, scene, [edit], createFont());
    const parsed = parseScene(out, 0);
    assert.equal(parsed.ops.get(40).jump, out.length - 1);
    assert.equal(parsed.ops.get(46).source, edit.target);
    assert.throws(() => rebuild(original, scene, [{...edit, target: "学校{name2}"}], createFont()), /control tokens/);
});

function scriptFixture(...instructions) {
    const header = Buffer.alloc(40);
    Buffer.from([0x38, 0x35, 0, 0, 40]).copy(header);
    header.write("FIXTURE", 24);
    const data = Buffer.concat([header, ...instructions, Buffer.from([0xff])]);
    return [data, scanScenes(data).get(0)];
}

test("a false inner header does not hide a childhood pack or discard its sound table", () => {
    const data = Buffer.alloc(3 * DATA);
    const firstPartSize = DATA + 128;
    const packAt = 12 + firstPartSize;
    const [script] = scriptFixture(display("あ"));
    const sound = Buffer.from("m0100.sx\0fixture sound table\0");
    const firstScene = 16;
    const secondScene = firstScene + Math.ceil(script.length / 4) * 4;
    const soundAt = secondScene + Math.ceil(script.length / 4) * 4;
    data.writeUInt32LE(2, 0);
    data.writeUInt32LE(firstPartSize, 4);
    data.writeUInt32LE(soundAt + sound.length, 8);
    data.writeUInt32LE(1, DATA);
    data.writeUInt32LE(DATA, DATA + 4);
    data.writeUInt16LE(0x3580, packAt);
    data.writeUInt16LE(2, packAt + 2);
    for (const [i, offset] of [firstScene, secondScene, soundAt].entries()) data.writeUInt32LE(offset, packAt + 4 + i * 4);
    script.copy(data, packAt + firstScene);
    script.copy(data, packAt + secondScene);
    sound.copy(data, packAt + soundAt);

    const scenes = scanScenes(data);
    const edits = [firstScene, secondScene].map(relative => {
        const offset = packAt + relative, scene = scenes.get(offset);
        assert.equal(scene.bundle?.base, 0);
        return {...scene.rows[0], offset, key: scene.key, target: "あいう", context: "Fixture/" + offset};
    });
    const plan = new SectorPlan(data);
    assert.equal(replaceScenes(plan, scenes, new Map(), edits, createFont(), []), 2);
    const newSize = plan.read(8, 12).readUInt32LE();
    const pack = plan.read(packAt, packAt + newSize);
    assert.equal(newSize, soundAt + sound.length + 8);
    assert.equal(pack.readUInt32LE(8), secondScene + 4);
    assert.equal(pack.readUInt32LE(12), soundAt + 8);
    assert.deepEqual(pack.subarray(soundAt + 8), sound);
    assert.deepEqual(plan.read(12, packAt), data.subarray(12, packAt));
});

test("the injection log shows the translations that grow a fixed-size scene", async t => {
    const {dir} = await fixture(t);
    const page = Buffer.from([0x80]);
    const [script] = scriptFixture(display("か"), page, display("あ"), page, display("そう"));
    const original = Buffer.alloc(DATA);
    script.copy(original, 4);
    const scenes = scanScenes(original), scene = scenes.get(4);
    const fileId = "/Dialogue/scene-FIXTURE.json";
    const targets = ["かき", "<b>", "そ"];
    const edits = scene.rows.map((row, i) => ({...row, offset: scene.offset, key: scene.key, fileId,
        context: "Disc 1/FIXTURE/message/" + row.at, target: targets[i]}));
    const plan = new SectorPlan(original);
    const discWriter = {exportDiscs() {
        replaceScenes(plan, scenes, new Map(), edits, createFont(), []);
    }};
    const addonPath = path.join(__dirname, "..");
    const load = id => {
        if (id === "www/js/AddonUtils.js") return () => {};
        if (id === "www/js/LanguageSettings.js") return require("../../../js/LanguageSettings.js");
        if (id === path.join(addonPath, "tm2Psx.module.js")) return discWriter;
        return require(id);
    };
    const addon = {getPathRelativeToRoot: () => addonPath};
    const document = {createElement: tag => ({tag, style: {}})};
    const trans = {getStagingPath: () => dir, getStagingDataPath: () => dir};
    const logs = [];
    const ui = {log: {addNode: node => logs.push(node)}};
    const entry = await fs.readFile(path.join(addonPath, "tm2Psx.js"), "utf8");
    new Function("require", "$", "document", "ui", "trans", "sys", entry)
        .call(addon, load, () => ({ready() {}}), document, ui, trans, {config: {}});

    await assert.rejects(addon.exportToFolder(dir, {project: {options: {init: {}}, files: {}}}, {
        translationDatas: {translationData: {}}
    }), {message: scene.key + " needs " + (script.length + 4) + " bytes with " + script.length + " available."});

    assert.equal(plan.modified.size, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].tag, "pre");
    const blocks = logs[0].textContent.split("\n\n");
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1], fileId + " — " + edits[1].context + ' (+4 encoded bytes)\nOriginal: "あ"\nTranslation: "<b>"');
    assert.equal(blocks[2], fileId + " — " + edits[0].context + ' (+2 encoded bytes)\nOriginal: "か"\nTranslation: "かき"');
    const fittingEdits = edits.map(edit => edit === edits[1] ? {...edit, target: "い"} : edit);
    assert.equal(replaceScenes(plan, scenes, new Map(), fittingEdits, createFont(), []), 1);
});

test("Shirayuki voiced boxes resolve the twin without changing the nameplate", () => {
    const label = display("白雪", 0x18);
    const [, scene] = scriptFixture(label, Buffer.from([0x1f, 6, 0, 0]), display("美帆です。"),
        Buffer.from([0x80]), label, Buffer.from([0x1e, 6, 0, 0x1f, 11, 0, 0]), display("真帆です。"),
        Buffer.from([0x80]), label, Buffer.from([0x1e, 6, 0]), display("……。"));
    assert.deepEqual(scene.rows.filter(row => row.kind === "message").map(row => row.speakerIdentity),
        ["美帆", "真帆", undefined]);
    const plates = scene.rows.filter(row => row.kind === "speaker");
    assert.ok(plates.every(row => row.source === "白雪" && !row.speakerIdentity));
    assert.deepEqual(plates.map(row => row.nameplateIdentity), ["美帆", "真帆", undefined]);
});

test("Shirayuki voice evidence is cleared where conflicting paths meet", () => {
    const [, scene] = scriptFixture(display("白雪", 0x18), Buffer.from([
        0x30, 0x4e, 0, 0, 7, 0,
        0x1f, 6, 0, 0, 0x31, 4, 0,
        0x1f, 11, 0, 0
    ]), display("……。"));
    assert.equal(scene.rows.find(row => row.kind === "message").speakerIdentity, undefined);
    assert.equal(scene.rows.find(row => row.kind === "speaker").nameplateIdentity, undefined);
});

function display(text, opcode = 0x10, tail = []) {
    const bytes = createFont().encode(text);
    return Buffer.from([opcode, ...bytes.map(byte => ((byte & 15) << 4) | (byte >>> 4)), ...tail, 0]);
}

test("wide speaker nameplates produce layout warnings", () => {
    const [data, scene] = scriptFixture(display("陽ノ下", 0x18), display("こんにちは。"));
    const nameplate = scene.rows[0];
    const font = createFont((_glyph, width) => Buffer.alloc(width * 15 / 8, 0x55));
    const warnings = [];
    const write = target => rebuild(data, scene, [{...nameplate, context: "Fixture/speaker", target}], font, warnings);
    write("Hikari");
    write("名前例");
    assert.deepEqual(warnings, []);
    write("Hinomoto");
    write("全角四字");
    assert.equal(warnings.length, 2);
    assert.match(warnings[0].issue, /4 glyph cells.*3 cells/);
    assert.equal(warnings[0].target, "Hinomoto");
    const names = require("../speaker-names-en.json");
    for (const name of Object.values(names)) assert.ok(font.encode(name).length <= 6, name);
});

test("selection opcodes delimit even unquoted options and keep each native slot", () => {
    for (const start of [0x20, 0x21]) {
        const [data, scene] = scriptFixture(display("『始めますか？』"), Buffer.from([0x80, start]),
            display("はい"), display("いいえ"), Buffer.from([0x26, 0x27]), display("後で。"));
        assert.deepEqual(scene.rows.map(row => [row.source, row.choice, row.reflow]), [
            ["『始めますか？』", undefined, true], ["はい\nいいえ", true, false], ["後で。", undefined, true]
        ]);
        const choice = scene.rows[1];
        const write = target => rebuild(data, scene, [{...choice, target, context: "Fixture/choice"}], createFont());
        assert.throws(() => write("はい"), /one line per choice option/);
        const ops = [...parseScene(write("そうだ\n違う"), 0).ops.values()];
        assert.deepEqual(ops.map(ins => ins.op), [0x10, 0x80, start, 0x10, 0x10, 0x26, 0x27, 0x10, 0xff]);
        const warnings = [];
        const target = "字".repeat(61) + "\n違う";
        const output = rebuild(data, scene, [{...choice, target, context: "Fixture/choice"}], createFont(), warnings);
        assert.deepEqual([...parseScene(output, 0).ops.values()].map(ins => ins.op), ops.map(ins => ins.op));
        assert.match(warnings[0].issue, /5 display rows.*4 rows/);
    }
});

test("one text box becomes one row whose line count can shrink or grow", () => {
    const [data, scene] = scriptFixture(display("日本", 0x11, [0xc0]), display("語"), display("文章"), Buffer.from([0x80]));
    assert.equal(scene.rows.length, 1);
    const box = scene.rows[0];
    assert.equal(box.source, "日本語\n文章");
    assert.equal(box.reflow, true);
    const warnings = [];
    const write = target => rebuild(data, scene, [{...box, context: "Fixture/message", target}], createFont(), warnings);
    for (const [lines, target] of [[1, "一行にする"], [4, "一\n二\n\n四"]]) {
        const ops = [...parseScene(write(target), 0).ops.values()];
        assert.equal(ops[0].op, 0x11);
        assert.equal(ops.filter(ins => ins.op === 0x10 || ins.op === 0x11).length, lines);
        assert.deepEqual(ops.slice(-2).map(ins => ins.op), [0x80, 0xff]);
        if (lines === 4) assert.equal(ops[2].source, "　");
    }
    assert.deepEqual(warnings, []);
    write("一\n二\n三\n四\n五");
    write("あ".repeat(81));
    assert.deepEqual(warnings.map(warning => warning.issue), Array(2).fill("May wrap to 5 display rows. Aim for 4 rows."));
    assert.throws(() => write("あ".repeat(128)), /256-byte expander buffer/);
});

test("a text box with an interleaved voice cue keeps its display slots", () => {
    const cue = Buffer.from([0x1f, 0x12, 0x34, 0x56]);
    const [data, scene] = scriptFixture(display("日本"), cue, display("文章"), Buffer.from([0x80]));
    const box = scene.rows[0];
    assert.equal(box.source, "日本\n文章");
    assert.equal(box.reflow, false);
    const write = target => rebuild(data, scene, [{...box, context: "Fixture/message", target}], createFont());
    assert.throws(() => write("一行にする"), /original line count/);
    assert.notEqual(write("あ\nい").indexOf(cue), -1);
});

test("branches within one page warn when a fragment may exceed its native layout", () => {
    const middle = display("中");
    const branch = Buffer.from([0x30, 0x4e, 0, 0, middle.length, 0]);
    const [data, scene] = scriptFixture(display("前"), branch, middle, display("後"), Buffer.from([0x80]));
    assert.deepEqual(scene.rows.map(box => [box.source, box.reflow, box.maxRows]),
        [["前", false, 1], ["中", false, 1], ["後", false, 1]]);
    const last = scene.rows[2];
    const warnings = [];
    rebuild(data, scene, [{...last, target: "字".repeat(21), context: "Fixture/branch"}], createFont(), warnings);
    assert.match(warnings[0].issue, /2 display rows.*1 row/);
});

test("updating a legacy project joins draft columns and keeps occurrence overrides", () => {
    const path = "/Dialogue/fixture.json";
    const stem = "Disc 1/fixture/0x2000";
    const context = stem + "/message/20";
    const file = {data: [["あ\nい", ""]], tags: [[]],
        parameters: [[{contextStr: context, kind: "message",
            lines: [{at: 20, source: "あ"}, {at: 25, source: "い"}]}]]};
    const old = {data: [["あ", "One"], ["い", "Two", "Second"]],
        context: [[stem + "/dialogue/20"], [stem + "/dialogue/25"]], tags: [["red"], []],
        parameters: [[{contextStr: stem + "/dialogue/20", translation: "First"}], []]};
    parser.migrateDialogueRows({[path]: file}, {[path]: old});
    assert.deepEqual(file.data[0], ["あ\nい", "One\nTwo", "One\nSecond"]);
    assert.deepEqual(file.tags[0], ["red"]);
    assert.equal(file.parameters[0][0].translation, "First\nSecond");
});

test("the Disc 2 intro uses message headers and carries drafts from the old Menus file", async t => {
    const path = "/" + parser.introFile;
    const [first, continuation, second] = [
        {source: "あれから７年", context: "Disc 2/intro/8", joinNext: true},
        {source: "か…", context: "Disc 2/intro/24"},
        {source: "帰ってきたんだなぁ。", context: "Disc 2/intro/44"}
    ];
    const {file} = await fixture(t, {version: 1, rows: [{
        kind: "message", module: "DISC2-INTRO", context: first.context, source: first.source + continuation.source + "\n" + second.source,
        speaker: "MC", speakerKind: "runtime", speakerIdentity: "MC", speakerSource: "TM2 Disc 2 intro overlay", controls: [], reflow: false,
        lines: [{parts: [first, continuation], maxCells: 10}, {parts: [second], maxCells: 11}]
    }]});
    const parsed = await parser.parseFile(file);
    const [[row]] = parsed.parameters;
    assert.equal(parsed.translationConstraintType, "scenario");
    assert.equal(row.rowInfoText, "MC");
    assert.equal(row.speakerNameIsVariable, true);
    assert.deepEqual(row.translationConstraints, {preserveLineCount: true, maxLines: 2});
    const old = {data: [[first.source, "Seven years"], [continuation.source, "..."], [second.source, "I'm home.", "I'm back."]],
        context: [[first.context], [continuation.context], [second.context]], tags: [[], ["red"], []],
        parameters: [[], [{contextStr: continuation.context, translation: " already..."}], []]};
    parser.migrateDialogueRows({[path]: parsed}, {"/Menus/DISC2-INTRO.json": old}, {legacySceneRows: false});
    assert.deepEqual(parsed.data[0].slice(1), ["Seven years...\nI'm home.", "Seven years...\nI'm back."]);
    assert.equal(row.translation, "Seven years already...\nI'm back.");
    assert.deepEqual(parsed.tags, [["red"]]);
});

test("refresh carries user project settings but keeps newly scanned source options", async () => {
    const addonPath = path.join(__dirname, "..");
    const source = await fs.readFile(path.join(addonPath, "tm2Psx.js"), "utf8");
    const load = id => id === "www/js/AddonUtils.js" ? () => {} : require(id);
    const {carryProjectOptions} = new Function("require", "$", "document", source + "\nreturn {carryProjectOptions};")
        .call({getPathRelativeToRoot: () => addonPath}, load, () => ({ready() {}}), {});
    const previous = {project: {options: {init: {discs: ["old"]}, translationPrompts: {game: ""},
        batchTranslation: {targetColumn: 3}, validationPolicy: {rules: {maxLines: "block"}},
        translatorPreset: {chatGPT: {file: "custom"}}, gridInfo: {rowHeaderWidth: 200}}}};
    const project = {options: {init: {discs: ["new"]}, newDefault: true}};
    carryProjectOptions(project, previous);
    assert.deepEqual(project.options.init, {discs: ["new"]});
    assert.equal(project.options.translationPrompts.game, "");
    assert.equal(project.options.batchTranslation.targetColumn, 3);
    assert.equal(project.options.validationPolicy.rules.maxLines, "block");
    assert.equal(project.options.translatorPreset.chatGPT.file, "custom");
    assert.equal(project.options.gridInfo.rowHeaderWidth, 200);
    assert.equal(project.options.newDefault, true);
    project.options.batchTranslation.targetColumn = 1;
    assert.equal(previous.project.options.batchTranslation.targetColumn, 3);
    assert.doesNotThrow(() => carryProjectOptions({options: {}}, null));
});

test("image export treats empty grid placeholders as unedited rows", async () => {
    const addonPath = path.join(__dirname, "..");
    const source = await fs.readFile(path.join(addonPath, "tm2Psx.js"), "utf8");
    const load = id => id === "www/js/AddonUtils.js" ? () => {} : require(id);
    const {hasImageEdits} = new Function("require", "$", "document", source + "\nreturn {hasImageEdits};")
        .call({getPathRelativeToRoot: () => addonPath}, load, () => ({ready() {}}), {});

    assert.equal(hasImageEdits({data: [{}, null, [], ["Original", ""]]}), false);
    assert.equal(hasImageEdits({data: [{}, ["Original", "", "Replacement"]]}), true);
    assert.equal(hasImageEdits({data: [{}, ["Original", "Replacement"]], layerVisibility: {texts: false}}), false);
    assert.equal(hasImageEdits({data: [{}], kritaLayer: {imageStagingPath: "edited.png"}}), true);
});

test("scene CG flags are prefetched before the eighth token payload", () => {
    // The first flag controls seven literals and a two-byte repeat. The
    // second flag is placed before that repeat's distance and length.
    const compressed = Buffer.from([0x80, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 8]);
    const expected = Buffer.from([1, 2, 3, 4, 5, 6, 7, 7, 7, 8]);
    assert.deepEqual(cg.decodeCG(compressed, expected.length), expected);
    assert.throws(() => cg.decodeCG(compressed.subarray(0, -1), expected.length), /Truncated/);
    const repeated = Buffer.from(Array.from({length: 8192}, (_, i) => i % 1023 > 250 ? 4 : i & 255));
    assert.deepEqual(cg.decodeCG(cg.encodeCG(repeated), repeated.length), repeated);
});

test("a cropped CG round-trips an edited PNG inside its original allocation", () => {
    const {DATA, SectorPlan} = require("../disc.js");
    const textures = require("../textures.js");
    const origin = 536 * DATA, disk = Buffer.alloc(origin + 2 * DATA);
    const width = 24, height = 10, start = origin + 1024;
    const pixels = Buffer.from(Array.from({length: width * height}, (_, i) => i));
    const stream = cg.encodeCG(pixels);
    disk.writeUInt32LE(0xbc35, origin);
    disk.writeUInt16LE(512, origin + 8);
    disk.writeUInt16LE(232, origin + 10);
    disk.writeUInt32LE(1024 + stream.length, origin + 12);
    for (const [index, word] of [100, 110, width, height].entries()) disk.writeUInt16LE(word, origin + 88 + 2 * index);
    for (let i = 0; i < 256; i++) disk.writeUInt16LE(i, origin + 512 + 2 * i);
    stream.copy(disk, start);
    const [image] = cg.inventory(disk);
    assert.deepEqual([image.width, image.height], [width, height]);
    assert.equal(cg.readReplacement(image, cg.preview(image)), null);
    assert.throws(() => cg.readReplacement(image, textures.toPng(pixels)), /24 × 10 PNG/);
    const edited = Buffer.from(pixels).fill(200, 10, 60);
    const replacement = cg.readReplacement(image, textures.toPng(edited, image));
    const plan = new SectorPlan(disk);
    assert.equal(cg.replace(plan, image, replacement), 1);
    const output = plan.read(0, disk.length);
    const [patched] = cg.inventory(output);
    assert.deepEqual(patched.pixels, edited);
    assert.deepEqual(output.subarray(origin + 16, start), disk.subarray(origin + 16, start));
    assert.deepEqual(output.subarray(image.copy.end), disk.subarray(image.copy.end));
    assert.throws(() => cg.replace(plan, image, Buffer.alloc(stream.length + 1)), /compressed bytes/);
});

test("TM2 logs layout warnings as a table after the build publishes its files", async t => {
    const {dir} = await fixture(t);
    const addonPath = path.join(__dirname, "..");
    const entry = await fs.readFile(path.join(addonPath, "tm2Psx.js"), "utf8");
    const output = path.join(dir, "Tokimeki Memorial 2 [Translated] 2");
    const artifacts = {outputDir: output, playlist: path.join(output, "Tokimeki Memorial 2.m3u"), report: path.join(output, "report.json")};
    const warning = {fileId: "/Dialogue/scene-FIXTURE.json", context: "Disc 1/FIXTURE/message/40", source: "あ",
        target: "<b>\nSecond line", issue: "May wrap to 5 display rows. Aim for 4 rows."};
    const discWriter = {exportDiscs: async target => {
        assert.equal(target, dir);
        await fs.mkdir(output);
        await fs.writeFile(artifacts.playlist, "Disc 1.cue\n");
        await fs.writeFile(artifacts.report, "[]");
        return {output, playlist: artifacts.playlist, reportPath: artifacts.report,
            report: [{disc: 1, changedSectors: 1, textureCopies: 0, layoutWarnings: [warning]}]};
    }};
    const load = id => {
        if (id === "www/js/AddonUtils.js") return () => {};
        if (id === "www/js/LanguageSettings.js") return require("../../../js/LanguageSettings.js");
        if (id === path.join(addonPath, "tm2Psx.module.js")) return discWriter;
        return require(id);
    };
    const addon = {getPathRelativeToRoot: () => addonPath};
    const trans = {getStagingPath: () => dir, getStagingDataPath: () => dir};
    function createElement(tag) {
        return {tag, style: {}, children: [], appendChild(node) { this.children.push(node); return node; },
            createCaption() { return this.appendChild(createElement("caption")); },
            createTHead() { return this.appendChild(createElement("thead")); },
            createTBody() { return this.appendChild(createElement("tbody")); },
            insertRow() { return this.appendChild(createElement("tr")); },
            insertCell() { return this.appendChild(createElement("td")); }};
    }
    const logged = [];
    const log = () => {};
    log.addNode = (node, options) => logged.push({node, options});
    new Function("require", "$", "document", "ui", "trans", "sys", entry)
        .call(addon, load, () => ({ready() {}}), {createElement}, {log}, trans, {config: {}});

    let published;
    const files = await addon.exportToFolder(dir, {project: {options: {init: {}}, files: {}}}, {
        translationDatas: {translationData: {}}, onInjectArtifacts: value => { published = value; }
    });
    assert.deepEqual(published, artifacts);
    assert.deepEqual(files.sort(), [artifacts.playlist, artifacts.report].sort());
    assert.equal(logged.length, 1);
    const [{node, options}] = logged;
    assert.equal(options.type, "warning");
    assert.equal(node.tag, "table");
    const [caption, header, body] = node.children;
    assert.match(caption.textContent, /Text layout warnings.*\(1\)/);
    assert.equal(header.children[0].children.length, 4);
    assert.deepEqual(body.children[0].children.map(cell => cell.textContent),
        [warning.fileId + "\n" + warning.context, warning.source, warning.target, warning.issue]);
});
