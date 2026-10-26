# Live TV for TizenBrew

Live TV with a program guide, free movies and TV, for Samsung Smart TVs, as a
[TizenBrew](https://github.com/reisxd/TizenBrew) app module.

## Add it to your TV

1. Install TizenBrew on the TV (see [TizenBrew Installer](https://github.com/reisxd/TizenBrewInstaller)).
2. Open TizenBrew and press the **green** button to open the Module Manager.
3. Add a GitHub module: `maskeralexander-byte/livetv-tizenbrew@main`.

**Live TV** then appears in TizenBrew. Changes pushed to `main` reach the TV the next time TizenBrew loads the module.

## Remote

- **Browse:** ▲▼ move, OK plays, ◀ opens the menu (All channels, Favorites, Recently watched, Free to watch,
  Search the web and 16 categories), ▶ (or yellow) adds/removes a favorite. Each channel shows what's on
  now and next.
- **Watching TV:** ▲▼ or CH+/CH− change channel, number keys jump to a channel, BACK returns to the list.
  A channel with backup feeds switches to the next one on its own when a feed fails; ◀▶ switch by hand
  and YELLOW favorites it.
- **Playback:** each stream is tried with the TV's own video player, then hls.js, then Samsung's AVPlay.
  The banner says which one is playing; BLUE switches to the next if the picture stays black. When none
  can play a stream, the message says what each one reported.
- **Free to watch:** public domain films and TV from the Internet Archive. ◀▶ pick a category, ▼ the list,
  OK opens a title (Play, Resume, or its episodes). While it plays: OK pauses, ◀ back 10 s, ▶ ahead 30 s.
  Continue Watching holds what you left part way.
- **Search the web:** search a title, pick it (choose season and episode for shows) and press OK on Play.
  ◀▶ or CH+/CH− switch to the next source if one doesn't work. BACK exits.

The app files are in `app/`. They are built from the Live TV Android project (`./gradlew tizenbrewModule`).

## TV guide

`tools/build_guide.py` builds `guide.json`, what's on now and for the next 24 hours on each channel, from
free XMLTV guides: [iptv-epg.org](https://iptv-epg.org/guides) (matched by channel id, including local
stations), Pluto TV, Samsung TV Plus, Plex, The Roku Channel and PBS (from i.mjh.nz), and epgshare01. The
**Guide** workflow (`.github/workflows/guide.yml`) runs it every 6 hours and publishes the result on the
`guide` branch, which keeps a single commit. The Live TV phone and Roku apps download it from
`https://raw.githubusercontent.com/maskeralexander-byte/livetv-tizenbrew/guide/guide.json`, and fall back to
reading the Pluto TV and Samsung TV Plus guides themselves when it's missing or more than 18 hours old.
To refresh it right away, run the workflow from the **Actions** tab.
