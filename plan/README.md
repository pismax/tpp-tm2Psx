# Tokimeki Memorial 2 disc format and evidence

## Source profile

PlayStation, Japan Rev 1. Detection checks Mode 2 Form 1 sectors, the ISO 9660
volume and root directory, `CDPACK00.BIN`, and the expected PS-X EXE.
Extraction and export match each complete BIN against the following profile.
Accept one or more single-track CUE or raw Mode 2/2352 BIN files, or a directory
with one copy of each disc in scope. A folder supplied through Inject can replace the
original paths for one export if all required discs match.

| Disc | PlayStation serial | Physical bytes | SHA-256 |
|---|---|---:|---|
| 1 | SLPM-86355 | 692447616 | c76b7878614d86cc0bb8fe58024b4d88617a7ecba0097957e6a2c646be078f83 |
| 2 | SLPM-86356 | 739793376 | d2f781f02455281b72a9e011fbf2bb2766cb01ce272affc43594cc5ae9018896 |
| 3 | SLPM-86357 | 747917184 | f462874d3d6af7c081218a75ab12ccae4eaaf9664cd8bc9e8cd2516edd06e68f |
| 4 | SLPM-86358 | 745115952 | 63e379cf2fa7564110a6ae306f4adf49ad049e4cf12a9bf0a1e921e5c100bd93 |
| 5 | SLPM-86359 | 743427216 | fac09425db4795f85d3cabd72459423a99963e33d32274786b371ee94d07def9 |

The local English patch project at commit
`053ec837c0dc51299f01185d0b5285a3359246ab` helped identify the formats.
Its `docs/game-internals.md` sections 2, 4–6, 10, 13, and 15 describe the
layout. The add-on reads and writes the format directly.

## Format and addresses

| Layer | Address and write rules |
|---|---|
| Raw CD | Physical offset = LBA × 2352. Logical data uses 2048 bytes at physical offset 24 within each sector. Changed and appended sectors must be Mode 2 Form 1 with valid EDC/ECC. |
| Script | Magic `38 35 00 00`. Scene starts are logical disc offsets. String offsets identify reachable opcodes inside a scene. Relative signed 16-bit jumps are remapped after string changes. |
| Script containers | Sector-aligned files, bundles with part sizes, packs with byte offsets, scene variant groups and overlays. Known groups and overlays can relocate within their measured loader capacity. Packed blocks with unknown owners retain their original extent. |
| Menus and place names | CP932, null-terminated or padded fixed fields. Scene place records carry a cell count. E.V.S. text bytes are stored with a +0x64 transform. Known name pools may repack with their pointers and address instructions updated. |
| Interface art | 4-bit palette indices, two pixels per byte. Packet/bare lz1 streams and lz2 image records. Rewrites keep the existing compressed space and metadata, and update every known matching copy of a selected sheet. |
| Scene CG | Sector-aligned `0x0000BC35` records in CDPACK. The 512 × 232 canvas uses the 8-bit rectangle at offset 88, with a 256-entry RGB555 palette at offset 512. The compressed stream starts at offset 1024. The word at offset 12 stores the total record length. |
| TIM artwork | Aligned PS1 TIM files with one indexed palette. The writer overwrites the fixed-size image pixel block and preserves the CLUT and both TIM block headers. |

The CG stream uses low-bit-first flags, with the next flag byte fetched before
the eighth token's payload. A zero flag encodes a literal. A one flag encodes
a little-endian word whose low 12 bits contain the distance minus one. The
high nibble encodes the length minus two. A high nibble of 15 takes an extra
length byte plus 17. The decoder must fill the stored rectangle and consume
the stream exactly. Writes retain the palette and the rectangle metadata,
update the recorded length, and fit the original compressed allocation.

See [Lossless bundle recompression](lossless-bundle-recompression.md) for the
packet layout and verification used to make room for longer opening dialogue.

## Text and speakers

