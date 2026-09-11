/*
    ============================================================
    CLIENT CAPABILITY MODEL  (Task 5)
    ============================================================

    A reusable, extensible description of what a playback client can
    decode: which video codecs, audio codecs and containers it
    supports, plus a resolution ceiling where known.

    This is NOT the playback decision engine. It does not decide
    Direct Play / Remux / Transcode and it does not combine axes
    (container + codec + profile + level + resolution + audio). It
    only produces the normalized *representation* that a later
    decision engine will consume alongside media-probe.js output.

    --------------------------------------------------------------
    Why the contract looks the way it does
    --------------------------------------------------------------

    1. Tri-state, not boolean.
       Every entry is "supported" | "unsupported" | "unknown".
       Absence of information is NOT the same as "no". A conservative
       decision engine must be able to tell "the client told us it
       cannot" apart from "we were never told". `unknown` is never
       silently upgraded to `supported`.

    2. Per-axis maps, not a combination matrix.
       video{}, audio{}, containers{} are independent. Real
       playability depends on combinations, but composing them is the
       decision engine's job (a later task). Task 5 only records each
       axis.

    3. A single registry.
       REGISTRY is the ONLY place formats are enumerated. Adding a
       codec = add one string to a list (+ probe MIME strings for
       browser detection). No per-codec `if/else` anywhere.

    4. Alias canonicalisation.
       Clients report the same codec many ways ("h264", "avc1",
       "hev1", "ec-3", ...). ALIASES collapse every known spelling
       onto one registry key before anything else happens.

    5. `raw` is kept for audit only.
       The normalized shape is the contract; `raw` is a frozen copy
       of whatever the client sent, for debugging. Never read `raw`
       for decisions.

    --------------------------------------------------------------
    Normalized shape
    --------------------------------------------------------------

      {
        client:  <string>,            // "browser", "unknown", ...
        source:  "reported" | "detected" | "default",
        video:      { h264, hevc, vp8, vp9, av1 },        // each: state
        audio:      { aac, mp3, opus, vorbis, ac3, eac3, flac },
        containers: { mp4, webm, mkv, mov, avi },
        maxResolution: { width, height } | null,
        warnings: [ <string>, ... ],
        raw: <frozen copy of the input | null>
      }

    Every registry key is ALWAYS present. Unmentioned / partial /
    contradictory / unrecognised input resolves to "unknown".

    --------------------------------------------------------------
    Browser wiring (a later task adds the <script> + endpoint)
    --------------------------------------------------------------

      const report = detectBrowserCapabilities({
        videoElement: document.createElement("video"),
        mediaCapabilitiesResults: await gatherMediaCapabilities(), // optional
        screen: window.screen,
        devicePixelRatio: window.devicePixelRatio
      });
      // POST `report` to the server; server calls
      // normalizeClientCapabilities(report, { source: "detected" }).

    The server never runs this file's browser branch and never
    depends on browser JS -- it only ever normalizes a plain object.
*/

