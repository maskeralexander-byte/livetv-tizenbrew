#!/usr/bin/env python3
"""Builds guide.json: what's on now and next for the Live TV app's channels.

The TV and phone apps download this one small file instead of several big XMLTV guides, which
the Roku in particular is too slow to read. It's rebuilt every few hours by
.github/workflows/guide.yml. Standard library only.

Listings come from free XMLTV guides:
  * i.mjh.nz: Pluto TV (by channel id), Samsung TV Plus, Plex, The Roku Channel, PBS
  * epgshare01: US cable networks, US local stations (by call sign), UK and Australia

and are matched to iptv-org's English playlist, so each schedule is keyed by the stream URL the
apps play. Name matches only count within the same country and the same time zone feed
(a West Coast feed never gets the East Coast schedule).

guide.json (all times are minutes from "base", a Unix time in seconds):
  {
    "v": 1,
    "base": 1760950000,
    "s": [[[start, length, "title", "episode", "description"], ...], ...],  # schedules
    "p": {"stream url": schedule index},
    "i": {"cnn.us": schedule index},        # by tvg-id, for playlists with other URLs
    "cat": {"pluto channel id": "genre"},
    "add": [{"name": ..., "url": ..., "logo": ..., "cat": ...}]  # Pluto TV US channels
  }
Episode and description are "" when unknown, and descriptions are only kept for the first few
programmes of each channel.
"""
import argparse
import calendar
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

PLAYLIST = "https://iptv-org.github.io/iptv/languages/eng.m3u"
MJH = "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/"
SHARE = "https://epgshare01.online/epgshare01/epg_ripper_"

HOURS = 16          # how far ahead to keep listings
MAX_PROGRAMMES = 14  # per channel
DESCRIBED = 4        # programmes per channel that keep their description
DESC_LEN = 160

PLUTO_RE = re.compile(r"jmp2\.uk/plu-([0-9a-f]{24})|pluto\.tv/.*?/channel/([0-9a-f]{24})|/stitch/hls/channel/([0-9a-f]{24})")
STOP_WORDS = {"hd", "east", "west", "pacific", "mountain", "feed", "the", "channel", "tv",
              "network", "us", "usa", "and", "live"}
