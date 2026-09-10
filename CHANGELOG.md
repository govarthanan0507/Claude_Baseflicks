# Changelog

## 1.0.2

Align TMDB artwork selection with Jellyfin's behaviour
(`jellyfin/jellyfin` `MediaBrowser.Providers/Plugins/Tmdb`):

- Backdrops are now **textless only**. Jellyfin never uses a backdrop that
  has a language/title card baked in (it reclassifies those as "Thumb"
  images); our details page draws its own logo/title over the banner, so
  it wants a clean plate too. This is the real cause of the
  foreign-language banner — `backdrops[0]` / `backdrops[1]` were used
  regardless of language.
- Image request now sends `include_image_language=en,null`, matching
  `TmdbUtils.GetImageLanguagesParam` (textless originals + English only).
- Logo selection prefers the English title treatment, then a textless
  one, mirroring Jellyfin's `OrderByLanguageDescending` for an "en"
  library.
- A re-identify / re-populate now **replaces** stored artwork instead of
  keeping whatever was fetched first (`COALESCE`), so switching to the
  corrected image actually takes effect. If the TMDB images call fails,
  existing artwork is left untouched (`metadata.imagesOk` gate).
- `apply-tmdb-match` now reuses `writeMetadataToVideo` instead of a
  third copy of the persistence SQL.

## 1.0.1

- Backdrop/landscape artwork from TMDB now prefers textless images, then
  English ones, over other languages. Previously the first backdrop in
  TMDB's list was used regardless of language, so titles like Central
  Intelligence showed a foreign-language title card (e.g. Portuguese
  "CENTRAL DE INTELIGÊNCIA") as the details-page banner.
