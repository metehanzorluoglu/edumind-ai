# Vendored CSL style/locale files

Milestone 4.2 (Citation & BibTeX Foundation).

These three files are unmodified downloads from the official
[Citation Style Language](https://citationstyles.org/) repositories:

- `apa.csl` — <https://github.com/citation-style-language/styles/blob/master/apa.csl>
  (APA 7th edition)
- `ieee.csl` — <https://github.com/citation-style-language/styles/blob/master/ieee.csl>
- `locales-en-US.xml` — <https://github.com/citation-style-language/locales/blob/master/locales-en-US.xml>
  (term/date-format strings the two styles above reference, e.g. "and", "no.", "ed.")

Both repositories are published under a Creative Commons
Attribution-ShareAlike license by the CSL project and are the same
canonical style definitions consumed by Zotero, Mendeley, and every other
CSL-aware citation tool — vendoring them (rather than hand-rolling APA/IEEE
punctuation rules) is the whole point of using `citeproc-py` as the
citation engine (see `app/core/citation_formatting.py`).

Do not hand-edit these files. To pick up upstream corrections, re-download
the same three URLs and replace them wholesale — never patch them in
place, or a future re-download would silently discard the patch.

Adding a third style later (Milestone 4.2 explicitly scoped this to APA 7
+ IEEE only) is "essentially free" with this engine: download the style's
`.csl` file into this directory and add it to `_STYLE_FILES` in
`citation_formatting.py`.
