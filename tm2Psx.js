// Addon entry. Translator++ evaluates this file with the Addon as `this`.
const addon = this;
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const AddonUtils = require("www/js/AddonUtils.js");
const parser = require(path.join(addon.getPathRelativeToRoot(), "tm2Psx.module.js"));
const rasterizeGlyph = require(path.join(addon.getPathRelativeToRoot(), "glyphCanvas.js"));
const title = "Tokimeki Memorial 2";

addon.gameEngine = "tm2Psx";
addon.originalResourceIsReadOnly = true;
addon.alwaysExportFromStage = true;
AddonUtils(addon);

function imageTranslator() {
    const it = addonLoader.getAddonByName("imageTranslator");
    return it?.buildImageFileEntry ? it : null;
}

function progress(line) {
    if (line) ui.loadingProgress(title, line, {consoleOnly: true, mode: "consoleOutput"});
}

addon.prepareNewProject = async function(info = {}) {
    const discFiles = (info.discFiles || []).map(file => path.resolve(file));
    const entryPoint = discFiles[0] || info.entryPoint;
    if (!entryPoint) throw new Error("Choose the game disc folder or one or more BIN/CUE files.");
    const previous = info.discs && trans.project?.gameEngine === "tm2Psx" ? trans.getSaveData() : null;
    const init = {...info, entryPoint: path.resolve(entryPoint), discFiles, messageBoxes: true, projectTitle: info.projectTitle || title};
    delete init.toolkit;
    delete init.python;
    ui.showLoading();
    try {
        const source = await parser.scan(discFiles.length ? discFiles : init.entryPoint, {...init, progress});
        try {
            init.discs = source.discs;
            return await addon.createProject(source.files, source.sourceDir, {init, source, previous});
        } finally {
            await fs.rm(source.sourceDir, {recursive: true, force: true});
        }
    } finally {
        ui.loadingEnd();
    }
};

addon.getTransData = (id, base) => parser.parseFile(parser.resourcePath(base, id));
addon.setFileFormatName = id => id === parser.introFile ? "TM2 timed intro dialogue" :
    id.startsWith("Dialogue/") ? "TM2 scene bytecode" : "TM2 menu and system text";
addon.setProjectLocation = async (_data, _base, {init}) =>
    (await fs.stat(init.entryPoint)).isDirectory() ? init.entryPoint : path.dirname(init.entryPoint);

function preserveImageRows() {
    const sanitize = trans.sanitize;
    trans.sanitize = function(data) {
        const project = (data || this).project;
        if (project?.gameEngine === addon.gameEngine) {
            for (const collection of [project.files, project.references]) {
                const reference = collection?.["Actor Reference"];
                if (reference) reference.dirname = "*";
            }
        }
        const images = Object.values(project?.files || {}).filter(file => file.tm2Image)
            .map(file => [file, file.data, file.context, file.parameters, file.tags]);
        const result = sanitize.call(this, data);
        for (const [file, rows, contexts, parameters, tags] of images) {
            Object.assign(file, {data: rows, context: contexts, parameters, tags});
        }
        return result;
    };
}

async function copyAsset(source, target) {
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(source, target);
}

async function copyLayers(value, from, to) {
    for (const [key, item] of Object.entries(value || {})) {
        if (key.endsWith("StagingPath") && typeof item === "string" && item) {
            await copyAsset(parser.resourcePath(from, item), parser.resourcePath(to, item));
        } else if (item && typeof item === "object") {
            await copyLayers(item, from, to);
        }
    }
}

function carryProjectOptions(project, previous) {
    if (!previous?.project?.options) return;
    // The scan supplies new source/disc information; all other project options
    // belong to the user and must survive an update, including explicit blanks.
    const init = project.options.init;
    project.options = {...project.options, ...JSON.parse(JSON.stringify(previous.project.options)), init};
}

