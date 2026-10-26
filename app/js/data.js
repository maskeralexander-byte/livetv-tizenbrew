/* Channel lists, guide and movies for the Samsung TV app. Mirrors the Roku and phone apps' data layers. */
'use strict';

var Data = (function () {
    var ENGLISH_URL = 'https://iptv-org.github.io/iptv/languages/eng.m3u';
    // The prebuilt guide (tools/guide/build_guide.py, rebuilt every 6 hours): listings for about 1,500
    // streams in one small file. The Pluto TV guide is the fallback when it can't be had.
    var GUIDE_URL = 'https://raw.githubusercontent.com/maskeralexander-byte/livetv-tizenbrew/guide/guide.json';
    var PLUTO_GUIDE_URL = 'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml';
    var CACHE_MS = 12 * 60 * 60 * 1000;

    // Same list as the phone app's Official.kt.
    var OFFICIAL_DOMAINS = [
        'jmp2.uk', 'pluto.tv', 'samsung.com', 'plex.tv', 'roku.com', 'xumo.com', 'tubi.video',
        'amagi.tv', 'wurl.tv', 'wurl.com', 'frequency.stream', 'stingray.com', 'getpublica.com',
        'klowdtv.com', 'rakuten.tv', 'redbox.com', 'vizio.com', 'trace.plus',
        'pbs.org', 'cbsnews.com', 'cbs.com', 'nbcuni.com', 'foxnews.com', 'bloomberg.com', 'nasa.gov',
        'warnermediacdn.com', 'cablecast.tv', 'telvue.com', 'swagit.com', 'streamhoster.com',
        'sinclairstoryline.com',
        'akamaized.net', 'akamaihd.net', 'edgesuite.net', 'cloudfront.net', 'llnwd.net',
        'uplynk.com', 'brightcove.com', 'dai.google.com', 'fastly.net'
    ];

    function isOfficial(url) {
        var m = /^https?:\/\/([^\/:?#]+)(:\d+)?/i.exec(url);
        if (!m || m[2]) return false;
        var host = m[1].toLowerCase();
        for (var i = 0; i < OFFICIAL_DOMAINS.length; i++) {
            var d = OFFICIAL_DOMAINS[i];
            if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
        }
        return false;
    }

    function get(url, timeout) {
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.timeout = timeout || 30000;
            x.onload = function () {
                if (x.status >= 200 && x.status < 300) resolve(x.responseText);
                else reject(new Error('HTTP ' + x.status));
            };
            x.onerror = function () { reject(new Error('network error')); };
            x.ontimeout = function () { reject(new Error('timed out')); };
            x.send();
        });
    }

    /** Downloads with a localStorage copy, so the app starts offline and doesn't refetch every launch. */
    function cached(key, url, maxAge) {
        var stamp = +(store('t:' + key) || 0);
        var copy = store('c:' + key);
        if (copy && Date.now() - stamp < maxAge) return Promise.resolve(copy);
        return get(url).then(function (text) {
            store('c:' + key, text);
            store('t:' + key, String(Date.now()));
            return text;
        }, function (e) {
            if (copy) return copy;
            throw e;
        });
    }

    function store(key, value) {
        try {
            if (value === undefined) return localStorage.getItem(key);
            localStorage.setItem(key, value);
        } catch (e) {
            // Full or unavailable: the app still works, it just downloads again next time.
        }
        return null;
    }

    function storedJson(key, fallback) {
        try {
            var v = JSON.parse(store(key) || 'null');
            return v == null ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    // ---- Playlists ----

    /** Entries as { name, url, g (every group-title tag), tid, logo, official, ua, ref }. */
    function parseM3u(text, source) {
        var out = [];
        var lines = text.split(/\r?\n/);
        var info = null;
        var ua = '';
        var ref = '';
        var attrRe = /([\w-]+)="([^"]*)"/g;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.indexOf('#EXTINF') === 0) {
                info = line;
                ua = '';
                ref = '';
            } else if (line.indexOf('#EXTVLCOPT') === 0) {
                var opt = line.slice(11);
                if (/^http-user-agent=/i.test(opt)) ua = opt.slice(16);
                if (/^http-referrer=/i.test(opt)) ref = opt.slice(14);
            } else if (line.charAt(0) !== '#' && info) {
                var attrs = {};
                var m;
                attrRe.lastIndex = 0;
                while ((m = attrRe.exec(info))) attrs[m[1].toLowerCase()] = m[2];
                var nm = /"\s*,(.*)$/.exec(info) || /^#EXTINF:-?\d+[^,]*,(.*)$/.exec(info);
                var name = cleanName(nm ? nm[1] : '') || attrs['tvg-name'] || 'Unknown';
                var group = attrs['group-title'];
                if (!group || group.toLowerCase() === 'undefined') group = 'Other';
                out.push({
                    name: name, url: line, g: group, tid: attrs['tvg-id'] || null, logo: attrs['tvg-logo'] || null,
                    official: isOfficial(line), ua: ua || attrs['http-user-agent'] || null,
                    ref: ref || attrs['http-referrer'] || null, source: source
                });
                info = null;
            }
        }
        return out;
    }

    function cleanName(raw) {
        return raw.replace(/\s*\(\d{3,4}[pi]\)/g, '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
    }

    // ---- Duplicates and categories (the same rules as roku/source/Channels.brs) ----
    //
    // The public lists carry the same channel many times: Pluto TV's US, Canadian, UK and Nordic versions,
    // a broadcaster's own stream next to its Pluto or Samsung TV Plus copy, East and West feeds. They're
    // folded into one channel whose best feed plays first; the others stay in ch.feeds as backups, tried
    // when a feed fails and switchable with ◀▶. Local stations are never folded.

    var COUNTRIES = 'United States|USA|Canada|United Kingdom|UK|Sweden|Denmark|Norway|Germany|Austria|Switzerland|' +
        'France|Spain|Italy|Australia|New Zealand|Ireland|Mexico|Brazil|Finland|Netherlands|Poland|India|' +
        'Latin America|Latam|Europe|International';
    var RE = {
        anyCountry: new RegExp('\\s*\\((' + COUNTRIES + ')\\)', 'gi'),
        usTag: /\s*\((United States|USA)\)/gi,
        spaces: /\s{2,}/g,
        keyChars: /[^a-z0-9+]/g,
        timezoneFeed: /^(East|West|Pacific|Mountain|Central)$/i,
        callSign: /^[KW][A-Z]{2,3}(TV|DT|LD|CD|CA)?$/,
        national: /c-span|cspan|cpac|congress|senate|house of/i
    };
    var REGION_NAMES = {
        us: 'US', ca: 'Canada', uk: 'UK', gb: 'UK', se: 'Sweden', dk: 'Denmark', no: 'Norway',
        de: 'Germany', at: 'Austria', ch: 'Switzerland', fr: 'France', es: 'Spain', it: 'Italy',
        au: 'Australia', nz: 'New Zealand', ie: 'Ireland', mx: 'Mexico', br: 'Brazil', fi: 'Finland',
        nl: 'Netherlands', pl: 'Poland', 'in': 'India',
        poland: 'Poland', sweden: 'Sweden', germany: 'Germany', denmark: 'Denmark', norway: 'Norway',
        canada: 'Canada', france: 'France', spain: 'Spain', italy: 'Italy', australia: 'Australia',
        latam: 'Latin America', latinamerica: 'Latin America', europe: 'Europe', international: 'International'
    };
    var FAST_HOSTS = ['jmp2.uk', 'xumo://', '.wurl.', 'amagi.tv', 'samsung', 'plex.tv', 'roku', 'tubi',
        'frequency.stream', 'getpublica', 'klowdtv', 'pluto.tv'];
    var LOCAL_HOSTS = ['cablecast.tv', 'telvue.com', 'swagit.com', 'granicus.com', 'reflect-'];

    /** Folds duplicates and returns the channels sorted by name. */
    function mergeDuplicates(raw) {
        var groups = {};
        var order = [];
        raw.forEach(function (ch, i) {
            ch.ord = i;
            var key = groupKey(ch) || 'url:' + ch.url;
            if (!groups[key]) { groups[key] = []; order.push(key); }
            groups[key].push(ch);
        });
        var out = order.map(function (key) {
            var g = groups[key];
            // Best feed first; ties keep the playlist's order, so the pick is the same on every start.
            g.sort(function (a, b) { return (feedScore(b) - feedScore(a)) || (a.ord - b.ord); });
            var primary = g[0];
            var merged = {};
            for (var k in primary) if (primary.hasOwnProperty(k)) merged[k] = primary[k];
            merged.category = categoryFor(g);
            for (var i = 0; i < g.length; i++) {
                // The best feed's listings, or the first backup's that has some.
                if (!(merged.p && merged.p.length) && g[i].p && g[i].p.length) merged.p = g[i].p;
                if (!merged.logo && g[i].logo) merged.logo = g[i].logo;
            }
            if (g.length > 1) {
                merged.name = displayName(primary, true);
                g.forEach(function (f) { f.label = feedLabel(f); });
                merged.feeds = g;
            } else {
                merged.name = displayName(primary, false);
            }
            return merged;
        });
        out.sort(function (a, b) {
            var x = a.name.toLowerCase(), y = b.name.toLowerCase();
            return x < y ? -1 : x > y ? 1 : 0;
        });
        return out;
    }

    function groupKey(ch) {
        var name = ch.name || '';
        name = isFastFeed(ch.url) ? name.replace(RE.anyCountry, ' ') : name.replace(RE.usTag, ' ');
        name = stripFeedSuffix(name.replace(RE.spaces, ' ').trim(), ch);
        var key = name.toLowerCase().replace(RE.keyChars, '');
        // Each local station is its own channel, whatever the playlist calls it.
        var code = feedCode(ch);
        if (RE.callSign.test(code)) key += '@' + code.toLowerCase();
        return key;
    }

    function displayName(ch, merged) {
        var name = (ch.name || '').replace(merged ? RE.anyCountry : RE.usTag, ' ').replace(RE.spaces, ' ').trim();
        if (merged) name = stripFeedSuffix(name, ch);
        return name || ch.name || '';
    }

    function stripFeedSuffix(name, ch) {
        var code = feedCode(ch);
        if (!code || !isRegionFeed(code)) return name;
        var suffix = ' ' + code.toLowerCase();
        if (name.length > suffix.length && name.toLowerCase().slice(-suffix.length) === suffix) {
            return name.slice(0, -suffix.length).trim();
        }
        return name;
    }

    /** The part of the tvg-id after "@": a country (DK), a time zone feed (West), a quality (HD) or a call sign. */
    function feedCode(ch) {
        var tid = ch.tid || '';
        var at = tid.indexOf('@');
        return at < 0 ? '' : tid.slice(at + 1);
    }

    function tidCountry(ch) {
        var tid = (ch.tid || '').split('@')[0];
        var dot = tid.lastIndexOf('.');
        return dot < 0 ? '' : tid.slice(dot + 1).toLowerCase();
    }

    function isRegionFeed(code) { return REGION_NAMES.hasOwnProperty(code.toLowerCase()) || RE.timezoneFeed.test(code); }

    function feedRegion(ch) {
        var code = feedCode(ch).toLowerCase();
        if (REGION_NAMES.hasOwnProperty(code)) return REGION_NAMES[code];
        var country = tidCountry(ch);
        if (!country || country === 'us') return 'US';
        return REGION_NAMES[country] || country.toUpperCase();
    }

    function isFastFeed(url) {
        var u = url.toLowerCase();
        for (var i = 0; i < FAST_HOSTS.length; i++) if (u.indexOf(FAST_HOSTS[i]) >= 0) return true;
        return false;
    }

    /** Higher is better: official, American, HD, East before West, and no special headers (the TV can't send them). */
    function feedScore(ch) {
        var s = 0;
        if (ch.official) s += 20;
        if (feedRegion(ch) === 'US') s += 16;
        var code = feedCode(ch).toLowerCase();
        if (code === 'hd') s += 2;
        if (code === 'west' || code === 'pacific' || code === 'mountain') s -= 1;
        if (ch.ua || ch.ref) s -= 3;
        return s;
    }

    /** "Pluto TV · Denmark", "CBS", "Samsung TV Plus · West"… */
    function feedLabel(ch) {
        var u = ch.url.toLowerCase();
        var service = 'Stream';
        if (u.indexOf('jmp2.uk') >= 0 || u.indexOf('pluto.tv') >= 0) service = 'Pluto TV';
        else if (u.indexOf('plex.tv') >= 0) service = 'Plex';
        else if (u.indexOf('tubi') >= 0) service = 'Tubi';
        else if (u.indexOf('roku') >= 0) service = 'The Roku Channel';
        else if (u.indexOf('samsung') >= 0) service = 'Samsung TV Plus';
        else if (u.indexOf('cbsnews') >= 0 || u.indexOf('cbs.com') >= 0) service = 'CBS';
        else if (u.indexOf('pbs.org') >= 0) service = 'PBS';
        else if (ch.official) service = 'Official stream';
        var extra = '';
        var region = feedRegion(ch);
        if (region !== 'US') extra = region;
        var code = feedCode(ch);
        if (RE.timezoneFeed.test(code)) extra = code;
        if (code.toLowerCase() === 'hd' && !extra) extra = 'HD';
        return extra ? service + ' · ' + extra : service;
    }

    // Most specific first: a channel tagged both "Movies" and "Series" goes under Movies.
    var CATEGORY_ORDER = ['Local', 'News', 'Sports', 'Kids', 'Animation', 'Movies', 'Music', 'Comedy', 'Drama',
        'Reality', 'Documentary', 'Faith', 'Shopping', 'Lifestyle', 'Classic TV', 'Entertainment'];
    var CATEGORY_MAP = (function () {
        var map = {};
        function add(category, tags) { tags.forEach(function (t) { map[t] = category; }); }
        add('News', ['news', 'news & information', 'news &amp; information', 'business', 'weather', 'legislative', 'news + opinion']);
        add('Sports', ['sports', 'outdoor', 'auto', 'sports event', 'sports non-event', 'motorsports']);
        add('Kids', ['kids', 'children', 'family', 'kids & family']);
        add('Animation', ['animation', 'animated', 'anime', 'anime series', 'anime action & adventure', 'cartoons']);
        add('Movies', ['movies', 'movie', 'action', 'horror', 'thriller', 'romance', 'adventure']);
        add('Music', ['music', 'pop', 'relax', 'music videos']);
        add('Comedy', ['comedy', 'screwball', 'romantic comedy', 'sitcom', 'fails & pranks']);
        add('Drama', ['drama', 'crime', 'true crime', 'mystery', 'western', 'westerns', 'science fiction',
            'classic sci-fi & fantasy', 'sci-fi', 'paranormal', 'telenovela', 'independent drama']);
        add('Reality', ['reality', 'competition reality', 'human interest', 'game show', 'game shows']);
        add('Documentary', ['documentary', 'education', 'educational', 'science', 'travel', 'culture', 'history', 'nature']);
        add('Faith', ['religious', 'faith']);
        add('Shopping', ['shop', 'shopping']);
        add('Lifestyle', ['cooking', 'food & cooking', 'lifestyle', 'home & lifestyle', 'food & home']);
        add('Classic TV', ['classic', 'classic tv']);
        add('Local', ['local']);
        add('Entertainment', ['entertainment', 'general', 'series', 'undefined', 'other']);
        return map;
    })();
    var NAME_KEYWORDS = [
        ['News', /\bnews\b|\bweather\b|\bbloomberg\b|\bcnbc\b/i],
        ['Sports', /\bsports?\b|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|\bgolf\b|\bracing\b|\bboxing\b|\bwrestling\b|\bsoccer\b|\bfootball\b|\bfight/i],
        ['Kids', /\bkids?\b|\bcartoons?\b|\btoons?\b|\bjunior\b|\bbaby\b|\bkidz\b/i],
        ['Movies', /\bmovies?\b|\bcinema\b|\bfilms?\b|flix\b/i],
        ['Music', /\bmusic\b|\bhits\b|\bmtv\b|\bvevo\b|\bradio\b|\bjazz\b|\bcountry\b/i],
        ['Comedy', /\bcomedy\b|\blaughs?\b|\bfunny\b/i],
        ['Drama', /\bcrime\b|\bdetectives?\b|\bmystery\b|\bmysteries\b|\bwestern\b|\bsci-fi\b/i],
        ['Faith', /\bchurch\b|\bfaith\b|\bgospel\b|\bbible\b|\bchristian\b|\bcatholic\b/i]
    ];

    /** One category for a channel's feeds: the playlist's tags, Pluto TV's genre, else keywords in the name. */
    function categoryFor(group) {
        var best = '';
        var bestRank = 999;
        for (var i = 0; i < group.length; i++) {
            var ch = group[i];
            if (isLocal(ch)) return 'Local';
            var parts = (ch.g || '').split(';');
            if (ch.pcat) parts.push(ch.pcat);
            for (var j = 0; j < parts.length; j++) {
                var c = CATEGORY_MAP[parts[j].trim().toLowerCase()] || 'Entertainment';
                var r = CATEGORY_ORDER.indexOf(c);
                if (r >= 0 && r < bestRank) { best = c; bestRank = r; }
            }
        }
        if (!best || best === 'Entertainment') {
            var n = ' ' + (group[0].name || '').toLowerCase() + ' ';
            for (var k = 0; k < NAME_KEYWORDS.length; k++) if (NAME_KEYWORDS[k][1].test(n)) return NAME_KEYWORDS[k][0];
            return 'Entertainment';
        }
        return best;
    }

    /** City and county channels, and local TV stations (feeds named by call sign, like Fox.us@WTVT). */
    function isLocal(ch) {
        var u = ch.url.toLowerCase();
        for (var i = 0; i < LOCAL_HOSTS.length; i++) if (u.indexOf(LOCAL_HOSTS[i]) >= 0) return true;
        if (RE.callSign.test(feedCode(ch))) return true;
        return (ch.g || '').toLowerCase() === 'legislative' && !RE.national.test(ch.name || '');
    }

    /** With Official streams only, a merged channel keeps just its official feeds. */
    function officialFeeds(ch) {
        if (!ch.feeds) return ch;
        var kept = ch.feeds.filter(function (f) { return f.official; });
        if (kept.length === ch.feeds.length) return ch;
        var copy = {};
        for (var k in ch) if (ch.hasOwnProperty(k)) copy[k] = ch[k];
        if (kept.length > 1) copy.feeds = kept; else delete copy.feeds;
        return copy;
    }

    // ---- Guide ----

    /** The prebuilt guide, or null when it's missing, unreadable or more than 18 hours old (it has a day of listings). */
    function downloadGuideJson() {
        return get(GUIDE_URL, 60000).then(function (text) {
            var g = JSON.parse(text);
            if (!g || g.v !== 1 || !g.base || !g.s || !g.p) return null;
            if (Date.now() / 1000 - g.base > 18 * 3600) return null;
            return g;
        }, function () { return null; });
    }

    /** A schedule ([start, length, title, episode, description], minutes from base) as the next 8 programmes. */
    function guideProgrammes(sched, base, now) {
        var out = [];
        if (!sched) return out;
        for (var i = 0; i < sched.length && out.length < 8; i++) {
            var row = sched[i];
            var s = (base + row[0] * 60) * 1000;
            var e = s + row[1] * 60000;
            if (e <= now) continue;
            var d = row[4] || '';
            if (row[3]) d = d ? row[3] + '  ·  ' + d : row[3];
            out.push({ s: s, e: e, t: row[2], d: d });
        }
        return out;
    }

    var PLUTO_RE = /jmp2\.uk\/plu-([0-9a-f]{24})/i;

    /** Listings by stream URL, Pluto TV genres, and Pluto TV's US channels the playlist doesn't have. */
    function attachGuideJson(raw, g) {
        var now = Date.now();
        var cats = g.cat || {};
        var havePluto = {};
        raw.forEach(function (ch) {
            var idx = g.p[ch.url];
            if (idx != null) ch.p = guideProgrammes(g.s[idx], g.base, now);
            var m = PLUTO_RE.exec(ch.url);
            if (m) {
                havePluto[m[1]] = true;
                if (cats[m[1]]) ch.pcat = cats[m[1]];
            }
        });
        (g.add || []).forEach(function (a) {
            var m = PLUTO_RE.exec(a.url);
            if (!m || havePluto[m[1]]) return;
            var ch = { name: a.name, url: a.url, g: 'Entertainment', tid: null, logo: a.logo || null, official: true, source: 'Pluto TV' };
            if (a.cat) ch.pcat = a.cat;
            var idx = g.p[a.url];
            if (idx != null) ch.p = guideProgrammes(g.s[idx], g.base, now);
            raw.push(ch);
        });
    }

    /**
     * The fallback: Pluto TV's US channels and what's on them, from the free XMLTV guide. The file is
     * ~7 MB, so it's scanned with regexes instead of a DOM parser, which is far too slow on a TV.
     */
    function attachPlutoXml(raw, xml) {
        var byId = {};
        var chRe = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
        var m;
        while ((m = chRe.exec(xml))) {
            var name = /<display-name>([^<]*)</.exec(m[2]);
            var icon = /<icon src="([^"]*)"/.exec(m[2]);
            byId[m[1]] = { name: name ? unescapeXml(name[1]).trim() : m[1], logo: icon ? icon[1] : null, p: [] };
        }
        var now = Date.now();
        var prRe = /<programme channel="([^"]+)" start="([^"]+)" stop="([^"]+)">\s*<title>([^<]*)</g;
        while ((m = prRe.exec(xml))) {
            var c = byId[m[1]];
            if (!c || c.p.length >= 8) continue;
            var stop = xmltvTime(m[3]);
            if (stop > now) c.p.push({ s: xmltvTime(m[2]), e: stop, t: unescapeXml(m[4]), d: '' });
        }
        var have = {};
        raw.forEach(function (ch) {
            var pm = PLUTO_RE.exec(ch.url);
            if (pm && byId[pm[1]]) { have[pm[1]] = true; ch.p = byId[pm[1]].p; }
        });
        Object.keys(byId).forEach(function (id) {
            if (have[id]) return;
            var c = byId[id];
            raw.push({ name: c.name, url: 'https://jmp2.uk/plu-' + id + '.m3u8', g: 'Entertainment', tid: null,
                logo: c.logo, official: true, source: 'Pluto TV', p: c.p });
        });
    }

    function unescapeXml(s) {
        return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, function (all, e) {
            if (e.charAt(0) === '#') return String.fromCharCode(+e.slice(1));
            return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
        });
    }

    function xmltvTime(s) {
        // 20251017030000 +0000
        var m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?/.exec(s || '');
        if (!m) return 0;
        var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        if (m[7]) {
            var sign = m[7].charAt(0) === '-' ? -1 : 1;
            t -= sign * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000;
        }
        return t;
    }

    /** What's on now and next on a channel: { now, next }, either may be null. */
    function nowNext(ch) {
        var now = Date.now();
        var p = ch && ch.p;
        if (!p) return { now: null, next: null };
        for (var i = 0; i < p.length; i++) {
            if (p[i].e <= now) continue;
            if (p[i].s <= now) return { now: p[i], next: p[i + 1] || null };
            return { now: null, next: p[i] };
        }
        return { now: null, next: null };
    }

    /** English channels (iptv-org), the bundled extras and Pluto TV's US channels, merged, with the guide. */
    function loadChannels(force) {
        var errors = [];
        var lists = [
            cached('eng', ENGLISH_URL, force ? 0 : CACHE_MS).then(function (t) { return parseM3u(t, 'iptv-org'); },
                function (e) { errors.push('Channel list: ' + e.message); return []; }),
            get('extra_channels.m3u').then(function (t) {
                return parseM3u(t, 'Extra channels').map(function (c) { c.official = true; return c; });
            }, function () { return []; }),
            downloadGuideJson()
        ];
        return Promise.all(lists).then(function (r) {
            var seen = {};
            var raw = [];
            r[0].concat(r[1]).forEach(function (c) {
                if (seen[c.url]) return;
                seen[c.url] = true;
                raw.push(c);
            });
            if (r[2]) {
                attachGuideJson(raw, r[2]);
                return { raw: raw, guide: 'prebuilt' };
            }
            return get(PLUTO_GUIDE_URL, 60000).then(function (xml) {
                attachPlutoXml(raw, xml);
                return { raw: raw, guide: 'pluto' };
            }, function (e) {
                errors.push('Guide: ' + e.message);
                return { raw: raw, guide: 'none' };
            });
        }).then(function (r) {
            return { channels: mergeDuplicates(r.raw), errors: errors, guide: r.guide };
        });
    }

    // ---- Free movies and TV: the Internet Archive's public domain films and shows ----

    var PD = ' AND (subject:"public domain" OR licenseurl:*publicdomain* OR description:"public domain")';
    // Videos the TV can play, and nothing adult.
    var ARCHIVE_FILTER = ' AND mediatype:movies AND format:(MPEG4 OR "h.264" OR "512Kb MPEG4" OR "h.264 IA")' +
        ' AND NOT subject:(sex OR sexploitation OR erotic OR nudity OR naked OR adult OR exploitation OR stag OR molester)' +
        ' AND NOT title:(sex OR nude OR naked OR erotic OR stag OR molester OR trailer OR captions)';
    // Items marked public domain only, since the collections also hold other uploads.
    var FREE_ROWS = [
        { title: 'Classic Movies', q: 'collection:feature_films' + PD },
        { title: 'Classic TV', q: 'collection:classic_tv' + PD },
        { title: 'Film Noir', q: 'collection:feature_films AND subject:"film noir"' + PD },
        { title: 'Westerns', q: 'collection:feature_films AND subject:western' + PD },
        { title: 'Horror & Sci-Fi', q: 'collection:SciFi_Horror' + PD },
        { title: 'Comedies', q: 'collection:Comedy_Films' + PD },
        { title: 'Silent Films', q: 'collection:silent_films' + PD },
        { title: 'Cartoons', q: 'collection:animationandcartoons' + PD }
    ];
    var freeCache = {};

    function archiveQuery(q, rows) {
        var url = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(q) +
            '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&fl%5B%5D=description&fl%5B%5D=runtime' +
            '&sort%5B%5D=downloads+desc&rows=' + rows + '&output=json';
        return get(url, 30000).then(function (t) { return parseArchiveDocs(JSON.parse(t)); });
    }

    /** One of FREE_ROWS' lists (kept for the session). */
    function freeRow(index) {
        if (freeCache[index]) return Promise.resolve(freeCache[index]);
        return archiveQuery('(' + FREE_ROWS[index].q + ')' + ARCHIVE_FILTER, 60).then(function (items) {
            freeCache[index] = items;
            return items;
        });
    }

    function freeSearch(text) {
        var words = text.replace(/[^A-Za-z0-9 ]/g, ' ').trim();
        if (!words) return Promise.resolve([]);
        var scope = FREE_ROWS.map(function (r) { return '(' + r.q + ')'; }).join(' OR ');
        return archiveQuery('title:(' + words + ') AND (' + scope + ')' + ARCHIVE_FILTER, 60);
    }

    function firstText(v) {
        if (v == null) return '';
        if (Object.prototype.toString.call(v) === '[object Array]') return v.length ? firstText(v[0]) : '';
        return String(v);
    }

    function parseArchiveDocs(json) {
        var docs = (json.response && json.response.docs) || [];
        var out = [];
        docs.forEach(function (d) {
            var id = d.identifier;
            var title = firstText(d.title).trim();
            if (!id || !title) return;
            var parts = [];
            var year = firstText(d.year);
            if (year) parts.push(year.slice(0, 4));
            var secs = runtimeSeconds(firstText(d.runtime));
            if (secs > 0) parts.push(runtimeText(secs));
            parts.push('Public domain');
            var desc = firstText(d.description).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
            out.push({ id: id, t: title, meta: parts.join('  ·  '), d: desc.slice(0, 400), img: 'https://archive.org/services/img/' + id });
        });
        return out;
    }

    /** An item's videos: one for most films, a list for series and collections, the best format of each. */
    function archiveVideos(ident) {
        return get('https://archive.org/metadata/' + encodeURIComponent(ident), 30000).then(function (t) {
            return parseArchiveFiles(ident, JSON.parse(t));
        });
    }

    function parseArchiveFiles(ident, json) {
        var rank = { 'h.264': 1, 'HiRes MPEG4': 2, 'MPEG4': 3, 'h.264 IA': 4, '512Kb MPEG4': 5 };
        var best = {};
        var order = [];
        (json.files || []).forEach(function (f) {
            var r = rank[f.format];
            if (!r || !f.name) return;
            var base = videoBase(f.name);
            if (!best[base]) order.push(base);
            if (!best[base] || r < rank[best[base].format]) best[base] = f;
        });
        var itemTitle = firstText(json.metadata && json.metadata.title);
        // The server the item lives on: archive.org/download sometimes redirects to a mirror that fails.
        var server = (json.workable_servers && json.workable_servers[0]) || json.d1 || json.server;
        var dir = json.dir || '';
        var prefix = server && dir.charAt(0) === '/' ? 'https://' + server + dir + '/' : 'https://archive.org/download/' + ident + '/';
        return order.map(function (base, i) {
            var f = best[base];
            var title = f.title || videoBase(f.name.split('/').pop()).replace(/[_.]/g, ' ').trim();
            if (order.length === 1 && itemTitle) title = itemTitle;
            var secs = runtimeSeconds(f.length || '');
            return {
                id: ident + '/' + f.name, t: title, meta: secs > 0 ? runtimeText(secs) : '', dur: secs, n: i + 1,
                url: prefix + f.name.split('/').map(function (p) { return encodeURIComponent(p); }).join('/')
            };
        });
    }

    /** "his_girl_friday_512kb.mp4" and "his_girl_friday.mp4" are the same video. */
    function videoBase(name) {
        var b = name.toLowerCase();
        var dot = b.lastIndexOf('.');
        if (dot > 0) b = b.slice(0, dot);
        return b.replace(/_512kb$/, '').replace(/\.ia$/, '');
    }

    function runtimeText(secs) {
        var mins = Math.floor((secs + 30) / 60);
        if (mins < 60) return mins + 'm';
        var h = Math.floor(mins / 60);
        var rest = mins % 60;
        return rest ? h + 'h ' + rest + 'm' : h + 'h';
    }

    /** "5504.57", "1:31:44" or "91 min" -> seconds (0 when unknown). */
    function runtimeSeconds(s) {
        var t = String(s || '').trim();
        if (!t) return 0;
        if (t.indexOf(':') >= 0) {
            return Math.floor(t.split(':').reduce(function (acc, part) { return acc * 60 + (parseFloat(part) || 0); }, 0));
        }
        var n = /[0-9.]+/.exec(t);
        if (!n) return 0;
        var v = parseFloat(n[0]) || 0;
        return Math.floor(/min/i.test(t) ? v * 60 : v);
    }

    // ---- Where you left off (kept on the TV) ----

    var positions = storedJson('freePos', {});    // id -> [seconds (-1 = watched), duration, when]
    var recent = storedJson('freeRecent', []);    // items left part way, latest first

    function savePositions() {
        var ids = Object.keys(positions);
        if (ids.length > 300) {
            ids.sort(function (a, b) { return positions[a][2] - positions[b][2]; });
            ids.slice(0, ids.length - 300).forEach(function (id) { delete positions[id]; });
        }
        store('freePos', JSON.stringify(positions));
    }

    var Free = {
        rows: FREE_ROWS,
        row: freeRow,
        search: freeSearch,
        videos: archiveVideos,
        runtimeText: runtimeText,
        /** Seconds to resume from, or 0. */
        resumeAt: function (id) {
            var p = positions[id];
            return p && p[0] >= 60 ? p[0] : 0;
        },
        watched: function (id) { var p = positions[id]; return !!p && p[0] < 0; },
        /** 0..1 of the way through (1 when finished). */
        progress: function (id) {
            var p = positions[id];
            if (!p) return 0;
            if (p[0] < 0) return 1;
            return p[1] > 0 ? Math.min(1, p[0] / p[1]) : 0;
        },
        save: function (id, pos, dur) {
            if (pos < 60) return;
            if (dur > 0 && pos > dur * 0.95) { Free.markWatched(id); return; }
            positions[id] = [Math.floor(pos), Math.floor(dur || 0), Date.now()];
            savePositions();
        },
        /** A series or collection shows its latest video's progress on its own row. */
        saveParent: function (id, pos, dur) {
            if (pos < 60 || !(dur > 0)) return;
            positions[id] = [Math.floor(Math.min(pos, dur * 0.9)), Math.floor(dur), Date.now()];
            savePositions();
        },
        markWatched: function (id) {
            positions[id] = [-1, 0, Date.now()];
            savePositions();
        },
        recent: function () { return recent; },
        /** Moves an item to the front of Continue Watching (or takes it off when it's finished). */
        noteRecent: function (item, finished) {
            var kept = finished ? [] : [{ id: item.id, t: item.t, meta: item.meta, d: (item.d || '').slice(0, 200), img: item.img }];
            recent.forEach(function (r) { if (r.id !== item.id && kept.length < 20) kept.push(r); });
            recent = kept;
            store('freeRecent', JSON.stringify(recent));
        }
    };

    // ---- Search the web (third-party players) ----

    var vod = null;

    function vodSources() {
        if (vod) return Promise.resolve(vod);
        return get('vod_sources.json').then(function (t) {
            vod = JSON.parse(t);
            return vod;
        });
    }

    /** IMDb's title search, or Wikidata's when IMDb refuses the request (it only allows some origins). */
    function searchTitles(q) {
        return searchImdb(q).then(null, function () { return searchWikidata(q); });
    }

    function searchImdb(q) {
        var slug = q.trim().toLowerCase().replace(/\s+/g, '_');
        if (!slug) return Promise.resolve([]);
        var enc = encodeURIComponent(slug);
        return get('https://v3.sg.media-imdb.com/suggestion/' + enc.charAt(0) + '/' + enc + '.json').then(function (t) {
            var d = JSON.parse(t).d || [];
            var kinds = { movie: 1, tvSeries: 1, tvMiniSeries: 1, tvMovie: 1 };
            return d.filter(function (o) { return /^tt/.test(o.id) && kinds[o.qid]; }).map(function (o) {
                return {
                    imdb: o.id, title: o.l, year: o.yr || (o.y ? String(o.y) : ''),
                    poster: o.i && o.i.imageUrl ? o.i.imageUrl.replace('._V1_.', '._V1_UX240_.') : null,
                    show: o.qid === 'tvSeries' || o.qid === 'tvMiniSeries'
                };
            });
        });
    }

    var tmdbCache = {};

    var WIKIDATA_SEARCH = [
        'SELECT ?imdb ?label ?show ?tmdbM ?tmdbT ?year ?num WHERE {',
        ' SERVICE wikibase:mwapi { bd:serviceParam wikibase:api "EntitySearch"; wikibase:endpoint "www.wikidata.org";',
        '  mwapi:search "%Q%"; mwapi:language "en"; mwapi:limit "25".',
        '  ?item wikibase:apiOutputItem mwapi:item. ?num wikibase:apiOrdinal true. }',
        ' ?item wdt:P345 ?imdb. FILTER(STRSTARTS(?imdb, "tt"))',
        ' ?item wdt:P31 ?type. VALUES (?type ?show) { (wd:Q11424 false) (wd:Q506240 false) (wd:Q5398426 true) (wd:Q1259759 true) (wd:Q581714 true) }',
        ' OPTIONAL { ?item wdt:P4947 ?tmdbM } OPTIONAL { ?item wdt:P4983 ?tmdbT }',
        ' OPTIONAL { ?item wdt:P577 ?date. BIND(YEAR(?date) AS ?year) }',
        ' ?item rdfs:label ?label. FILTER(LANG(?label) = "en")',
        '} ORDER BY ?num LIMIT 60'
    ].join('\n');

    /** Title search through Wikidata (no posters, but it also gives the TMDB id). */
    function searchWikidata(q) {
        var safe = q.trim().replace(/["\\]/g, ' ');
        if (!safe) return Promise.resolve([]);
        var url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(WIKIDATA_SEARCH.replace('%Q%', safe));
        return get(url, 20000).then(function (t) {
            var seen = {};
            var out = [];
            JSON.parse(t).results.bindings.forEach(function (b) {
                var id = b.imdb.value;
                var show = b.show.value === 'true';
                var tmdb = (show ? b.tmdbT : b.tmdbM) || null;
                if (tmdb) tmdbCache[id] = tmdb.value;
                if (seen[id]) return;
                seen[id] = true;
                out.push({ imdb: id, title: b.label.value, year: b.year ? b.year.value : '', poster: null, show: show });
            });
            return out;
        });
    }

    /** TMDB id from Wikidata (no API key needed), or null. */
    function tmdbId(title) {
        if (title.imdb in tmdbCache) return Promise.resolve(tmdbCache[title.imdb]);
        var prop = title.show ? 'P4983' : 'P4947';
        var q = 'SELECT ?t WHERE { ?i wdt:P345 "' + title.imdb + '"; wdt:' + prop + ' ?t } LIMIT 1';
        return get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), 15000).then(function (t) {
            var b = JSON.parse(t).results.bindings;
            return b.length ? b[0].t.value : null;
        }, function () { return null; }).then(function (id) {
            tmdbCache[title.imdb] = id;
            return id;
        });
    }

    function vodUrl(provider, title, tmdb, season, episode) {
        var t = title.show ? provider.tv : provider.movie;
        if (!t) return null;
        if (t.indexOf('{tmdb}') >= 0 && !tmdb) return null;
        return t.replace('{imdb}', title.imdb).replace('{tmdb}', tmdb || '')
            .replace('{season}', season).replace('{episode}', episode);
    }

    return {
        loadChannels: loadChannels, nowNext: nowNext, store: store, storedJson: storedJson, isOfficial: isOfficial,
        parseM3u: parseM3u, mergeDuplicates: mergeDuplicates, officialFeeds: officialFeeds, categoryOrder: CATEGORY_ORDER,
        Free: Free,
        vodSources: vodSources, searchTitles: searchTitles, tmdbId: tmdbId, vodUrl: vodUrl
    };
})();
