// ADB Capture Studio — Frontend Controller

const state = {
    devices: [],
    knownDevices: {},
    selectedSerial: null,
    activeRecordings: {},
    activeLogStreams: {},
    activeBugreports: {},
    seenCompletedBugreports: new Set(),
    folders: {},
    files: {
        screenshots: [],
        screen_recordings: [],
        logs: [],
        bug_reports: [],
    },
    activeTab: "all",
    manualConnectDrawerOpen: false,
};

// DOM Elements
const els = {
    connectionBadge: document.getElementById("connectionBadge"),
    connectionBadgeText: document.getElementById("connectionBadgeText"),
    btnRefreshDevices: document.getElementById("btnRefreshDevices"),
    btnToggleConnectPanel: document.getElementById("btnToggleConnectPanel"),
    btnEnableTcpip: document.getElementById("btnEnableTcpip"),
    btnRestartAdb: document.getElementById("btnRestartAdb"),
    deviceList: document.getElementById("deviceList"),
    connectPanel: document.getElementById("connectPanel"),
    formConnectIp: document.getElementById("formConnectIp"),
    inputConnectIp: document.getElementById("inputConnectIp"),
    inputConnectPort: document.getElementById("inputConnectPort"),
    formPairDevice: document.getElementById("formPairDevice"),
    inputPairIp: document.getElementById("inputPairIp"),
    inputPairPort: document.getElementById("inputPairPort"),
    inputPairCode: document.getElementById("inputPairCode"),

    // Naming
    globalCustomName: document.getElementById("globalCustomName"),
    btnClearGlobalName: document.getElementById("btnClearGlobalName"),
    chkIncludeTimestamp: document.getElementById("chkIncludeTimestamp"),
    nameScreenshot: document.getElementById("nameScreenshot"),
    nameRecording: document.getElementById("nameRecording"),
    nameLogs: document.getElementById("nameLogs"),
    nameBugReport: document.getElementById("nameBugReport"),
    previewScreenshot: document.getElementById("previewScreenshot"),
    previewRecording: document.getElementById("previewRecording"),
    previewLogs: document.getElementById("previewLogs"),
    previewBugReport: document.getElementById("previewBugReport"),

    // Capture Controls
    btnCaptureAll: document.getElementById("btnCaptureAll"),
    btnScreenshot: document.getElementById("btnScreenshot"),
    btnScreenRecord: document.getElementById("btnScreenRecord"),
    selectRecDuration: document.getElementById("selectRecDuration"),
    btnStartLogs: document.getElementById("btnStartLogs"),
    btnStopLogs: document.getElementById("btnStopLogs"),
    btnClearLogs: document.getElementById("btnClearLogs"),
    selectLogLevel: document.getElementById("selectLogLevel"),
    btnBugReport: document.getElementById("btnBugReport"),

    // Files
    folderTabs: document.getElementById("folderTabs"),
    storageRootText: document.getElementById("storageRootText"),
    btnOpenCurrentFolder: document.getElementById("btnOpenCurrentFolder"),
    filesTableWrap: document.getElementById("filesTableWrap"),

    // Modal & Toasts
    toastContainer: document.getElementById("toastContainer"),
    previewModal: document.getElementById("previewModal"),
    modalBackdrop: document.getElementById("modalBackdrop"),
    modalTitle: document.getElementById("modalTitle"),
    modalDownloadBtn: document.getElementById("modalDownloadBtn"),
    modalCloseBtn: document.getElementById("modalCloseBtn"),
    modalBody: document.getElementById("modalBody"),
};

// Track whether user manually customized an individual name input
const individualOverrides = {
    screenshot: false,
    recording: false,
    logs: false,
    bugreport: false,
};

function showToast(message, type = "info", durationMs = 4500) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.remove();
    }, durationMs);
}

async function apiPost(url, payload = {}) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return res.json();
}

function sanitizePreviewName(raw, fallback) {
    const val = (raw || "").trim().replace(/\.(png|mp4|log|txt|zip)$/i, "");
    const cleaned = val.replace(/[^a-zA-Z0-9_\-\. ]+/g, "_").trim().replace(/\s+/g, "_");
    return cleaned || fallback;
}

function updateFilenamePreviews() {
    const tsSuffix = els.chkIncludeTimestamp.checked ? "_YYYYMMDD_HHMMSS" : "";
    const sName = sanitizePreviewName(els.nameScreenshot.value || els.globalCustomName.value, "screenshot");
    const rName = sanitizePreviewName(els.nameRecording.value || els.globalCustomName.value, "screen_recording");
    const lName = sanitizePreviewName(els.nameLogs.value || els.globalCustomName.value, "logcat");
    const bName = sanitizePreviewName(els.nameBugReport.value || els.globalCustomName.value, "bugreport");

    els.previewScreenshot.textContent = `screenshots/${sName}${tsSuffix}.png`;
    els.previewRecording.textContent = `screen_recordings/${rName}${tsSuffix}.mp4`;
    els.previewLogs.textContent = `logs/${lName}${tsSuffix}.txt`;
    els.previewBugReport.textContent = `bug_reports/${bName}${tsSuffix}.zip`;
}

function getEffectiveName(individualInput, defaultPrefix) {
    const val = individualInput.value.trim() || els.globalCustomName.value.trim();
    return val || defaultPrefix;
}

function getReadyDeviceSerial() {
    if (!state.selectedSerial) {
        showToast("No ADB device connected! Please connect a device in Section 1 first.", "error");
        els.connectPanel.classList.remove("hidden");
        els.inputConnectIp.focus();
        return null;
    }
    const dev = state.devices.find((d) => d.serial === state.selectedSerial);
    if (!dev || dev.state !== "device") {
        showToast(
            `Device ${state.selectedSerial} is '${dev ? dev.state : "disconnected"}'. Please authorize USB debugging on the phone screen.`,
            "warning"
        );
        return null;
    }
    return state.selectedSerial;
}

