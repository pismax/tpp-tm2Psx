# Making room for dialogue with lossless graphics recompression

The Disc 1 opening scene, `YG_02506-2a7201b4` (`/Dialogue/scene-YG_02506.json`),
stores its script and graphics in a single bundle. A smaller compressed
graphics part lets the script use more of the same allocation. The exporter
keeps the bundle at its original disc address, and the game decompresses
exactly the same graphics bytes.

## Measured allocation

On the Japanese Rev 1 disc, the bundle starts at LBA 35550 (logical offset
`0x0456F000`) and occupies ten 2,048-byte sectors. The next sector, LBA 35560,
starts a companion resource with the ASCII scene ID. The bundle starts with a
little-endian `u32` part count and one `u32` size per part, followed by the
parts in order.

| Part | Original bytes | Longer test build |
|---|---:|---:|
| Bundle header | 20 | 20 |
| Scene script, aligned to four bytes | 552 | 584 |
| Small scene data table | 36 | 36 |
| First graphics part | 13,516 | 13,516 |
| Last graphics part | 6,352 | 6,256 |
| **Total used** | **20,476** | **20,412** |
| **Free within the 20,480-byte allocation** | **4** | **68** |

The script itself grew from 549 to 581 bytes. Without recompression, the same
edit would require 20,508 bytes, exceeding the bundle by 28 bytes. The
recompression reclaimed 96 aligned bytes. The exporter can use that space for
text anywhere in this script. The game's string and display limits still apply.

## Rebuild the last graphics packet

The implementation is `compactOpeningGraphics` in [`layout.js`](../layout.js).
`repackBundle` calls it after rebuilding the edited script, and only if the
bundle overflows. The path is scoped to LBA 35550, the four-part layout, and the
verified opening scene key. It also checks the SHA-256 of the planned graphics
part against the measured original. If the part differs, the writer leaves it
as supplied and applies its normal capacity check.

The offsets below are relative to the start of the last graphics part. The
offset table at `0x98` points to a 32-byte transfer descriptor. The descriptor
has type `0x204`. Its `+4` field holds the compressed byte count and its `+8`
field points back to the payload.

| Field | Original | Recompressed |
|---|---:|---:|
| Payload start | `0x12A8` | `0x12A8` |
| Compressed payload length | 1,542 bytes | 1,445 bytes |
| Aligned payload space | 1,544 bytes | 1,448 bytes |
| Descriptor offset stored at `0x98` | `0x18B0` | `0x1850` |

1. Decode the original LZ2 stream with [`textures.js`](../textures.js). The
   output must be exactly 16,384 bytes, and the decoder must consume the byte
   count recorded in the original descriptor.
2. Encode those bytes with the existing LZ2 encoder, which selects literals and
   back-references based on their encoded cost. Decode the result again,
   require exact stream consumption, and compare all decoded bytes with the
   original. Use the replacement only when it saves space after four-byte
   alignment.
3. Keep the payload start and earlier packets in place. Write the smaller
   stream, pad to four-byte alignment, and move the copied descriptor directly
   after it. Update the descriptor offset at `0x98` and the compressed length
   at descriptor `+4`. Preserve the payload pointer at `+8` and the other
   descriptor bytes.
4. Rebuild the outer bundle with the new part sizes and check its total
   against the original ten-sector allocation. Write through
   [`SectorPlan`](../disc.js), which regenerates the sectors' EDC/ECC.

## Verification and reuse

Translator++ Inject produced a Disc 1 test image with a longer exchange for
Hikari and the player. Re-reading it recovered the expected script bytes,
matched the decompressed graphics byte for byte, and verified valid EDC/ECC
across the ten bundle sectors. The small table, first graphics part, and
companion sector matched the original. A fresh DuckStation 0.1-12777 boot
through New Game displayed Hikari's full two-line message, the expanded
nickname, and the classroom graphics.

For another scene, first establish its loader's allocation, the packet format,
and every reference to the bytes that would move. Verify that the aligned
output fits and that re-decoding produces identical graphics. Compare adjacent
resources and test the edited scene from a fresh boot. The offsets in this
note describe this one Rev 1 bundle. Other bundles may use different packet
layouts, share fewer resources with the script, or yield too little space after
compression.
