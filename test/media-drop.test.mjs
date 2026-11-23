// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import {setImmediate} from "node:timers/promises";
import test from "node:test";
import {runInNewContext} from "node:vm";
import {createMediaDrop} from "../src/media-drop.mjs";
import {patchDropHandler} from "../src/sdk-10.0.0-169.mjs";

const desktopDropHandler = 'AscCommon.DGf=function(a){"undefined"!=typeof FileReader&&null!=a&&(' +
    'a.ondragover=function(b){b.preventDefault();b.dataTransfer.dropEffect=AscCommon.Ieh(b)?"copy":"none";return!1},' +
    'a.ondrop=function(b){b.preventDefault();var e=window.editor,f=window.AscDesktopEditor.GetDropFiles(),d=0;if(0!==f.length)' +
    '{var g=[];for(d=0;d<f.length;d++)if(window.AscDesktopEditor.IsImageFile(f[d])){g.push(f[d]);break}' +
    'd=g.length;0!==d&&e.kbb(g)}0===d&&e.pluginMethod_PasteText(b.dataTransfer.getData("text/plain"))})};';

function dropEvent({types = ["Files"], mime = "", files = [], canvas = true, trusted = true} = {}) {
    return {
        isTrusted: trusted,
        target: {closest: () => canvas ? {} : null},
        dataTransfer: {types, items: [{kind: "file", type: mime}], files},
    };
}

function harness(timeout = 1000) {
    const editor = {};
    const state = {slide: {media: []}, editor};
    const calls = [];
    const notices = [];
    const host = {setTimeout, clearTimeout};
    const adapter = {
        currentEditor: () => state.editor,
        activeSlide: () => state.slide,
        localFileExists: path => !path.includes("missing"),
        copiedMediaExists: name => !name.includes("uncopied"),
        copyMedia(kind, path, callback) {
            calls.push([kind, path]);
            host.on_add_multimedia_local = callback;
            queueMicrotask(() => {
                host.on_add_multimedia_local("poster.png", path);
                host.on_add_multimedia_local = undefined;
            });
        },
        insertMedia(_, kind, poster, name, transaction) {
            transaction.apply(() => {
                state.slide.media.push({kind, poster, name});
                return true;
            });
        },
        notify: message => notices.push(message),
    };
    return {drop: createMediaDrop(host, adapter, timeout), adapter, state, editor, host, calls, notices};
}

test("accepts Finder video and audio on the editing canvas", () => {
    const {drop, editor, state} = harness();
    for (const mime of ["video/mp4", "video/quicktime", "audio/mpeg", ""]) {
        assert.equal(drop.allowsDrop(dropEvent({mime}), editor), true);
    }
    for (const event of [dropEvent({trusted: false}), dropEvent({canvas: false}),
        dropEvent({types: ["text/plain"]}), dropEvent({mime: "image/png"})]) {
        assert.equal(drop.allowsDrop(event, editor), false);
        assert.equal(drop.claimDrop(event, editor, ["/clip.png"]), null);
    }
    state.slide = null;
    assert.equal(drop.claimDrop(dropEvent(), editor, ["/clip.mp4"]), null);
});

test("imports a batch in order through the shared native callback", async () => {
    const {drop, editor, state, calls} = harness();
    const paths = ["/01 中文 视频.mp4", "/02 QuickTime.MOV", "/03 声音.MP3", "/04 photo.png"];
    const job = drop.claimDrop(dropEvent(), editor, paths);
    assert.deepEqual(job.remainingPaths, ["/04 photo.png"]);
    const second = drop.claimDrop(dropEvent(), editor, ["/other.mp4"]);
    assert.equal(second.skip, true);
    let imageInserted = false;
    await drop.run(job, () => {
        assert.equal(state.slide.media.length, 3);
        imageInserted = true;
    });
    assert.equal(imageInserted, true);
    assert.deepEqual(calls, [["video", paths[0]], ["video", paths[1]], ["audio", paths[2]]]);
    assert.deepEqual(state.slide.media.map(({name}) => name), paths.slice(0, 3));
});

test("reports unreadable files and keeps the rest of the batch", async () => {
    const {drop, editor, calls, notices, state} = harness();
    const paths = ["/empty.mp4", "/missing.mov", "/uncopied.mp3", "/valid.mp4"];
    const event = dropEvent({files: paths.map(path => ({name: path.slice(1), size: path.includes("empty") ? 0 : 2}))});
    const job = drop.claimDrop(event, editor, paths);
    await drop.run(job, () => {});
    assert.deepEqual(calls, [["audio", "/uncopied.mp3"], ["video", "/valid.mp4"]]);
    assert.equal(state.slide.media.length, 1);
    for (const name of paths.slice(0, 3)) assert.match(notices[0], new RegExp(name.slice(1)));
});