addon.finalizeTransData = async function(data, base, {source, previous, init}) {
    const project = data.project;
    carryProjectOptions(project, previous);
    project.options.sl = "ja";
    const targetLanguage = previous?.project.options.tl || init.targetLanguage;
    if (targetLanguage) project.options.tl = targetLanguage;
    project.options.gridInfo = {rowHeaderWidth: 160, rowHeaderInfo: true, isRuleActive: true, ...project.options.gridInfo};
    project.options.translationConstraints = previous?.project.options.translationConstraints || {
        enabled: true, types: {image: {enabled: false}, reference: {enabled: false}}
    };
    const oldActors = previous?.project.references?.["Actor Reference"] || previous?.project.files?.["Actor Reference"];
    const reference = oldActors || trans.createFileData("Actor Reference", {
        type: "reference", actorInfoColumn: 2, data: source.actors, context: [], parameters: [], tags: []
    });
    if (oldActors) {
        reference.actorInfoColumn ??= 2;
        reference.data = parser.mergeActorReferenceRows(oldActors.data || [], source.actors, reference.actorInfoColumn);
        reference.indexIsBuilt = false;
        reference.cacheResetOnChange = {};
    }
    reference.dirname = "*";
    project.references ||= {};
    project.references["Actor Reference"] = project.files["Actor Reference"] = reference;
    if (previous && !previous.project.options.init?.messageBoxes) {
        if (previous.colHeaders) data.colHeaders = previous.colHeaders;
        if (previous.columns) data.columns = previous.columns;
    }
    if (previous) {
        parser.migrateDialogueRows(project.files, previous.project.files, {legacySceneRows: !previous.project.options.init?.messageBoxes});
        parser.migrateChoiceTranslations(project.files, previous.project.files);
    }
    const language = require("www/js/LanguageSettings.js").resolve(project, sys.config).tl;
    parser.seedSpeakerNames(project.files, language);
    parser.seedMenuTranslations(project.files, language);
    const cache = trans.getStagingPath(data);
    const it = imageTranslator();
    const layers = ["kritaLayer", "inpaintLayer", "aiInpaintLayer", "burnInLayer", "aiInpaint"];
    for (const image of source.images) {
        await copyAsset(path.join(base, image.name), parser.resourcePath(cache, image.file));
        const format = image.kind === "cg" ? "TM2 scene CG (8-bit)" : image.kind === "tim"
            ? "PS1 TIM (" + image.bpp + "-bit)" : "PS1 indexed texture (4-bit)";
        const entry = it?.buildImageFileEntry(image.file, [], {
            width: image.width, height: image.height, stagingPath: image.file, sourceExtension: ".png", originalFormat: format
        }) || trans.createFileData(image.file, {
            type: "image", data: [], context: [], parameters: [], tags: [], originalFormat: format,
            imageWidth: image.width, imageHeight: image.height, imageStagingPath: image.file, imageSourceExtension: ".png"
        }, {leadSlash: true});
        const previousImage = previous?.project.files[entry.path];
        if (previousImage?.tm2Image?.key === image.key) {
            const oldCache = trans.getStagingPath(previous);
            for (const key of layers) await copyLayers(previousImage[key], oldCache, cache);
            Object.assign(entry, previousImage);
        }
        entry.tm2Image = image;
        entry.note = image.label;
        project.files[entry.path] = entry;
    }
    if (init.ocrImages && source.images.length && !previous) {
        try { await addon.recognizeImages(data); }
        catch (error) { ui.log("Image text recognition: " + error.message); }
    }
    return data;
};

