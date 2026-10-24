# Live TV for TizenBrew

Live TV and Movies & Shows for Samsung Smart TVs, as a [TizenBrew](https://github.com/reisxd/TizenBrew) app module.

## Add it to your TV

1. Install TizenBrew on the TV (see [TizenBrew Installer](https://github.com/reisxd/TizenBrewInstaller)).
2. Open TizenBrew and press the **green** button to open the Module Manager.
3. Add a GitHub module: `maskeralexander-byte/livetv-tizenbrew@main`.

**Live TV** then appears in TizenBrew. Changes pushed to `main` reach the TV the next time TizenBrew loads the module.

## Remote

- **Browse:** ▲▼ move, OK plays, ◀ opens the menu, ▶ (or yellow) adds/removes a favorite.
- **Watching TV:** ▲▼ or CH+/CH− change channel, number keys jump to a channel, BACK returns to the list.
- **Movies & Shows:** search a title, pick it (choose season and episode for shows) and press OK on Play.
  ◀▶ or CH+/CH− switch to the next source if one doesn't work. BACK exits.

The app files are in `app/`. They are built from the Live TV Android project (`./gradlew tizenbrewModule`).

## TV guide

`tools/build_guide.py` builds `guide.json`, what's on now and for the next 16 hours on each channel, from
free XMLTV guides (Pluto TV, Samsung TV Plus, Plex, The Roku Channel, PBS and epgshare01). The **Guide**
workflow (`.github/workflows/guide.yml`) runs it every 3 hours and publishes the result on the `guide`
branch, which keeps a single commit. The Live TV phone and Roku apps download it from
`https://raw.githubusercontent.com/maskeralexander-byte/livetv-tizenbrew/guide/guide.json`, and fall back to
reading the Pluto TV and Samsung TV Plus guides themselves when it's missing or more than 12 hours old.
To refresh it right away, run the workflow from the **Actions** tab.
