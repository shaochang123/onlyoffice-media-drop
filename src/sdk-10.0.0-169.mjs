// SPDX-License-Identifier: AGPL-3.0-only
import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {createMediaDrop} from "./media-drop.mjs";

export const fingerprints = Object.freeze({
    "sdk-all.js": "7e3cb3dbcd069deb782d0a50bf45ebb3f77b1d617cf081b06e3cff75e9540c73",
    "sdk-all-min.js": "04e0c9864bf17a08201cf8409b83b14a3b7abe2ecbd0173bd236507da145adc3",
});

// Symbol mapping from ONLYOFFICE sdkjs v10.0.0.169, compiled macOS arm64 SDK.
// Names come from slide/api.js and slide/Editor/Format/Presentation.js.
function editorAdapter(window, AscCommon) {
    function desktop() { return window.AscDesktopEditor; }

    return {
        currentEditor: () => window.Asc?.editor || window.editor,
        activeSlide(editor) {
            const document = editor?.va?.Pa;
            if (!desktop()?.IsSupportMedia?.() || !editor?.asc_IsSlidePageMode?.() ||
                !document?.Iu()) return null;
            return document.Nk() ?? null;
        },
        localFileExists: path => desktop().IsLocalFileExist(path),
        copiedMediaExists(name) {
            const url = AscCommon.Gt.tU(name);
            if (typeof url !== "string") return false;
            if (desktop().IsLocalFileExist(url)) return true;
            return url.startsWith("file:") && desktop().IsLocalFileExist(decodeURIComponent(new URL(url).pathname));
        },
        copyMedia(kind, path, callback) {
            const bridge = desktop();
            if (kind === "video") bridge.AddVideo(path, callback);
            else bridge.AddAudio(path, callback);
        },
        insertMedia(editor, kind, poster, name, transaction) {
            editor.c8f(poster, undefined, name, kind === "video" ? "localVideo" : "localAudio", transaction);
        },
    };
}

function replaceOnce(source, from, to) {
    const index = source.indexOf(from);
    if (index < 0 || source.indexOf(from, index + from.length) >= 0) {
        throw new Error(`SDK patch anchor must occur once: ${from.slice(0, 96)}`);
    }
    return source.slice(0, index) + to + source.slice(index + from.length);
}

export function patchDropHandler(source) {
    const handler = 'AscCommon.DGf=function(a){"undefined"!=typeof FileReader&&null!=a&&(';
    // The same SDK is loaded by the headless PPTX converter, which has no DOM.
    const init = `AscCommon.DGf=function(a){if(typeof FileReader==="undefined"||a==null)return;\nconst onlyOfficeMediaDropV010 = (${createMediaDrop.toString()})(window, (${editorAdapter.toString()})(window, AscCommon));\n(`;
    source = replaceOnce(source, handler, init);

    const hover = 'b.dataTransfer.dropEffect=AscCommon.Ieh(b)?"copy":"none"';
    source = replaceOnce(source, hover, 'b.dataTransfer.dropEffect=onlyOfficeMediaDropV010.allowsDrop(b,window.Asc.editor||window.editor)||AscCommon.Ieh(b)?"copy":"none"');

    const paths = "f=window.AscDesktopEditor.GetDropFiles(),d=0;if(0!==f.length)";
    source = replaceOnce(source, paths,
        "f=window.AscDesktopEditor.GetDropFiles(),d=0;const mediaJob=onlyOfficeMediaDropV010.claimDrop(b,e,f);if(mediaJob)f=mediaJob.remainingPaths;if(0!==f.length)");

    const tail = "break}d=g.length;0!==d&&e.kbb(g)}0===d&&";
    return replaceOnce(source, tail,
        "break}d=g.length;if(!mediaJob&&0!==d)e.kbb(g)}if(mediaJob){void onlyOfficeMediaDropV010.run(mediaJob,function(){if(d)e.kbb(g)});return}0===d&&");
}

export function patchMediaCallback(source) {
    const loadPoster = "d.prototype.c8f=function(ia,aa,ba,ya){var ca=this,xa=AscCommon.Gt.tU(ia);this.oq.s1([xa],function(){var Ga=ca.oq.HP(xa,1);Ga&&Ga.Image&&(";
    source = replaceOnce(source, loadPoster,
        "d.prototype.c8f=function(ia,aa,ba,ya,mediaDropTransaction){var ca=this,xa=AscCommon.Gt.tU(ia);this.oq.s1([xa],function(){function insertMedia(){var Ga=ca.oq.HP(xa,1);return Ga&&Ga.Image&&(");
    const addMedia = "ca.va.Pa.PSc([Ga],aa))})};d.prototype.wig=";
    return replaceOnce(source, addMedia,
        "ca.va.Pa.PSc([Ga],aa),!0)}if(mediaDropTransaction)mediaDropTransaction.apply(insertMedia);else insertMedia()})};d.prototype.wig=");
}

export async function patchBundle(bundle, {checkOnly = false} = {}) {
    const directory = join(bundle, "Contents", "Resources", "editors", "sdkjs", "slide");
    const replacements = {"sdk-all.js": patchDropHandler, "sdk-all-min.js": patchMediaCallback};
    const patchedFiles = await Promise.all(Object.entries(fingerprints).map(async ([filename, expected]) => {
        const path = join(directory, filename);
        const source = await readFile(path);
        const actual = createHash("sha256").update(source).digest("hex");
        if (actual !== expected) throw new Error(`Unsupported ${filename} build (SHA-256 ${actual})`);
        return [path, replacements[filename](source.toString("utf8"))];
    }));
    if (checkOnly) return;
    await Promise.all(patchedFiles.map(([path, contents]) => writeFile(path, contents)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const checkOnly = args[0] === "--check";
    if (checkOnly) args.shift();
    try {
        if (args.length !== 1) throw new Error("Usage: node src/sdk-10.0.0-169.mjs [--check] <app bundle>");
        await patchBundle(args[0], {checkOnly});
    } catch (error) {
        console.error(`Media Drop: ${error.message}`);
        process.exitCode = 1;
    }
}