addon.recognizeImages = async function(data = {project: trans.project}) {
    if (data.project?.gameEngine !== "tm2Psx") throw new Error("Open a Tokimeki Memorial 2 project first.");
    const it = imageTranslator();
    const engine = typeof OcrEngine !== "undefined" && OcrEngine.getMainEngine();
    if (!it || !engine) throw new Error("Enable Image Translator and an OCR engine to recognize labels.");
    const cache = trans.getStagingPath(data);
    const edited = [];
    for (const file of Object.values(data.project.files)) {
        if (!file.tm2Image || file.tm2Image.kind || (Array.isArray(file.data) && file.data.some(row => Array.isArray(row) && row[0]))) continue;
        progress("Recognizing " + file.tm2Image.name);
        try {
            const png = await fs.readFile(parser.resourcePath(cache, file.imageStagingPath));
            const blocks = await it.translateImageAsset(png, {engineId: engine.id});
            if (!blocks.length) continue;
            const detected = it.buildImageFileEntry(file.path.replace(/^\//, ""), blocks, {width: file.imageWidth, height: file.imageHeight});
            for (const key of ["data", "context", "parameters", "tags"]) file[key] = detected[key];
            file.ocrEngineId = engine.id;
            edited.push(file.tm2Image.name);
        } catch (error) {
            ui.log("Could not recognize labels in " + file.tm2Image.name + ". " + error.message);
        }
    }
    return edited;
};

function hasTranslatedText(file) {
    return file.layerVisibility?.texts !== false && Array.isArray(file.data) &&
        file.data.some(row => Array.isArray(row) && row.slice(1).some(Boolean));
}

function hasImageEdits(file) {
    return file.layerVisibility?.original === false || hasTranslatedText(file) ||
        ["krita", "inpaint", "aiInpaint", "burnIn"].some(name => file[name + "Layer"]?.imageStagingPath && file.layerVisibility?.[name] !== false);
}

async function fileExists(file) {
    try { return (await fs.stat(file)).isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function logLayoutWarnings(warnings) {
    if (!warnings.length) return;
    const table = document.createElement("table");
    table.style.display = "table";
    table.style.width = "100%";
    table.style.whiteSpace = "normal";
    table.style.borderSpacing = "12px 6px";
    const caption = table.createCaption();
    caption.textContent = "Text layout warnings to review in game (" + warnings.length + ")";
    const header = table.createTHead().insertRow();
    for (const label of ["Project file and occurrence", "Original text", "Translation used", "Potential layout issue"]) {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = label;
        cell.style.textAlign = "left";
        header.appendChild(cell);
    }
    const body = table.createTBody();
    for (const {fileId, context, source, target, issue} of warnings) {
        const row = body.insertRow();
        for (const value of [[fileId, context].filter(Boolean).join("\n"), source, target, issue]) {
            const cell = row.insertCell();
            cell.textContent = value;
            cell.style.whiteSpace = "pre-wrap";
            cell.style.overflowWrap = "anywhere";
            cell.style.verticalAlign = "top";
        }
    }
    await ui.log.addNode(table, {type: "warning", preserveWrapper: true});
}

addon.exportToFolder = async function(destination, data, options = {}) {
    data ||= trans.getSaveData();
    const init = data.project.options.init;
    const files = options.files ?? (options.useSelectedFiles === false ? [] : trans.getCheckedFiles?.());
    const selected = files?.length ? new Set(files) : null;
    const language = require("www/js/LanguageSettings.js").resolve(data.project, sys.config).tl;
    const english = /^en(?:[-_]|$)/i.test(language);
    const englishChildhoodDate = english && (!selected || selected.has("/Menus/CHILD.json"));
    const translationData = options.translationDatas || trans.getTranslationData(data, options);
    const translations = Object.fromEntries(Object.keys(translationData.translationData || {})
        .filter(id => /^\/?(?:Dialogue|Menus)\//.test(id) && (!selected || selected.has(id)))
        .map(id => [id, addon.selectTranslationData(translationData, id)]));
    const images = [];
    const cache = trans.getStagingPath(data);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tpp-tm2-images-"));
    try {
        for (const [id, file] of Object.entries({...data.project.files, ...options.imageTranslatorFiles})) {
            if (!file.tm2Image || (selected && !selected.has(id))) continue;
            const image = file.tm2Image;
            const original = parser.resourcePath(cache, file.imageStagingPath);
            const preview = image.kind ? undefined : original;
            const external = init.replacementPngFolder && parser.resourcePath(init.replacementPngFolder, image.name);
            if (external && await fileExists(external) && !(await fs.readFile(external)).equals(await fs.readFile(original))) {
                images.push({...image, png: external, preview});
            } else if (hasImageEdits(file)) {
                const it = imageTranslator();
                if (!it) throw new Error("Enable Image Translator to render edits for " + image.name + ".");
                const png = parser.resourcePath(temp, image.name);
                const parameters = file.parameters?.map((row, index) => it.getBestTranslation(file.data?.[index]) ? row : []);
                await fs.writeFile(png, await it.renderImageToBuffer({...file, parameters}));
                images.push({...image, png, preview});
            }
        }
        const result = await parser.exportDiscs(destination, {...init, stage: trans.getStagingDataPath(data),
            translations, images, englishChildhoodDate, englishMainDate: english, latinNameEntry: options.latinNameEntry ?? english,
            sourceMaterial: options.tm2SourceMaterial, signal: options.signal, progress,
            rasterizeGlyph: (text, width) => rasterizeGlyph(document, text, width)});
        options.imageTranslatorHandled = true;
        for (const disc of result.report) {
            ui.log("Disc " + disc.disc + ": " + disc.changedSectors + " changed sectors, " + disc.textureCopies + " texture copies.");
        }
        await logLayoutWarnings(result.report.flatMap(disc => disc.layoutWarnings ?? []));
        ui.log("Play the BIN/CUE set through the playlist in " + result.output);
        options.onInjectArtifacts?.({outputDir: result.output, playlist: result.playlist, report: result.reportPath});
        return (await fs.readdir(result.output)).map(name => path.join(result.output, name));
    } catch (error) {
        if (error?.scriptOverflowDetails) {
            const details = document.createElement("pre");
            details.style.whiteSpace = "pre-wrap";
            details.textContent = error.scriptOverflowDetails;
            await ui.log.addNode(details, {type: "error", virtualizeText: true});
        }
        throw error;
    } finally {
        await fs.rm(temp, {recursive: true, force: true});
    }
};

addon.injectCopyMaterials = async function(source, _destination, options) {
    const {loc, options: projectOptions} = trans.project;
    const useSelectedFiles = projectOptions.init.discFiles?.length && loc && source && path.resolve(source) === path.resolve(loc);
    options.tm2SourceMaterial = useSelectedFiles ? undefined : source || undefined;
};

addon.resolveTranslationOccurrences = async function(fileId, rows) {
    if (!/^\/?(?:Dialogue|Menus)\//.test(fileId)) return null;
    const file = trans.project.files[fileId];
    if (!file || file.type === "reference") return null;
    const data = {project: {...trans.project, files: {[fileId]: file}}};
    const translationData = trans.getTranslationData(data, {
        files: [fileId], useSelectedFiles: false, wordWrapByTags: trans.getOption?.("wordWrapByTags") || []
    });
    const selected = addon.selectTranslationData(translationData, fileId);
    return parser.describeOccurrences(parser.resourcePath(trans.getStagingDataPath(data), fileId), rows, selected);
};

addon.exportAsZip = async function(target, data, options) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tpp-tm2-zip-"));
    const output = path.resolve(target);
    try {
        if (await fileExists(output)) throw new Error("Choose a new ZIP filename.");
        const files = await addon.exportToFolder(temporary, data, options);
        const archive = path.join(temporary, "discs.zip");
        await new Promise((resolve, reject) => require("7zip-min").cmd(["a", "-tzip", archive, ...files], error => error ? reject(error) : resolve()));
        await fs.copyFile(archive, output, require("fs").constants.COPYFILE_EXCL);
        return output;
    } finally {
        await fs.rm(temporary, {recursive: true, force: true});
    }
};

addon.handleExport = async function(output, options = {}) {
    ui.showLoading();
    try {
        if (options.mode === "zip") await addon.exportAsZip(output, undefined, options);
        else await addon.exportToFolder(output, undefined, options);
        await ui.log.showOpenDirButton(output);
    } finally {
        ui.loadingEnd();
    }
};

function showImageSettings() {
    if (trans.project?.gameEngine !== "tm2Psx") return alert("Open a Tokimeki Memorial 2 project first.");
    const project = trans.project;
    const data = trans.getSaveData();
    const images = Object.values(data.project.files).filter(file => file.tm2Image);
    if (!images.length) return alert("Use Update Project from Source to capture game artwork first.");
    const cache = trans.getStagingPath(data);
    const fields = new CustomFields($("<form></form>"), {jsonForm: {
        schema: {folder: {type: "string", title: "Replacement PNG folder", default: data.project.options.init.replacementPngFolder || ""}},
        form: [{key: "folder", type: "selectfile", directory: true}]
    }});
    const description = $("<p></p>").text("Extract the project’s CG and interface PNGs to your editing folder. Keep the filenames and dimensions. Inject and Export use matching replacements for the included images.");
    if (!images.some(file => file.tm2Image.kind)) {
        description.append($("<span></span>").text(" Use Update Project from Source to add CG to this project."));
    }
    const status = $("<p></p>", {role: "status"});
    const dialog = $("<div></div>").append(description, fields.getElm(), status).appendTo(document.body);
    function useFolder(folder) {
        if (trans.project !== project) throw new Error("The active project changed.");
        project.options.init.replacementPngFolder = folder;
        trans.gridIsModified(true);
    }
    dialog.dialog({title: title + " artwork", width: 610, modal: true,
        close: function() { $(this).dialog("destroy").remove(); },
        buttons: [
            {text: "Extract PNGs", click: async function(event) {
                const folder = fields.getValues().folder;
                if (!folder) { status.text("Choose a folder for the PNGs."); return; }
                const button = $(event.currentTarget).prop("disabled", true);
                status.text("Extracting " + images.length + " PNGs…");
                try {
                    const target = path.resolve(folder);
                    await fs.mkdir(target, {recursive: true});
                    let copied = 0;
                    for (const file of images) {
                        const from = parser.resourcePath(cache, file.imageStagingPath);
                        const to = parser.resourcePath(target, file.tm2Image.name);
                        try {
                            await fs.copyFile(from, to, require("fs").constants.COPYFILE_EXCL);
                            copied++;
                        } catch (error) {
                            if (error.code !== "EEXIST" || !await fileExists(to)) throw error;
                        }
                    }
                    useFolder(target);
                    status.text("Extracted " + copied + " PNGs. Kept " + (images.length - copied) +
                        " existing PNGs and set this as the replacement folder.");
                    nw.Shell.openItem(target);
                } catch (error) {
                    status.text(error.message);
                } finally {
                    button.prop("disabled", false);
                }
            }},
            {text: "Save folder", click: () => {
                try {
                    const folder = fields.getValues().folder;
                    useFolder(folder ? path.resolve(folder) : "");
                    dialog.dialog("close");
                } catch (error) {
                    status.text(error.message);
                }
            }}
        ]});
}

function discList(numbers) {
    return (numbers.length === 1 ? "Disc " : "Discs ") + numbers.join(", ");
}

function createDiscFields() {
    const $form = $("<form></form>");
    const $files = $("<input>", {type: "file", accept: ".cue,.bin", multiple: true, hidden: true, "aria-label": "Disc files"});
    const $summary = $("<span>", {"aria-live": "polite"});
    const $status = $("<p>", {class: "help-block", role: "status"});
    let revision = 0, timer;
    function showStatus(text, type = "") {
        $status.removeClass("text-danger text-warning text-success").addClass(type).text(text);
    }
    async function inspect(values, current) {
        const selection = values.discFiles?.length ? values.discFiles : values.entryPoint?.trim();
        if (!selection) {
            showStatus("Choose a disc folder or BIN/CUE files.", "text-danger");
            return null;
        }
        showStatus("Checking disc images…");
        try {
            const result = await parser.inspectDiscSelection(selection);
            if (current !== revision) return null;
            if (result.missing.length) {
                showStatus("Found " + discList(result.found) + ". Missing " + discList(result.missing) + ".", "text-warning");
            } else showStatus("Found all five Japanese Rev 1 discs.", "text-success");
            return {...result, values: {...values, entryPoint: values.entryPoint?.trim()}};
        } catch (error) {
            if (current === revision) {
                const message = error.code === "ENOENT" ? "A selected folder or disc image could not be found." : error.message;
                showStatus(message, "text-danger");
            }
            return null;
        }
    }
    function sourceChanged(delay = 0) {
        clearTimeout(timer);
        const current = ++revision, values = fields.getValues();
        if (!values.discFiles?.length && !values.entryPoint?.trim()) { showStatus(""); return; }
        if (delay) {
            showStatus("Checking disc images…");
            timer = setTimeout(() => inspect(values, current), delay);
        } else void inspect(values, current);
    }
    function setFiles(files) {
        $form.find("[name='discFiles']").val(JSON.stringify(files));
        $summary.text(files.map(file => path.basename(file)).join(", "));
        if (files.length) $form.find("[name='entryPoint']").val("");
    }
    const fields = new CustomFields($form, {jsonForm: {
        schema: {
            entryPoint: {type: "string", title: "Rev 1 disc folder"},
            discFiles: {type: "array", items: {type: "string"}},
            includeImages: {type: "boolean", title: "Capture game CG and interface textures", default: true},
            ocrImages: {type: "boolean", title: "Recognize texture labels with the active OCR engine", default: false}
        },
        form: [
            {key: "entryPoint", type: "selectdir"},
            {key: "discFiles", type: "hidden"},
            {type: "button", title: "Browse BIN/CUE files…", onClick: () => $files[0].click(),
                onInsert: (_event, node) => $(node.el).after($files, $summary, $status)},
            "includeImages",
            "ocrImages"
        ]
    }});
    setFiles([]);
    $form.on("input change", "[name='entryPoint']", event => {
        if (event.target.value) setFiles([]);
        sourceChanged(event.type === "input" ? 250 : 0);
    });
    $files.on("change", event => {
        const files = Array.from(event.currentTarget.files, file => file.path);
        if (files.length && files.every(Boolean)) {
            setFiles(files);
            sourceChanged();
        }
        event.currentTarget.value = "";
    });
    return {fields, selectFiles(files) {
        setFiles(files);
        sourceChanged();
    }, validate() {
        clearTimeout(timer);
        return inspect(fields.getValues(), ++revision);
    }};
}

function registerWizard() {
    const slide = $("<div><h2>Tokimeki Memorial 2 (PlayStation)</h2><div class='tm2Fields'></div></div>");
    slide.find(".tm2Fields").before($("<p></p>").text("Choose the Japanese Rev 1 disc folder to import all five discs, or browse for specific BIN/CUE files."));
    ui.newProjectDialog.addMenu({
        icon: addon.getWebLocation() + "/icon.png", descriptionBar: "<h2>Tokimeki Memorial 2 (PlayStation)</h2>",
        actionBar: "", goToSlide: addon.package.name, at: 8,
        slides: {parser: ui.newProjectDialog.newSlide(addon.package.name, slide, {
            buttons: [{text: t("Create Project"), click: async () => {
                const form = addon.discFields;
                if (form.creating) return;
                form.creating = true;
                try {
                    const selection = await form.validate();
                    if (!selection || form !== addon.discFields) return;
                    if (selection.missing.length && !confirm("Missing " + discList(selection.missing) +
                        ". Create a project with " + discList(selection.found) + " only?")) return;
                    await addon.prepareNewProject(selection.values);
                    ui.newProjectDialog.close();
                } catch (error) {
                    ui.log.error(error.stack || String(error));
                    alert(error.message);
                } finally {
                    form.creating = false;
                }
            }}],
            onActive: () => {
                addon.discFields = createDiscFields();
                slide.find(".tm2Fields").empty().append(addon.discFields.fields.getElm());
            }
        })}
    });
}

function registerDetector() {
    const registry = window.engineDetectionRegistry;
    if (!registry || registry.definitions.has("tm2Psx")) return;
    registry.register({
        id: "tm2Psx", addonId: addon.id || addon.package.name, engineIds: ["tm2Psx"], displayName: title, priority: 100,
        detect: async request => {
            const entryPoint = request.entryPoint || request.selectedPath;
            if (!entryPoint || !await parser.detect(entryPoint)) return {matches: []};
            const gameRoot = (await fs.stat(entryPoint)).isDirectory() ? entryPoint : path.dirname(entryPoint);
            return {matches: [{engineId: "tm2Psx", confidence: 1, evidence: ["Japanese Rev 1 disc size, serial, and CDPACK signature"],
                entryPoint, gameRoot, preferredInput: "entryPoint"}]};
        },
        openProjectWizard: async (_candidate, launch) => {
            const isFolder = (await fs.stat(launch.entryPoint)).isDirectory();
            ui.newProjectDialog.gotoSlide(addon.package.name, "engineDetectResult");
            if (isFolder) registry.setFieldValue(addon.discFields.fields.getElm().find("[name='entryPoint']"), launch.entryPoint);
            else addon.discFields.selectFiles([launch.entryPoint]);
        }
    });
}

$(document).ready(() => ui.onReady(() => {
    preserveImageRows();
    registerWizard();
    registerDetector();
    AddonUtils.applyCommonHandlers(["tm2Psx"], addon);
    engines.addHandler("tm2Psx", "resolveTranslationOccurrences", addon.resolveTranslationOccurrences);
    ui.mainMenu.addChild("tools", {id: "tm2PsxTools", label: title});
    ui.mainMenu.addChild("tm2PsxTools", {label: "Extract CG and interface PNGs"}).on("select", showImageSettings);
    ui.mainMenu.addChild("tm2PsxTools", {label: "Recognize text in interface textures"}).on("select", async () => {
        ui.showLoading();
        try {
            const edited = await addon.recognizeImages();
            if (edited.length) {
                trans.syncFileNavigator("tm2-ocr");
                trans.refreshGrid();
                trans.gridIsModified(true);
            }
            ui.log("Recognized labels in " + edited.length + " textures.");
        } catch (error) {
            alert(error.message);
        } finally {
            ui.loadingEnd();
        }
    });
}));
