# SheetJS CE 0.20.3

Pinned official archive: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
SHA-256: 8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
License: Apache-2.0, unchanged from 0.18.5. See SHEETJS-LICENSE.txt.

Installed through file:vendor/xlsx-0.20.3.tgz; commit the archive with package.json and package-lock.json. Do not regenerate from the stale npm xlsx package. No upstream source modifications.

Reviewed seven existing workbook files (two unique contents). Old/new complete cell read semantics, frontend previews, backend parsing, mappings and exported OOXML parts matched. Export checks include zero scores and Unicode text, preserving untouched archive parts and source hashes. Existing grade calculations and assessment weights are unchanged. Compatibility evidence is limited to these reviewed templates and automated synthetic workflows.