// Fetch status from backend
async function refreshStatus(showNotification = false) {
    try {
        const res = await fetch("/api/status");
        const data = await res.json();

        state.devices = data.devices || [];
        state.activeRecordings = data.active_recordings || {};
        state.activeLogStreams = data.active_log_streams || {};
        state.activeBugreports = data.active_bugreports || {};
        state.activeGhaFlashes = data.active_gha_flashes || {};
        state.uploadedApks = data.uploaded_apks || [];
        state.folders = data.folders || {};
        state.files = data.files || state.files;

        for (const d of state.devices) {
            state.knownDevices[d.serial] = d;
        }

        // Auto-select first online device if none selected or previous disappeared,
        // EXCEPT when the currently selected device is actively flashing GHA (e.g., rebooting mid-flash).
        const readyDevices = state.devices.filter((d) => d.state === "device");
        const stillExists = state.devices.some((d) => d.serial === state.selectedSerial);
        const isFlashingSelected = Boolean(
            state.selectedSerial &&
            state.activeGhaFlashes &&
            state.activeGhaFlashes[state.selectedSerial] &&
            state.activeGhaFlashes[state.selectedSerial].status === "running"
        );
        if (!stillExists && !isFlashingSelected) {
            const runningFlashSerial = Object.keys(state.activeGhaFlashes || {}).find(
                (s) => state.activeGhaFlashes[s] && state.activeGhaFlashes[s].status === "running"
            );
            if (runningFlashSerial) {
                state.selectedSerial = runningFlashSerial;
            } else if (readyDevices.length > 0) {
                state.selectedSerial = readyDevices[0].serial;
            } else if (state.devices.length > 0) {
                state.selectedSerial = state.devices[0].serial;
            } else {
                state.selectedSerial = null;
            }
        }

        renderHeaderBadge(readyDevices.length, state.devices.length);
        renderDevices();
        renderCaptureButtonStates();
        renderGhaPanel();
        renderControllerPanel();
        renderFiles();

        if (showNotification) {
            if (readyDevices.length > 0) {
                showToast(`Found ${readyDevices.length} connected ADB device(s).`, "success");
            } else {
                showToast("No connected ADB devices found. Connect one via USB or Wi-Fi below.", "warning");
            }
        }
    } catch (err) {
        console.error("Failed to fetch status:", err);
    }
}

function renderHeaderBadge(readyCount, totalCount) {
    if (readyCount > 0) {
        els.connectionBadge.className = "status-pill connected";
        els.connectionBadgeText.textContent = `${readyCount} Device${readyCount > 1 ? "s" : ""} Connected`;
    } else if (totalCount > 0) {
        els.connectionBadge.className = "status-pill disconnected";
        els.connectionBadgeText.textContent = `${totalCount} Device (Unauthorized/Offline)`;
    } else {
        els.connectionBadge.className = "status-pill disconnected";
        els.connectionBadgeText.textContent = "No Device Connected";
    }
}

function renderDevices() {
    if (state.devices.length === 0) {
        els.deviceList.innerHTML = `
<div class="empty-devices-banner" style="grid-column: 1 / -1;">
<div>
<strong>⚠️ No ADB Devices Connected</strong>
<div style="font-size: 0.84rem; margin-top: 2px;">
Plug in your Android phone via USB (with <em>USB Debugging</em> enabled) or connect wirelessly using the form below.
</div>
</div>
</div>
`;
        // Automatically show the connect panel when no device is connected
        els.connectPanel.classList.remove("hidden");
        return;
    }

    // Hide connect drawer if devices are connected unless manually opened
    if (!state.manualConnectDrawerOpen) {
        els.connectPanel.classList.add("hidden");
    }

    els.deviceList.innerHTML = state.devices
        .map((dev) => {
            const isSelected = dev.serial === state.selectedSerial;
            const stateClass = `state-${dev.state}`;
            const connType = dev.is_wireless ? "📶 Wi-Fi" : "🔌 USB";
            const modelDetail = dev.adb_model || dev.model || "Unknown";
            const productDetail = dev.product || "Unknown";
            const title = dev.manufacturer ? `${dev.manufacturer} ${dev.model}` : dev.model;
            const ghaLabel = dev.gha_version
                ? `${dev.gha_version}${dev.gha_version_code ? ` (${dev.gha_version_code})` : ""}`
                : dev.state === "device"
                    ? "Not Installed"
                    : "N/A";
            const ghaTooltip = dev.gha_path ? `Installed at: ${dev.gha_path}` : "com.google.android.apps.chromecast.app";

            return `
<div class="device-card ${isSelected ? "selected" : ""}" data-serial="${escapeHtml(dev.serial)}">
<div class="device-card-top">
<div class="device-name">
<span>${escapeHtml(title)}</span>
</div>
<span class="device-state-badge ${stateClass}">${escapeHtml(dev.state)}</span>
</div>
<div class="device-meta">
<span>${connType}</span>
<span>SN: <code>${escapeHtml(dev.serial)}</code></span>
<span>Product: <code>${escapeHtml(productDetail)}</code></span>
<span>Model: <code>${escapeHtml(modelDetail)}</code></span>
<span title="${escapeHtml(ghaTooltip)}">GHA: <code>${escapeHtml(ghaLabel)}</code></span>
${dev.SystemBuild ? `<span>System Build: <code>${escapeHtml(dev.SystemBuild)}</code></span>` : ""}
${dev.VendorBuild ? `<span>Vendor Build: <code>${escapeHtml(dev.VendorBuild)}</code></span>` : ""}
${dev.android_version ? `<span>Android ${escapeHtml(dev.android_version)} (API ${escapeHtml(dev.sdk_version)})</span>` : ""}
${dev.battery ? `<span>🔋 ${escapeHtml(dev.battery)}</span>` : ""}
</div>
<div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; gap:8px;">
<span style="font-size:0.76rem; color: ${isSelected ? "#60a5fa" : "#94a3b8"}; font-weight:600;">
${isSelected ? "✓ Active Target Device" : "Click to select"}
</span>
<div style="display:flex; gap:6px; flex-wrap:wrap;">
<button class="btn btn-sm btn-outline btn-open-controller-device" data-serial="${escapeHtml(dev.serial)}">🎮 Controller</button>
<button class="btn btn-sm btn-outline btn-open-gha-device" data-serial="${escapeHtml(dev.serial)}">⚡ GHA Flash</button>
${dev.is_wireless
                    ? `<button class="btn btn-sm btn-ghost btn-disconnect-device" data-serial="${escapeHtml(dev.serial)}">Disconnect</button>`
                    : ""
                }
</div>
</div>
</div>
`;
        })
        .join("");

    // Attach click listeners for selecting a device
    els.deviceList.querySelectorAll(".device-card").forEach((card) => {
        card.addEventListener("click", (e) => {
            if (
                e.target.closest(".btn-disconnect-device") ||
                e.target.closest(".btn-open-gha-device") ||
                e.target.closest(".btn-open-controller-device")
            )
                return;
            state.selectedSerial = card.dataset.serial;
            renderDevices();
            renderCaptureButtonStates();
            renderGhaPanel();
            renderControllerPanel();
        });
    });

    // Attach Controller button listeners on device cards
    els.deviceList.querySelectorAll(".btn-open-controller-device").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            state.selectedSerial = btn.dataset.serial;
            const ctrlPanel = document.getElementById("controllerPanel");
            if (ctrlPanel) {
                ctrlPanel.classList.remove("hidden");
                ctrlPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
            renderDevices();
            renderCaptureButtonStates();
            renderGhaPanel();
            renderControllerPanel();
        });
    });

    // Attach GHA Flash button listeners on device cards
    els.deviceList.querySelectorAll(".btn-open-gha-device").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            state.selectedSerial = btn.dataset.serial;
            const ghaPanel = document.getElementById("ghaFlashingPanel");
            if (ghaPanel) {
                ghaPanel.classList.remove("hidden");
                ghaPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
            renderDevices();
            renderCaptureButtonStates();
            renderGhaPanel();
            renderControllerPanel();
        });
    });

    // Attach disconnect listeners
    els.deviceList.querySelectorAll(".btn-disconnect-device").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const serial = btn.dataset.serial;
            const res = await apiPost("/api/disconnect", { serial });
            showToast(res.message || "Disconnected", res.ok ? "info" : "error");
            refreshStatus();
        });
    });
}

