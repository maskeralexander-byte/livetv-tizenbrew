/* Live TV for Samsung Smart TVs (Tizen). Remote-first: everything works with the D-pad, OK and BACK. */
'use strict';

(function () {
    var $ = function (id) { return document.getElementById(id); };
    var searchInput = document.getElementById('search');
    var ROW_H = 96;
    var VISIBLE_ROWS = 9;

    var state = {
        channels: [],
        errors: [],
        loading: true,
        officialOnly: Data.store('officialOnly') !== '0',
        favorites: JSON.parse(Data.store('favorites') || '[]'),
        recents: JSON.parse(Data.store('recents') || '[]'),
        section: { kind: 'all' },     // all | favorites | recent | group | movies
        menu: [],
        menuIndex: 0,
        focus: 'list',                // menu | toolbar | list
        toolbarIndex: 0,
        rows: [],                     // what the list shows now
        rowIndex: 0,
        // movies
        results: [],
        query: '',
        searching: false,
        title: null,                  // picked show
        season: 1,
        episode: 1,
        episodeField: 2               // 0 season, 1 episode, 2 play
    };

    var player = {
        open: false, mode: null, list: [], index: 0, hls: null, bannerTimer: null, digits: '', digitTimer: null,
        sources: [], sourceIndex: 0, title: null, tmdb: null
    };

    // ---- Keys ----

    var KEYS = {
        37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 10009: 'back', 8: 'back', 27: 'back',
        427: 'chup', 428: 'chdown', 33: 'chup', 34: 'chdown', 10252: 'playpause', 415: 'play', 19: 'pause',
        403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info', 73: 'info'
    };

    function registerTvKeys() {
        try {
            var keys = ['ChannelUp', 'ChannelDown', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'ColorF0Red',
                'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
            keys.forEach(function (k) { try { tizen.tvinputdevice.registerKey(k); } catch (e) {} });
        } catch (e) {
            // Not on a TV (testing in a browser).
        }
    }

    document.addEventListener('keydown', function (e) {
        if (document.activeElement === searchInput) {
            if (e.keyCode === 13 || e.keyCode === 65376) { e.preventDefault(); searchInput.blur(); runSearch(); return; }
            if (e.keyCode === 10009 || e.keyCode === 27 || e.keyCode === 65385) { e.preventDefault(); searchInput.blur(); return; }
            if (e.keyCode === 40) { searchInput.blur(); state.focus = 'list'; render(); return; }
            return;
        }
        var key = KEYS[e.keyCode];
        if (e.keyCode >= 48 && e.keyCode <= 57) key = 'digit';
        if (!key) return;
        e.preventDefault();
        if (player.open) playerKey(key, e.keyCode - 48);
        else browseKey(key);
    });

    // ---- Browse ----

    function buildMenu() {
        var groups = {};
        visibleChannels().forEach(function (c) { groups[c.group] = (groups[c.group] || 0) + 1; });
        var top = Object.keys(groups).sort(function (a, b) { return groups[b] - groups[a]; }).slice(0, 14);
        state.menu = [
            { label: 'All channels', section: { kind: 'all' } },
            { label: 'Favorites', section: { kind: 'favorites' } },
            { label: 'Recently watched', section: { kind: 'recent' } },
            { label: 'Movies & Shows', section: { kind: 'movies' }, accent: true },
            { header: 'Categories' }
        ].concat(top.sort().map(function (g) {
            return { label: g, count: groups[g], section: { kind: 'group', group: g } };
        }));
    }

    function visibleChannels() {
        return state.officialOnly ? state.channels.filter(function (c) { return c.official; }) : state.channels;
    }

    function computeRows() {
        var s = state.section;
        var all = visibleChannels();
        if (s.kind === 'movies') {
            state.rows = state.title ? [] : state.results;
        } else if (s.kind === 'favorites') {
            state.rows = state.channels.filter(function (c) { return state.favorites.indexOf(c.url) >= 0; });
        } else if (s.kind === 'recent') {
            var byUrl = {};
            state.channels.forEach(function (c) { byUrl[c.url] = c; });
            state.rows = state.recents.map(function (u) { return byUrl[u]; }).filter(Boolean);
        } else if (s.kind === 'group') {
            state.rows = all.filter(function (c) { return c.group === s.group; });
        } else {
            state.rows = all;
        }
        if (state.rowIndex >= state.rows.length) state.rowIndex = Math.max(0, state.rows.length - 1);
    }

    function toolbarItems() {
        if (state.section.kind === 'movies') return state.title ? [] : ['search'];
        return ['official', 'all'];
    }

    function selectSection(item) {
        state.section = item.section;
        state.rowIndex = 0;
        if (item.section.kind !== 'movies') state.title = null;
        computeRows();
        if (item.section.kind === 'movies' && !state.results.length) {
            state.focus = 'toolbar';
            state.toolbarIndex = 0;
        } else {
            state.focus = 'list';
        }
        render();
    }

    function browseKey(key) {
        if (state.title) return episodeKey(key);
        var tb = toolbarItems();
        if (state.focus === 'menu') {
            if (key === 'up') moveMenu(-1);
            else if (key === 'down') moveMenu(1);
            else if (key === 'right') { state.focus = state.rows.length ? 'list' : (tb.length ? 'toolbar' : 'list'); render(); }
            else if (key === 'back') exitApp();
            else if (key === 'ok') selectSection(state.menu[state.menuIndex]);
        } else if (state.focus === 'toolbar') {
            if (key === 'left') { if (state.toolbarIndex > 0) state.toolbarIndex--; else state.focus = 'menu'; render(); }
            else if (key === 'right') { if (state.toolbarIndex < tb.length - 1) state.toolbarIndex++; render(); }
            else if (key === 'down') { if (state.rows.length) state.focus = 'list'; render(); }
            else if (key === 'back') { state.focus = 'menu'; render(); }
            else if (key === 'ok') {
                var t = tb[state.toolbarIndex];
                if (t === 'search') { searchInput.focus(); }
                else { setOfficial(t === 'official'); }
            }
        } else {
            if (key === 'up') {
                if (state.rowIndex > 0) state.rowIndex--; else if (tb.length) state.focus = 'toolbar';
                render();
            } else if (key === 'down') { if (state.rowIndex < state.rows.length - 1) state.rowIndex++; render(); }
            else if (key === 'chup') { state.rowIndex = Math.max(0, state.rowIndex - VISIBLE_ROWS); render(); }
            else if (key === 'chdown') { state.rowIndex = Math.min(state.rows.length - 1, state.rowIndex + VISIBLE_ROWS); render(); }
            else if (key === 'left' || key === 'back') { state.focus = 'menu'; render(); }
            else if (key === 'ok') openRow();
            else if ((key === 'right' || key === 'yellow') && state.section.kind !== 'movies') toggleFavorite(state.rows[state.rowIndex]);
        }
    }

    function moveMenu(d) {
        var i = state.menuIndex;
        do { i += d; } while (state.menu[i] && state.menu[i].header);
        if (state.menu[i]) state.menuIndex = i;
        render();
    }

    function setOfficial(on) {
        state.officialOnly = on;
        Data.store('officialOnly', on ? '1' : '0');
        buildMenu();
        computeRows();
        render();
    }

    function toggleFavorite(c) {
        if (!c) return;
        var i = state.favorites.indexOf(c.url);
        if (i >= 0) state.favorites.splice(i, 1); else state.favorites.push(c.url);
        Data.store('favorites', JSON.stringify(state.favorites));
        render();
    }

    function openRow() {
        var item = state.rows[state.rowIndex];
        if (!item) return;
        if (state.section.kind === 'movies') {
            if (item.show) {
                state.title = item;
                state.season = 1;
                state.episode = 1;
                state.episodeField = 2;
                render();
            } else {
                playVod(item, 1, 1);
            }
        } else {
            playLive(state.rows, state.rowIndex);
        }
    }

    function exitApp() {
        try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
    }

    // ---- Episode picker ----

    function episodeKey(key) {
        if (key === 'back') { state.title = null; computeRows(); render(); return; }
        if (key === 'up') state.episodeField = Math.max(0, state.episodeField - 1);
        else if (key === 'down') state.episodeField = Math.min(2, state.episodeField + 1);
        else if (key === 'left' || key === 'right') {
            var d = key === 'left' ? -1 : 1;
            if (state.episodeField === 0) { state.season = Math.max(1, state.season + d); state.episode = 1; }
            else if (state.episodeField === 1) state.episode = Math.max(1, state.episode + d);
        } else if (key === 'ok') {
            if (state.episodeField === 2) playVod(state.title, state.season, state.episode);
            else state.episodeField = 2;
        }
        render();
    }

    // ---- Movies search ----

    function runSearch() {
        var q = searchInput.value.trim();
        if (!q) return;
        state.query = q;
        state.searching = true;
        state.results = [];
        render();
        Data.searchTitles(q).then(function (r) {
            state.results = r;
            state.searchError = null;
        }, function (e) {
            state.searchError = 'Search failed: ' + e.message;
        }).then(function () {
            state.searching = false;
            state.rowIndex = 0;
            computeRows();
            state.focus = state.rows.length ? 'list' : 'toolbar';
            render();
        });
    }

    // ---- Rendering ----

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function render() {
        renderMenu();
        renderTop();
        renderList();
    }

    function renderMenu() {
        $('menu').innerHTML = '<div class="brand">LIVE<span>TV</span></div>' + state.menu.map(function (m, i) {
            if (m.header) return '<div class="menu-header">' + esc(m.header) + '</div>';
            var cls = 'menu-item';
            if (i === state.menuIndex && state.focus === 'menu') cls += ' focused';
            if (sameSection(m.section, state.section)) cls += ' selected';
            if (m.accent) cls += ' accent';
            return '<div class="' + cls + '"><span>' + esc(m.label) + '</span>' +
                (m.count ? '<em>' + m.count + '</em>' : '') + '</div>';
        }).join('');
        var f = $('menu').querySelector('.focused') || $('menu').querySelector('.selected');
        if (f) f.scrollIntoView({ block: 'nearest' });
    }

    function sameSection(a, b) { return a.kind === b.kind && a.group === b.group; }

    function renderTop() {
        var s = state.section;
        var title = s.kind === 'movies' ? 'Movies & Shows' : s.kind === 'favorites' ? 'Favorites' :
            s.kind === 'recent' ? 'Recently watched' : s.kind === 'group' ? s.group : 'All channels';
        $('title').textContent = title;
        var tb = toolbarItems();
        var html = '';
        if (s.kind === 'movies' && !state.title) {
            html = '<div class="search-box' + (state.focus === 'toolbar' ? ' focused' : '') + '" id="searchSlot"></div>';
        } else if (s.kind !== 'movies') {
            html = ['official', 'all'].map(function (t, i) {
                var on = (t === 'official') === state.officialOnly;
                var cls = 'chip' + (on ? ' on' : '') + (state.focus === 'toolbar' && state.toolbarIndex === i ? ' focused' : '');
                return '<div class="' + cls + '">' + (t === 'official' ? 'Official channels' : 'All streams') + '</div>';
            }).join('');
        }
        // The search box is one element that moves between the toolbar and <body>, so typing and
        // focus survive re-renders. Park it before the toolbar is rebuilt.
        var input = searchInput;
        if (input.parentNode !== document.body) document.body.appendChild(input);
        $('toolbar').innerHTML = html;
        var slot = $('searchSlot');
        if (slot) {
            var hadFocus = document.activeElement === input;
            slot.appendChild(input);
            if (hadFocus) input.focus();
            input.placeholder = 'Search a movie or show (press OK to type)';
            input.style.display = '';
        } else {
            input.style.display = 'none';
        }
        var status = '';
        if (state.loading && s.kind !== 'movies') status = 'Loading channels…';
        else if (s.kind === 'movies') {
            if (state.searching) status = 'Searching…';
            else if (state.searchError) status = state.searchError;
            else if (!state.title && state.query) status = state.results.length + ' results for “' + esc(state.query) + '”';
        } else {
            status = state.rows.length + ' channels' + (state.errors.length ? ' · Couldn’t update: ' + esc(state.errors.join('; ')) : '');
        }
        $('status').innerHTML = status;
    }

    function renderList() {
        var list = $('list');
        if (state.title) { list.innerHTML = episodeHtml(); return; }
        var rows = state.rows;
        if (!rows.length) {
            var msg = state.section.kind === 'movies'
                ? (state.query && !state.searching ? 'No movies or shows found.' : 'Press ▲ then OK to search for a title.')
                : (state.loading ? '' : state.section.kind === 'favorites' ? 'Press ▶ on a channel to add it here.' : 'Nothing here yet.');
            list.innerHTML = '<div class="empty">' + msg + '</div>';
            return;
        }
        var start = Math.max(0, Math.min(state.rowIndex - Math.floor(VISIBLE_ROWS / 2), rows.length - VISIBLE_ROWS));
        var end = Math.min(rows.length, start + VISIBLE_ROWS + 1);
        var html = '';
        for (var i = start; i < end; i++) {
            html += state.section.kind === 'movies' ? titleRow(rows[i], i) : channelRow(rows[i], i);
        }
        list.innerHTML = html;
    }

    function channelRow(c, i) {
        var focused = i === state.rowIndex && state.focus === 'list';
        var fav = state.favorites.indexOf(c.url) >= 0;
        var now = Data.nowOn(c);
        var sub = now ? '<span class="dot"></span>' + esc(now.title) : esc(c.group);
        return '<div class="row' + (focused ? ' focused' : '') + '">' +
            '<div class="num">' + (i + 1) + '</div>' +
            logo(c.logo, c.name) +
            '<div class="text"><div class="name">' + esc(c.name) + '</div><div class="sub">' + sub + '</div>' +
            (now ? '<div class="progress"><i style="width:' + Math.round(100 * (Date.now() - now.start) / (now.stop - now.start)) + '%"></i></div>' : '') +
            '</div><div class="fav' + (fav ? ' on' : '') + '">' + (fav ? '★' : '☆') + '</div></div>';
    }

    function titleRow(t, i) {
        var focused = i === state.rowIndex && state.focus === 'list';
        return '<div class="row' + (focused ? ' focused' : '') + '">' +
            logo(t.poster, t.title, true) +
            '<div class="text"><div class="name">' + esc(t.title) + '</div><div class="sub' + (t.show ? ' cyan' : '') + '">' +
            (t.show ? 'Show' : 'Movie') + (t.year ? ' · ' + esc(t.year) : '') + '</div></div>' +
            '<div class="fav">▶</div></div>';
    }

    function logo(src, name, poster) {
        var cls = poster ? 'logo poster' : 'logo';
        var initials = esc((name || '').slice(0, 2).toUpperCase());
        if (!src) return '<div class="' + cls + '">' + initials + '</div>';
        return '<div class="' + cls + '"><img src="' + esc(src) + '" onerror="this.parentNode.textContent=\'' + initials + '\'"></div>';
    }

    function episodeHtml() {
        var t = state.title;
        function field(i, label, value) {
            return '<div class="stepper' + (state.episodeField === i ? ' focused' : '') + '"><span>' + label +
                '</span><b>◀</b><strong>' + value + '</strong><b>▶</b></div>';
        }
        return '<div class="episodes">' + logo(t.poster, t.title, true) +
            '<div class="ep-body"><div class="ep-title">' + esc(t.title) + '</div><div class="sub">' + esc(t.year) + '</div>' +
            field(0, 'Season', state.season) + field(1, 'Episode', state.episode) +
            '<div class="play-btn' + (state.episodeField === 2 ? ' focused' : '') + '">▶ Play S' + pad(state.season) + ' E' + pad(state.episode) + '</div>' +
            '<div class="hint">▲▼ choose · ◀▶ change · OK play · BACK results</div></div></div>';
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function tickClock() {
        var d = new Date();
        var h = d.getHours() % 12 || 12;
        $('clock').textContent = h + ':' + pad(d.getMinutes()) + (d.getHours() < 12 ? ' AM' : ' PM');
    }

    // ---- Player ----

    function showPlayer(mode) {
        player.open = true;
        player.mode = mode;
        $('player').classList.remove('hidden');
        $('video').style.display = mode === 'live' ? '' : 'none';
        $('frame').style.display = mode === 'vod' ? '' : 'none';
    }

    function closePlayer() {
        stopVideo();
        $('frame').src = 'about:blank';
        $('player').classList.add('hidden');
        $('playerMsg').classList.add('hidden');
        player.open = false;
        render();
    }

    function stopVideo() {
        if (player.hls) { player.hls.destroy(); player.hls = null; }
        var v = $('video');
        v.pause();
        v.removeAttribute('src');
        v.load();
    }

    function playLive(list, index) {
        player.list = list;
        showPlayer('live');
        tune(index);
    }

    function tune(index) {
        var n = player.list.length;
        if (!n) return;
        player.index = (index + n) % n;
        var c = player.list[player.index];
        state.rowIndex = player.index;
        state.recents = [c.url].concat(state.recents.filter(function (u) { return u !== c.url; })).slice(0, 50);
        Data.store('recents', JSON.stringify(state.recents));
        stopVideo();
        $('playerMsg').classList.add('hidden');
        var v = $('video');
        var native = v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL');
        if (!native && window.Hls && Hls.isSupported() && /\.m3u8?(\?|$)/i.test(c.url)) {
            player.hls = new Hls({ liveDurationInfinity: true });
            player.hls.on(Hls.Events.ERROR, function (ev, data) { if (data.fatal) failed(); });
            player.hls.loadSource(c.url);
            player.hls.attachMedia(v);
        } else {
            v.src = c.url;
        }
        v.onerror = failed;
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
        showBanner();
    }

    function failed() {
        var m = $('playerMsg');
        m.textContent = 'This channel isn’t working right now. Press ▲/▼ for another.';
        m.classList.remove('hidden');
    }

    function showBanner() {
        var b = $('banner');
        if (player.mode === 'live') {
            var c = player.list[player.index];
            var now = Data.nowOn(c);
            $('bannerNum').textContent = player.index + 1;
            $('bannerTitle').textContent = c.name;
            $('bannerSub').textContent = now ? 'Now: ' + now.title : c.group;
            $('bannerHint').textContent = '▲▼ channel · ▶ favorite · BACK list';
        } else {
            var t = player.title;
            $('bannerNum').textContent = '';
            $('bannerTitle').textContent = t.title + (t.show ? '  S' + pad(player.season) + ' E' + pad(player.episode) : '');
            var s = player.sources[player.sourceIndex];
            $('bannerSub').textContent = player.sources.length
                ? 'Source ' + (player.sourceIndex + 1) + ' of ' + player.sources.length + ' · ' + s.name
                : 'No sources for this title';
            $('bannerHint').textContent = '◀▶ or CH change source · BACK exit';
        }
        b.classList.remove('hidden');
        clearTimeout(player.bannerTimer);
        player.bannerTimer = setTimeout(function () { b.classList.add('hidden'); }, 5000);
    }

    function playerKey(key, digit) {
        if (key === 'back') {
            if (player.mode === 'vod' && state.title) { state.episodeField = 2; }
            closePlayer();
            return;
        }
        if (player.mode === 'live') {
            if (key === 'up' || key === 'chup') tune(player.index - 1);
            else if (key === 'down' || key === 'chdown') tune(player.index + 1);
            else if (key === 'right' || key === 'yellow') { toggleFavorite(player.list[player.index]); showBanner(); }
            else if (key === 'digit') typeDigit(digit);
            else if (key === 'playpause' || key === 'pause' || key === 'play') { var v = $('video'); if (v.paused) v.play(); else v.pause(); }
            else showBanner();
        } else {
            if (key === 'left' || key === 'chdown') switchSource(-1);
            else if (key === 'right' || key === 'chup') switchSource(1);
            else showBanner();
        }
    }

    function typeDigit(d) {
        player.digits += d;
        $('bannerNum').textContent = player.digits;
        $('banner').classList.remove('hidden');
        clearTimeout(player.digitTimer);
        player.digitTimer = setTimeout(function () {
            var n = parseInt(player.digits, 10);
            player.digits = '';
            if (n >= 1 && n <= player.list.length) tune(n - 1);
        }, 1500);
    }

    // ---- Movies & shows player ----

    function playVod(title, season, episode) {
        player.title = title;
        player.season = season;
        player.episode = episode;
        player.sources = [];
        showPlayer('vod');
        $('frame').src = 'about:blank';
        $('bannerTitle').textContent = title.title;
        $('bannerSub').textContent = 'Finding sources…';
        $('banner').classList.remove('hidden');
        Promise.all([Data.vodSources(), Data.tmdbId(title)]).then(function (r) {
            var cfg = r[0];
            player.tmdb = r[1];
            player.sources = cfg.providers.filter(function (p) { return Data.vodUrl(p, title, player.tmdb, season, episode); });
            var last = Data.store('vodLast');
            player.sourceIndex = Math.max(0, player.sources.map(function (p) { return p.name; }).indexOf(last));
            loadSource();
        }, function () {
            $('bannerSub').textContent = 'Couldn’t load the source list';
        });
    }

    function switchSource(d) {
        if (!player.sources.length) return;
        player.sourceIndex = (player.sourceIndex + d + player.sources.length) % player.sources.length;
        loadSource();
    }

    function loadSource() {
        var p = player.sources[player.sourceIndex];
        if (p) {
            Data.store('vodLast', p.name);
            $('frame').src = Data.vodUrl(p, player.title, player.tmdb, player.season, player.episode);
        }
        showBanner();
    }

    // ---- Start ----

    function load(force) {
        state.loading = true;
        render();
        Data.loadChannels(force).then(function (r) {
            state.channels = r.channels;
            state.errors = r.errors;
            state.loading = false;
            buildMenu();
            computeRows();
            render();
        });
    }

    registerTvKeys();
    buildMenu();
    computeRows();
    tickClock();
    setInterval(tickClock, 15000);
    // Keeps the "now playing" lines and progress bars current.
    setInterval(function () { if (!player.open && state.section.kind !== 'movies') render(); }, 60000);
    load(false);
})();
