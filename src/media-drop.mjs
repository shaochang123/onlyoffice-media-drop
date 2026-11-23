// SPDX-License-Identifier: AGPL-3.0-only

// The builder embeds this factory in the local presentation SDK. Keep it self-contained.
export function createMediaDrop(host, adapter, timeoutMs = 45_000) {
    const supportedMimeTypes = new Set([
        "video/mp4", "video/quicktime", "video/x-quicktime", "audio/mpeg", "audio/mp3", "audio/x-mp3",
    ]);
    const english = {
        busy: "Media Drop is already importing files. Try again in a moment.",
        unavailable: "Media Drop could not read the files from Finder.",
        failed: "Could not insert",
        slideChanged: "The target slide changed or is no longer editable. Import stopped.",
    };
    const chinese = {
        busy: "正在导入媒体，请稍后再拖放。",
        unavailable: "无法读取从 Finder 拖入的文件。",
        failed: "无法插入",
        slideChanged: "目标幻灯片已切换或无法编辑，媒体导入已停止。",
    };
    const locale = new URLSearchParams(host.location?.search).get("lang") ||
        host.document?.documentElement?.lang || host.navigator?.language || "";
    const messages = /^zh\b/i.test(locale) ? chinese : english;
    let activeJob;
    let noticeTimer;

    function mediaKind(name) {
        const extension = name.match(/\.(mp4|mov|mp3)$/i)?.[1].toLowerCase();
        if (!extension) return null;
        return extension === "mp3" ? "audio" : "video";
    }

    function showNotice(message) {
        if (adapter.notify) {
            adapter.notify(message);
            return;
        }
        const document = host.document;
        if (!document?.body) return;

        const existing = document.getElementById("onlyoffice-media-drop-notice");
        const notice = existing ?? document.createElement("div");
        if (!existing) {
            notice.id = "onlyoffice-media-drop-notice";
            notice.setAttribute("role", "status");
            Object.assign(notice.style, {
                position: "fixed", right: "20px", bottom: "36px", zIndex: "100000",
                maxWidth: "min(420px, 85vw)", padding: "12px 16px", borderRadius: "6px",
                background: "#252833", color: "#fff", boxShadow: "0 3px 14px #0004",
                font: "13px/1.5 system-ui, sans-serif", overflowWrap: "anywhere",
                pointerEvents: "none",
            });
            document.body.append(notice);
        }
        notice.textContent = message;
        host.clearTimeout(noticeTimer);
        noticeTimer = host.setTimeout(() => notice.remove(), 6500);
    }

    function isCanvasFileEvent(event) {
        return event.isTrusted && event.target?.closest?.("#id_main_view") &&
            Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function allowsDrop(event, editor) {
        if (!isCanvasFileEvent(event) || !adapter.activeSlide(editor)) return false;
        const items = Array.from(event.dataTransfer.items ?? []).filter(item => item.kind === "file");
        // Finder and Chromium can leave the MIME type empty until the drop.
        return !items.length || items.some(({type}) => !type || type === "application/octet-stream" ||
            supportedMimeTypes.has(type.toLowerCase()));
    }

    function claimDrop(event, editor, paths) {
        if (!isCanvasFileEvent(event)) return null;
        const slide = adapter.activeSlide(editor);
        if (!slide) return null;

        const browserFiles = Array.from(event.dataTransfer.files ?? []);
        const files = [];
        const remainingPaths = [];
        for (const [index, path] of paths.entries()) {
            const kind = typeof path === "string" && path.startsWith("/") && mediaKind(path);
            if (!kind) {
                remainingPaths.push(path);
                continue;
            }
            const name = path.slice(path.lastIndexOf("/") + 1);
            const meta = browserFiles.length === paths.length ? browserFiles[index] : null;
            const empty = meta?.name.normalize() === name.normalize() && meta.size === 0;
            files.push({path, name, kind, empty});
        }

        if (!files.length) {
            if (paths.length || !browserFiles.some(file => mediaKind(file.name))) return null;
            showNotice(messages.unavailable);
            return {remainingPaths, skip: true};
        }

        if (activeJob || typeof host.on_add_multimedia_local === "function") {
            showNotice(messages.busy);
            return {remainingPaths: [], skip: true};
        }

        activeJob = {editor, slide, files, remainingPaths};
        return activeJob;
    }

    function isCurrent(job) {
        return activeJob === job && adapter.currentEditor() === job.editor &&
            adapter.activeSlide(job.editor) === job.slide;
    }

    function insertFile(job, file) {
        return new Promise(resolve => {
            let finished = false;
            const timer = host.setTimeout(() => finish(false), timeoutMs);

            function finish(success) {
                if (finished) return;
                finished = true;
                host.clearTimeout(timer);
                resolve(success);
            }

            try {
                if (file.empty || typeof host.on_add_multimedia_local === "function" ||
                    !adapter.localFileExists(file.path)) {
                    finish(false);
                    return;
                }

                adapter.copyMedia(file.kind, file.path, (poster, mediaName) => {
                    try {
                        if (finished || !isCurrent(job) || !poster || !mediaName ||
                            !adapter.copiedMediaExists(mediaName)) {
                            finish(false);
                            return;
                        }

                        adapter.insertMedia(job.editor, file.kind, poster, mediaName, {
                            apply(insert) {
                                if (finished || !isCurrent(job)) {
                                    finish(false);
                                    return;
                                }

                                try {
                                    finish(insert() === true);
                                } catch {
                                    finish(false);
                                }
                            },
                        });
                    } catch {
                        finish(false);
                    }
                });
            } catch {
                finish(false);
            }
        });
    }

    async function run(job, insertOriginalImage) {
        if (job.skip || activeJob !== job) return;
        const failures = [];
        try {
            for (const file of job.files) {
                if (!isCurrent(job)) break;
                if (!(await insertFile(job, file))) failures.push(file.name);
            }
            if (!isCurrent(job)) {
                showNotice(messages.slideChanged);
                return;
            }
            insertOriginalImage();
            if (failures.length) showNotice(`${messages.failed} ${failures.join(", ")}`);
        } finally {
            activeJob = undefined;
        }
    }

    return {allowsDrop, claimDrop, run};
}