function renderCaptureButtonStates() {
    const serial = state.selectedSerial;

    // Screen Recording button state
    const rec = serial ? state.activeRecordings[serial] : null;
    if (rec) {
        const limitStr = rec.max_duration ? ` / ${rec.max_duration}s` : "";
        els.btnScreenRecord.className = "btn btn-recording-active btn-block";
        els.btnScreenRecord.textContent = `⏹ Stop & Save Recording (${Math.floor(rec.elapsed)}s${limitStr})`;
    } else {
        els.btnScreenRecord.className = "btn btn-danger-outline btn-block";
        els.btnScreenRecord.textContent = "⏺ Start Screen Recording";
    }

    // Start Logs / Stop Logs button state
    const stream = serial ? state.activeLogStreams[serial] : null;
    if (stream) {
        els.btnStartLogs.disabled = true;
        els.btnStartLogs.className = "btn btn-start-logs collecting flex-1";
        els.btnStartLogs.textContent = `● Collecting (${Math.floor(stream.elapsed)}s)`;

        els.btnStopLogs.disabled = false;
        els.btnStopLogs.className = "btn btn-stop-logs active flex-1";
        els.btnStopLogs.textContent = "⏹ Stop Logs";
    } else {
        els.btnStartLogs.disabled = false;
        els.btnStartLogs.className = "btn btn-start-logs flex-1";
        els.btnStartLogs.textContent = "▶ Start Logs";

        els.btnStopLogs.disabled = true;
        els.btnStopLogs.className = "btn btn-stop-logs flex-1";
        els.btnStopLogs.textContent = "⏹ Stop Logs";
    }

    // Bug Report button state
    let runningBugReport = null;
    for (const [tid, br] of Object.entries(state.activeBugreports)) {
        if (br.serial === serial && br.status === "running") {
            runningBugReport = br;
        } else if (br.status === "completed" && !state.seenCompletedBugreports.has(tid)) {
            state.seenCompletedBugreports.add(tid);
            showToast(br.message || "Bug report completed!", "success", 6000);
        } else if (br.status === "error" && !state.seenCompletedBugreports.has(tid)) {
            state.seenCompletedBugreports.add(tid);
            showToast(br.error || "Bug report failed", "error", 6000);
        }
    }

    if (runningBugReport) {
        els.btnBugReport.disabled = true;
        els.btnBugReport.textContent = `⏳ Generating Bug Report (${Math.floor(runningBugReport.elapsed)}s)...`;
    } else {
        els.btnBugReport.disabled = false;
        els.btnBugReport.textContent = "🐞 Generate Bug Report";
    }
}

function renderFiles() {
    const counts = {
        screenshots: (state.files.screenshots || []).length,
        screen_recordings: (state.files.screen_recordings || []).length,
        logs: (state.files.logs || []).length,
        bug_reports: (state.files.bug_reports || []).length,
    };
    const totalCount = counts.screenshots + counts.screen_recordings + counts.logs + counts.bug_reports;

    document.getElementById("count-all").textContent = totalCount;
    document.getElementById("count-screenshots").textContent = counts.screenshots;
    document.getElementById("count-screen_recordings").textContent = counts.screen_recordings;
    document.getElementById("count-logs").textContent = counts.logs;
    document.getElementById("count-bug_reports").textContent = counts.bug_reports;

    // Update folder path banner
    if (state.activeTab === "all") {
        const anyFolder = state.folders.screenshots || "";
        const rootDir = anyFolder ? anyFolder.replace(/\/screenshots$/, "") : "";
        els.storageRootText.textContent = rootDir
            ? `${rootDir}/{screenshots, screen_recordings, logs, bug_reports}`
            : "screenshots/, screen_recordings/, logs/, bug_reports/";
    } else {
        els.storageRootText.textContent = state.folders[state.activeTab] || `${state.activeTab}/`;
    }

    let items = [];
    if (state.activeTab === "all") {
        items = [
            ...(state.files.screenshots || []),
            ...(state.files.screen_recordings || []),
            ...(state.files.logs || []),
            ...(state.files.bug_reports || []),
        ].sort((a, b) => b.modified.localeCompare(a.modified));
    } else {
        items = state.files[state.activeTab] || [];
    }

    if (items.length === 0) {
        els.filesTableWrap.innerHTML = `
<div style="text-align:center; padding: 28px; color: var(--text-muted); font-size: 0.9rem;">
No captures saved in <code>${state.activeTab === "all" ? "any folder" : state.activeTab + "/"}</code> yet. Use the one-click buttons above!
</div>
`;
        return;
    }

    els.filesTableWrap.innerHTML = items
        .map((file) => {
            const canPreview =
                file.category === "screenshots" || file.category === "screen_recordings" || file.category === "logs";
            return `
<div class="file-row">
<div class="file-info">
<span class="file-cat-tag">📁 ${escapeHtml(file.category)}/</span>
<div>
<div class="file-name">${escapeHtml(file.name)}</div>
<div class="file-meta">${escapeHtml(file.size_human)} &bull; ${escapeHtml(file.modified)} &bull; <code>${escapeHtml(file.path)}</code></div>
</div>
</div>
<div class="file-actions">
${canPreview
                    ? `<button class="btn btn-sm btn-secondary btn-preview-file" data-url="${escapeHtml(file.url)}" data-cat="${escapeHtml(file.category)}" data-name="${escapeHtml(file.name)}">Preview</button>`
                    : ""
                }
<a class="btn btn-sm btn-primary" href="${escapeHtml(file.url)}?download=1" download="${escapeHtml(file.name)}">Download</a>
<button class="btn btn-sm btn-ghost btn-reveal-file" data-cat="${escapeHtml(file.category)}" data-name="${escapeHtml(file.name)}" title="Show in macOS Finder">Finder</button>
<button class="btn btn-sm btn-ghost btn-delete-file" data-cat="${escapeHtml(file.category)}" data-name="${escapeHtml(file.name)}" title="Delete file">&times;</button>
</div>
</div>
`;
        })
        .join("");

    // Preview listeners
    els.filesTableWrap.querySelectorAll(".btn-preview-file").forEach((btn) => {
        btn.addEventListener("click", () => {
            openPreviewModal(btn.dataset.name, btn.dataset.cat, btn.dataset.url);
        });
    });

    // Reveal in Finder listeners
    els.filesTableWrap.querySelectorAll(".btn-reveal-file").forEach((btn) => {
        btn.addEventListener("click", async () => {
            await apiPost("/api/open-folder", { category: btn.dataset.cat, filename: btn.dataset.name });
        });
    });

    // Delete file listeners
    els.filesTableWrap.querySelectorAll(".btn-delete-file").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const res = await apiPost("/api/delete-file", { category: btn.dataset.cat, filename: btn.dataset.name });
            if (res.ok) {
                showToast(res.message, "info");
                refreshStatus();
            } else {
                showToast(res.error || "Failed to delete file", "error");
            }
        });
    });
}

