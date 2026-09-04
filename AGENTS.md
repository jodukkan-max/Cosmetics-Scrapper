# Standards & Guidance for AI work on this project

These rules apply to every task in this repo. Follow them unless the user explicitly says otherwise.

## 1. Canonical file locations — never change them

Deliverables have ONE fixed location and name. Do not rename, re-folder, or "improve" them:

- Android APK → `/Users/indiana/Desktop/Universal-Scrapper.apk`
- WordPress plugin zip → `/Users/indiana/Desktop/rey-swatches-import.zip`

Once a path/name is established, keep it forever. If you told the user "the file is at X",
the next turn must ALSO point to X — never switch to a different folder or filename.

## 2. Always finish the "final moves"

Code that works but isn't delivered is not done. When a deliverable is expected, do the full
chain: build → verify → copy to the canonical location → tell the user. Never stop at "the code
is fixed" without producing the artifact (APK, zip, pushed release, tag, etc.).

## 3. Verify before claiming done

- Rebuild and actually run/install the artifact before handing it over.
- If the user reports an error, reproduce it against the real URL/data before concluding.
- Never hand over a stale build and imply it contains a fix that was made after it was built.

## 4. Product constraints (hard requirements)

- Anonymous only — NO login / sign-up, ever.
- All scraper code is served from Supabase (`scraper_modules` + `predefined/scrapers.js`),
  not bundled.

## 5. Build hygiene (disk space)

The machine runs near 100% disk. After building `mobile/`, free space by removing
`mobile/build/app/intermediates/` while keeping `build/app/outputs/flutter-apk/app-release.apk`.

## 6. Repos

- Main: `github.com/jodukkan-max/Cosmetics-Scrapper` (`/Users/indiana/Cursor/product-scraper Extension/`)
- Plugin: `github.com/jodukkan-max/universal-import` ("Universal Import")
