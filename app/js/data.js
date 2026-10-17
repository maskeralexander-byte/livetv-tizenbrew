/* Channel lists, guide and movie sources for the Samsung TV app. Mirrors the phone app's data layer. */
'use strict';

var Data = (function () {
    var ENGLISH_URL = 'https://iptv-org.github.io/iptv/languages/eng.m3u';
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

    function parseM3u(text, source) {
        var out = [];
        var lines = text.split(/\r?\n/);
        var info = null;
        var attrRe = /([\w-]+)="([^"]*)"/g;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.indexOf('#EXTINF') === 0) {
                info = line;
            } else if (line.charAt(0) !== '#' && info) {
                var attrs = {};
                var m;
                attrRe.lastIndex = 0;
                while ((m = attrRe.exec(info))) attrs[m[1].toLowerCase()] = m[2];
                var comma = info.lastIndexOf('",');
                var name = comma >= 0 ? info.slice(comma + 2) : info.replace(/^#EXTINF:[^,]*,/, '');
                name = name.replace(/\s*\(\d{3,4}[pi]\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim() || attrs['tvg-name'] || 'Unknown';
                var group = (attrs['group-title'] || '').split(';')[0];
                if (!group || group.toLowerCase() === 'undefined') group = 'Other';
                out.push({
                    url: line, name: name, logo: attrs['tvg-logo'] || null, group: group,
                    source: source, official: isOfficial(line), tvgId: attrs['tvg-id'] || null
                });
                info = null;
            }
        }
        return out;
    }

    /**
     * Pluto TV's US channels and what's on them, from the free XMLTV guide. The file is ~7 MB, so it is
     * scanned with regexes instead of a DOM parser, which is far too slow on a TV.
     */
    function parsePluto(xml) {
        var channels = [];
        var byId = {};
        var chRe = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
        var m;
        while ((m = chRe.exec(xml))) {
            var body = m[2];
            var name = /<display-name>([^<]*)</.exec(body);
            var icon = /<icon src="([^"]*)"/.exec(body);
            var c = {
                url: 'https://jmp2.uk/plu-' + m[1] + '.m3u8',
                name: name ? unescapeXml(name[1]).trim() : m[1],
                logo: icon ? icon[1] : null,
                group: 'Pluto TV', source: 'Pluto TV', official: true, plutoId: m[1], guide: []
            };
            byId[m[1]] = c;
            channels.push(c);
        }
        var now = Date.now();
        var prRe = /<programme channel="([^"]+)" start="([^"]+)" stop="([^"]+)">\s*<title>([^<]*)</g;
        while ((m = prRe.exec(xml))) {
            var ch = byId[m[1]];
            if (!ch) continue;
            var stop = xmltvTime(m[3]);
            if (stop < now) continue;
            ch.guide.push({ start: xmltvTime(m[2]), stop: stop, title: unescapeXml(m[4]) });
        }
        return channels;
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

    function nowOn(channel) {
        if (!channel.guide) return null;
        var now = Date.now();
        for (var i = 0; i < channel.guide.length; i++) {
            var g = channel.guide[i];
            if (g.start <= now && now < g.stop) return g;
        }
        return null;
    }

    /** English channels (iptv-org), the bundled extras and every Pluto TV US channel, without duplicates. */
    function loadChannels(force) {
        var maxAge = force ? 0 : CACHE_MS;
        var errors = [];
        var lists = [
            cached('eng', ENGLISH_URL, maxAge).then(function (t) { return parseM3u(t, 'iptv-org'); },
                function (e) { errors.push('Channel list: ' + e.message); return []; }),
            get('extra_channels.m3u').then(function (t) {
                return parseM3u(t, 'Extra channels').map(function (c) { c.official = true; return c; });
            }, function () { return []; }),
            // ~7 MB, too big to keep in localStorage, so it is fetched on each start (like on Roku).
            get(PLUTO_GUIDE_URL, 60000).then(parsePluto,
                function (e) { errors.push('Pluto TV: ' + e.message); return []; })
        ];
        return Promise.all(lists).then(function (r) {
            var seen = {};
            var plutoSeen = {};
            var all = [];
            r[0].concat(r[1]).forEach(function (c) {
                if (seen[c.url]) return;
                seen[c.url] = true;
                var pm = /jmp2\.uk\/plu-([0-9a-f]+)/i.exec(c.url);
                if (pm) plutoSeen[pm[1]] = true;
                all.push(c);
            });
            r[2].forEach(function (c) {
                if (plutoSeen[c.plutoId] || seen[c.url]) return;
                seen[c.url] = true;
                all.push(c);
            });
            // Guide data for Pluto channels that came from the playlist.
            var guideById = {};
            r[2].forEach(function (c) { guideById[c.plutoId] = c.guide; });
            all.forEach(function (c) {
                var pm = /jmp2\.uk\/plu-([0-9a-f]+)/i.exec(c.url);
                if (pm && guideById[pm[1]]) c.guide = guideById[pm[1]];
            });
            all.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
            return { channels: all, errors: errors };
        });
    }

    // ---- Movies & shows ----

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
        loadChannels: loadChannels, nowOn: nowOn, store: store, isOfficial: isOfficial, parseM3u: parseM3u,
        vodSources: vodSources, searchTitles: searchTitles, tmdbId: tmdbId, vodUrl: vodUrl
    };
})();