async function openPreviewModal(name, category, url) {
    els.modalTitle.textContent = `${category}/${name}`;
    els.modalDownloadBtn.href = `${url}?download=1`;
    els.modalDownloadBtn.setAttribute("download", name);
    els.modalBody.innerHTML = `<div style="color:var(--text-muted);">Loading preview...</div>`;
    els.previewModal.classList.remove("hidden");

    if (category === "screenshots") {
        els.modalBody.innerHTML = `<img src="${url}" alt="${escapeHtml(name)}" />`;
    } else if (category === "screen_recordings") {
        els.modalBody.innerHTML = `<video src="${url}" controls autoplay></video>`;
    } else if (category === "logs") {
        try {
            const res = await fetch(url);
            const text = await res.text();
            const tail = text.length > 120000 ? "... [Showing last 120 KB of log file] ...\n" + text.slice(-120000) : text;
            const pre = document.createElement("pre");
            pre.textContent = tail || "(Log file is empty)";
            els.modalBody.innerHTML = "";
            els.modalBody.appendChild(pre);
        } catch (e) {
            els.modalBody.innerHTML = `<div>Failed to load log file.</div>`;
        }
    }
}

function closePreviewModal() {
    els.previewModal.classList.add("hidden");
    els.modalBody.innerHTML = "";
}

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ============================================================================
// Event Listeners
// ============================================================================

els.btnRefreshDevices.addEventListener("click", () => refreshStatus(true));

els.btnToggleConnectPanel.addEventListener("click", () => {
    const isHidden = els.connectPanel.classList.toggle("hidden");
    state.manualConnectDrawerOpen = !isHidden;
    if (!isHidden) {
        els.inputConnectIp.focus();
    }
});

// Connect via IP:Port
els.formConnectIp.addEventListener("submit", async (e) => {
    e.preventDefault();
    const host = els.inputConnectIp.value.trim();
    const port = els.inputConnectPort.value.trim() || "5555";
    if (!host) return;

    const btn = document.getElementById("btnConnectSubmit");
    btn.disabled = true;
    btn.textContent = "Connecting...";
    try {
        const res = await apiPost("/api/connect", { host, port });
        showToast(res.message || res.error, res.ok ? "success" : "error");
        await refreshStatus();
    } finally {
        btn.disabled = false;
        btn.textContent = "Connect";
    }
});

// Pair Device (Android 11+)
els.formPairDevice.addEventListener("submit", async (e) => {
    e.preventDefault();
    const host = els.inputPairIp.value.trim();
    const port = els.inputPairPort.value.trim();
    const code = els.inputPairCode.value.trim();
    if (!host || !port || !code) return;

    const btn = document.getElementById("btnPairSubmit");
    btn.disabled = true;
    btn.textContent = "Pairing...";
    try {
        const res = await apiPost("/api/pair", { host, port, code });
        showToast(res.message || res.error, res.ok ? "success" : "error");
        if (res.ok && !els.inputConnectIp.value) {
            els.inputConnectIp.value = host;
        }
        await refreshStatus();
    } finally {
        btn.disabled = false;
        btn.textContent = "Pair";
    }
});

// Enable TCP/IP 5555 on selected USB device
els.btnEnableTcpip.addEventListener("click", async () => {
    const serial = getReadyDeviceSerial();
    if (!serial) return;
    const res = await apiPost("/api/tcpip", { serial, port: "5555" });
    if (res.ok) {
        if (res.device_ip) {
            els.inputConnectIp.value = res.device_ip;
            els.inputConnectPort.value = "5555";
            els.connectPanel.classList.remove("hidden");
            state.manualConnectDrawerOpen = true;
            showToast(`TCP/IP enabled! Device IP detected: ${res.device_ip}:5555. Click Connect to attach over Wi-Fi.`, "success", 6500);
        } else {
            showToast(res.message || "Enabled TCP/IP on port 5555", "success");
        }
    } else {
        showToast(res.error || "Failed to enable TCP/IP mode", "error");
    }
});

// Restart ADB Server
els.btnRestartAdb.addEventListener("click", async () => {
    els.btnRestartAdb.disabled = true;
    els.btnRestartAdb.textContent = "Restarting ADB...";
    try {
        const res = await apiPost("/api/restart-adb");
        showToast(res.message || "ADB restarted", res.ok ? "success" : "error");
        await refreshStatus();
    } finally {
        els.btnRestartAdb.disabled = false;
        els.btnRestartAdb.textContent = "Restart ADB Server";
    }
});

// Sync Global Name -> Individual Name inputs (unless individually overridden)
els.globalCustomName.addEventListener("input", () => {
    const val = els.globalCustomName.value;
    if (!individualOverrides.screenshot) els.nameScreenshot.value = val;
    if (!individualOverrides.recording) els.nameRecording.value = val;
    if (!individualOverrides.logs) els.nameLogs.value = val;
    if (!individualOverrides.bugreport) els.nameBugReport.value = val;
    updateFilenamePreviews();
});

els.btnClearGlobalName.addEventListener("click", () => {
    els.globalCustomName.value = "";
    individualOverrides.screenshot = false;
    individualOverrides.recording = false;
    individualOverrides.logs = false;
    individualOverrides.bugreport = false;
    els.nameScreenshot.value = "";
    els.nameRecording.value = "";
    els.nameLogs.value = "";
    els.nameBugReport.value = "";
    updateFilenamePreviews();
});

els.nameScreenshot.addEventListener("input", () => {
    individualOverrides.screenshot = els.nameScreenshot.value.trim().length > 0;
    updateFilenamePreviews();
});
els.nameRecording.addEventListener("input", () => {
    individualOverrides.recording = els.nameRecording.value.trim().length > 0;
    updateFilenamePreviews();
});
els.nameLogs.addEventListener("input", () => {
    individualOverrides.logs = els.nameLogs.value.trim().length > 0;
    updateFilenamePreviews();
});
els.nameBugReport.addEventListener("input", () => {
    individualOverrides.bugreport = els.nameBugReport.value.trim().length > 0;
    updateFilenamePreviews();
});
els.chkIncludeTimestamp.addEventListener("change", updateFilenamePreviews);

