# Working on the Tokimeki Memorial 2 parser

Read the [format and evidence worksheet](plan/README.md) for the source profile,
container routing, and verification results. Use the repository's console
parser router for the phase that needs further investigation.

- Keep the Translator++ UI in `tm2Psx.js` and portable project/disc routing in
  `tm2Psx.module.js`. Keep raw formats separate from the app and font rasterizer.
- Resolve every output from the verified original discs and their staged
  occurrence data. Preserve the original images, exact scene contexts,
  ordered controls, and unedited texture indices.
- The English patch is a format reference. Keep retail extracts, reference
  code and artwork, and emulation artifacts out of the add-on.
- Run `node --test www/addons/tm2Psx/test/tm2Psx.module.test.js` from the
  repository root.
