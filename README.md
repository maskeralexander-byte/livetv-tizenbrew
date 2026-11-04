# Live TV app releases

The newest Live TV Android app, which the app itself downloads from **Settings → App → Check for
updates**. `version.json` says which version `LiveTV.apk` is; the app installs it when its
`versionCode` is higher than its own. This branch holds only the latest build.

To install by hand, download `LiveTV.apk` on the phone and open it.

`LiveTV.wgt` is the Samsung TV app, to install as its own app (no TizenBrew needed): open TizenBrew
Installer on a PC, connect to the TV, choose **Select file to install** and pick this file. It updates
itself after that.