// 1. One-Click Screenshot
async function triggerScreenshot() {
    const serial = getReadyDeviceSerial();
    if (!serial) return;
    const name = getEffectiveName(els.nameScreenshot, "screenshot");
    els.btnScreenshot.disabled = true;
    els.btnScreenshot.textContent = "📸 Capturing...";
    try {
        const res = await apiPost("/api/screenshot", {
            serial,
            name,
            include_timestamp: els.chkIncludeTimestamp.checked,
        });
        if (res.ok) {
            showToast(res.message, "success");
            await refreshStatus();
        } else {
            showToast(res.error || "Screenshot failed", "error");
        }
    } finally {
        els.btnScreenshot.disabled = false;
        els.btnScreenshot.textContent = "📸 Take Screenshot";
    }
}
els.btnScreenshot.addEventListener("click", triggerScreenshot);

// 2. One-Click Screen Recording (Start / Stop Toggle)
els.btnScreenRecord.addEventListener("click", async () => {
    const serial = getReadyDeviceSerial();
    if (!serial) return;

    const isRecording = Boolean(state.activeRecordings[serial]);
    if (!isRecording) {
        const name = getEffectiveName(els.nameRecording, "screen_recording");
        const duration = els.selectRecDuration.value;
        els.btnScreenRecord.disabled = true;
        els.btnScreenRecord.textContent = "Starting Recording...";
        try {
            const res = await apiPost("/api/screenrecord/start", {
                serial,
                name,
                duration,
                include_timestamp: els.chkIncludeTimestamp.checked,
            });
            if (res.ok) {
                showToast(res.message, "info");
                await refreshStatus();
            } else {
                showToast(res.error || "Failed to start screen recording", "error");
            }
        } finally {
            els.btnScreenRecord.disabled = false;
            renderCaptureButtonStates();
        }
    } else {
        els.btnScreenRecord.disabled = true;
        els.btnScreenRecord.textContent = "⏳ Saving MP4 from device...";
        try {
            const res = await apiPost("/api/screenrecord/stop", { serial });
            if (res.ok) {
                showToast(`${res.message} -> screen_recordings/${res.file.name}`, "success");
                await refreshStatus();
            } else {
                showToast(res.error || "Failed to save recording", "error");
            }
        } finally {
            els.btnScreenRecord.disabled = false;
            renderCaptureButtonStates();
        }
    }
});

// 3. Start Logs & Stop Logs
async function triggerStartLogs() {
    const serial = getReadyDeviceSerial();
    if (!serial) return;
    if (state.activeLogStreams[serial]) return;

    const name = getEffectiveName(els.nameLogs, "logcat");
    const level = els.selectLogLevel.value;
    els.btnStartLogs.disabled = true;
    els.btnStartLogs.textContent = "Starting...";
    try {
        const res = await apiPost("/api/logs/stream/start", {
            serial,
            name,
            level,
            include_timestamp: els.chkIncludeTimestamp.checked,
        });
        showToast(res.message || res.error, res.ok ? "info" : "error");
        await refreshStatus();
    } finally {
        renderCaptureButtonStates();
    }
}

async function triggerStopLogs() {
    const serial = getReadyDeviceSerial();
    if (!serial) return;
    if (!state.activeLogStreams[serial]) return;

    els.btnStopLogs.disabled = true;
    els.btnStopLogs.textContent = "Saving...";
    try {
        const res = await apiPost("/api/logs/stream/stop", { serial });
        showToast(res.message || res.error, res.ok ? "success" : "error");
        await refreshStatus();
    } finally {
        renderCaptureButtonStates();
    }
}

els.btnStartLogs.addEventListener("click", triggerStartLogs);
els.btnStopLogs.addEventListener("click", triggerStopLogs);

els.btnClearLogs.addEventListener("click", async () => {
    const serial = getReadyDeviceSerial();
    if (!serial) return;
    const res = await apiPost("/api/logs/clear", { serial });
    showToast(res.message || res.error, res.ok ? "info" : "error");
});

// 4. One-Click Bug Report
async function triggerBugReport() {
    const serial = getReadyDeviceSerial();
    if (!serial) return;
    const name = getEffectiveName(els.nameBugReport, "bugreport");

    const res = await apiPost("/api/bugreport", {
        serial,
        name,
        include_timestamp: els.chkIncludeTimestamp.checked,
    });
    showToast(res.message || res.error, res.ok ? "info" : "error");
    await refreshStatus();
}
els.btnBugReport.addEventListener("click", triggerBugReport);

// 5. One-Click Capture All (Screenshot + Start Logs + Bug Report)
els.btnCaptureAll.addEventListener("click", async () => {
    const serial = getReadyDeviceSerial();
    if (!serial) return;
    showToast("Running One-Click Capture All (Screenshot + Start Logs + Bug Report)...", "info");
    await Promise.all([triggerScreenshot(), triggerStartLogs(), triggerBugReport()]);
});

// Open folder buttons on each card
document.querySelectorAll(".open-folder-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
        const category = btn.dataset.folder;
        const res = await apiPost("/api/open-folder", { category });
        if (res.ok) showToast(res.message, "info", 2500);
    });
});

els.btnOpenCurrentFolder.addEventListener("click", async () => {
    const category = state.activeTab === "all" ? "" : state.activeTab;
    const res = await apiPost("/api/open-folder", { category });
    if (res.ok) showToast(res.message, "info", 2500);
});

// Folder Filter Tabs
els.folderTabs.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        els.folderTabs.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeTab = btn.dataset.tab;
        renderFiles();
    });
});

// Modal Close
els.modalCloseBtn.addEventListener("click", closePreviewModal);
els.modalBackdrop.addEventListener("click", closePreviewModal);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePreviewModal();
});

// Dark / Light Theme Toggle
const btnThemeToggle = document.getElementById("btnThemeToggle");
const themeToggleIcon = document.getElementById("themeToggleIcon");
const themeToggleText = document.getElementById("themeToggleText");

function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("adb_studio_theme", theme);
    if (theme === "light") {
        if (themeToggleIcon) themeToggleIcon.textContent = "🌙";
        if (themeToggleText) themeToggleText.textContent = "Dark";
    } else {
        if (themeToggleIcon) themeToggleIcon.textContent = "☀️";
        if (themeToggleText) themeToggleText.textContent = "Light";
    }
}

if (btnThemeToggle) {
    btnThemeToggle.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") || "dark";
        applyTheme(current === "dark" ? "light" : "dark");
    });
}

