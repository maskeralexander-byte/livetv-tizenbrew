/* Live TV for Samsung Smart TVs (Tizen). Remote-first: everything works with the D-pad, OK and BACK. */
'use strict';

(function () {
    var $ = function (id) { return document.getElementById(id); };
    var searchInput = document.getElementById('search');
    // The Add a channel form's two boxes; like the search box, each moves into its slot when shown.
    var addLink = document.getElementById('addLink');
    var addName = document.getElementById('addName');
    // What's typed is kept as it's typed, so nothing is lost however the box is left.
    addLink.addEventListener('input', function () { if (state.adding) state.adding.link = addLink.value.trim(); });
    addName.addEventListener('input', function () { if (state.adding) state.adding.name = addName.value.trim(); });
    var Free = Data.Free;
    var VISIBLE_ROWS = 9;

    var state = {
        channels: [],                 // merged channels, each with .feeds when it has backups
        visible: [],                  // what All channels and the categories show
        byUrl: {},                    // any feed's URL -> its channel
        errors: [],
        loading: true,
        favorites: Data.storedJson('favorites', []),
        recents: Data.storedJson('recents', []),
        section: { kind: 'all' },     // all | favorites | recent | mine | group | free | movies
        // My channels: the Add form ({ field: 0 link, 1 name, 2 Add, 3 Cancel, link, name, busy, error })
        // while it's open, and the last thing added or removed.
        adding: null,
        notice: '',
        menu: [],
        menuIndex: 0,
        focus: 'list',                // menu | toolbar | list
        toolbarIndex: 0,
        rows: [],                     // what the list shows now
        rowIndex: 0,
        // Search the web
        results: [],
        query: '',
        searching: false,
        title: null,                  // picked show
        season: 1,
        episode: 1,
        episodeField: 2,              // 0 season, 1 episode, 2 play
        // Free to watch
        free: {
            tab: null,                // { kind: 'recent' | 'row' | 'search', index, label }
            items: [],
            loading: false,
            error: null,
            query: '',
            req: 0,
            item: null,               // the title whose page is open
            videos: null,             // its videos, once loaded
            actions: [],              // what the page's list holds: { label, sub, run }
            actionIndex: 0
        }
    };

    var player = {
        open: false, mode: null, list: [], index: 0, feed: 0, tried: {}, bannerTimer: null,
        digits: '', digitTimer: null, msgTimer: null,
        // Search the web
        sources: [], sourceIndex: 0, title: null, tmdb: null, season: 1, episode: 1,
        // Free to watch
        item: null, videos: [], videoIndex: 0, lastSaved: 0, clockTimer: null
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
        if (document.activeElement === addLink || document.activeElement === addName) {
            var a = state.adding;
            var k = e.keyCode;
            // Done, Enter, Back, or moving off the box: keep what was typed and leave the box.
            if (k === 13 || k === 65376 || k === 10009 || k === 27 || k === 65385 || k === 38 || k === 40) {
                e.preventDefault();
                var box = document.activeElement;
                if (a) { a.link = addLink.value.trim(); a.name = addName.value.trim(); }
                box.blur();
                if (a && (k === 13 || k === 65376 || k === 40)) a.field = Math.min(a.field + 1, 2);
                if (a && k === 38) a.field = Math.max(a.field - 1, 0);
                render();
            }
            return;
        }
        if (document.activeElement === searchInput) {
            if (e.keyCode === 13 || e.keyCode === 65376) {
                e.preventDefault();
                searchInput.blur();
                if (state.section.kind === 'free') runFreeSearch(); else runSearch();
                return;
            }
            if (e.keyCode === 10009 || e.keyCode === 27 || e.keyCode === 65385) { e.preventDefault(); searchInput.blur(); return; }
            if (e.keyCode === 40) { searchInput.blur(); if (state.rows.length) state.focus = 'list'; render(); return; }
            return;
        }
        var key = KEYS[e.keyCode];
        if (e.keyCode >= 48 && e.keyCode <= 57) key = 'digit';
        if (!key) return;
        e.preventDefault();
        if (player.open) playerKey(key, e.keyCode - 48);
        else browseKey(key);
    });

    // ---- Channels ----

    function setChannels(list) {
        state.channels = list;
        state.byUrl = {};
        list.forEach(function (c) {
            state.byUrl[c.url] = c;
            (c.feeds || []).forEach(function (f) { if (!state.byUrl[f.url]) state.byUrl[f.url] = c; });
        });
        state.visible = list;
    }

    /** A favorite can be saved under any of a channel's feeds. */
    function isFavorite(c) {
        if (state.favorites.indexOf(c.url) >= 0) return true;
        return (c.feeds || []).some(function (f) { return state.favorites.indexOf(f.url) >= 0; });
    }

    // ---- Browse ----

    function buildMenu() {
        var counts = {};
        state.visible.forEach(function (c) { counts[c.category] = (counts[c.category] || 0) + 1; });
        var mine = counts[Data.MY_CHANNELS] || 0;
        delete counts[Data.MY_CHANNELS];
        state.menu = [
            { label: 'All channels', section: { kind: 'all' } },
            { label: 'Favorites', section: { kind: 'favorites' } },
            { label: 'Recently watched', section: { kind: 'recent' } },
            { label: 'My channels', count: mine, section: { kind: 'mine' } },
            { label: 'Free to watch', section: { kind: 'free' }, accent: true },
            { label: 'Search the web', section: { kind: 'movies' } },
            { header: 'Categories' }
        ].concat(Object.keys(counts).sort().map(function (g) {
            return { label: g, count: counts[g], section: { kind: 'group', group: g } };
        }));
        if (state.menuIndex >= state.menu.length) state.menuIndex = 0;
    }

    function computeRows() {
        var s = state.section;
        if (s.kind === 'movies') {
            state.rows = state.title ? [] : state.results;
        } else if (s.kind === 'free') {
            state.rows = state.free.item ? [] : state.free.items;
        } else if (s.kind === 'favorites') {
            state.rows = state.channels.filter(isFavorite);
        } else if (s.kind === 'recent') {
            var seen = [];
            state.rows = [];
            state.recents.forEach(function (u) {
                var c = state.byUrl[u];
                if (c && seen.indexOf(c) < 0) { seen.push(c); state.rows.push(c); }
            });
        } else if (s.kind === 'mine') {
            state.rows = state.adding ? [] : state.visible.filter(function (c) { return c.mine; });
        } else if (s.kind === 'group') {
            state.rows = state.visible.filter(function (c) { return c.category === s.group; });
        } else {
            state.rows = state.visible;
        }
        if (state.rowIndex >= state.rows.length) state.rowIndex = Math.max(0, state.rows.length - 1);
    }

    function toolbarItems() {
        if (state.section.kind === 'movies') return state.title ? [] : ['search'];
        if (state.section.kind === 'free') return state.free.item ? [] : freeTabs().concat(['search']);
        if (state.section.kind === 'mine') return state.adding ? [] : ['add'];
        return [];
    }

    function selectSection(item) {
        state.section = item.section;
        state.rowIndex = 0;
        if (item.section.kind !== 'movies') state.title = null;
        state.free.item = null;
        state.adding = null;
        state.notice = '';
        computeRows();
        if (item.section.kind === 'free') {
            var tabs = freeTabs();
            state.focus = 'toolbar';
            state.toolbarIndex = 0;
            selectFreeTab(tabs[0]);
            return;
        }
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
        if (state.free.item) return freePageKey(key);
        if (state.adding) return addKey(key);
        var tb = toolbarItems();
        if (state.focus === 'menu') {
            if (key === 'up') moveMenu(-1);
            else if (key === 'down') moveMenu(1);
            else if (key === 'right') { state.focus = state.rows.length || !tb.length ? 'list' : 'toolbar'; render(); }
            else if (key === 'back') exitApp();
            else if (key === 'ok') selectSection(state.menu[state.menuIndex]);
        } else if (state.focus === 'toolbar') {
            if (key === 'left') {
                if (state.toolbarIndex > 0) state.toolbarIndex--; else state.focus = 'menu';
                if (state.section.kind === 'free' && state.focus === 'toolbar') pickFreeChip(); else render();
            } else if (key === 'right') {
                if (state.toolbarIndex < tb.length - 1) state.toolbarIndex++;
                if (state.section.kind === 'free') pickFreeChip(); else render();
            } else if (key === 'down') { if (state.rows.length) state.focus = 'list'; render(); }
            else if (key === 'back') { state.focus = 'menu'; render(); }
            else if (key === 'ok') {
                var t = tb[state.toolbarIndex];
                if (t === 'search') { searchInput.focus(); }
                else if (t === 'add') openAddForm();
                else if (state.section.kind === 'free') {
                    if (state.free.error || !sameTab(t, state.free.tab)) { state.free.tab = null; selectFreeTab(t); }
                    else if (state.rows.length) { state.focus = 'list'; render(); }
                }
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
            else if ((key === 'right' || key === 'yellow') && isChannelSection()) toggleFavorite(state.rows[state.rowIndex]);
            else if (key === 'red' && state.section.kind === 'mine') removeMine(state.rows[state.rowIndex]);
        }
    }

    function isChannelSection() { return state.section.kind !== 'movies' && state.section.kind !== 'free'; }

    function moveMenu(d) {
        var i = state.menuIndex;
        do { i += d; } while (state.menu[i] && state.menu[i].header);
        if (state.menu[i]) state.menuIndex = i;
        render();
    }

    // ---- My channels ----

    function openAddForm() {
        state.adding = { field: 0, link: '', name: '', busy: false, error: '' };
        state.notice = '';
        addLink.value = '';
        addName.value = '';
        state.focus = 'list';
        computeRows();
        render();
    }

    function closeAddForm() {
        state.adding = null;
        computeRows();
        state.focus = state.rows.length ? 'list' : 'toolbar';
        state.toolbarIndex = 0;
        render();
    }

    /** ▲▼ between the boxes and the buttons, ◀▶ between Add and Cancel, OK to type or press. */
    function addKey(key) {
        var a = state.adding;
        if (a.busy) return;
        if (key === 'up') a.field = a.field === 3 ? 1 : Math.max(0, a.field - 1);
        else if (key === 'down') a.field = Math.min(a.field + 1, 2);
        else if (key === 'left' && a.field === 3) a.field = 2;
        else if (key === 'right' && a.field === 2) a.field = 3;
        else if (key === 'back' || (key === 'left' && a.field < 2)) return closeAddForm();
        else if (key === 'ok') {
            if (a.field === 0) { render(); addLink.focus(); return; }
            if (a.field === 1) { render(); addName.focus(); return; }
            if (a.field === 3) return closeAddForm();
            return submitAdd();
        }
        render();
    }

    function submitAdd() {
        var a = state.adding;
        if (!/^https?:\/\/\S+$/i.test(a.link)) {
            a.error = 'Type the link first: it starts with http:// or https://';
            a.field = 0;
            render();
            return;
        }
        a.busy = true;
        a.error = '';
        render();
        Data.addMyLink(a.name, a.link).then(function (r) {
            state.adding = null;
            state.notice = r.kind === 'playlist' ? 'Added the playlist “' + r.name + '”.' : 'Added ' + r.name + '.';
            load(false);
        }, function (e) {
            a.busy = false;
            a.error = e.message;
            a.field = 0;
            render();
        });
    }

    /** RED on one of My channels: removes it, or the whole playlist it came from. */
    function removeMine(c) {
        if (!c || !c.mine) return;
        var url = c.mine === 'link' ? c.url : c.mine;
        var playlist = c.mine !== 'link' && Data.myLinks('playlist').filter(function (l) { return l.url === url; })[0];
        Data.removeMyLink(url);
        state.notice = playlist ? 'Removed the playlist “' + playlist.name + '” and its channels.' : 'Removed ' + c.name + '.';
        load(false);
    }

    function toggleFavorite(c) {
        if (!c) return;
        var urls = [c.url].concat((c.feeds || []).map(function (f) { return f.url; }));
        if (isFavorite(c)) state.favorites = state.favorites.filter(function (u) { return urls.indexOf(u) < 0; });
        else state.favorites.push(c.url);
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
        } else if (state.section.kind === 'free') {
            openFreePage(item);
        } else {
            playLive(state.rows, state.rowIndex);
        }
    }

    function exitApp() {
        try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
    }

    // ---- Free to watch ----

    function freeTabs() {
        var tabs = [];
        if (Free.recent().length) tabs.push({ kind: 'recent', label: 'Continue Watching' });
        Free.rows.forEach(function (r, i) { tabs.push({ kind: 'row', index: i, label: r.title }); });
        return tabs;
    }

    /** The chip under the focus becomes the list (the search box at the end only takes focus). */
    function pickFreeChip() {
        var t = toolbarItems()[state.toolbarIndex];
        if (t && t !== 'search') selectFreeTab(t); else render();
    }

    function sameTab(a, b) { return !!a && !!b && a.kind === b.kind && a.index === b.index; }

    function selectFreeTab(tab) {
        var f = state.free;
        if (sameTab(f.tab, tab) && !f.error) { render(); return; }
        f.tab = tab;
        f.error = null;
        state.rowIndex = 0;
        var req = ++f.req;
        if (tab.kind === 'recent') {
            f.items = Free.recent().slice();
            f.loading = false;
            computeRows();
            render();
            return;
        }
        f.items = [];
        f.loading = true;
        computeRows();
        render();
        Free.row(tab.index).then(function (items) {
            if (req !== f.req) return;
            f.items = items;
        }, function (e) {
            if (req !== f.req) return;
            f.error = 'Couldn’t load ' + tab.label + ' (' + e.message + '). Press OK on the chip to try again.';
        }).then(function () {
            if (req !== f.req) return;
            f.loading = false;
            computeRows();
            render();
        });
    }

    function runFreeSearch() {
        var q = searchInput.value.trim();
        if (!q) return;
        var f = state.free;
        f.query = q;
        f.tab = { kind: 'search', label: q };
        f.items = [];
        f.error = null;
        f.loading = true;
        state.rowIndex = 0;
        var req = ++f.req;
        computeRows();
        render();
        Free.search(q).then(function (items) {
            if (req === f.req) f.items = items;
        }, function (e) {
            if (req === f.req) f.error = 'Search failed: ' + e.message;
        }).then(function () {
            if (req !== f.req) return;
            f.loading = false;
            computeRows();
            if (state.rows.length) state.focus = 'list';
            render();
        });
    }

    /** A title's page: Play / Resume for a film, a list of videos for a series or collection. */
    function openFreePage(item) {
        var f = state.free;
        f.item = item;
        f.videos = null;
        f.actions = [];
        f.actionIndex = 0;
        f.pageError = null;
        computeRows();
        render();
        Free.videos(item.id).then(function (videos) {
            if (f.item !== item) return;
            f.videos = videos;
            buildFreeActions();
            render();
        }, function (e) {
            if (f.item !== item) return;
            f.pageError = 'Couldn’t load this title (' + e.message + '). Press BACK and try again.';
            render();
        });
    }

    function buildFreeActions() {
        var f = state.free;
        var videos = f.videos || [];
        f.actions = [];
        if (!videos.length) {
            f.pageError = 'This title isn’t available to play.';
        } else if (videos.length === 1) {
            var at = Free.resumeAt(videos[0].id);
            if (at > 0) {
                f.actions.push({ label: 'Resume from ' + clock(at), run: function () { playFree(f.item, videos, 0, at); } });
                f.actions.push({ label: 'Play from the beginning', run: function () { playFree(f.item, videos, 0, 0); } });
            } else {
                f.actions.push({ label: 'Play', run: function () { playFree(f.item, videos, 0, 0); } });
            }
        } else {
            // A show: open on the video watched last, or the next one once it's finished.
            var last = -1;
            videos.forEach(function (v, i) {
                var at = Free.resumeAt(v.id);
                var sub = v.meta;
                if (Free.watched(v.id)) { sub = (sub ? sub + '  ·  ' : '') + 'Watched'; last = i; }
                else if (at > 0) { sub = (sub ? sub + '  ·  ' : '') + 'Resume ' + clock(at); last = i; }
                f.actions.push({
                    label: v.n + '.  ' + v.t, sub: sub, progress: Free.progress(v.id),
                    run: function () { playFree(f.item, videos, i, Free.resumeAt(v.id)); }
                });
            });
            if (last >= 0) f.actionIndex = Free.watched(videos[last].id) ? Math.min(last + 1, videos.length - 1) : last;
        }
        if (f.actionIndex >= f.actions.length) f.actionIndex = 0;
    }

    function freePageKey(key) {
        var f = state.free;
        if (key === 'back' || key === 'left') {
            f.item = null;
            computeRows();
            // Continue Watching may have changed while the page was open.
            if (f.tab && f.tab.kind === 'recent') { f.items = Free.recent().slice(); computeRows(); }
            render();
            return;
        }
        if (key === 'up' && f.actionIndex > 0) f.actionIndex--;
        else if (key === 'down' && f.actionIndex < f.actions.length - 1) f.actionIndex++;
        else if (key === 'chup') f.actionIndex = Math.max(0, f.actionIndex - 6);
        else if (key === 'chdown') f.actionIndex = Math.min(f.actions.length - 1, f.actionIndex + 6);
        else if (key === 'ok' && f.actions[f.actionIndex]) { f.actions[f.actionIndex].run(); return; }
        render();
    }

    // ---- Episode picker (Search the web) ----

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

    // ---- Search the web ----

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
        if (f) keepInView($('menu'), f);
    }

    /** Scrolls a container just enough to show an element. */
    function keepInView(box, el) {
        var top = el.offsetTop - box.offsetTop;
        if (top < box.scrollTop + 40) box.scrollTop = Math.max(0, top - 40);
        else if (top + el.offsetHeight > box.scrollTop + box.clientHeight - 40) box.scrollTop = top + el.offsetHeight - box.clientHeight + 40;
    }

    function sameSection(a, b) { return a.kind === b.kind && a.group === b.group; }

    function sectionTitle() {
        var s = state.section;
        if (s.kind === 'free') return 'Free to watch';
        if (s.kind === 'mine') return 'My channels';
        return s.kind === 'movies' ? 'Search the web' : s.kind === 'favorites' ? 'Favorites' :
            s.kind === 'recent' ? 'Recently watched' : s.kind === 'group' ? s.group : 'All channels';
    }

    function renderTop() {
        var s = state.section;
        $('title').textContent = sectionTitle();
        var html = '';
        if (s.kind === 'free' && !state.free.item) {
            html = '<div class="strip" id="strip">' + freeTabs().map(function (t, i) {
                var on = sameTab(t, state.free.tab);
                var cls = 'chip' + (on ? ' on' : '') + (state.focus === 'toolbar' && state.toolbarIndex === i ? ' focused' : '');
                return '<div class="' + cls + '">' + esc(t.label) + '</div>';
            }).join('') + '<div class="search-box small' + (state.focus === 'toolbar' && state.toolbarIndex === freeTabs().length ? ' focused' : '') +
                '" id="searchSlot"></div></div>';
        } else if (s.kind === 'movies' && !state.title) {
            html = '<div class="search-box' + (state.focus === 'toolbar' ? ' focused' : '') + '" id="searchSlot"></div>';
        } else if (s.kind === 'mine' && !state.adding) {
            html = '<div class="chip' + (state.focus === 'toolbar' ? ' focused' : '') + '">+ Add a channel or playlist</div>';
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
            input.placeholder = s.kind === 'free' ? 'Search free titles' : 'Search a movie or show (press OK to type)';
            if (s.kind === 'free' && !hadFocus) input.value = state.free.query;
            input.style.display = '';
        } else {
            input.style.display = 'none';
        }
        // Keeps the focused chip in view.
        var strip = $('strip');
        var chip = strip && strip.querySelector('.focused');
        if (strip && chip) {
            var bar = $('toolbar');
            if (chip.offsetLeft + chip.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = chip.offsetLeft + chip.offsetWidth - bar.clientWidth + 8;
            if (chip.offsetLeft < bar.scrollLeft) bar.scrollLeft = Math.max(0, chip.offsetLeft - 8);
        } else {
            $('toolbar').scrollLeft = 0;
        }
        $('status').innerHTML = statusText();
    }

    function statusText() {
        var s = state.section;
        if (s.kind === 'free') {
            var f = state.free;
            if (f.item) return '';
            if (f.loading) return 'Loading…';
            if (f.error) return esc(f.error);
            if (f.tab && f.tab.kind === 'search') return f.items.length + ' free titles for “' + esc(f.query) + '”';
            return f.items.length ? 'Public domain films and TV from the Internet Archive' : '';
        }
        if (s.kind === 'movies') {
            if (state.searching) return 'Searching…';
            if (state.searchError) return esc(state.searchError);
            if (!state.title && state.query) return state.results.length + ' results for “' + esc(state.query) + '”';
            return '';
        }
        if (state.loading) return 'Loading channels…';
        if (s.kind === 'mine') {
            if (state.adding) return '';
            if (state.notice) return esc(state.notice);
            return state.rows.length ? state.rows.length + ' channels · RED removes the selected one' : '';
        }
        // Saved copies are showing when a list couldn't update; the details are for troubleshooting.
        return state.rows.length + ' channels' + (state.errors.length ? ' · Some lists couldn’t update (' + esc(state.errors.join('; ')) + ')' : '');
    }

    function renderList() {
        var list = $('list');
        // Redrawing the form while one of its boxes is being typed in would close the TV keyboard.
        if (state.adding && state.section.kind === 'mine' && list.querySelector('.add-form') &&
            (document.activeElement === addLink || document.activeElement === addName)) return;
        parkAddBoxes();
        if (state.title) { list.innerHTML = episodeHtml(); return; }
        if (state.adding && state.section.kind === 'mine') { list.innerHTML = addFormHtml(); placeAddBoxes(); return; }
        if (state.free.item && state.section.kind === 'free') { list.innerHTML = freePageHtml(); return; }
        var rows = state.rows;
        if (!rows.length) {
            var msg;
            if (state.section.kind === 'movies') {
                msg = state.query && !state.searching ? 'No movies or shows found.' : 'Press ▲ then OK to search for a title.';
            } else if (state.section.kind === 'free') {
                msg = state.free.loading || state.free.error ? '' :
                    state.free.tab && state.free.tab.kind === 'search' ? 'Nothing found. Try another title.' : 'Nothing here yet.';
            } else {
                msg = state.loading ? '' : state.section.kind === 'favorites' ? 'Press ▶ on a channel to add it here.' :
                    state.section.kind === 'mine' ? 'Add a channel by its link: press ▲, then OK on “Add a channel or playlist”.' : 'Nothing here yet.';
            }
            list.innerHTML = '<div class="empty">' + msg + '</div>';
            return;
        }
        var start = Math.max(0, Math.min(state.rowIndex - Math.floor(VISIBLE_ROWS / 2), rows.length - VISIBLE_ROWS));
        var end = Math.min(rows.length, start + VISIBLE_ROWS + 1);
        var html = '';
        for (var i = start; i < end; i++) {
            var k = state.section.kind;
            html += k === 'movies' ? titleRow(rows[i], i) : k === 'free' ? freeRow(rows[i], i) : channelRow(rows[i], i);
        }
        list.innerHTML = html;
    }

    function channelRow(c, i) {
        var focused = i === state.rowIndex && state.focus === 'list';
        var fav = isFavorite(c);
        var on = Data.nowNext(c);
        var sub;
        if (on.now) {
            sub = '<span class="dot"></span>' + esc(on.now.t) +
                (on.next ? '<span class="next">  ·  Next ' + timeOf(on.next.s) + '  ' + esc(on.next.t) + '</span>' : '');
        } else if (on.next) {
            sub = '<span class="next">Next ' + timeOf(on.next.s) + '  ' + esc(on.next.t) + '</span>';
        } else {
            sub = esc(c.category) + (c.feeds ? '  ·  ' + c.feeds.length + ' feeds' : '');
        }
        return '<div class="row' + (focused ? ' focused' : '') + '">' +
            '<div class="num">' + (i + 1) + '</div>' +
            logo(c.logo, c.name) +
            '<div class="text"><div class="name">' + esc(c.name) + '</div><div class="sub">' + sub + '</div>' +
            (on.now ? progressBar((Date.now() - on.now.s) / (on.now.e - on.now.s)) : '') +
            '</div><div class="fav' + (fav ? ' on' : '') + '">' + (fav ? '★' : '☆') + '</div></div>';
    }

    function addFormHtml() {
        var a = state.adding;
        function box(i, label, id) {
            return '<div class="add-field' + (a.field === i && state.focus === 'list' ? ' focused' : '') + '"><span>' + label + '</span>' +
                '<div class="add-slot" id="' + id + '"></div></div>';
        }
        function button(i, label) {
            return '<div class="add-btn' + (a.field === i && state.focus === 'list' ? ' focused' : '') + '">' + label + '</div>';
        }
        return '<div class="add-form"><div class="ep-title">Add a channel or playlist</div>' +
            '<div class="sub">Type the link to a channel’s stream, or to a playlist of channels (M3U). It shows under My channels on this TV.</div>' +
            box(0, 'Link', 'slotLink') + box(1, 'Name (optional)', 'slotName') +
            '<div class="add-buttons">' + button(2, a.busy ? 'Checking the link…' : 'Add') + button(3, 'Cancel') + '</div>' +
            (a.error ? '<div class="hint error">' + esc(a.error) + '</div>' : '') +
            '<div class="hint">▲▼ choose · OK type (the TV keyboard opens) or press · BACK cancel</div></div>';
    }

    /** Takes the form's boxes out before the list is redrawn, keeping what was typed and the focus. */
    function parkAddBoxes() {
        [addLink, addName].forEach(function (el) {
            if (el.parentNode !== document.body) document.body.appendChild(el);
            el.style.display = 'none';
        });
    }

    function placeAddBoxes() {
        [[addLink, 'slotLink', 'https://…', state.adding.link], [addName, 'slotName', 'Optional', state.adding.name]].forEach(function (b) {
            var el = b[0];
            var hadFocus = document.activeElement === el;
            $(b[1]).appendChild(el);
            el.style.display = '';
            el.placeholder = b[2];
            if (!hadFocus) el.value = b[3];
            if (hadFocus) el.focus();
        });
    }

    function freeRow(t, i) {
        var focused = i === state.rowIndex && state.focus === 'list';
        var p = Free.progress(t.id);
        return '<div class="row tall' + (focused ? ' focused' : '') + '">' +
            logo(t.img, t.t, true) +
            '<div class="text"><div class="name">' + esc(t.t) + '</div><div class="sub cyan">' + esc(t.meta || '') + '</div>' +
            '<div class="sub">' + esc(t.d || '') + '</div>' + (p > 0.01 ? progressBar(p) : '') + '</div>' +
            '<div class="fav">▶</div></div>';
    }

    function progressBar(share) {
        return '<div class="progress"><i style="width:' + Math.round(100 * Math.max(0, Math.min(1, share))) + '%"></i></div>';
    }

    function freePageHtml() {
        var f = state.free;
        var t = f.item;
        var body;
        if (f.pageError) body = '<div class="hint">' + esc(f.pageError) + '</div>';
        else if (!f.videos) body = '<div class="hint">Loading…</div>';
        else {
            var n = f.actions.length;
            var many = n > 2 || (n && f.actions[0].sub !== undefined);
            var shown = 6;
            var start = Math.max(0, Math.min(f.actionIndex - 2, n - shown));
            body = '<div class="actions' + (many ? ' list' : '') + '">';
            for (var i = start; i < Math.min(n, start + shown); i++) {
                var a = f.actions[i];
                body += '<div class="action' + (i === f.actionIndex ? ' focused' : '') + '"><div class="name">' + esc(a.label) + '</div>' +
                    (a.sub ? '<div class="sub">' + esc(a.sub) + '</div>' : '') +
                    (a.progress > 0.01 && a.progress < 1 ? progressBar(a.progress) : '') + '</div>';
            }
            body += '</div><div class="hint">' + (many ? '▲▼ choose · OK play · BACK titles' : 'OK play · BACK titles') + '</div>';
        }
        return '<div class="episodes">' + logo(t.img, t.t, true) +
            '<div class="ep-body"><div class="ep-title">' + esc(t.t) + '</div><div class="sub cyan">' + esc(t.meta || '') + '</div>' +
            '<div class="ep-desc">' + esc(t.d || '') + '</div>' + body + '</div></div>';
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

    /** 9:05 PM */
    function timeOf(ms) {
        var d = new Date(ms);
        var h = d.getHours() % 12 || 12;
        return h + ':' + pad(d.getMinutes()) + (d.getHours() < 12 ? ' AM' : ' PM');
    }

    /** 3725 -> "1:02:05" */
    function clock(secs) {
        secs = Math.max(0, Math.floor(secs));
        var h = Math.floor(secs / 3600);
        var m = Math.floor(secs % 3600 / 60);
        var s = secs % 60;
        return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
    }

    function tickClock() {
        $('clock').textContent = timeOf(Date.now());
    }

    // ---- Player ----

    function showPlayer(mode) {
        player.open = true;
        player.mode = mode;
        $('player').classList.remove('hidden');
        $('video').style.display = mode === 'vod' ? 'none' : '';
        $('frame').style.display = mode === 'vod' ? '' : 'none';
    }

    function closePlayer() {
        if (player.mode === 'free') saveFreePosition();
        Video.stop();
        clearInterval(player.clockTimer);
        $('frame').src = 'about:blank';
        $('player').classList.add('hidden');
        $('playerMsg').classList.add('hidden');
        player.open = false;
        if (player.mode === 'free' && state.free.item) buildFreeActions();
        render();
    }

    /** why: what went wrong, in small print under the message. */
    function showMessage(text, ms, why) {
        var m = $('playerMsg');
        m.innerHTML = esc(text) + (why ? '<div class="why">' + esc(why) + '</div>' : '');
        m.classList.remove('hidden');
        clearTimeout(player.msgTimer);
        if (ms) player.msgTimer = setTimeout(function () { m.classList.add('hidden'); }, ms);
    }

    // ---- Live channels ----

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
        state.recents = [c.url].concat(state.recents.filter(function (u) { return state.byUrl[u] !== c && u !== c.url; })).slice(0, 50);
        Data.store('recents', JSON.stringify(state.recents));
        player.feed = 0;
        player.tried = {};
        startFeed();
        showBanner();
    }

    function currentStream() {
        var c = player.list[player.index];
        return c.feeds ? c.feeds[player.feed] : c;
    }

    function startFeed() {
        $('playerMsg').classList.add('hidden');
        player.tried[player.feed] = true;
        var s = currentStream();
        Video.play(s.url, { ua: s.ua, onFail: feedFailed });
    }

    /** A feed that doesn't play hands over to the channel's next untried feed. */
    function feedFailed(why) {
        var c = player.list[player.index];
        var feeds = c.feeds || [];
        for (var i = 1; i < feeds.length; i++) {
            var next = (player.feed + i) % feeds.length;
            if (!player.tried[next]) {
                player.feed = next;
                startFeed();
                showMessage('Trying another feed: ' + feeds[next].label, 4000);
                showBanner();
                return;
            }
        }
        Video.stop();
        showMessage('This channel isn’t working right now. Press ▲/▼ for another.', 0, why);
    }

    function switchFeed(d) {
        var c = player.list[player.index];
        if (!c.feeds) return false;
        player.feed = (player.feed + d + c.feeds.length) % c.feeds.length;
        player.tried = {};
        startFeed();
        showBanner();
        return true;
    }

    function showBanner() {
        var b = $('banner');
        $('bannerNext').textContent = '';
        if (player.mode === 'live') {
            var c = player.list[player.index];
            var on = Data.nowNext(c);
            $('bannerNum').textContent = player.index + 1;
            $('bannerTitle').textContent = c.name;
            $('bannerSub').textContent = on.now ? 'Now: ' + on.now.t + '  ·  ' + timeOf(on.now.s) + ' – ' + timeOf(on.now.e) : c.category;
            $('bannerDesc').textContent = on.now && on.now.d ? on.now.d : '';
            $('bannerNext').textContent = on.next ? 'Next: ' + timeOf(on.next.s) + '  ' + on.next.t : '';
            var feeds = c.feeds;
            $('bannerHint').innerHTML = (feeds ? '<div class="feed">Feed ' + (player.feed + 1) + ' of ' + feeds.length + ' · ' + esc(feeds[player.feed].label) + '</div>' : '') +
                engineLine() +
                '▲▼ channel · ' + (feeds ? '◀▶ feed · YELLOW favorite' : '▶ favorite') + ' · BACK list';
        } else if (player.mode === 'free') {
            var v = player.videos[player.videoIndex];
            $('bannerNum').textContent = '';
            $('bannerTitle').textContent = player.videos.length > 1 ? player.item.t + '  ·  ' + v.t : v.t;
            updateFreeClock();
            $('bannerDesc').textContent = player.videos.length > 1 ? '' : player.item.d || '';
            $('bannerHint').innerHTML = engineLine() + 'OK pause · ◀ 10s · ▶ 30s · BACK exit';
        } else {
            var t = player.title;
            $('bannerNum').textContent = '';
            $('bannerTitle').textContent = t.title + (t.show ? '  S' + pad(player.season) + ' E' + pad(player.episode) : '');
            var s = player.sources[player.sourceIndex];
            $('bannerSub').textContent = player.sources.length
                ? 'Source ' + (player.sourceIndex + 1) + ' of ' + player.sources.length + ' · ' + s.name
                : 'No sources for this title';
            $('bannerDesc').textContent = '';
            $('bannerHint').innerHTML = '◀▶ or CH change source · BACK exit';
        }
        b.classList.remove('hidden');
        clearTimeout(player.bannerTimer);
        player.bannerTimer = setTimeout(function () { b.classList.add('hidden'); }, 6000);
    }

    /** Which player is showing the stream, so a black picture can be tried another way with BLUE. */
    function engineLine() {
        var engine = Video.engineName();
        if (!engine) return '';
        return '<div class="engine">Playing with ' + esc(engine) + (Video.canSwitch() ? ' · BLUE to switch' : '') + '</div>';
    }

    function switchPlayer() {
        var name = Video.switchEngine(player.mode === 'free');
        if (name) showMessage('Trying the ' + name, 3000);
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
            else if ((key === 'left' || key === 'right') && switchFeed(key === 'left' ? -1 : 1)) return;
            else if (key === 'right' || key === 'yellow') { toggleFavorite(player.list[player.index]); showBanner(); }
            else if (key === 'digit') typeDigit(digit);
            else if (key === 'playpause' || key === 'pause' || key === 'play') Video.toggle();
            else if (key === 'blue') switchPlayer();
            else showBanner();
        } else if (player.mode === 'free') {
            if (key === 'ok' || key === 'playpause' || key === 'pause' || key === 'play') Video.toggle();
            else if (key === 'left') seek(-10);
            else if (key === 'right') seek(30);
            else if (key === 'chdown') seek(-300);
            else if (key === 'chup') seek(300);
            else if (key === 'blue') switchPlayer();
            showBanner();
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

    // ---- Free to watch player ----

    /** videos and index are the title's video list, so the next one can follow. */
    function playFree(item, videos, index, startSec) {
        player.item = item;
        player.videos = videos;
        player.videoIndex = index;
        showPlayer('free');
        startFreeVideo(startSec);
    }

    function startFreeVideo(startSec) {
        var video = player.videos[player.videoIndex];
        player.lastSaved = startSec;
        $('playerMsg').classList.add('hidden');
        Video.play(video.url, {
            startAt: startSec,
            onFail: function (why) {
                showMessage('Couldn’t play this title. Press BACK and try again in a moment.', 0, why);
            },
            onTime: function (t) {
                if (Math.abs(t - player.lastSaved) >= 15) saveFreePosition();
            },
            onEnded: function () {
                Free.markWatched(video.id);
                var next = player.videoIndex + 1;
                Free.noteRecent(player.item, next >= player.videos.length);
                if (next < player.videos.length) {
                    player.videoIndex = next;
                    startFreeVideo(Free.resumeAt(player.videos[next].id));
                    showBanner();
                } else {
                    closePlayer();
                }
            }
        });
        clearInterval(player.clockTimer);
        player.clockTimer = setInterval(updateFreeClock, 1000);
        showBanner();
    }

    function saveFreePosition() {
        var video = player.videos[player.videoIndex];
        var t = Video.time();
        if (!video || !(t > 0)) return;
        player.lastSaved = t;
        var dur = Video.duration() || video.dur;
        Free.save(video.id, t, dur);
        if (player.item.id !== video.id) Free.saveParent(player.item.id, t, dur);
        // A film finished by hand drops off Continue Watching; a part-way one goes to the front.
        if (!(dur > 0 && t > dur * 0.95) && t >= 60) Free.noteRecent(player.item, false);
    }

    function seek(d) {
        var dur = Video.duration();
        if (!isFinite(dur)) return;
        Video.seekTo(Math.max(0, Math.min(dur - 1, Video.time() + d)));
    }

    function updateFreeClock() {
        if (player.mode !== 'free') return;
        var t = Video.time();
        var dur = Video.duration() || (player.videos[player.videoIndex] || {}).dur;
        $('bannerSub').textContent = (Video.paused() && t > 0 ? 'Paused  ·  ' : '') + clock(t) + (dur ? ' / ' + clock(dur) : '');
    }

    // ---- Search the web player ----

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
        state.loading = !state.channels.length;
        render();
        Data.loadChannels(force).then(function (r) {
            setChannels(r.channels);
            state.errors = r.errors;
            state.loading = false;
            buildMenu();
            computeRows();
            if (!player.open) render();
        });
    }

    registerTvKeys();
    buildMenu();
    computeRows();
    tickClock();
    setInterval(tickClock, 15000);
    // Keeps the "now playing" lines and progress bars current.
    setInterval(function () { if (!player.open && isChannelSection() && !state.adding) render(); }, 60000);
    // A fresh guide every 3 hours for a TV that's left on.
    setInterval(function () { load(false); }, 3 * 3600 * 1000);
    load(false);
})();