The main engine appends the honorifics in `ENGINE.json` as NUL-terminated
strings. `さん` and `ちゃん` share `0x800C1424–0x800C1433`, and `君` and `くん`
share `0x800C1458–0x800C1463`. Repacking keeps each pair within its original
range and updates the engine's address operands. For `君`, both native
references at `0x800E327C` and `0x800E3330` resolve to the four encoded bytes
for `-kun` and its terminator on all five Rev 1 discs. The adjacent dispatch
table and the pronouns copied by fixed-length routines retain their fields.

- Script text uses nibble-swapped CP932 and bytecode string terminators.
  Narrow Latin letter pairs and extra glyphs use otherwise unused codes.
  An unpaired narrow character uses the left half of a pair with a blank
  right half. This keeps odd-length names and line endings in the same font.
  A guarded detour at `0x8001C5C0` dispatches those codes to the font table or
  pair composer. The ISO directory points to an extended boot executable
  whose startup code copies the font above the reserved stack limit at
  `0x801FEF00`. The retail heap ceiling follows the adjusted stack limit.
  The zero-filled area at `0x800654E8` holds live SDK interrupt state and
  stays intact. Other glyph lookups retain their original behavior.
- Validate line breaks, ordered controls and the encoded 256-byte expander
  ceiling before writing. Export checks script capacity and reports dialogue
  strings estimated to exceed 20 cells.
- The main engine's special character-name cases for Takumi and Jun at
  `0x800E2F14` and `0x800E2F54` copy only three bytes, which fits the
  original single-character names and their terminators. A packed English
  name can exceed this and leave the previous name's tail in the shared
  buffer at `0x8011B370`. When the engine name pool is repacked, both cases
  use the game's string-copy routine at `0x8005A074` instead. The source
  addresses remain subject to the pool's normal relocation.