applyTheme(localStorage.getItem("adb_studio_theme") || "dark");

// =========================================================================
// GHA Flashing Studio (Kramer vs Phone Auto-Detection, Drag & Drop + Upload)
// =========================================================================
let ghaModeOverride = "auto"; // 'auto' | 'kramer' | 'phone'
let lastSeenGhaFlashFinishedAt = {};
let lastGhaLogCount = 0;

const ghaEls = {
    btnToggleGhaPanel: document.getElementById("btnToggleGhaPanel"),
    ghaFlashingPanel: document.getElementById("ghaFlashingPanel"),
    ghaDetectedBadge: document.getElementById("ghaDetectedBadge"),
    ghaCurrentDeviceInfo: document.getElementById("ghaCurrentDeviceInfo"),
    ghaApkDropzone: document.getElementById("ghaApkDropzone"),
    ghaApkFileInput: document.getElementById("ghaApkFileInput"),
    btnBrowseApk: document.getElementById("btnBrowseApk"),
    ghaDropzoneTitle: document.getElementById("ghaDropzoneTitle"),
    ghaDropzoneSub: document.getElementById("ghaDropzoneSub"),
    selectUploadedApk: document.getElementById("selectUploadedApk"),
    ghaPathTitle: document.getElementById("ghaPathTitle"),
    ghaKramerSteps: document.getElementById("ghaKramerSteps"),
    ghaPhoneSteps: document.getElementById("ghaPhoneSteps"),
    btnStartGhaFlash: document.getElementById("btnStartGhaFlash"),
    ghaConsoleWrap: document.getElementById("ghaConsoleWrap"),
    ghaConsoleStep: document.getElementById("ghaConsoleStep"),
    ghaConsoleStatusBadge: document.getElementById("ghaConsoleStatusBadge"),
    ghaConsoleOutput: document.getElementById("ghaConsoleOutput"),
    chkGhaAutoScroll: document.getElementById("chkGhaAutoScroll"),
    btnClearGhaConsole: document.getElementById("btnClearGhaConsole"),
    btnCopyGhaConsole: document.getElementById("btnCopyGhaConsole"),
};

function getEffectiveGhaMode() {
    const dev =
        state.devices.find((d) => d.serial === state.selectedSerial) ||
        (state.selectedSerial ? state.knownDevices[state.selectedSerial] : null);
    const flashState =
        state.selectedSerial && state.activeGhaFlashes ? state.activeGhaFlashes[state.selectedSerial] : null;
    const productStr = dev
        ? `${dev.product || ""} ${dev.device || ""} ${dev.adb_model || ""} ${dev.model || ""}`.toLowerCase()
        : "";
    const isKramerDevice =
        productStr.includes("kramer") || Boolean(flashState && flashState.mode === "kramer");

    if (ghaModeOverride === "kramer") return { mode: "kramer", isAuto: false, product: dev?.product || "None", dev };
    if (ghaModeOverride === "phone") return { mode: "phone", isAuto: false, product: dev?.product || "None", dev };
    if (flashState && flashState.status === "running" && flashState.mode) {
        return {
            mode: flashState.mode,
            isAuto: true,
            product: dev
                ? dev.product || dev.adb_model || (flashState.mode === "kramer" ? "kramer" : "Phone")
                : flashState.mode === "kramer"
                    ? "kramer"
                    : "Phone",
            dev,
        };
    }
    return {
        mode: isKramerDevice ? "kramer" : "phone",
        isAuto: true,
        product: dev ? dev.product || dev.adb_model || "Phone" : "No Device",
        dev,
    };
}

function updatePipelineStepCards(container, stepStates) {
    if (!container) return;
    const cards = container.querySelectorAll(".pipeline-step-card");
    cards.forEach((card) => {
        const stepKey = card.dataset.step;
        const rawState = (stepStates && stepStates[stepKey]) || "pending";
        const statusEl = card.querySelector(".pipeline-step-status");

        card.classList.remove("step-running", "step-completed", "step-skipped", "step-error");

        if (rawState === "running") {
            card.classList.add("step-running");
            if (statusEl) statusEl.textContent = "Running...";
        } else if (rawState === "completed") {
            card.classList.add("step-completed");
            if (statusEl) statusEl.textContent = "Completed";
        } else if (rawState === "skipped") {
            card.classList.add("step-skipped");
            if (statusEl) statusEl.textContent = "Skipped";
        } else if (rawState === "error") {
            card.classList.add("step-error");
            if (statusEl) statusEl.textContent = "Failed";
        } else {
            if (statusEl) statusEl.textContent = "Pending";
        }
    });
}