test("rechecks slide identity after the poster finishes loading", async () => {
    const {drop, editor, adapter, state, calls, notices} = harness();
    const original = state.slide;
    let finishPoster;
    adapter.insertMedia = (_, kind, poster, name, transaction) => {
        finishPoster = () => transaction.apply(() => {
            state.slide.media.push({kind, poster, name});
            return true;
        });
    };
    const job = drop.claimDrop(dropEvent(), editor, ["/first.mp4", "/next.mp3"]);
    const importing = drop.run(job, () => assert.fail("a stale batch must not insert its remaining image"));
    await setImmediate();
    state.slide = {media: []};
    finishPoster();
    await importing;
    assert.equal(original.media.length, 0);
    assert.equal(state.slide.media.length, 0);
    assert.equal(calls.length, 1);
    assert.match(notices[0], /target slide changed/i);
});

test("a timed-out native callback never inserts media after the job ends", async () => {
    const {drop, editor, adapter, host, state, notices} = harness(20);
    const normalCopy = adapter.copyMedia;
    adapter.copyMedia = (_, __, callback) => { host.on_add_multimedia_local = callback; };
    const job = drop.claimDrop(dropEvent(), editor, ["/timed-out.mp4"]);
    await drop.run(job, () => {});
    const blocked = drop.claimDrop(dropEvent(), editor, ["/another.mp4"]);
    assert.equal(blocked.skip, true);
    host.on_add_multimedia_local("poster.png", "timed-out.mp4");
    host.on_add_multimedia_local = undefined;
    assert.equal(state.slide.media.length, 0);
    assert.match(notices[0], /timed-out\.mp4/);

    adapter.copyMedia = normalCopy;
    await drop.run(drop.claimDrop(dropEvent(), editor, ["/another.mp4"]), () => {});
    assert.equal(state.slide.media.length, 1);
});

test("reports a Finder drop that provides filenames but no native paths", () => {
    const {drop, editor, notices} = harness();
    const job = drop.claimDrop(dropEvent({files: [{name: "video.mp4", size: 42}]}), editor, []);
    assert.equal(job.skip, true);
    assert.match(notices[0], /could not read/i);
});

test("loading the patched SDK does not require browser globals in the PPTX converter", () => {
    // The converter loads the SDK without FileReader, a document, or URLSearchParams.
    const context = {AscCommon: {}, window: {}};
    const target = {};
    runInNewContext(patchDropHandler(desktopDropHandler), context);
    context.AscCommon.DGf(target);
    assert.deepEqual(target, {});
});

test("the patched desktop handler preserves image and text drops and rejects read-only media drops", () => {
    const received = [];
    let editable = true;
    let paths = [];
    const editor = {
        asc_IsSlidePageMode: () => true,
        va: {Pa: {Iu: () => editable, Nk: () => ({})}},
        kbb: images => received.push(...images),
        pluginMethod_PasteText: text => { if (text) received.push(text); },
    };
    const window = {
        Asc: {editor}, editor,
        AscDesktopEditor: {
            GetDropFiles: () => paths,
            IsSupportMedia: () => true,
            IsImageFile: path => path.endsWith(".png"),
            AddVideo: () => assert.fail("read-only tabs must not use the media bridge"),
        },
    };
    const AscCommon = {Ieh: event => event.dataTransfer.items[0].type === "image/png"};
    runInNewContext(patchDropHandler(desktopDropHandler), {window, AscCommon, URLSearchParams, FileReader: class {}});
    const target = {};
    AscCommon.DGf(target);

    function dispatch(event, text = "") {
        event.preventDefault = () => {};
        event.dataTransfer.getData = () => text;
        target.ondragover(event);
        target.ondrop(event);
        return event.dataTransfer.dropEffect;
    }

    paths = ["/photo.png"];
    assert.equal(dispatch(dropEvent({mime: "image/png"})), "copy");
    paths = [];
    dispatch(dropEvent({types: ["text/plain"]}), "Selected text");
    paths = ["/clip.mp4"];
    editable = false;
    assert.equal(dispatch(dropEvent({mime: "video/mp4"})), "none");
    assert.deepEqual(received, ["/photo.png", "Selected text"]);
});