# Feed codes that name a country: "Homeful.ca@US" is Homeful's US feed.
FEED_COUNTRIES = {"us": "us", "usa": "us", "uk": "uk", "gb": "uk", "ca": "ca", "au": "au", "in": "in",
                  "india": "in", "ie": "ie", "nz": "nz"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch(url, cache_dir):
    """Returns the body of url (un-gzipped); with cache_dir, reads a saved copy if there is one."""
    name = re.sub(r"[^A-Za-z0-9._-]", "_", url.split("://", 1)[1])
    path = os.path.join(cache_dir, name) if cache_dir else None
    if path and os.path.exists(path):
        data = open(path, "rb").read()
    else:
        req = urllib.request.Request(url, headers={"User-Agent": "LiveTV-guide/1.0", "Accept-Encoding": "gzip"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    data = r.read()
                break
            except Exception as e:  # network hiccup: try again, then give up on this source
                log("  download failed (%s): %s" % (e, url))
                if attempt == 2:
                    return None
                time.sleep(5 * (attempt + 1))
        if path:
            open(path, "wb").write(data)
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data


# ---- Playlist ----

def parse_m3u(text):
    out = []
    info = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF"):
            info = line
        elif line and not line.startswith("#") and info:
            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', info))
            m = re.search(r'"\s*,(.*)$', info) or re.search(r"^#EXTINF:-?\d+[^,]*,(.*)$", info)
            name = m.group(1).strip() if m else attrs.get("tvg-name", "")
            out.append({"url": line, "name": name, "tid": attrs.get("tvg-id", "")})
            info = None
    return out


def tid_parts(tid):
    """'CBSNewsLosAngeles.us@SD' -> ('CBSNewsLosAngeles', 'us', 'SD')."""
    base, _, feed = tid.partition("@")
    name, _, country = base.partition(".")
    return name, country.lower(), feed


# ---- Names ----

def norm(name):
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", name).lower()
    s = re.sub(r"^(pluto tv|samsung tv plus|samsung|plex|the roku channel|roku)\s+", "", s)
    s = s.replace("&", " and ").replace("+", " plus ")
    return re.sub(r"[^a-z0-9]", "", s)


def loose(name):
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", name).lower()
    s = re.sub(r"^(pluto tv|samsung tv plus|samsung|plex|the roku channel|roku)\s+", "", s)
    s = s.replace("&", " and ").replace("+", " plus ")
    words = [w for w in re.findall(r"[a-z0-9]+", s) if w not in STOP_WORDS]
    return "".join(words)


def region_of(text):
    """Time zone feed named in a channel name or feed code: 'west', 'mountain' or ''."""
    t = text.lower()
    if re.search(r"\b(west|pacific)\b", t):
        return "west"
    if re.search(r"\bmountain\b", t):
        return "mountain"
    return ""


# ---- XMLTV ----

def xmltv_time(s):
    m = re.match(r"(\d{14})\s*([+-]\d{4})?", s or "")
    if not m:
        return None
    secs = calendar.timegm(time.strptime(m.group(1), "%Y%m%d%H%M%S"))
    off = m.group(2)
    if off:
        sign = 1 if off[0] == "+" else -1
        secs -= sign * (int(off[1:3]) * 3600 + int(off[3:5]) * 60)
    return secs


def load_xmltv(data, now, until):
    """Returns (channels {id: {names, logo}}, programmes {id: [(s, e, title, ep, desc, cat)]})."""
    channels = {}
    progs = {}
    if not data:
        return channels, progs
    for _, el in ET.iterparse(io.BytesIO(data), events=("end",)):
        tag = el.tag
        if tag == "channel":
            names = [n.text.strip() for n in el.findall("display-name") if n.text]
            icon = el.find("icon")
            channels[el.get("id")] = {"names": names, "logo": icon.get("src") if icon is not None else None}
            el.clear()
        elif tag == "programme":
            s = xmltv_time(el.get("start"))
            e = xmltv_time(el.get("stop"))
            if s is not None and e is not None and e > now and s < until:
                title = (el.findtext("title") or "").strip()
                ep = (el.findtext("sub-title") or "").strip()
                desc = (el.findtext("desc") or "").strip()
                cats = [c.text.strip() for c in el.findall("category") if c.text]
                progs.setdefault(el.get("channel"), []).append((s, e, title, ep, desc, cats))
            elif s is not None and el.get("channel") not in progs:
                # Still note the channel's genre from programmes outside the window.
                cats = [c.text.strip() for c in el.findall("category") if c.text]
                if cats:
                    progs.setdefault("#cat:" + el.get("channel"), cats)
            el.clear()
    for k in progs:
        if not k.startswith("#"):
            progs[k].sort()
    return channels, progs


def genre(progs, cid):
    for p in progs.get(cid, []):
        for c in p[5]:
            if c and c != "Series":
                return c
    for c in progs.get("#cat:" + cid, []):
        if c and c != "Series":
            return c
    return None


# ---- Matching ----

class NameIndex:
    """Channels of one guide by (normalised name, time zone feed), for one country."""

    def __init__(self, label, channels, progs, country_of=lambda cid: "us"):
        self.label = label
        self.progs = progs
        self.exact = {}
        self.loose = {}
        for cid, info in channels.items():
            if not progs.get(cid):
                continue
            country = country_of(cid)
            if country is None:
                continue
            for n in info["names"][:2]:
                reg = region_of(n + " " + cid.replace(".", " "))
                self.exact.setdefault((country, norm(n), reg), cid)
                ln = loose(n)
                if ln:
                    self.loose.setdefault((country, ln, reg), cid)

    def find(self, country, name, reg, exact_only=False):
        cid = self.exact.get((country, norm(name), reg))
        if cid is None and not exact_only:
            ln = loose(name)
            if len(ln) >= 3:
                cid = self.loose.get((country, ln, reg))
        return cid


def samsung_country(cid):
    c = cid[:2].lower()
    return "uk" if c == "gb" else c


CALL_RE = re.compile(r"^([KW][A-Z]{2,3})(TV|DT|LD|CD|CA)?(\d{2,4})?$")
CALL_NAME_RE = re.compile(r"\b([KW][A-Z]{2,3})-(TV|DT|LD|CD|CA)\b")
# Networks whose affiliates show the network on their main channel. Others ("Movies! KPVM-LD")
# are on a station's subchannel, whose schedule the local guide doesn't have.
NETWORKS = {"abc", "cbs", "nbc", "fox", "pbs", "cw", "thecw", "mynetworktv", "telemundo", "univision",
            "unimas", "ion", "iontelevision"}


def call_sign(ch):
    """The station call sign of a local channel's main (.1) feed, or None."""
    base, country, feed = tid_parts(ch["tid"])
    if country == "us":
        # Network affiliates carried by streaming services: "CBS.us@WWMT", "ABC.us@KSTPTV".
        m = re.match(r"^([KW][A-Z]{2,3})(TV|DT|LD|CD|CA)?$", feed)
        if m:
            return m.group(1) if base.lower() in NETWORKS else None
        m = CALL_RE.match(base)
        if m and (m.group(2) or m.group(3)):
            digits = m.group(3)
            if digits is None or digits.endswith("1"):
                return m.group(1)
    m = CALL_NAME_RE.search(ch["name"])
    sub = re.search(r"\b\d{1,2}\.(\d{1,2})\b", ch["name"])
    if m and (sub is None or sub.group(1) == "1"):
        return m.group(1)
    return None


ID_SUFFIXES = {"hd", "east", "west", "pacific", "feed", "a"}


def us2_key(cid):
    """'FX.HD.(Pacific).us2' -> ('fx', 'west'): a cable network's id and time zone feed."""
    words = [w for w in re.split(r"[.()\s]+", cid.rsplit(".", 1)[0].lower()) if w]
    reg = region_of(" ".join(words))
    while len(words) > 1 and words[-1] in ID_SUFFIXES:
        words.pop()
    return "".join(words).replace("-", ""), reg


def playlist_key(base_name):
    """'AandEHD' -> 'aande', to look up in the cable network ids."""
    s = base_name.lower()
    for suffix in ("hd", "east", "west", "pacific"):
        if s.endswith(suffix) and len(s) > len(suffix) + 2:
            s = s[: -len(suffix)]
    return s


def tidy(text):
    """One line, and straight double quotes made typographic (the Roku app's JSON cache is fussy)."""
    return re.sub(r"\s+", " ", text).replace('"', "\u201d").strip()


def compact(progs, base):
    out = []
    for n, (s, e, title, ep, desc, _) in enumerate(progs[:MAX_PROGRAMMES]):
        if ep == title:
            ep = ""
        d = desc if n < DESCRIBED else ""
        if len(d) > DESC_LEN:
            d = d[: DESC_LEN - 1].rsplit(" ", 1)[0] + "…"
        out.append([(s - base) // 60, max(1, (e - s) // 60), tidy(title), tidy(ep[:80]), tidy(d)])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="guide.json")
    ap.add_argument("--cache", help="keep downloads in this folder and reuse them (for testing)")
    ap.add_argument("--report", action="store_true", help="print which channels have no listings")
    args = ap.parse_args()
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)

    now = int(time.time())
    base = now - now % 60
    until = now + HOURS * 3600

    log("playlist")
    playlist = parse_m3u(fetch(PLAYLIST, args.cache).decode("utf-8", "replace"))
    log("  %d entries" % len(playlist))

    def guide(url, label):
        log(label)
        t0 = time.time()
        chans, progs = load_xmltv(fetch(url, args.cache), now, until)
        log("  %d channels, %d with listings (%.1fs)" % (len(chans), sum(1 for k in progs if not k.startswith("#")), time.time() - t0))
        return chans, progs

    pluto_ch, pluto = guide(MJH + "PlutoTV/all.xml", "Pluto TV")
    pluto_us, _ = guide(MJH + "PlutoTV/us.xml", "Pluto TV (US channel list)")
    indexes = []
    sam_ch, sam = guide(MJH + "SamsungTVPlus/all.xml", "Samsung TV Plus")
    indexes.append(NameIndex("samsung", sam_ch, sam, samsung_country))
    for label, path in (("plex", "Plex/all.xml"), ("roku", "Roku/all.xml"), ("pbs", "PBS/all.xml")):
        ch, pr = guide(MJH + path, label)
        indexes.append(NameIndex(label, ch, pr))
    us2_ch, us2 = guide(SHARE + "US2.xml.gz", "US networks")
    us2_index = NameIndex("us2", us2_ch, us2)
    indexes.append(us2_index)
    us2_ids = {}
    for cid in us2_ch:
        if us2.get(cid):
            us2_ids.setdefault(us2_key(cid), cid)
    for label, country in (("UK1", "uk"), ("AU1", "au")):
        ch, pr = guide(SHARE + label + ".xml.gz", label)
        indexes.append(NameIndex(label, ch, pr, lambda cid, c=country: c))
    loc_ch, loc = guide(SHARE + "US_LOCALS1.xml.gz", "US local stations")
    # A station's full-power channel first, then its low-power and translator ones.
    rank = {"DT": 0, "TV": 1, "": 2, "CD": 3, "CA": 4, "LD": 5, "D": 6}
    locals_by_call = {}
    for cid in sorted(loc_ch):
        if loc.get(cid):
            m = re.match(r"^([KW][A-Z0-9]{2,5})(?:-(DT|TV|LD|CD|CA|D))?\.", cid)
            if m:
                best = locals_by_call.get(m.group(1))
                if best is None or rank[m.group(2) or ""] < best[0]:
                    locals_by_call[m.group(1)] = (rank[m.group(2) or ""], cid)
    locals_by_call = {k: v[1] for k, v in locals_by_call.items()}

    schedules = []
    sched_index = {}

    def add_schedule(source, cid, progs):
        key = (source, cid)
        if key not in sched_index:
            sched_index[key] = len(schedules)
            schedules.append(compact(progs, base))
        return sched_index[key]

    by_url = {}
    by_id = {}
    stats = {}
    missing = []
    matched = []
    for ch in playlist:
        if ch["url"] in by_url:
            continue
        base_name, country, feed = tid_parts(ch["tid"])
        country = FEED_COUNTRIES.get(feed.lower()) or country or "us"
        reg = region_of(feed + " " + ch["name"])
        hit = None
        m = PLUTO_RE.search(ch["url"])
        if m:
            pid = next(g for g in m.groups() if g)
            if pluto.get(pid):
                hit = ("pluto", pid, pluto[pid])
        if hit is None and country == "us":
            cid = us2_ids.get((playlist_key(base_name), reg)) if base_name else None
            if cid:
                hit = ("us2", cid, us2[cid])
        if hit is None and country == "us" and reg == "":
            call = call_sign(ch)
            if call and call in locals_by_call:
                cid = locals_by_call[call]
                hit = ("locals", cid, loc[cid])
        if hit is None:
            for exact_only in (True, False):
                for idx in indexes:
                    cid = idx.find(country, ch["name"], reg, exact_only)
                    if cid:
                        hit = (idx.label + ("" if exact_only else "~"), cid, idx.progs[cid])
                        break
                if hit:
                    break
        if hit is None:
            missing.append(ch)
            continue
        source, cid, progs = hit
        n = add_schedule(source, cid, progs)
        by_url[ch["url"]] = n
        if ch["tid"] and reg == "":
            by_id.setdefault(ch["tid"].split("@")[0].lower(), n)
        stats[source] = stats.get(source, 0) + 1
        matched.append((ch, source, cid))

    # Pluto TV US channels the playlist doesn't have; the apps add them to the lineup.
    have_pluto = set()
    for ch in playlist:
        m = PLUTO_RE.search(ch["url"])
        if m:
            have_pluto.add(next(g for g in m.groups() if g))
    add = []
    for pid, info in pluto_us.items():
        if pid in have_pluto:
            continue
        item = {"name": info["names"][0] if info["names"] else pid, "url": "https://jmp2.uk/plu-%s.m3u8" % pid}
        if info["logo"]:
            item["logo"] = info["logo"]
        g = genre(pluto, pid)
        if g:
            item["cat"] = g
        add.append(item)
        if pluto.get(pid):
            by_url[item["url"]] = add_schedule("pluto", pid, pluto[pid])
    add.sort(key=lambda c: c["name"].lower())

    cats = {}
    for pid in have_pluto:
        g = genre(pluto, pid)
        if g:
            cats[pid] = g

    out = {"v": 1, "base": base, "built": now, "s": schedules, "p": by_url, "i": by_id, "cat": cats, "add": add}
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    tmp = args.out + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, args.out)

    total = len({c["url"] for c in playlist})
    log("matched %d of %d playlist streams: %s" % (sum(stats.values()), total, stats))
    log("pluto additions: %d; schedules: %d; %s: %.2f MB (%.2f MB gzipped)" % (
        len(add), len(schedules), args.out, len(text.encode()) / 1e6, len(gzip.compress(text.encode())) / 1e6))
    if args.report:
        for ch in missing:
            print("MISS  %-40s %-32s %s" % (ch["name"][:40], ch["tid"][:32], ch["url"][:60]))
        for ch, source, cid in matched:
            print("MATCH %-40s %-32s %-8s %s" % (ch["name"][:40], ch["tid"][:32], source, cid))


if __name__ == "__main__":
    main()