function renderGhaPanel() {
    if (!ghaEls.ghaFlashingPanel) return;

    const { mode, isAuto, product, dev } = getEffectiveGhaMode();

    // 0. Render current GHA info on selected device
    if (ghaEls.ghaCurrentDeviceInfo) {
        if (!dev) {
            ghaEls.ghaCurrentDeviceInfo.innerHTML = state.selectedSerial
                ? `<span>Target SN: <code>${escapeHtml(state.selectedSerial)}</code></span><span>Status: <code>Rebooting...</code></span>`
                : `<span>Target Device: <code>None Connected</code></span>`;
        } else if (dev.gha_version) {
            ghaEls.ghaCurrentDeviceInfo.innerHTML = `
<span>Target SN: <code>${escapeHtml(dev.serial)}</code>${dev.state === "rebooting" ? " <em>(Rebooting...)</em>" : ""}</span>
<span>Installed GHA Version: <code>${escapeHtml(dev.gha_version)}</code></span>
${dev.gha_version_code ? `<span>Version Code: <code>${escapeHtml(dev.gha_version_code)}</code></span>` : ""}
${dev.gha_path ? `<span>GHA Path: <code>${escapeHtml(dev.gha_path)}</code></span>` : ""}
`;
        } else {
            ghaEls.ghaCurrentDeviceInfo.innerHTML = `
<span>Target SN: <code>${escapeHtml(dev.serial)}</code>${dev.state === "rebooting" ? " <em>(Rebooting...)</em>" : ""}</span>
<span>Installed GHA: <code>${dev.state === "rebooting" ? "Rebooting..." : "Not Installed"}</code></span>
`;
        }
    }

    // 1. Update badge & steps visibility
    if (ghaEls.ghaPathTitle) {
        ghaEls.ghaPathTitle.textContent = "Execution Pipeline";
    }

    if (mode === "kramer") {
        ghaEls.ghaDetectedBadge.className = "gha-mode-badge mode-kramer";
        ghaEls.ghaDetectedBadge.textContent = isAuto
            ? `Kramer Path (Product: ${product})`
            : `Kramer Path (Manual Override)`;
        ghaEls.ghaKramerSteps.classList.remove("hidden");
        ghaEls.ghaPhoneSteps.classList.add("hidden");
    } else {
        ghaEls.ghaDetectedBadge.className = "gha-mode-badge mode-phone";
        ghaEls.ghaDetectedBadge.textContent = isAuto
            ? `Phone Path (Product: ${product})`
            : `Phone Path (Manual Override)`;
        ghaEls.ghaKramerSteps.classList.add("hidden");
        ghaEls.ghaPhoneSteps.classList.remove("hidden");
    }

    // 2. Populate uploaded APK dropdown
    const apks = state.uploadedApks || [];
    const currentVal = ghaEls.selectUploadedApk.value;
    if (apks.length === 0) {
        ghaEls.selectUploadedApk.innerHTML = `<option value="">-- Upload or drop a .apk file above --</option>`;
    } else {
        ghaEls.selectUploadedApk.innerHTML = apks
            .map(
                (a) =>
                    `<option value="${escapeHtml(a.filename)}">${escapeHtml(a.filename)} (${escapeHtml(a.size_human)})</option>`
            )
            .join("");
        if (currentVal && apks.some((a) => a.filename === currentVal)) {
            ghaEls.selectUploadedApk.value = currentVal;
        } else {
            ghaEls.selectUploadedApk.value = apks[0].filename;
        }
    }

    // 3. Live Execution Pipeline & ADB Execution Console
    const serial = state.selectedSerial;
    const flashState = serial && state.activeGhaFlashes ? state.activeGhaFlashes[serial] : null;
    const defaultConsoleMsg =
        mode === "kramer"
            ? "System initialized. Connect a Kramer device and select an APK to begin."
            : "System initialized. Connect a Phone device and select an APK to begin.";

    if (flashState) {
        const activeContainer = flashState.mode === "phone" ? ghaEls.ghaPhoneSteps : ghaEls.ghaKramerSteps;
        updatePipelineStepCards(activeContainer, flashState.step_states || {});

        const logs = flashState.logs || [];
        ghaEls.ghaConsoleOutput.textContent = logs.length > 0 ? logs.join("\n") : defaultConsoleMsg;

        const autoScroll = ghaEls.chkGhaAutoScroll ? ghaEls.chkGhaAutoScroll.checked : true;
        if (autoScroll && logs.length !== lastGhaLogCount) {
            ghaEls.ghaConsoleOutput.scrollTop = ghaEls.ghaConsoleOutput.scrollHeight;
        }
        lastGhaLogCount = logs.length;

        if (ghaEls.ghaConsoleStatusBadge) {
            ghaEls.ghaConsoleStatusBadge.classList.remove("hidden");
        }

        if (flashState.status === "running") {
            if (ghaEls.ghaConsoleStatusBadge) {
                ghaEls.ghaConsoleStatusBadge.className = "device-state-badge state-device";
                ghaEls.ghaConsoleStatusBadge.textContent = "Running...";
            }
            ghaEls.btnStartGhaFlash.disabled = true;
            ghaEls.btnStartGhaFlash.textContent = "⏳ Flashing GHA in Progress...";
        } else if (flashState.status === "completed") {
            if (ghaEls.ghaConsoleStatusBadge) {
                ghaEls.ghaConsoleStatusBadge.className = "device-state-badge state-device";
                ghaEls.ghaConsoleStatusBadge.textContent = "Completed ✓";
            }
            ghaEls.btnStartGhaFlash.disabled = false;
            ghaEls.btnStartGhaFlash.textContent = `⚡ Start GHA Flashing (${mode === "kramer" ? "Kramer Path" : "Phone Path"})`;
            if (flashState.finished_at && lastSeenGhaFlashFinishedAt[serial] !== flashState.finished_at) {
                lastSeenGhaFlashFinishedAt[serial] = flashState.finished_at;
                showToast(`GHA APK flashed onto ${serial} (${flashState.mode.toUpperCase()} path)!`, "success", 6000);
            }
        } else {
            if (ghaEls.ghaConsoleStatusBadge) {
                ghaEls.ghaConsoleStatusBadge.className = "device-state-badge state-unauthorized";
                ghaEls.ghaConsoleStatusBadge.textContent = "Failed";
            }
            ghaEls.btnStartGhaFlash.disabled = false;
            ghaEls.btnStartGhaFlash.textContent = "⚡ Retry GHA Flashing";
            if (flashState.finished_at && lastSeenGhaFlashFinishedAt[serial] !== flashState.finished_at) {
                lastSeenGhaFlashFinishedAt[serial] = flashState.finished_at;
                showToast(`GHA Flashing failed: ${flashState.step}`, "error", 6000);
            }
        }
    } else {
        updatePipelineStepCards(ghaEls.ghaKramerSteps, {});
        updatePipelineStepCards(ghaEls.ghaPhoneSteps, {});
        if (ghaEls.ghaConsoleStatusBadge) {
            ghaEls.ghaConsoleStatusBadge.classList.add("hidden");
        }
        ghaEls.ghaConsoleOutput.textContent = defaultConsoleMsg;
        lastGhaLogCount = 0;
        ghaEls.btnStartGhaFlash.disabled = false;
        ghaEls.btnStartGhaFlash.textContent = `⚡ Start GHA Flashing (${mode === "kramer" ? "Kramer Path" : "Phone Path"})`;
    }
}

// Clear & Copy console buttons
if (ghaEls.btnClearGhaConsole) {
    ghaEls.btnClearGhaConsole.addEventListener("click", async () => {
        const serial = state.selectedSerial || "";
        await apiPost("/api/gha/clear-console", { serial });
        if (serial && state.activeGhaFlashes && state.activeGhaFlashes[serial]) {
            if (state.activeGhaFlashes[serial].status === "running") {
                state.activeGhaFlashes[serial].logs = [];
            } else {
                delete state.activeGhaFlashes[serial];
            }
        }
        renderGhaPanel();
    });
}

if (ghaEls.btnCopyGhaConsole) {
    ghaEls.btnCopyGhaConsole.addEventListener("click", async () => {
        const text = (ghaEls.ghaConsoleOutput && ghaEls.ghaConsoleOutput.textContent) || "";
        try {
            await navigator.clipboard.writeText(text);
            showToast("Console output copied to clipboard!", "success", 2500);
        } catch (_) {
            showToast("Unable to copy to clipboard", "error", 2500);
        }
    });
}

// Toggle GHA panel button
if (ghaEls.btnToggleGhaPanel) {
    ghaEls.btnToggleGhaPanel.addEventListener("click", () => {
        ghaEls.ghaFlashingPanel.classList.toggle("hidden");
        if (!ghaEls.ghaFlashingPanel.classList.contains("hidden")) {
            renderGhaPanel();
        }
    });
}

