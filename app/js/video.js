/* Plays one stream at a time, trying each way this device has until one works:
 * the TV's own <video> playback, hls.js, then Samsung's AVPlay.
 * Samsung TVs play HLS in <video> even when canPlayType says they can't, so on a TV it goes first. */
'use strict';

var Video = (function () {
    var IS_TIZEN = !!window.tizen || /Tizen/i.test(navigator.userAgent);
    var START_TIMEOUT = 15000;        // no picture this long after starting: try the next way
    var STALL_TIMEOUT = 20000;        // stuck this long after playing: the stream has failed
    var NAMES = { native: 'TV player', hlsjs: 'hls.js', avplay: 'Samsung player' };
    var MEDIA_ERRORS = { 1: 'stopped', 2: 'network error', 3: 'couldn’t decode', 4: 'format not supported' };

    var el = document.getElementById('video');
    var cur = null;                   // { url, opts, engines, index, reasons, started, engine, hls, timer }
    var preferred = null;
    try { preferred = localStorage.getItem('videoEngine'); } catch (e) {}

    // AVPlay lives in Samsung's webapis, which TizenBrew pages may or may not be able to load.
    if (IS_TIZEN && !window.webapis) {
        var s = document.createElement('script');
        s.src = '$WEBAPIS/webapis/webapis.js';
        document.head.appendChild(s);
    }

    function avplay() {
        try { return window.webapis && webapis.avplay && typeof webapis.avplay.open === 'function' ? webapis.avplay : null; }
        catch (e) { return null; }
    }

    function isHls(url) { return /\.m3u8?(\?|$)/i.test(url); }

    function enginesFor(url) {
        var hls = isHls(url);
        var list = [];
        var native = !hls || IS_TIZEN || el.canPlayType('application/vnd.apple.mpegurl') || el.canPlayType('application/x-mpegURL');
        if (native) list.push('native');
        if (hls && window.Hls && Hls.isSupported()) list.push('hlsjs');
        // The way that last worked here goes first.
        if (preferred && list.indexOf(preferred) > 0) {
            list.splice(list.indexOf(preferred), 1);
            list.unshift(preferred);
        }
        // Last, as it draws under the page; it can also send the user agent some streams insist on.
        if (avplay()) list.push('avplay');
        return list;
    }

    /** opts: onFail(reasons), onEnded(), onTime(sec), startAt (seconds), ua. */
    function play(url, opts) {
        stop();
        cur = { url: url, opts: opts || {}, engines: enginesFor(url), index: -1, reasons: [] };
        next();
    }

    function next(reason) {
        var c = cur;
        if (reason) c.reasons.push(NAMES[c.engine] + ': ' + reason);
        teardown();
        c.index++;
        if (c.index >= c.engines.length) {
            cur = null;
            if (!c.engines.length) c.reasons.push('no way to play this here');
            if (c.opts.onFail) c.opts.onFail(c.reasons.join(' · ') + device());
            return;
        }
        c.engine = c.engines[c.index];
        c.started = false;
        armTimer(START_TIMEOUT);
        try {
            if (c.engine === 'avplay') startAvplay(c); else startElement(c);
        } catch (e) {
            fail(c, (e && (e.name || e.message)) || 'error');
        }
    }

    /** Before the picture starts, a failure tries the next way; after, the stream itself has failed. */
    function fail(c, reason) {
        if (c !== cur) return;
        if (!c.started) { next(reason); return; }
        c.reasons.push(NAMES[c.engine] + ': ' + reason);
        stop();
        if (c.opts.onFail) c.opts.onFail(c.reasons.join(' · ') + device());
    }

    function started(c) {
        if (c !== cur) return;
        clearTimeout(c.timer);
        if (!c.started) {
            c.started = true;
            // Remember a way that works here, except AVPlay: it is last resort, as it draws under the page.
            if (c.engine !== 'avplay' && preferred !== c.engine) {
                preferred = c.engine;
                try { localStorage.setItem('videoEngine', preferred); } catch (e) {}
            }
        }
    }

    function armTimer(ms) {
        var c = cur;
        clearTimeout(c.timer);
        c.timer = setTimeout(function () {
            fail(c, c.started ? 'stopped for ' + (ms / 1000) + 's' : 'no picture after ' + (ms / 1000) + 's');
        }, ms);
    }

    // ---- <video>, natively or through hls.js ----

    function startElement(c) {
        if (c.engine === 'hlsjs') {
            c.hls = new Hls({ liveDurationInfinity: true });
            c.hls.on(Hls.Events.ERROR, function (ev, data) {
                if (!data.fatal) return;
                var code = data.response && data.response.code;
                fail(c, data.details + (code ? ' (HTTP ' + code + ')' : data.type === 'networkError' ? ' (no answer, or blocked)' : ''));
            });
            c.hls.loadSource(c.url);
            c.hls.attachMedia(el);
        } else {
            el.src = c.url;
        }
        el.onerror = function () { fail(c, MEDIA_ERRORS[el.error && el.error.code] || 'error'); };
        el.onplaying = function () { started(c); };
        el.onwaiting = function () { if (c.started) armTimer(STALL_TIMEOUT); };
        el.ontimeupdate = function () {
            if (!el.paused && el.readyState > 2) started(c);
            if (c.opts.onTime) c.opts.onTime(el.currentTime);
        };
        el.onended = function () { if (c === cur && c.opts.onEnded) c.opts.onEnded(); };
        el.onloadedmetadata = function () {
            var at = c.opts.startAt;
            if (at > 0 && at < (el.duration || Infinity)) el.currentTime = at;
        };
        el.style.visibility = '';
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
    }

    // ---- AVPlay: Samsung's player, drawn on a layer under the page ----

    function startAvplay(c) {
        var av = avplay();
        if (!document.getElementById('avplayer')) {
            var obj = document.createElement('object');
            obj.id = 'avplayer';
            obj.setAttribute('type', 'application/avplayer');
            var box = document.getElementById('player');
            box.insertBefore(obj, box.firstChild);
        }
        document.documentElement.classList.add('avplay');
        el.style.visibility = 'hidden';
        av.open(c.url);
        av.setDisplayRect(0, 0, 1920, 1080);
        if (c.opts.ua) { try { av.setStreamingProperty('USER_AGENT', c.opts.ua); } catch (e) {} }
        av.setListener({
            onbufferingstart: function () { if (c.started) armTimer(STALL_TIMEOUT); },
            onbufferingcomplete: function () { if (c.started) clearTimeout(c.timer); },
            oncurrentplaytime: function (ms) {
                if (ms > 0) started(c);
                if (c === cur && c.opts.onTime) c.opts.onTime(ms / 1000);
            },
            onstreamcompleted: function () { if (c === cur && c.opts.onEnded) c.opts.onEnded(); },
            onerror: function (type) { fail(c, String(type || 'error')); }
        });
        av.prepareAsync(function () {
            if (c !== cur) return;
            var at = c.opts.startAt;
            if (at > 0) { try { av.seekTo(Math.round(at * 1000)); } catch (e) {} }
            av.play();
        }, function (e) {
            fail(c, (e && (e.name || e.message)) || 'couldn’t open');
        });
    }

    // ---- Shared ----

    function teardown() {
        if (!cur) return;
        clearTimeout(cur.timer);
        if (cur.hls) { cur.hls.destroy(); cur.hls = null; }
        if (cur.engine === 'avplay') {
            var av = avplay();
            try { av.stop(); } catch (e) {}
            try { av.close(); } catch (e) {}
            document.documentElement.classList.remove('avplay');
        }
        el.onerror = null;
        el.onwaiting = null;
        el.onplaying = null;
        el.ontimeupdate = null;
        el.onended = null;
        el.onloadedmetadata = null;
        el.pause();
        el.removeAttribute('src');
        el.load();
    }

    function stop() {
        teardown();
        cur = null;
    }

    /** Plays the same stream the next way, for when a way "plays" but shows nothing; a film keeps its place.
     *  Returns the way's name. */
    function switchEngine(keepPlace) {
        var c = cur;
        if (!c || c.engines.length < 2) return '';
        var t = time();
        if (keepPlace && t > 0) c.opts.startAt = t;
        var i = (c.index + 1) % c.engines.length;
        c.engines = c.engines.slice(i).concat(c.engines.slice(0, i));
        c.index = -1;
        c.reasons = [];
        next();
        return cur === c ? NAMES[c.engine] : '';
    }

    function time() {
        if (!cur) return 0;
        if (onAvplay()) { try { return webapis.avplay.getCurrentTime() / 1000; } catch (e) { return 0; } }
        return el.currentTime || 0;
    }

    /** Seconds, or NaN for live streams and before it is known. */
    function duration() {
        if (!cur) return NaN;
        if (onAvplay()) {
            try { var d = webapis.avplay.getDuration(); return d > 0 ? d / 1000 : NaN; } catch (e) { return NaN; }
        }
        return isFinite(el.duration) && el.duration > 0 ? el.duration : NaN;
    }

    function device() {
        var m = navigator.userAgent.match(/Tizen\s*([\d.]+)/i);
        return m ? ' (Tizen ' + m[1] + ')' : '';
    }

    function onAvplay() { return cur && cur.engine === 'avplay'; }

    function state() {
        try { return onAvplay() ? webapis.avplay.getState() : ''; } catch (e) { return ''; }
    }

    return {
        play: play,
        stop: stop,
        /** The way that is playing now, for the banner. */
        engineName: function () { return cur && cur.started ? NAMES[cur.engine] : ''; },
        canSwitch: function () { return !!cur && cur.engines.length > 1; },
        paused: function () { return onAvplay() ? state() === 'PAUSED' : el.paused; },
        toggle: function () {
            if (!cur) return;
            if (onAvplay()) {
                try { if (state() === 'PAUSED') webapis.avplay.play(); else webapis.avplay.pause(); } catch (e) {}
            } else if (el.paused) {
                var p = el.play();
                if (p && p.catch) p.catch(function () {});
            } else {
                el.pause();
            }
        },
        switchEngine: switchEngine,
        time: time,
        duration: duration,
        seekTo: function (sec) {
            if (!cur) return;
            if (onAvplay()) { try { webapis.avplay.seekTo(Math.round(sec * 1000)); } catch (e) {} }
            else el.currentTime = sec;
        }
    };
})();
