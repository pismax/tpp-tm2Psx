# Working on the Tokimeki Memorial 2 parser

Read the [format and evidence worksheet](plan/README.md) for the source profile,
container routing, and verification results before changing a format.

- Keep the Translator++ UI in `tm2Psx.js` and portable project/disc routing in
  `tm2Psx.module.js`. Keep raw formats separate from the app and font rasterizer.
- Resolve every output from the verified original discs and their staged
  occurrence data. Preserve the original images, exact scene contexts,
  ordered controls, and unedited texture indices.
- The English patch is a format reference. Keep retail extracts, reference
  code and artwork, and emulation artifacts out of the add-on.
- Run `node --test www/addons/tm2Psx/test/tm2Psx.module.test.js` from the
  Translator++ root.

## Repository and releases

This folder is its own git repository,
[pismax/tpp-tm2Psx](https://github.com/pismax/tpp-tm2Psx), cloned at
`<Translator++>/www/addons/tm2Psx` so the app loads it and the tests can require
`www/js/...`. Commit here as `pismax <360907843+pismax@users.noreply.github.com>`
(set in this clone's git config). Never commit these files to the Translator++
repository, and never add other identities, emails or local paths.

To release:

1. Bump `version` in `package.json` (and the top-level and root-package
   versions in `package-lock.json` when present). Raise `minimumVersion` when
   the code needs a newer Translator++.
2. Describe the user-facing change under a new version heading in
   `CHANGELOG.md`.
3. Run the tests above, commit, then `git tag v<version>` and
   `git push origin main v<version>`. Never move a published tag.
4. In the catalog repository [pismax/tpp-addons](https://github.com/pismax/tpp-addons),
   set this add-on's `ref` to the new tag, update its README table, run
   `node scripts/validate-catalog.js`, and push. Translator++ offers the update
   within a few minutes.