// Mode selector buttons (Auto / Kramer / Phone)
document.querySelectorAll(".gha-mode-selector .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".gha-mode-selector .tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        ghaModeOverride = btn.dataset.ghamode || "auto";
        renderGhaPanel();
    });
});

// Upload APK helper (used by both Drag & Drop and File Input)
async function uploadGhaApkFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".apk")) {
        showToast("Please select a valid .apk file.", "error");
        return;
    }

    ghaEls.ghaDropzoneTitle.innerHTML = `⏳ Uploading <code>${escapeHtml(file.name)}</code>...`;
    ghaEls.ghaDropzoneSub.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

    try {
        const res = await fetch("/api/gha/upload-apk", {
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Filename": encodeURIComponent(file.name),
            },
            body: file,
        });
        const data = await res.json();
        if (data.ok) {
            showToast(data.message, "success");
            state.uploadedApks = data.uploaded_apks || [];
            renderGhaPanel();
            if (data.apk && data.apk.filename) {
                ghaEls.selectUploadedApk.value = data.apk.filename;
            }
            ghaEls.ghaDropzoneTitle.innerHTML = `✅ Ready: <code>${escapeHtml(data.apk.filename)}</code>`;
            ghaEls.ghaDropzoneSub.textContent = `${data.apk.size_human} — Drop or upload another APK anytime`;
        } else {
            showToast(data.error || "APK upload failed", "error");
            ghaEls.ghaDropzoneTitle.innerHTML = `Drag &amp; Drop GHA <code>.apk</code> here`;
            ghaEls.ghaDropzoneSub.textContent = `or click below to browse & upload`;
        }
    } catch (err) {
        showToast(`Upload error: ${err.message}`, "error");
        ghaEls.ghaDropzoneTitle.innerHTML = `Drag &amp; Drop GHA <code>.apk</code> here`;
        ghaEls.ghaDropzoneSub.textContent = `or click below to browse & upload`;
    }
}

if (ghaEls.btnBrowseApk && ghaEls.ghaApkFileInput) {
    ghaEls.btnBrowseApk.addEventListener("click", (e) => {
        e.stopPropagation();
        ghaEls.ghaApkFileInput.click();
    });

    ghaEls.ghaApkDropzone.addEventListener("click", (e) => {
        if (e.target === ghaEls.btnBrowseApk) return;
        ghaEls.ghaApkFileInput.click();
    });

    ghaEls.ghaApkFileInput.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) uploadGhaApkFile(file);
    });

    // Drag and Drop events
    ["dragenter", "dragover"].forEach((evtName) => {
        ghaEls.ghaApkDropzone.addEventListener(evtName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            ghaEls.ghaApkDropzone.classList.add("drag-over");
        });
    });

    ["dragleave", "drop"].forEach((evtName) => {
        ghaEls.ghaApkDropzone.addEventListener(evtName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            ghaEls.ghaApkDropzone.classList.remove("drag-over");
        });
    });

    ghaEls.ghaApkDropzone.addEventListener("drop", (e) => {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
            uploadGhaApkFile(files[0]);
        }
    });
}

// Start GHA Flashing button
if (ghaEls.btnStartGhaFlash) {
    ghaEls.btnStartGhaFlash.addEventListener("click", async () => {
        const serial = getReadyDeviceSerial();
        if (!serial) return;

        const apkFilename = ghaEls.selectUploadedApk.value;
        if (!apkFilename) {
            showToast("Please drag & drop or upload a GHA .apk file first!", "warning");
            return;
        }

        ghaEls.btnStartGhaFlash.disabled = true;
        ghaEls.btnStartGhaFlash.textContent = "⏳ Starting GHA Flash...";

        const res = await apiPost("/api/gha/flash", {
            serial,
            apk_filename: apkFilename,
            mode: ghaModeOverride,
        });

        showToast(res.message || res.error, res.ok ? "info" : "error");
        await refreshStatus(false);
    });
}

// =========================================================================
// Android Device Remote Controller (D-Pad, Nav Keys, Power, Volume, Swipes)
// =========================================================================
const ctrlEls = {
    btnToggleControllerPanel: document.getElementById("btnToggleControllerPanel"),
    controllerPanel: document.getElementById("controllerPanel"),
    controllerTargetBadge: document.getElementById("controllerTargetBadge"),
    formControllerText: document.getElementById("formControllerText"),
    inputControllerText: document.getElementById("inputControllerText"),
};

function renderControllerPanel() {
    if (!ctrlEls.controllerPanel) return;
    const dev = state.devices.find((d) => d.serial === state.selectedSerial);
    if (ctrlEls.controllerTargetBadge) {
        if (dev) {
            ctrlEls.controllerTargetBadge.textContent = `Target: ${dev.model} (${dev.serial})`;
            ctrlEls.controllerTargetBadge.className = "gha-mode-badge mode-phone";
        } else {
            ctrlEls.controllerTargetBadge.textContent = "No Device Selected";
            ctrlEls.controllerTargetBadge.className = "gha-mode-badge";
        }
    }
}

if (ctrlEls.btnToggleControllerPanel) {
    ctrlEls.btnToggleControllerPanel.addEventListener("click", () => {
        ctrlEls.controllerPanel.classList.toggle("hidden");
        if (!ctrlEls.controllerPanel.classList.contains("hidden")) {
            renderControllerPanel();
        }
    });
}

let controllerQueue = Promise.resolve();

function sendControllerCommand(payload) {
    const serial = getReadyDeviceSerial();
    if (!serial) return Promise.resolve();

    controllerQueue = controllerQueue
        .then(async () => {
            const res = await apiPost("/api/controller", { serial, ...payload });
            if (!res.ok) {
                showToast(res.error || "Controller command failed", "error", 3000);
            }
        })
        .catch(() => { });

    return controllerQueue;
}

document.querySelectorAll(".ctrl-key").forEach((btn) => {
    btn.addEventListener("click", async () => {
        const action = btn.dataset.ctrlAction;
        const label = btn.dataset.label || action;
        if (action === "reboot") {
            if (!confirm("Are you sure you want to reboot the selected Android device?")) return;
        }
        await sendControllerCommand({
            action,
            label,
            keycode: btn.dataset.keycode || "",
            direction: btn.dataset.direction || "",
            sub: btn.dataset.sub || "",
        });
    });
});

if (ctrlEls.formControllerText) {
    ctrlEls.formControllerText.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = ctrlEls.inputControllerText.value;
        if (!text) {
            showToast("Enter text to send to the device.", "warning", 2500);
            return;
        }
        ctrlEls.inputControllerText.value = "";
        await sendControllerCommand({
            action: "text",
            label: `Text "${text}"`,
            text,
        });
    });
}

// Initial load & periodic polling (updates timers and checks connected devices)
updateFilenamePreviews();
refreshStatus(false);
setInterval(() => refreshStatus(false), 2000);