# Tokimeki Memorial 2 (PlayStation)

A third-party [Translator++](https://dreamsavior.net/docs/translator/) add-on for translating and modding the 5-disc PlayStation release of *Tokimeki Memorial 2*.

> **Note:** This repository provides the parser and build tools, not a pre-made English patch. You will need your own clean Japanese Rev 1 disc images (`SLPM-86355`–`SLPM-86359`).

![Tokimeki Memorial 2 title screen with the English main menu][cover]

## Why

I’ve found that the AI-assisted MCP tools and skills in [Translator++](https://dreamsavior.net/docs/translator/) make retro game translation easier and cheaper. I built this add-on so I could edit the translation myself and add more languages later.

The add-on handles the PlayStation disc structures, font packing, and image containers automatically—so anyone who wants to revise the English, translate into another language, or make a mod can focus on the text and artwork.

## Sample

<!-- Tip: Drag showcase/english-sample.mp4 into the GitHub web editor to replace this link with an inline player -->
[Watch / Download the English gameplay sample (MP4, 4:14)][video]

![Kasumi speaking in English in the original PlayStation dialogue box][dialogue]

Disc 2 includes English stat labels and a reformatted calendar. On Disc 1, the **Symbols** tab supports up to six Latin letters per name field.

| Disc 2 status screen | Disc 1 name entry |
| --- | --- |
| ![English stat labels and calendar on the Disc 2 status screen][status] | ![The name entry screen with Piter Cross entered using Latin letters][name-entry] |

## Inside Translator++

### Speaker names
Dialogue rows include the character’s name when the speaker is known, giving AI translation tools context for tone and wording.

![Dialogue grid with Hinomoto and MC speaker labels and a yellow-tagged nameplate row][speakers]

### Menu textures
Button labels and other text baked into the interface can be edited directly in **Image Translator**.

![English name-entry buttons on a texture sheet open in Image Translator][ui-textures]

### Scene artwork
CGs load on demand under **Images → tm2 → cg**. For mods, you can extract them as PNGs and include edited versions in your build.

![A scene CG showing a character under a yellow umbrella open in Translator++][cg-browser]

## Quick start

### 1. Install
Requires Translator++ **8.11.21 or later** ([Download Translator++](https://dreamsavior.net/download)).

* **Translator++ 8.11.25+:** Open **Options → Add-ons → Install → Community add-ons**, install **Tokimeki Memorial 2 Parser**, and restart.
* **Manual install:** Follow the steps in the [Pismax add-on catalog](https://github.com/pismax/tpp-addons#install).

### 2. Create a project
Prepare clean Japanese Rev 1 disc images (`SLPM-86355` through `SLPM-86359`), each as a single Mode 2/2352 data track.

1. Select **New Project → Tokimeki Memorial 2 (PlayStation)**.
2. Choose **Rev 1 disc folder** for all five discs, or **Browse BIN/CUE files…** for a partial set.
3. Leave **Capture game CG and interface textures** enabled to include artwork and UI sheets (automatic interface OCR requires Image Translator and an active OCR engine).
4. Pick your target language using the standard Translator++ controls.

### 3. Export and play
Export to a folder, ZIP, or use **Inject** to build a separate disc set. Open the generated `Tokimeki Memorial 2.m3u` in an emulator that supports playlists, or load an individual CUE. Unmodified discs are copied byte-for-byte.

## Translation & modding reference

Detailed per-file rules, formatting limits, and asset workflows are documented in the **[Translation & Modding Guide](USAGE.md)**:

* **Dialogue & Nameplates:** Row wrapping limits, speaker tags, `Actor Reference`, and Shirayuki Miho/Maho disambiguation.
* **System & Menus:** Memory-card prompts (`STARTUP.json`, `OV6.json`), disc-swap text, and childhood map labels (`CHILD.json`).
* **Player Names & Fonts:** Packed Latin glyphs, the Disc 1 Symbols tab, and E.V.S. kana notes.
* **Interface Textures & CGs:** Extracting/replacing PNGs, calendar overlays, and palette/compression limits.

---

*Independent community add-on. Not affiliated with Dreamsavior or Konami.*

[cover]: showcase/cover.png
[video]: showcase/english-sample.mp4
[dialogue]: showcase/dialogue.png
[status]: showcase/status.png
[name-entry]: showcase/name-entry.png
[speakers]: showcase/speakers.png
[ui-textures]: showcase/ui-textures.png
[cg-browser]: showcase/cg-browser.png