(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        root.BaseflixClientCapabilities = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STATES = {
        SUPPORTED: "supported",
        UNSUPPORTED: "unsupported",
        UNKNOWN: "unknown"
    };

    // The single source of truth for which formats exist in the model.
    const REGISTRY = {
        video: ["h264", "hevc", "vp8", "vp9", "av1"],
        audio: ["aac", "mp3", "opus", "vorbis", "ac3", "eac3", "flac"],
        containers: ["mp4", "webm", "mkv", "mov", "avi"]
    };

    // Every known spelling -> its registry key. Lower-cased lookup.
    const ALIASES = {
        video: {
            "h264": "h264", "h.264": "h264", "avc": "h264", "avc1": "h264",
            "avc3": "h264", "x264": "h264",
            "hevc": "hevc", "h265": "hevc", "h.265": "hevc", "hev1": "hevc",
            "hvc1": "hevc", "x265": "hevc",
            "vp8": "vp8", "vp08": "vp8",
            "vp9": "vp9", "vp09": "vp9",
            "av1": "av1", "av01": "av1"
        },
        audio: {
            "aac": "aac", "mp4a": "aac", "mp4a.40.2": "aac", "mp4a.40.5": "aac",
            "mp3": "mp3", "mp3float": "mp3", "mpga": "mp3", "mpeg-audio": "mp3",
            "opus": "opus",
            "vorbis": "vorbis",
            "ac3": "ac3", "ac-3": "ac3",
            "eac3": "eac3", "e-ac3": "eac3", "ec-3": "eac3", "ec3": "eac3",
            "flac": "flac"
        },
        containers: {
            "mp4": "mp4", "m4v": "mp4", "mpeg4": "mp4", "isom": "mp4",
            "webm": "webm",
            "mkv": "mkv", "matroska": "mkv", "x-matroska": "mkv",
            "mov": "mov", "quicktime": "mov",
            "avi": "avi", "x-msvideo": "avi", "msvideo": "avi", "divx": "avi"
        }
    };

    // MIME strings used for HTMLMediaElement.canPlayType() probing.
    const PROBE_MIME = {
        video: {
            h264: ['video/mp4;codecs="avc1.42E01E"', 'video/mp4;codecs="avc1.640028"'],
            hevc: ['video/mp4;codecs="hvc1.1.6.L93.B0"', 'video/mp4;codecs="hev1.1.6.L93.B0"'],
            vp8:  ['video/webm;codecs="vp8"'],
            vp9:  ['video/webm;codecs="vp9"', 'video/mp4;codecs="vp09.00.10.08"'],
            av1:  ['video/mp4;codecs="av01.0.05M.08"', 'video/webm;codecs="av01.0.05M.08"']
        },
        audio: {
            aac:    ['audio/mp4;codecs="mp4a.40.2"'],
            mp3:    ['audio/mpeg', 'audio/mp3'],
            opus:   ['audio/webm;codecs="opus"', 'audio/ogg;codecs="opus"'],
            vorbis: ['audio/webm;codecs="vorbis"', 'audio/ogg;codecs="vorbis"'],
            ac3:    ['audio/mp4;codecs="ac-3"'],
            eac3:   ['audio/mp4;codecs="ec-3"'],
            flac:   ['audio/mp4;codecs="flac"', 'audio/flac', 'audio/ogg;codecs="flac"']
        },
        containers: {
            mp4:  ['video/mp4'],
            webm: ['video/webm'],
            mkv:  ['video/x-matroska'],
            mov:  ['video/quicktime'],
            avi:  ['video/x-msvideo', 'video/avi']
        }
    };

    const KINDS = ["video", "audio", "containers"];


    // ---- helpers -------------------------------------------------

    function isPlainObject(value) {
        return value !== null &&
            typeof value === "object" &&
            !Array.isArray(value);
    }

    // A reported spelling -> registry key, or null when the format is
    // not in the model at all ("theora", "wmv", ...).
    function canonicalFormat(kind, name) {

        if (typeof name !== "string") {
            return null;
        }

        const key = name.trim().toLowerCase();

        if (key === "" || !REGISTRY[kind]) {
            return null;
        }

        if (ALIASES[kind] && Object.prototype.hasOwnProperty.call(ALIASES[kind], key)) {
            return ALIASES[kind][key];
        }

        if (REGISTRY[kind].indexOf(key) !== -1) {
            return key;
        }

        return null;
    }

    // A single reported value -> { state, recognised }.
    // recognised:false means "we could not interpret this at all" so
    // the caller can warn; the state is still a safe "unknown".
    function classifyValue(value) {

        if (value === true || value === 1) {
            return { state: STATES.SUPPORTED, recognised: true };
        }

        if (value === false || value === 0) {
            return { state: STATES.UNSUPPORTED, recognised: true };
        }

        if (typeof value === "string") {

            const token = value.trim().toLowerCase();

            if (token === "supported" || token === "probably") {
                return { state: STATES.SUPPORTED, recognised: true };
            }

            if (token === "unsupported" || token === "") {
                // "" is HTMLMediaElement.canPlayType()'s definite "no".
                return { state: STATES.UNSUPPORTED, recognised: true };
            }

            if (token === "unknown" || token === "maybe") {
                // "maybe" == the browser itself is not sure.
                return { state: STATES.UNKNOWN, recognised: true };
            }
        }

        return { state: STATES.UNKNOWN, recognised: false };
    }

    // Combine every reported state for one canonical key.
    //   no explicit info                -> unknown
    //   all explicit values agree       -> that value
    //   explicit values disagree        -> unknown  (never guess)
    function mergeStates(states) {

        const explicit = states.filter(function (s) {
            return s === STATES.SUPPORTED || s === STATES.UNSUPPORTED;
        });

        if (explicit.length === 0) {
            return STATES.UNKNOWN;
        }

        const first = explicit[0];

        return explicit.every(function (s) { return s === first; })
            ? first
            : STATES.UNKNOWN;
    }

    function parseResolution(value, warnings) {

        if (value === undefined || value === null) {
            return null;
        }

        if (!isPlainObject(value)) {
            warnings.push("maxResolution was not an object; ignored");
            return null;
        }

        const width = Number(value.width);
        const height = Number(value.height);

        const valid =
            Number.isInteger(width) && width > 0 &&
            Number.isInteger(height) && height > 0;

        if (!valid) {
            warnings.push("maxResolution had invalid width/height; ignored");
            return null;
        }

        return { width: width, height: height };
    }

    function pickClientName(input, options) {

        let raw = options && options.client;

        if (raw === undefined && isPlainObject(input)) {
            raw = input.client;
        }

        if (typeof raw === "string" && raw.trim() !== "") {
            return raw.trim().slice(0, 64);
        }

        return "unknown";
    }

    function safeClone(value) {
        try {
            return structuredClone(value);
        } catch (e) {
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (e2) {
                return null;
            }
        }
    }

    function deepFreeze(obj) {

        if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
            Object.freeze(obj);
            Object.keys(obj).forEach(function (key) {
                deepFreeze(obj[key]);
            });
        }

        return obj;
    }


    // ---- core: normalize any client-reported capabilities --------

    function normalizeClientCapabilities(input, options) {

        options = options || {};

        const warnings = [];
        const inputIsObject = isPlainObject(input);

        if (input !== undefined && input !== null && !inputIsObject) {
            warnings.push("capability input was not an object; ignored");
        }

        const model = {
            client: pickClientName(input, options),
            source: inputIsObject ? (options.source || "reported") : "default",
            video: {},
            audio: {},
            containers: {},
            maxResolution: null,
            warnings: warnings,
            raw: null
        };

        KINDS.forEach(function (kind) {

            const out = {};

            REGISTRY[kind].forEach(function (key) {
                out[key] = STATES.UNKNOWN;
            });

            let section = null;

            if (inputIsObject && input[kind] !== undefined) {
                if (isPlainObject(input[kind])) {
                    section = input[kind];
                } else {
                    warnings.push('"' + kind + '" capability section was not an object; ignored');
                }
            }

            if (section) {

                const grouped = {};

                Object.keys(section).forEach(function (reportedKey) {

                    const canon = canonicalFormat(kind, reportedKey);

                    if (!canon) {
                        warnings.push("unknown " + kind + ' format "' + reportedKey + '" ignored');
                        return;
                    }

                    const classified = classifyValue(section[reportedKey]);

                    if (!classified.recognised) {
                        warnings.push("unrecognised capability value for " + kind + "." + reportedKey + "; treated as unknown");
                    }

                    if (!grouped[canon]) {
                        grouped[canon] = [];
                    }

                    grouped[canon].push(classified.state);
                });

                Object.keys(grouped).forEach(function (canon) {

                    if (grouped[canon].length > 1) {
                        warnings.push("multiple entries for " + kind + "." + canon + " merged");
                    }

                    out[canon] = mergeStates(grouped[canon]);
                });
            }

            model[kind] = out;
        });

        model.maxResolution = parseResolution(
            inputIsObject ? input.maxResolution : undefined,
            warnings
        );

        model.raw = inputIsObject ? safeClone(input) : null;

        return deepFreeze(model);
    }


    // ---- query API ---------------------------------------------

    // -> "supported" | "unsupported" | "unknown"  (never throws)
    function capabilityOf(model, kind, name) {

        if (!isPlainObject(model) || !REGISTRY[kind]) {
            return STATES.UNKNOWN;
        }

        const canon = canonicalFormat(kind, name);

        if (!canon || !isPlainObject(model[kind])) {
            return STATES.UNKNOWN;
        }

        const state = model[kind][canon];

        return (state === STATES.SUPPORTED || state === STATES.UNSUPPORTED)
            ? state
            : STATES.UNKNOWN;
    }

    // A model that admits it knows nothing. Use this when there is no
    // client information at all -- so the decision engine downstream
    // gets "unknown" everywhere rather than a false "supported".
    function defaultCapabilities(clientName) {
        return normalizeClientCapabilities(null, { client: clientName });
    }


    // ---- browser-side detection (injectable, pure over inputs) ---

    // canPlayType: (mimeType) => "" | "maybe" | "probably"
    function detectFromCanPlayType(canPlayType) {

        const report = {
            client: "browser",
            source: "detected",
            video: {},
            audio: {},
            containers: {},
            warnings: []
        };

        if (typeof canPlayType !== "function") {
            report.warnings.push("HTMLMediaElement.canPlayType unavailable");
            return report;
        }

        KINDS.forEach(function (kind) {

            Object.keys(PROBE_MIME[kind]).forEach(function (key) {

                let sawProbably = false;
                let sawMaybe = false;
                let sawAnswer = false;

                PROBE_MIME[kind][key].forEach(function (mime) {

                    let verdict;

                    try {
                        verdict = canPlayType(mime);
                    } catch (e) {
                        verdict = null;
                    }

                    if (verdict === null || verdict === undefined) {
                        return;
                    }

                    sawAnswer = true;

                    const token = String(verdict).trim().toLowerCase();

                    if (token === "probably") {
                        sawProbably = true;
                    } else if (token === "maybe") {
                        sawMaybe = true;
                    }
                });

                if (sawProbably) {
                    report[kind][key] = STATES.SUPPORTED;
                } else if (!sawAnswer || sawMaybe) {
                    // no answer at all, or only "maybe" -> not enough to
                    // affirm OR deny.
                    report[kind][key] = STATES.UNKNOWN;
                } else {
                    // every probe returned "" -> a definite no.
                    report[kind][key] = STATES.UNSUPPORTED;
                }
            });
        });

        return report;
    }

    /*
        env:
          videoElement       - an <video> element (its .canPlayType is used)
          canPlayType        - or the bound function directly
          mediaCapabilities  - navigator.mediaCapabilities (presence check only)
          mediaCapabilitiesResults - array of
              { kind:"video"|"audio", format:<string>, supported:<bool> }
              that the caller gathered via decodingInfo() (async)
          screen             - { width, height }
          devicePixelRatio   - number
          maxResolution      - { width, height } (explicit override)
    */
    function detectBrowserCapabilities(env) {

        env = env || {};

        let canPlayType = typeof env.canPlayType === "function"
            ? env.canPlayType
            : undefined;

        if (!canPlayType &&
            env.videoElement &&
            typeof env.videoElement.canPlayType === "function") {
            canPlayType = env.videoElement.canPlayType.bind(env.videoElement);
        }

        const report = detectFromCanPlayType(canPlayType);

        // Fold in MediaCapabilities results if the caller gathered them.
        if (Array.isArray(env.mediaCapabilitiesResults)) {

            env.mediaCapabilitiesResults.forEach(function (result) {

                if (!isPlainObject(result) || !REGISTRY[result.kind]) {
                    return;
                }

                const canon = canonicalFormat(result.kind, result.format);

                if (!canon) {
                    return;
                }

                if (result.supported === true) {
                    report[result.kind][canon] = STATES.SUPPORTED;
                } else if (result.supported === false &&
                    report[result.kind][canon] !== STATES.SUPPORTED) {
                    report[result.kind][canon] = STATES.UNSUPPORTED;
                }
            });

        } else if (env.mediaCapabilities === undefined ||
            env.mediaCapabilities === null) {
            report.warnings.push("navigator.mediaCapabilities unavailable; used canPlayType only");
        }

        // Resolution ceiling.
        if (isPlainObject(env.maxResolution)) {
            report.maxResolution = env.maxResolution;
        } else if (isPlainObject(env.screen) &&
            typeof env.screen.width === "number" &&
            typeof env.screen.height === "number") {

            const dpr = typeof env.devicePixelRatio === "number" && env.devicePixelRatio > 0
                ? env.devicePixelRatio
                : 1;

            report.maxResolution = {
                width: Math.round(env.screen.width * dpr),
                height: Math.round(env.screen.height * dpr)
            };
        }

        return report;
    }

    // Convenience: detect + normalize in one call.
    function describeBrowserClient(env) {
        return normalizeClientCapabilities(
            detectBrowserCapabilities(env),
            { source: "detected", client: "browser" }
        );
    }


    // ---- browser -> server transport (Task 16) ------------------
    //
    // detectBrowserCapabilities() reports every registry key, most of
    // them "unknown" (canPlayType only ever affirms or denies a
    // handful of formats). normalizeClientCapabilities() already
    // treats an ABSENT key exactly like an explicit "unknown" one --
    // so a report can be shrunk to just its "supported"/"unsupported"
    // entries with zero loss of information. That is the only
    // encoding this file hands to the network layer; Baseflicks
    // targets modest home hardware, so the request URL stays small
    // instead of carrying a full tri-state map plus warnings/raw.

    // report -> the smallest object that normalizes identically to
    // the full report, or null when there is nothing worth sending
    // (every axis unknown, or the input itself is unusable).
    function compactForTransport(report) {

        if (!isPlainObject(report)) {
            return null;
        }

        const compact = {};

        KINDS.forEach(function (kind) {

            const section = report[kind];

            if (!isPlainObject(section)) {
                return;
            }

            const kept = {};
            let any = false;

            Object.keys(section).forEach(function (key) {

                const state = section[key];

                if (state === STATES.SUPPORTED || state === STATES.UNSUPPORTED) {
                    kept[key] = state;
                    any = true;
                }
                // STATES.UNKNOWN (or anything unrecognised) is
                // omitted -- normalizeClientCapabilities() treats a
                // missing key as unknown already.
            });

            if (any) {
                compact[kind] = kept;
            }
        });

        if (isPlainObject(report.maxResolution) &&
            typeof report.maxResolution.width === "number" &&
            typeof report.maxResolution.height === "number") {
            compact.maxResolution = report.maxResolution;
        }

        return Object.keys(compact).length > 0 ? compact : null;
    }

    // report -> "" | "?caps=<url-encoded compact JSON>", ready to
    // append to a /video request. Pure string logic (no DOM, no
    // fetch) so both the browser and a Node test can call it
    // directly. Never throws -- an unencodable report just yields "".
    function toQueryString(report) {

        const compact = compactForTransport(report);

        if (!compact) {
            return "";
        }

        try {
            return "?caps=" + encodeURIComponent(JSON.stringify(compact));
        } catch (e) {
            return "";
        }
    }


    return {
        STATES: STATES,
        REGISTRY: REGISTRY,
        PROBE_MIME: PROBE_MIME,
        canonicalFormat: canonicalFormat,
        normalizeClientCapabilities: normalizeClientCapabilities,
        capabilityOf: capabilityOf,
        defaultCapabilities: defaultCapabilities,
        detectFromCanPlayType: detectFromCanPlayType,
        detectBrowserCapabilities: detectBrowserCapabilities,
        describeBrowserClient: describeBrowserClient,
        compactForTransport: compactForTransport,
        toQueryString: toQueryString
    };
});
