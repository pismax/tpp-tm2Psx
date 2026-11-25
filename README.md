# Tokimeki Memorial 2 (PlayStation)

Import clean Japanese Rev 1 images of Discs 1–5, serials SLPM-86355 through
SLPM-86359. Select the folder to work on all five discs in one project, or
select the BIN/CUE files you want to import. Each disc must be a single Mode
2/2352 data track.

## Create a project

1. In Translator++, select **New Project → Tokimeki Memorial 2 (PlayStation)**.
2. Use **Rev 1 disc folder** to import the folder, or **Browse BIN/CUE files…**
   to select one or more images. The wizard lists missing discs as the
   selection changes and asks before creating a partial project.
3. Leave **Capture game CG and interface textures** enabled to include scene
   artwork and interface sheets. Automatic interface OCR requires Image
   Translator and an active OCR engine.
4. Choose your target language using the normal Translator++ language controls.

Each dialogue box appears as one row in **Dialogue**, with its line breaks
inside the cell. Aim for one to four display lines including wrapping in a
standard box. Boxes with interleaved script events, special render
flags, or branches inside a page keep their native display slots. Speaker labels appear in the row headers
when all known paths to an occurrence agree.
Selectable options have a `choice` row header and dedicated translation
guidance in Actor Reference. Their occurrence paths include `/choice/`.
Keep one option per line in the original order.
**Actor Reference** appears under `*`. New projects include brief gender, role,
and voice guidance for the detected speakers, including
the custom-named player when relevant. Updates fill missing notes, refresh
older stock descriptions, and preserve your custom notes and translated names.
Voiced Shirayuki dialogue can use separate Miho and Maho speaker notes even
within the same file. Their original nameplates stay translatable separately.
Fill in name equivalents in your target language.
To change the name drawn by the game, translate the speaker-label row in
**Dialogue**. Nameplate rows are tagged yellow. New English projects prefill
short nameplates in **Initial**. When identical text is used as both a
nameplate and dialogue, only the nameplate occurrences are prefilled.
Shirayuki nameplates use **Miho** or **Maho** when the voices identify the
speaker, including separate occurrences of the same row. Unclear nameplates
use **Shir**, and their rows also receive a blue tag.

Use **Update Project from Source** to regroup an existing project's dialogue.
The update combines existing translation columns and context translations
using each original line's scene offset.

Repeated text can have independent context translations. Contexts include the
disc, scene or module, and original byte offset. Preserve the order and
arguments of script tokens such as `{name1}`, `{char:21}`, and `{nobreak}`.
The exporter checks encoding, container capacity, and file identity. The
encoded texts share the space available to their scene or bundle. After a
successful build, the log lists potential display issues in a table. It
estimates dialogue wrapping at 20 glyph cells per display line and flags
literal nameplates over three full-width cells. Details are also in the disc report.

Export retains the game's original characters, renders compact Latin pairs,
and generates extra glyphs from system fonts for characters outside its
encoding. The disc has a finite space for additional glyphs, and dialogue
uses the original fixed-width layout. Scripts that need contextual shaping
between cells or bidirectional layout need further game renderer work.

## Startup and memory-card prompts

**Menus → STARTUP.json** contains the memory-card check and system-file load
messages. The successful load message combines a slot label with the shared
two-line text, so translate the slot labels and the following text together.
Keep the original line counts and type Latin text normally. The export draws
two half-width Latin characters per cell. Use **Update Project from Source**
to add the new rows to an existing project.

Other save and load prompts appear in **Menus → OV6.json**, including the
two-line File Select Room Continue prompt with colored ○ and × symbols. The
parser fills this row in English projects. Keep both symbols in order on the
second line. One row covers all copies, including name entry and E.V.S.

## Disc changes and introductory dialogue

Use **Update Project from Source** to add these native text files to an existing
project:

- **Menus → DISC-SWAP.json** contains the two-line disc-check message and the
  prompt after the highlighted disc label. Keep both lines of the disc-check
  message. The game supplies the label and disc number for the swap prompt, so
  include any space needed before your text.
- **Menus → CHILD-TEXT.json** contains eight childhood map lines, including
  the candy-shop thoughts. Keep the original line counts.
- **Dialogue → scene-DISC2-INTRO.json** contains one row per textbox at the
  start of Disc 2, with **MC** as the speaker. Keep each row's existing line
  count. The game supplies the opening quote and standalone ellipses. Updating
  an older project joins translations from the four original fragments.

## Player names

On Disc 1 of an English export, open the **Symbols** tab (記号 on the original
buttons). The tab starts with A–Z and a–z. Each surname and given name fits
six Latin letters, or a mixture of Latin letters and full-width characters
within three cells. **Back** deletes one letter from a pair. The name uses
the same narrow glyphs as the English dialogue. E.V.S. readings still use
the game's kana input.

English exports install the name font on every disc in the project, including
discs with no selected translation rows. Use the exported set for disc swaps
and for loading saves that contain packed Latin names.

## Childhood map

The Disc 1 map location labels are in **Menus → CHILD.json**. Use **Update
Project from Source** to add these rows to an existing project. English
projects prefill the new labels in **Initial**. Each label has room for nine
glyph cells, which can hold up to 18 compact Latin characters.
English exports use slashes and two-letter weekdays for the childhood map
date. A selection export includes the date when it includes **CHILD.json**.

## Interface textures

The title choices **Game Start**, **Options**, and **PocketStation** are on
`title_menu_left.png` and `title_menu_right.png` under **Images**. The sheets
include both selection states.

The interface sheets also include name-entry buttons, file-select buttons, and
status and date labels. Their indexed previews preserve the game's pixel indices.
English builds format the main calendar like the childhood map, for example
`1999 / 4 / 11 (Su)`. This applies to selection exports as well. The parser
draws the calendar glyphs over the date tiles in the status sheet, including
when that sheet has an artwork replacement.

## Game CG

Use **Update Project from Source** to add artwork to an existing project.
**Images → tm2 → cg** contains full-screen scene graphics, including backgrounds
and cropped overlays, and indexed TIM artwork such as the concert title card.
Each PNG has the dimensions of the stored drawing. The game positions cropped
drawings on its original canvas.

1. Open **Tools → Tokimeki Memorial 2 → Extract CG and interface PNGs**.
2. Choose an editing folder and click **Extract PNGs**. The parser copies the
   originals and uses that folder for replacements. Existing PNGs are kept.
3. Edit the matching PNGs in that folder or use Image Translator inside the
   project. Keep each filename and image size.
4. Include the edited image entries in **Inject** or **Export**. An all-file build
   includes all edited entries. Modified replacement PNGs take precedence
   over Image Translator edits. The parser updates every matching
   copy of an included image in the project's discs.

CG and TIM colors are mapped to the original palette. Compressed CG replacements
must fit the original byte allocation. If a replacement exceeds that space,
the error identifies the PNG and its capacity. Movies and character sprite
assemblies have separate formats.

## Export

Export to a folder, ZIP, or use **Inject** to build a separate disc set. Open
the generated `Tokimeki Memorial 2.m3u` in an emulator that supports playlists,
or open an individual CUE. Discs with no edits or enabled patches are copied byte-for-byte. If the
originals move, select the new folder in **Inject** for that build.