- Speaker labels come from opcode `0x18`. Propagate identical labels across
  branches. Clear state at message boundaries and when crossing unmodeled
  subroutine effects. Leave conflicting inputs unknown. Player-name slots are
  recorded as runtime labels. Actor Reference starts with the detected literal
  labels and, when present, the player role. `actor-info.json` supplies gender,
  role, and concise voice guidance in the style of the TM4 project sample.
  The notes use the original
  dialogue, including `G_TELG` for the returning cast's recorded greetings,
  `YG_07504` for Robo's barks, and `G000013` for Maeka's delivery-worker label.
  The [Konami series portal](https://www.konami.com/games/tokimeki/prize/)
  and [original game cast](https://www.konami.com/games/tokimeki/1r/) corroborate
  character names. The [Dengeki retrospective](https://dengekionline.com/elem/000/000/951/951039/)
  corroborates the Shirayuki sisters' shared presentation. Speaker strings
  remain independently translatable.
- In Rev 1, the first operand of voice opcode `0x1F` identifies Miho as
  `0x06` and Maho as `0x0B`. Both identify themselves in `G336000`
  (block `f538923a`, offsets 3940 and 3966), and both IDs occur in
  `G132000-248644a1`. Attribute voiced dialogue per occurrence. The EVS
  name cue `0x1E` can use Miho's ID before Maho speaks. Leave unvoiced or
  conflicting paths unresolved. Shared rows retain both occurrence identities
  and use the neutral Shirayuki reference for a single default translation.
- Rev 1 scripts open a choice list with `0x20` or `0x21` and finish it with
  `0x26` and `0x27`. `G018000-8c9d3035` starts its three options at
  offset 876 and branches on the selected index. The same commands surround
  the unquoted Yes/No in `YG_02506-2a7201b4`. Follow the choice state across
  branches, preserve the original display slots, and set `messageType` to
  `choice`. Choice contexts use `/choice/<offset>`. Export accepts their
  legacy `/message/<offset>` paths, and a source update carries over
  translations keyed to the legacy paths. All 4,915 unique staged blocks
  kept their original source rows and offsets after choice detection.
- Nameplate opcode `0x18` uses a three-cell display field. The nameplate
  `Hinomoto` takes four packed cells and overlaps the dialogue bracket.
  `Hikari` takes three. English defaults also respect fixed script byte
  budgets where nameplates cannot grow. The literal nameplate check uses the
  encoded glyph width before moving any script pointers.
- Shirayuki nameplates trace the ordinary voice cues along the paths that
  display the page. A visible path with no matching cue or conflicting twin
  cues keeps the shared fallback. Both English given names fit the two-cell
  allocation of the original surname.
- File IDs use scene IDs or menu modules. Occurrences identify the disc,
  original block or record, and byte offset. Duplicate display text merges to a
  Translator++ row while retaining every occurrence and its metadata.
- A dialogue row groups display opcodes up to the next wait, clear, or
  control-flow boundary. Both engine variants use the same handler for
  `0x10` and `0x11`, with bit 0 passed as a render flag. Standard boxes are
  rebuilt with one display instruction per output line. Injection reports
  estimated overflow beyond the four-row layout as a warning. Interleaved
  events, interior render flags, and branches
  within a page keep their native display slots. Old line contexts are matched
  by their original scene offsets when updating a project.
- The startup module holds the three-line memory-card check at LBA 543 + 24
  (88 bytes) and the one-line system-file skip message at LBA 543 + 112
  (36 bytes) on all five discs. Disc 1 also stores the check at LBA 63825
  + 744. These null-terminated CP932 fields use LF separators. The startup
  slot labels at LBA 543 + 148 and + 160 (12 bytes each) precede the
  shared two-line success message at + 172 (56 bytes). These bytes match
  on all five original discs. Each field retains its own terminator and
  allocation. The startup module passes the primary messages at `0x800C0018` and `0x800C0070` to
  `0x8001CF8C`. Both primary fields share the same sector. The warning's
  existing contexts are unchanged.
- Startup Latin pairs use a separate trail-byte range. The font lookup
  selects a five-pixel bitmap per half for calls from the 10-pixel renderer
  at `0x8001CB18`. The renderer samples different foreground bits on
  the left and right, so the composer shifts two columns on the right.
  The 16-pixel renderer uses the eight-pixel alphabet. The small
  alphabet sits below the existing font reservation, and the Disc 1 name
  routines keep their fixed address.
- Disc 1's name-entry module starts at LBA 2038 and loads at `0x800C0000`.
  The surname and given name each use a seven-byte field at
  `0x800F97B0` and `0x800F97B7` during entry. The Symbols table at
  `0x800C0500` keeps all 453 keys with the 52 alphabet keys moved first.
  Hooks at `0x800C8804` and `0x800C8644` pack the letters and delete one
  letter at a time. Three two-byte cells and a terminator still fit in each
  field. The added routines use 512 bytes reserved beneath the existing
  font area on Disc 1. All exported discs use the same pair codes and
  font address. The E.V.S. reading fields continue to take kana.
- Executable menu extraction is limited to the verified Rev 1 text fields
  at `0x8006C7CC–0x8006C7D3` and `0x8006C974–0x8006C9FB`. The older
  scanner exposed the low bytes of the calls at `0x8003E158` and
  `0x8003E368` as `偸` and `尾`. Legacy staged descriptors can still
  contain these entries, so export skips them even before a project refresh.
- Option overlay instructions at `0x80144F20` and `0x8014507C` resemble
  the text 貯, but changing them corrupts the Option Room. Exclude both from
  extraction and legacy exports. The background selector indexes the five
  cells in each of `ＡＢＣＤＥ` and `ＦＧＨＩＪ` separately, so their
  translations use one native-width glyph per choice rather than Latin pairs.
- Option Room values at `0x8013DEDC`, `0x8013DEE4`, `0x8013DEF0`, and
  `0x8013DEFC` display two, four, four, and six cells respectively. Disc 5
  screenshots show garbage after shorter translations of these entries; pad
  them with composed blank Latin-pair cells and limit each translation to its
  drawn width. Version 0.1.43 used native `8140` spaces and still drew garbage.
  A cold-boot Disc 5 probe replacing those padding cells with `A140` showed
  clean Stereo, Mono, Mouse-like and On values in DuckStation 0.1-12777.
  On Disc 1, overlay 3 aliases the Option Room resource first, so it must use
  the same width and selector rules as overlay 5 on Discs 2–5.
  The mouse-hand choices at `0x8013DF1C` and `0x8013DF24` each draw three
  cells; Disc 1 displayed garbage after the shorter English label “Left.”
  A fresh DuckStation 0.1-12777 boot of the version 0.1.45 Disc 1 export
  displayed Right and Left without stray glyphs. The tested BIN SHA-256 was
  `ee755cc3e2f0c077c35d288e700acbaeebcb56931b6748d7a81a457fabe4b80c`.
- The disc-change controller reads the selected label from the table at
  `0x80011088` and appends the string at `0x800159A8` before rendering at
  `0x8001CF8C`. On all five discs the suffix uses a 28-byte field at
  LBA 25 + 424. Keep its `08 37` color reset, the null terminator, and the
  runtime disc label. Use the small-renderer Latin codes for this field.
- The disc-check box uses the 64-byte field at LBA 25 + 144 (RAM `0x80015890`)
  on all five discs. Its two CP932 lines start with `08 33` and `08 37`, with
  LF between them. Preserve both color controls and the next record at +208.
  It uses the same small-renderer Latin codes as the disc-change suffix.
- File Select Room's colored Continue box is the 48-byte field at overlay 6
  + `0x984` (RAM `0x8013E6D4`). Entry 23 of the table at `0x8014C104`
  points to the field. The overlay draws it with the 16-pixel glyph routine.
  Keep LF, `08 35` before ○, `08 37` after ○, `08 33` before ×, and the
  null terminator. One `OV6` row also covers the four Disc 1 copies at
  LBA 2042 + 996, 63826 + 216, 134899 + 1716, and 1505 + 1805. The last
  copy uses the E.V.S. `+0x64` transform.
- Disc 1's childhood map stores eight CP932 messages in 132-byte records.
  The first string starts at LBA 35330 + 1456. The writer caps its writable
  span to 124 bytes per record, including the terminator, to preserve the
  mode bytes and the data following the final message.
- Disc 2's `00256a.sx` sets the nameplate from the saved player surname at
  `0x80075004` and queues the intro text through `0x800EC9A0`. LBA 266524
  + 8 and +24 form the first line, +44 completes the second line, and +68
  fills a new textbox. The 16-, 8-, and 24-byte fields hold 7, 3, and 11
  encoded glyph cells after reserving the terminator. Import two Dialogue
  rows with the runtime `MC` speaker. The writer splits the first line
  at a glyph boundary and retains the quote, ellipses, and cue calls. Source
  updates join drafts from the old `Menus/DISC2-INTRO.json` fields by context.
- Disc 1's childhood map reads 23 fixed 20-byte records at LBA 35335 + 1120
  (RAM `0x800EBC60`). There are 22 location labels and a blank slot. Each
  record contains nine CP932 glyph cells plus a two-byte terminator.
- The childhood speaker renderer passes the fixed `「` glyph at RAM
  `0x800C021C` to the text drawing routine. Its row in `Menus/CHILD.json`
  is tagged red for translator review.
- The two childhood HUD layouts start at RAM `0x800EBA80` and
  `0x800EBB70`. The native date renderer reads the weekday from the
  4-bit atlas at VRAM (896,384). The retail lz2 stream starts at LBA 35516
  + 308, inside a scene bundle. Apply the atlas edit before repacking that
  bundle. English builds use the seven English weekday tiles and draw the
  numeric month and day with the original game code.

## Host integration and verification

Save disc identities and image paths with the project.
Stage compact text descriptors and original PNGs. All three game export paths
write a private partial disc set, then publish it with CUEs, M3U and a report.
The path chosen for Inject is used only as the original input for that build.
The actor reference and compatible image layers carry over on Update.

| Check | Result |
|---|---|
| Synthetic fixtures | Node tests cover duplicate/context translations, speaker metadata, invalid input, image codecs, font codes and worker loading. |
| Retail scan | Five discs yielded 134 text resources, 140,576 script text occurrences and 27,922 menu/place occurrences. Found 70 distinct literal speaker labels and ten indexed sheets at 46 locations. |
| Actor Reference | A fresh scan of all five discs produces 71 rows, including the runtime player. Version 0.1.12 uses shorter notes and upgrades exact stock descriptions from 0.1.10 and 0.1.11. A modified stock note is treated as a custom note. |
| Retail BIN patch | The standalone writer changed a context-specific line and a bare lz1 name-entry texture on Disc 1. Discs 3–5 in the same set matched the original SHA-256 values. |
| Additional native formats | Disc 2 export changed a fixed menu field, a pointer-backed name table, two title-menu lz1 packets and two copies of an lz2 status sheet. All written sectors passed EDC/ECC verification. |
| Live Translator++ | After restarting into version 0.1.2, created a Disc 1 project using only its CUE. Verified its 41 text resources and nine available texture sheets, wrote an edit in the grid, and exported it with the standalone writer. The earlier integration tests also exercised save/reopen, ZIP export, Inject, and Update. |
| CG and TIM artwork | Version 0.1.31 scanned all five retail discs and extracted 1,273 distinct CGs and 17 TIM images from 5,507 locations. The classroom and house CGs matched Disc 1 DuckStation VRAM byte-for-byte. A rebuilt classroom CG and TIM re-extracted to the edited pixels. Live Inject applied a selected house CG to both copies at LBAs 33848 and 49176. Only the 54 CG sectors changed, with valid EDC/ECC. An all-file Inject applied all four edited copies. |
| Source pickers | In version 0.1.3, verified that the folder button requests a directory and that the BIN/CUE button opens a multiple-file input. The live wizard received the native file list and created a project from only Discs 2 and 5. Folder discovery located all five discs. |
| Project preflight | In version 0.1.5, the NW.js wizard confirmed all five discs for the full folder, warned for Disc 2 alone, respected Cancel and Continue, and blocked an invalid path. An older result did not replace the status after a rapid source change. |
| Text box round trip | In version 0.1.4, Disc 1's `YG_01503` sample imports as one row with speaker 麻生. Re-extraction from rebuilt BINs recovered one- and four-line translations. A five-line translation was rejected. NW.js checks confirmed the four-line row policy, migration of the original two translation cells, and Actor Reference under `*`. |
| Font and boot | In version 0.1.7, a font-only build reproduced the boot freeze. The repaired Disc 1 retained the exact translated `YG_01503` bundle bytes, played the opening in DuckStation, and reached the title screen in ePSXe 2.0.18. MIPS checks exercised the boot-time font copy, native lookup, and rendering of generated glyphs and Latin pairs. |
| Odd-length Latin text | In version 0.1.8, rebuilt the user's `YG_01503` translation. The speaker opcode stores `As` followed by a narrow `o` with a blank right half. The native renderer produced the same pixels for `As` and drew the new `o` and `?` in the left half of their tiles. |
| Startup memory-card warning | In version 0.1.9, found the primary field on all five originals and the extra copy on Disc 1. Exporting a three-line Disc 1 sample changed exactly two sectors with valid checksums. A fresh DuckStation boot showed all three translated lines. |
| Half-width startup messages | Version 0.1.28 refreshed and exported the five-disc English project in NW.js. All six startup sectors passed EDC/ECC checks. Unicorn rendered the exported strings with both native renderers on every disc and confirmed that both halves of the compact pairs were drawn. The Latin name-entry regression checks also passed. DuckStation 0.1.12777 cold-booted Disc 1 to the title screen. |
| Disc changes and introductory dialogue | Version 0.1.29 scanned all five retail discs and exported a separate set with a test disc prompt, candy-shop thought, and all four intro fragments. Re-reading the BINs verified the prompt in each relocated boot executable and preserved the adjacent childhood data and intro cues. Unicorn exercised the native 10- and 16-pixel glyph routines with the exported Latin pairs. The scenes have not been played through in DuckStation. |
| Disc-check box and grouped Disc 2 intro | In version 0.1.32, a retail scan found the check message on all five discs and extracted two Dialogue rows with the `MC` header. An unchanged Disc 2 build matched the retail SHA-256. The Disc 1 and 2 test exports kept both color controls and the surrounding bytes. Unicorn verified the small-font disc-check glyphs and the complete native intro queue. DuckStation 0.1-12777 booted the rebuilt Disc 1, then displayed both translated intro boxes and the saved surname after inserting the rebuilt Disc 2 from an isolated pre-swap save. |
| File Select Room Continue prompt | Version 0.1.33 imported nine occurrences as one row and exported the English text to all five discs. Re-reading the affected sectors recovered the translated text, original color codes, and correct EDC/ECC. Bytes outside the fields matched the originals. The untouched Disc 2 export matched the retail SHA-256. Unicorn drew the sample Latin glyphs with the native 16-pixel renderer. DuckStation 0.1-12777 cold-booted the rebuilt Disc 2 to the title screen. |
| MCP build and occurrence reporting | Version 0.1.30 reports the published build directory, playlist, and disc report. A read-only comparison of `scene-G034000` matched all 935 staged writer edits. The numbered build fixture verified the artifact paths. [Implementation and checks](../../../../plan/mcp-injection-and-occurrence-reporting.md). |
| Childhood voice playback | In version 0.1.23, a retail scan kept all 80 legitimate executable-menu occurrences and excluded both false entries on each disc. The full and scene-only exports had identical `YG_01503` bundles. Restoring the two calls in the full set let the user advance from an earlier save to Kasumi's “Are you okay?” in DuckStation. |
| Compiled module | Loaded the release-compiled module in NW.js 0.60.0 and detected the retail disc folder through it. |
| Childhood map HUD | Version 0.1.24 reimported 22 map labels from Rev 1. An export with YGROUP00 dialogue repacked the bundle. Re-extraction recovered the translated location field and the 1,799-byte English atlas at LBA 35515 + 276. A fresh DuckStation boot of the full build displayed the English date on the childhood map. |
| Longer opening childhood dialogue | Version 0.1.35 exported `YG_02506-2a7201b4` at its original LBA 35550. The last LZ2 graphics payload shrank from 1,542 to 1,445 bytes and freed 96 bytes after alignment. Live Inject grew the scene from 549 to 581 bytes. Re-reading the output verified the translated script, byte-identical decoded graphics, the untouched companion sector, and valid EDC/ECC for all ten bundle sectors. A fresh DuckStation 0.1-12777 boot through New Game displayed Hikari's full two-line translation, the expanded nickname, and the classroom art. |
| YGROUP01 pack ownership | Version 0.1.38 recognizes the two-part bundle at LBA 35336 after skipping a header-shaped region at LBA 35338. The script pack at `0x045067CC` has 16 script offsets and an additional offset to `m0100.sx`. The same sound-table layout appears in `YGROUP00` through `YGROUP04`. A standalone NW.js export with the current `YGROUP01` translations wrote all 16 scripts, including the 156-byte `YGROUP01-273c3bbb`. Re-reading the output verified the updated sound-table offset, all 1,024 original sound-table bytes, the adjacent `YGROUP00` sector, and valid EDC/ECC. |
| Latin name entry | Version 0.1.27 exported the five-disc English project through the NW.js folder writer. Extraction found all 453 symbol keys, and Unicorn verified 48,000 input edits and all 52 Latin glyphs in both halves on every disc. DuckStation 0.1.12777 cold-booted the build, showed Latin input on the Symbols page, and displayed the entered given name in Hikari's childhood dialogue. |
| Friend-name substitution | Version 0.1.40 guards and patches the original routines on all five Rev 1 engine modules. Unicorn ran both special cases with short and longer packed names and a pre-filled destination, verifying the complete name, terminator and return pointer. A real-pool repack on each disc also relocated Jun and copied the complete packed result. The affected hallway scene has not yet been replayed in-game. |
| Interface art coverage | Ten editable sheets. The sports-day instruction boards, full-screen stills and movies remain outside the catalog. |
