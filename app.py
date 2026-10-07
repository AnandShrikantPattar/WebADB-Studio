#!/usr/bin/env python3
"""
ADB Device Manager & One-Click Capture Studio
Provides a web interface to:
Check connected ADB devices & connect new ones (Wi-Fi IP:Port, Pairing, USB TCP/IP)
Take one-click Screenshots, Screen Recordings, Logcat Logs, and Bug Reports
Save each capture type into its own dedicated directory with custom filenames
"""
import datetime
import json
import mimetypes
import os
import re
import shlex
import shutil
import signal
import struct
import subprocess
import threading
import time
import zipfile
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Separate folders for each capture type as requested
FOLDERS = {
    "screenshots": BASE_DIR / "screenshots",
    "screen_recordings": BASE_DIR / "screen_recordings",
    "logs": BASE_DIR / "logs",
    "bug_reports": BASE_DIR / "bug_reports",
}
APKS_DIR = BASE_DIR / "apks"
APKS_DIR.mkdir(parents=True, exist_ok=True)
for folder in FOLDERS.values():
    folder.mkdir(parents=True, exist_ok=True)

ADB_BIN = shutil.which("adb") or "/usr/local/bin/adb"

# Track active screen recordings, live log streams, bug report tasks, and APK flashing per device
active_recordings = {}  # serial -> dict with process, remote_path, local_path, start_time, max_duration
active_log_streams = {}  # serial -> dict with process, local_path, file_handle, start_time
active_bugreports = {}  # task_id -> dict with serial, status, local_path, start_time, message, error
active_apk_flashes = {}  # serial -> dict with status, step, logs, apk_name, pkg_name, start_time, error
active_gha_flashes = active_apk_flashes  # alias for backwards compatibility
device_props_cache = {}  # serial -> (timestamp, cached_props_dict)
state_lock = threading.Lock()
controller_lock = threading.Lock()


def sanitize_filename(name: str, default_prefix: str) -> str:
    """Clean user-supplied name so it is safe for filesystem paths."""
    if not name or not name.strip():
        name = default_prefix
    name = name.strip()
    # Remove any file extension the user might have typed so we don't double-append
    name = re.sub(r"\.(png|mp4|log|txt|zip)$", "", name, flags=re.IGNORECASE)
    # Replace unsafe characters with underscores
    cleaned = re.sub(r"[^a-zA-Z0-9_\-. ]+", "_", name).strip()
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned or default_prefix


def build_target_filepath(folder_key: str, custom_name: str, default_prefix: str, ext: str, include_timestamp: bool = True) -> Path:
    """Construct a unique file path inside the dedicated folder."""
    folder = FOLDERS[folder_key]
    folder.mkdir(parents=True, exist_ok=True)
    base = sanitize_filename(custom_name, default_prefix)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    if include_timestamp:
        filename = f"{base}_{timestamp}.{ext}"
    else:
        filename = f"{base}.{ext}"
    target = folder / filename
    counter = 1
    while target.exists():
        if include_timestamp:
            target = folder / f"{base}_{timestamp}_{counter}.{ext}"
        else:
            target = folder / f"{base}_{counter}.{ext}"
        counter += 1
    return target


def run_adb(args, serial=None, timeout=30, binary=False):
    """Execute an ADB command and return (success, stdout, stderr, returncode)."""
    cmd = [ADB_BIN]
    if serial:
        cmd.extend(["-s", serial])
    cmd.extend(args)
    try:
        res = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        if binary:
            return (res.returncode == 0, res.stdout, res.stderr.decode("utf-8", errors="replace"), res.returncode)
        return (
            res.returncode == 0,
            res.stdout.decode("utf-8", errors="replace").strip(),
            res.stderr.decode("utf-8", errors="replace").strip(),
            res.returncode,
        )
    except FileNotFoundError:
        msg = f"ADB binary not found at '{ADB_BIN}'. Make sure Android Platform Tools are installed."
        return (False, b"" if binary else "", msg, -1)
    except subprocess.TimeoutExpired:
        return (False, b"" if binary else "", f"Command timed out after {timeout}s", -2)
    except Exception as exc:
        return (False, b"" if binary else "", str(exc), -3)


def get_connected_devices():
    """Parse `adb devices -l` and enrich connected devices with model/version/battery info."""
    ok, out, err, _ = run_adb(["devices", "-l"], timeout=10)
    if not ok and not out:
        return {"ok": False, "error": err or "Failed to query adb devices", "devices": []}
    devices = []
    lines = out.splitlines()
    for line in lines[1:]:
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial = parts[0]
        state = parts[1]  # 'device', 'offline', 'unauthorized', etc.
        meta = {}
        for token in parts[2:]:
            if ":" in token:
                k, v = token.split(":", 1)
                meta[k] = v
        adb_model = meta.get("model", "")
        adb_product = meta.get("product", "")
        device_info = {
            "serial": serial,
            "state": state,
            "model": adb_model.replace("_", " ") or serial,
            "adb_model": adb_model,
            "device": meta.get("device", ""),
            "product": adb_product,
            "transport_id": meta.get("transport_id", ""),
            "is_wireless": ":" in serial,
            "android_version": "",
            "sdk_version": "",
            "manufacturer": "",
            "battery": "",
            "SystemBuild": "",
            "VendorBuild": "",
            "gha_version": "",
            "gha_version_code": "",
            "gha_path": "",
        }
        with state_lock:
            is_flashing_now = (
                serial in active_gha_flashes and active_gha_flashes[serial].get("status") == "running"
            )
        if state == "device":
            now_ts = time.time()
            cached = device_props_cache.get(serial)
            if cached and ((now_ts - cached[0] < 6.0) or is_flashing_now):
                device_info.update(cached[1])
            else:
                prop_cmd = [
                    "shell",
                    "getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.product.name; getprop ro.build.fingerprint; getprop ro.vendor.build.fingerprint",
                ]
                p_ok, p_out, _, _ = run_adb(prop_cmd, serial=serial, timeout=4)
                if p_ok and p_out:
                    p_lines = [x.strip() for x in p_out.splitlines()]
                    if len(p_lines) >= 1:
                        device_info["android_version"] = p_lines[0]
                    if len(p_lines) >= 2:
                        device_info["sdk_version"] = p_lines[1]
                    if len(p_lines) >= 3:
                        device_info["manufacturer"] = p_lines[2]
                    if len(p_lines) >= 4 and p_lines[3] and not device_info["adb_model"]:
                        device_info["adb_model"] = p_lines[3]
                        device_info["model"] = p_lines[3]
                    if len(p_lines) >= 5 and p_lines[4] and not device_info["product"]:
                        device_info["product"] = p_lines[4]
                    if len(p_lines) >= 6:
                        device_info["SystemBuild"] = p_lines[5]
                    if len(p_lines) >= 7:
                        device_info["VendorBuild"] = p_lines[6]
                b_ok, b_out, _, _ = run_adb(["shell", "dumpsys battery | grep level"], serial=serial, timeout=3)
                if b_ok and b_out:
                    m = re.search(r"level:\s*(\d+)", b_out)
                    if m:
                        device_info["battery"] = f"{m.group(1)}%"
                # Query GHA (com.google.android.apps.chromecast.app) version & path info
                g_ok, g_out, _, _ = run_adb(
                    [
                        "shell",
                        "dumpsys package com.google.android.apps.chromecast.app | grep -E 'versionName=|versionCode=|codePath='",
                    ],
                    serial=serial,
                    timeout=4,
                )
                if g_ok and g_out:
                    m_ver = re.search(r"versionName=([^\s]+)", g_out)
                    m_code = re.search(r"versionCode=(\d+)", g_out)
                    m_path = re.search(r"codePath=([^\s]+)", g_out)
                    if m_ver:
                        device_info["gha_version"] = m_ver.group(1)
                    if m_code:
                        device_info["gha_version_code"] = m_code.group(1)
                    if m_path:
                        device_info["gha_path"] = m_path.group(1)
                device_props_cache[serial] = (
                    now_ts,
                    {
                        "android_version": device_info["android_version"],
                        "sdk_version": device_info["sdk_version"],
                        "manufacturer": device_info["manufacturer"],
                        "adb_model": device_info["adb_model"],
                        "model": device_info["model"],
                        "product": device_info["product"],
                        "SystemBuild": device_info["SystemBuild"],
                        "VendorBuild": device_info["VendorBuild"],
                        "battery": device_info["battery"],
                        "gha_version": device_info["gha_version"],
                        "gha_version_code": device_info["gha_version_code"],
                        "gha_path": device_info["gha_path"],
                    },
                )
        else:
            cached = device_props_cache.get(serial)
            if cached:
                device_info.update(cached[1])
        devices.append(device_info)
    # Keep any device that is currently rebooting during an active APK flash in the device list
    # so the UI never drops it or switches to another connected device mid-flash.
    seen_serials = {d["serial"] for d in devices}
    with state_lock:
        running_flashes = {
            s: dict(info)
            for s, info in active_apk_flashes.items()
            if info.get("status") == "running"
        }
    for flash_serial, flash_info in running_flashes.items():
        if flash_serial not in seen_serials:
            cached_props = (device_props_cache.get(flash_serial) or (0, {}))[1]
            snap = flash_info.get("device_snapshot") or {}
            merged = {**snap, **cached_props}
            fallback_product = merged.get("product") or ""
            fallback_model = merged.get("model") or merged.get("adb_model") or flash_serial
            devices.append(
                {
                    "serial": flash_serial,
                    "state": "rebooting",
                    "model": fallback_model,
                    "adb_model": merged.get("adb_model") or fallback_model,
                    "device": merged.get("device", ""),
                    "product": fallback_product,
                    "transport_id": "",
                    "is_wireless": ":" in flash_serial,
                    "android_version": merged.get("android_version", ""),
                    "sdk_version": merged.get("sdk_version", ""),
                    "manufacturer": merged.get("manufacturer", ""),
                    "battery": merged.get("battery", ""),
                    "SystemBuild": merged.get("SystemBuild", ""),
                    "VendorBuild": merged.get("VendorBuild", ""),
                    "gha_version": merged.get("gha_version", ""),
                    "gha_version_code": merged.get("gha_version_code", ""),
                    "gha_path": merged.get("gha_path", ""),
                }
            )
    return {"ok": True, "devices": devices, "adb_path": ADB_BIN}


def list_captured_files():
    """Return all files organized by capture category, newest first."""
    result = {}
    for key, folder in FOLDERS.items():
        items = []
        if folder.exists():
            for f in sorted(folder.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
                if f.is_file() and not f.name.startswith("."):
                    stat = f.stat()
                    items.append(
                        {
                            "name": f.name,
                            "category": key,
                            "size_bytes": stat.st_size,
                            "size_human": format_size(stat.st_size),
                            "modified": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                            "url": f"/files/{key}/{f.name}",
                            "path": str(f),
                        }
                    )
        result[key] = items
    return result


def format_size(num_bytes: int) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if num_bytes < 1024.0 or unit == "GB":
            return f"{num_bytes:.1f} {unit}" if unit != "B" else f"{num_bytes} B"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} GB"


def stop_screen_recording(serial: str):
    """Stop an active screen recording on `serial` and pull the MP4 file from `/storage/emulated/0/` to `screen_recordings/`."""
    with state_lock:
        rec = active_recordings.get(serial)
        if not rec:
            return {"ok": False, "error": "No active screen recording found for this device."}
        proc = rec["process"]
        remote_path = rec["remote_path"]
        local_path = rec["local_path"]
    # 1. Gracefully send SIGINT (signal 2) to `screenrecord` on the Android device
    # Note: Android toybox pkill uses `-SIGINT` or `-2` (NOT `-l SIGINT`).
    # Sending SIGINT on-device lets Android's MediaMuxer write the MP4 moov atom cleanly.
    run_adb(
        [
            "shell",
            "kill -2 $(pidof screenrecord) 2>/dev/null || pkill -2 screenrecord 2>/dev/null || killall -2 screenrecord 2>/dev/null",
        ],
        serial=serial,
        timeout=5,
    )
    # 2. Wait for the `screenrecord` process on the device to finish flushing the MP4 file to /storage/emulated/0/
    for _ in range(15):
        _, pid_out, _, _ = run_adb(["shell", "pidof", "screenrecord"], serial=serial, timeout=3)
        if not pid_out.strip():
            break
        time.sleep(0.3)
    # 3. Wait for the local adb shell subprocess to exit cleanly
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    # Give the filesystem on /storage/emulated/0/ a moment to sync
    time.sleep(0.8)
    # 4. Verify the recorded video exists in /storage/emulated/0/ (or find latest .mp4 in /storage/emulated/0/ if needed)
    chk_ok, chk_out, _, _ = run_adb(["shell", f"ls -l {remote_path}"], serial=serial, timeout=5)
    if not chk_ok or "No such file" in chk_out:
        # Fallback: check for the most recently modified .mp4 in /storage/emulated/0/
        _, latest_out, _, _ = run_adb(
            ["shell", "ls -t /storage/emulated/0/*.mp4 2>/dev/null | head -n 1"],
            serial=serial,
            timeout=5,
        )
        if latest_out.strip():
            remote_path = latest_out.strip().splitlines()[0].strip()
    # 5. Pull the recorded MP4 from /storage/emulated/0/... to local screen_recordings/ folder
    ok, out, err, _ = run_adb(["pull", remote_path, str(local_path)], serial=serial, timeout=60)
    with state_lock:
        active_recordings.pop(serial, None)
    if not ok or not local_path.exists() or local_path.stat().st_size == 0:
        return {
            "ok": False,
            "error": err or out or f"Failed to pull recorded video from {remote_path}.",
        }
    # Remove the temporary file from /storage/emulated/0/ only after a verified successful pull
    run_adb(["shell", "rm", "-f", remote_path], serial=serial, timeout=5)
    duration = round(time.time() - rec["start_time"], 1)
    return {
        "ok": True,
        "message": f"Screen recording pulled from {remote_path} and saved ({duration}s)",
        "file": {
            "name": local_path.name,
            "category": "screen_recordings",
            "path": str(local_path),
            "url": f"/files/screen_recordings/{local_path.name}",
            "size_human": format_size(local_path.stat().st_size),
        },
    }


def stop_live_log_stream(serial: str):
    """Stop an active live logcat recording and close the file."""
    with state_lock:
        stream = active_log_streams.pop(serial, None)
        if not stream:
            return {"ok": False, "error": "No active live log stream for this device."}
        proc = stream["process"]
        fh = stream["file_handle"]
        local_path = stream["local_path"]
    try:
        proc.terminate()
        proc.wait(timeout=4)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        fh.flush()
        fh.close()
    except Exception:
        pass
    duration = round(time.time() - stream["start_time"], 1)
    size_bytes = local_path.stat().st_size if local_path.exists() else 0
    return {
        "ok": True,
        "message": f"Live logs saved ({duration}s)",
        "file": {
            "name": local_path.name,
            "category": "logs",
            "path": str(local_path),
            "url": f"/files/logs/{local_path.name}",
            "size_human": format_size(size_bytes),
        },
    }


def list_uploaded_apks():
    """Return all uploaded .apk files in the apks/ folder, newest first."""
    items = []
    if APKS_DIR.exists():
        for f in sorted(APKS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if f.is_file() and f.suffix.lower() == ".apk" and not f.name.startswith("."):
                stat = f.stat()
                items.append(
                    {
                        "name": f.name,
                        "filename": f.name,
                        "path": str(f),
                        "size_human": format_size(stat.st_size),
                        "modified": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                    }
                )
    return items


def get_apk_package_name(apk_path: Path):
    """Extract Android package name from an APK file's AndroidManifest.xml (pure Python)."""
    try:
        if not apk_path.is_file():
            return None
        with zipfile.ZipFile(apk_path, "r") as z:
            if "AndroidManifest.xml" not in z.namelist():
                return None
            data = z.read("AndroidManifest.xml")
        if len(data) < 36:
            return None
        magic, _ = struct.unpack("<II", data[:8])
        if magic != 0x00080003:
            return None
        sp_type, _ = struct.unpack("<HH", data[8:12])
        if sp_type != 0x0001:
            return None
        sp_size = struct.unpack("<I", data[12:16])[0]
        string_count, _, flags, strings_start, _ = struct.unpack("<IIIII", data[16:36])
        is_utf8 = bool(flags & (1 << 8))
        string_offsets = [struct.unpack("<I", data[36 + i * 4 : 40 + i * 4])[0] for i in range(string_count)]
        strings = []
        pool_base = 8 + strings_start
        for offset in string_offsets:
            pos = pool_base + offset
            if pos >= len(data):
                strings.append("")
                continue
            if is_utf8:
                u16len = data[pos]
                pos += 1
                if u16len & 0x80:
                    pos += 1
                u8len = data[pos]
                pos += 1
                if u8len & 0x80:
                    pos += 1
                s = data[pos : pos + u8len].decode("utf-8", errors="ignore")
            else:
                u16len = struct.unpack("<H", data[pos : pos + 2])[0]
                pos += 2
                if u16len & 0x8000:
                    pos += 2
                s = data[pos : pos + u16len * 2].decode("utf-16le", errors="ignore")
            strings.append(s)
        offset = 8 + sp_size
        while offset < len(data) - 8:
            chunk_type, _ = struct.unpack("<HH", data[offset : offset + 4])
            chunk_size = struct.unpack("<I", data[offset + 4 : offset + 8])[0]
            if chunk_size <= 0:
                break
            if chunk_type == 0x0102:  # START_TAG
                tag_name_idx = struct.unpack("<I", data[offset + 20 : offset + 24])[0]
                attr_start = struct.unpack("<H", data[offset + 24 : offset + 26])[0]
                attr_size = struct.unpack("<H", data[offset + 26 : offset + 28])[0]
                attr_count = struct.unpack("<H", data[offset + 28 : offset + 30])[0]
                tag_name = strings[tag_name_idx] if tag_name_idx < len(strings) else ""
                if tag_name == "manifest":
                    attr_base = offset + 16 + attr_start
                    for a in range(attr_count):
                        ap = attr_base + a * attr_size
                        if ap + 20 > len(data):
                            break
                        _, name_idx, val_str_idx, _, _ = struct.unpack("<IIIIh", data[ap : ap + 18])
                        name = strings[name_idx] if name_idx < len(strings) else ""
                        if name == "package" and val_str_idx < len(strings):
                            return strings[val_str_idx]
            offset += chunk_size
    except Exception:
        pass
    return None


def run_apk_flash_task(serial: str, apk_path: Path):
    """Execute the APK flashing sequence in a background thread with live command logs."""
    current_step_key = ["1"]

    def set_step_state(step_key: str, state_val: str, step_desc: str = None):
        current_step_key[0] = step_key
        with state_lock:
            entry = active_apk_flashes.get(serial)
            if entry:
                if "step_states" not in entry:
                    entry["step_states"] = {}
                entry["step_states"][step_key] = state_val
                if step_desc:
                    entry["step"] = step_desc

    def append_log(line: str, step: str = None):
        ts = datetime.datetime.now().strftime("%H:%M:%S")
        with state_lock:
            entry = active_apk_flashes.get(serial)
            if entry:
                if step:
                    entry["step"] = step
                entry["logs"].append(f"[{ts}] {line}")

    def exec_step(args, desc: str, timeout: int = 60, allow_fail: bool = False):
        cmd_str = f"adb -s {serial} {' '.join(args)}"
        append_log(f"$ {cmd_str}", step=desc)
        ok, out, err, code = run_adb(args, serial=serial, timeout=timeout)
        combined = "\n".join(x for x in (out, err) if x).strip()
        if combined:
            append_log(combined)
        if not ok and not allow_fail:
            raise RuntimeError(combined or f"Command failed (exit {code}): {cmd_str}")
        return ok, combined

    try:
        pkg_name = get_apk_package_name(apk_path)
        with state_lock:
            entry = active_apk_flashes.get(serial)
            if entry:
                entry["pkg_name"] = pkg_name or ""

        append_log(
            f"Starting APK flashing sequence with {apk_path.name}"
            + (f" (package: {pkg_name})" if pkg_name else ""),
            step="Checking device & application state...",
        )

        # Step 1: Check existing package & prepare
        set_step_state("1", "running", "Step 1/3: Checking existing package")
        if pkg_name:
            _, pm_out = exec_step(
                ["shell", "pm", "path", pkg_name],
                f"Step 1/3: Checking if {pkg_name} is already installed",
                timeout=15,
                allow_fail=True,
            )
            if "package:" in pm_out:
                append_log(f"Existing installation of '{pkg_name}' found on device. Uninstalling previous version...")
                exec_step(
                    ["uninstall", pkg_name],
                    f"Step 1/3: Uninstalling existing {pkg_name}",
                    timeout=30,
                    allow_fail=True,
                )
            else:
                append_log(f"No existing installation of '{pkg_name}' found — proceeding directly to install.")
        else:
            append_log("Package name auto-detection bypassed — proceeding directly to install.")
        set_step_state("1", "completed")

        # Step 2: Install APK
        set_step_state("2", "running", f"Step 2/3: Installing {apk_path.name}")
        _, inst_out = exec_step(
            ["install", "-d", "-r", str(apk_path)],
            f"Step 2/3: Installing {apk_path.name} (adb install -d -r)",
            timeout=180,
        )
        if "success" not in inst_out.lower():
            raise RuntimeError(inst_out or "APK installation did not report Success.")
        set_step_state("2", "completed")

        # Step 3: Verify & Launch
        set_step_state("3", "running", "Step 3/3: Verify & Launch App")
        if pkg_name:
            _, verify_out = exec_step(
                ["shell", "pm", "path", pkg_name],
                f"Step 3/3: Verifying installed package {pkg_name}",
                timeout=15,
                allow_fail=True,
            )
            if "package:" not in verify_out:
                raise RuntimeError(f"Verification failed: {pkg_name} not found after install.")
            exec_step(
                ["shell", "monkey", "-p", pkg_name, "-c", "android.intent.category.LAUNCHER", "1"],
                f"Step 3/3: Launching {pkg_name}",
                timeout=15,
                allow_fail=True,
            )
        else:
            append_log("APK installation verified.")
        set_step_state("3", "completed")

        with state_lock:
            device_props_cache.pop(serial, None)
            entry = active_apk_flashes.get(serial)
            if entry:
                entry["status"] = "completed"
                entry["finished_at"] = time.time()
                entry["step"] = f"✅ APK Installation Completed ({apk_path.name})"
        append_log(f"🎉 APK '{apk_path.name}' installation completed successfully!")

    except Exception as exc:
        append_log(f"❌ ERROR: {exc}")
        with state_lock:
            device_props_cache.pop(serial, None)
            entry = active_apk_flashes.get(serial)
            if entry:
                if "step_states" not in entry:
                    entry["step_states"] = {}
                entry["step_states"][current_step_key[0]] = "error"
                entry["status"] = "error"
                entry["finished_at"] = time.time()
                entry["error"] = str(exc)
                entry["step"] = f"❌ Flashing Failed: {exc}"


run_gha_flash_task = run_apk_flash_task  # alias for backwards compatibility


class ADBDashboardHandler(SimpleHTTPRequestHandler):
    """HTTP handler serving both static UI assets and the JSON API."""

    def log_message(self, fmt, *args):
        pass

    def send_json(self, payload: dict, status: int = 200):
        raw = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/status":
            dev_data = get_connected_devices()
            with state_lock:
                rec_status = {
                    serial: {
                        "name": info["local_path"].name,
                        "elapsed": round(time.time() - info["start_time"], 1),
                        "max_duration": info.get("max_duration"),
                    }
                    for serial, info in active_recordings.items()
                }
                log_status = {
                    serial: {
                        "name": info["local_path"].name,
                        "elapsed": round(time.time() - info["start_time"], 1),
                    }
                    for serial, info in active_log_streams.items()
                }
                bug_status = {
                    tid: {
                        "serial": info["serial"],
                        "status": info["status"],
                        "filename": info["local_path"].name,
                        "elapsed": round(time.time() - info["start_time"], 1),
                        "message": info["message"],
                        "error": info["error"],
                    }
                    for tid, info in active_bugreports.items()
                }
                apk_status = {
                    serial: {
                        "status": info["status"],
                        "step": info["step"],
                        "step_states": dict(info.get("step_states", {})),
                        "apk_name": info["apk_name"],
                        "pkg_name": info.get("pkg_name", ""),
                        "elapsed": round(time.time() - info["start_time"], 1),
                        "finished_at": info.get("finished_at"),
                        "logs": info["logs"][-120:],
                        "error": info.get("error"),
                    }
                    for serial, info in active_apk_flashes.items()
                }
            self.send_json(
                {
                    "ok": dev_data["ok"],
                    "error": dev_data.get("error"),
                    "adb_path": dev_data.get("adb_path", ADB_BIN),
                    "devices": dev_data.get("devices", []),
                    "active_recordings": rec_status,
                    "active_log_streams": log_status,
                    "active_bugreports": bug_status,
                    "active_apk_flashes": apk_status,
                    "active_gha_flashes": apk_status,
                    "uploaded_apks": list_uploaded_apks(),
                    "folders": {k: str(v) for k, v in FOLDERS.items()},
                    "files": list_captured_files(),
                }
            )
            return

        if path == "/api/files":
            self.send_json({"ok": True, "files": list_captured_files(), "folders": {k: str(v) for k, v in FOLDERS.items()}})
            return

        if path.startswith("/files/"):
            rel = unquote(path[len("/files/") :])
            parts = rel.split("/", 1)
            if len(parts) == 2 and parts[0] in FOLDERS:
                cat, fname = parts[0], os.path.basename(parts[1])
                target = FOLDERS[cat] / fname
                if target.exists() and target.is_file():
                    ctype, _ = mimetypes.guess_type(str(target))
                    ctype = ctype or "application/octet-stream"
                    query = parse_qs(parsed.query)
                    download = query.get("download", ["0"])[0] == "1"
                    data = target.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(data)))
                    if download:
                        self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_json({"ok": False, "error": "File not found"}, status=404)
            return

        if path == "/" or path == "/index.html":
            index_file = STATIC_DIR / "index.html"
            if index_file.exists():
                content = index_file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(content)
                return

        if path.startswith("/static/"):
            rel = unquote(path[len("/static/") :])
            target = (STATIC_DIR / rel).resolve()
            if str(target).startswith(str(STATIC_DIR.resolve())) and target.exists() and target.is_file():
                ctype, _ = mimetypes.guess_type(str(target))
                content = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", ctype or "application/octet-stream")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(content)
                return

        self.send_json({"ok": False, "error": "Not found"}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Binary APK Upload endpoint (Drag & Drop or File Input)
        if path in ("/api/apk/upload-apk", "/api/gha/upload-apk"):
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw_name = unquote(self.headers.get("X-Filename", "app.apk"))
            if length <= 0:
                self.send_json({"ok": False, "error": "Empty APK file upload."}, status=400)
                return
            safe_base = re.sub(r"[^a-zA-Z0-9_\-.]+", "_", os.path.basename(raw_name)).strip("_") or "app.apk"
            if not safe_base.lower().endswith(".apk"):
                safe_base += ".apk"
            APKS_DIR.mkdir(parents=True, exist_ok=True)
            dest = APKS_DIR / safe_base
            remaining = length
            with open(dest, "wb") as fh:
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
            pkg_name = get_apk_package_name(dest)
            self.send_json(
                {
                    "ok": True,
                    "message": f"Uploaded {dest.name} ({format_size(dest.stat().st_size)})",
                    "apk": {
                        "name": dest.name,
                        "filename": dest.name,
                        "path": str(dest),
                        "size_human": format_size(dest.stat().st_size),
                        "package_name": pkg_name or "",
                    },
                    "uploaded_apks": list_uploaded_apks(),
                }
            )
            return

        body = self.read_json_body()

        # Clear APK Console Logs
        if path in ("/api/apk/clear-console", "/api/gha/clear-console"):
            serial = (body.get("serial") or "").strip()
            with state_lock:
                if serial and serial in active_apk_flashes:
                    if active_apk_flashes[serial].get("status") == "running":
                        active_apk_flashes[serial]["logs"] = []
                    else:
                        active_apk_flashes.pop(serial, None)
            self.send_json({"ok": True})
            return

        # Start APK Flashing
        if path in ("/api/apk/flash", "/api/gha/flash"):
            serial = (body.get("serial") or "").strip()
            apk_filename = (body.get("apk_filename") or "").strip()
            apk_path_str = (body.get("apk_path") or "").strip()
            if not serial:
                self.send_json({"ok": False, "error": "No connected ADB device selected."}, status=400)
                return
            if apk_filename:
                apk_path = APKS_DIR / os.path.basename(apk_filename)
            elif apk_path_str:
                apk_path = Path(apk_path_str)
            else:
                self.send_json({"ok": False, "error": "Please drag & drop or upload an .apk file first."}, status=400)
                return
            if not apk_path.exists() or not apk_path.is_file():
                self.send_json({"ok": False, "error": f"APK file not found on server: {apk_path.name}"}, status=400)
                return
            cached_snap = dict((device_props_cache.get(serial) or (0, {}))[1])
            initial_steps = {"1": "pending", "2": "pending", "3": "pending"}
            with state_lock:
                cur = active_apk_flashes.get(serial)
                if cur and cur["status"] == "running":
                    self.send_json({"ok": False, "error": "APK flashing is already in progress on this device."}, status=400)
                    return
                active_apk_flashes[serial] = {
                    "status": "running",
                    "step": "Initializing APK flashing...",
                    "step_states": initial_steps,
                    "apk_name": apk_path.name,
                    "start_time": time.time(),
                    "logs": [],
                    "error": None,
                    "device_snapshot": cached_snap,
                }
            threading.Thread(
                target=run_apk_flash_task,
                args=(serial, apk_path),
                daemon=True,
            ).start()
            self.send_json(
                {
                    "ok": True,
                    "message": f"Started APK flashing with {apk_path.name}",
                }
            )
            return

        # Android Device Remote Controller (Keyevents, D-Pad, Volume, Power, Swipes, Text Input)
        if path == "/api/controller":
            serial = (body.get("serial") or "").strip()
            action = (body.get("action") or "").strip().lower()
            label = (body.get("label") or action).strip()
            if not serial:
                self.send_json({"ok": False, "error": "No connected ADB device selected."}, status=400)
                return
            with controller_lock:
                if action == "keyevent":
                    keycode = str(body.get("keycode") or "").strip()
                    if not keycode:
                        self.send_json({"ok": False, "error": "Missing keycode"}, status=400)
                        return
                    ok, out, err, _ = run_adb(["shell", "input", "keyevent", keycode], serial=serial, timeout=8)
                    self.send_json(
                        {
                            "ok": ok,
                            "message": f"Sent key: {label} ({keycode})" if ok else (err or out or "Failed to send keyevent"),
                            "command": f"adb -s {serial} shell input keyevent {keycode}",
                        }
                    )
                    return

                if action == "swipe":
                    direction = (body.get("direction") or "up").strip().lower()
                    swipes = {
                        "up": ["500", "1300", "500", "350", "250"],
                        "down": ["500", "350", "500", "1300", "250"],
                        "left": ["900", "600", "150", "600", "250"],
                        "right": ["150", "600", "900", "600", "250"],
                    }
                    coords = swipes.get(direction, swipes["up"])
                    ok, out, err, _ = run_adb(["shell", "input", "swipe"] + coords, serial=serial, timeout=8)
                    self.send_json(
                        {
                            "ok": ok,
                            "message": f"Sent Swipe {direction.capitalize()}" if ok else (err or out or "Swipe failed"),
                            "command": f"adb -s {serial} shell input swipe {' '.join(coords)}",
                        }
                    )
                    return

                if action == "text":
                    raw_text = body.get("text") or ""
                    if not raw_text:
                        self.send_json({"ok": False, "error": "Enter text to send to the device."}, status=400)
                        return
                    # Send each character individually in a single remote shell script so Android's
                    # InputManager never drops consecutive/repeated/shifted characters or shell metacharacters.
                    shell_cmds = []
                    for ch in raw_text:
                        if ch == " ":
                            shell_cmds.append("input keyevent 62")
                        elif ch == "\n":
                            shell_cmds.append("input keyevent 66")
                        elif ch == "\t":
                            shell_cmds.append("input keyevent 61")
                        else:
                            shell_cmds.append(f"input text {shlex.quote(ch)}")
                    script = "; ".join(shell_cmds)
                    timeout_sec = max(15, len(raw_text) // 2 + 10)
                    ok, out, err, _ = run_adb(["shell", script], serial=serial, timeout=timeout_sec)
                    self.send_json(
                        {
                            "ok": ok,
                            "message": f'Typed text on device: "{raw_text}"' if ok else (err or out or "Failed to send text"),
                        }
                    )
                    return

                if action == "statusbar":
                    sub = (body.get("sub") or "expand-notifications").strip()
                    if sub not in ("expand-notifications", "expand-settings", "collapse"):
                        sub = "expand-notifications"
                    ok, out, err, _ = run_adb(["shell", "cmd", "statusbar", sub], serial=serial, timeout=8)
                    self.send_json(
                        {
                            "ok": ok,
                            "message": f"Status bar: {label}" if ok else (err or out or "Failed to control statusbar"),
                            "command": f"adb -s {serial} shell cmd statusbar {sub}",
                        }
                    )
                    return

                if action == "launch_gha":
                    ok, out, err, _ = run_adb(
                        [
                            "shell",
                            "monkey",
                            "-p",
                            "com.google.android.apps.chromecast.app",
                            "-c",
                            "android.intent.category.LAUNCHER",
                            "1",
                        ],
                        serial=serial,
                        timeout=10,
                    )
                    self.send_json(
                        {
                            "ok": ok,
                            "message": "Launched Google Home App (GHA)" if ok else (err or out or "Failed to launch GHA"),
                            "command": f"adb -s {serial} shell monkey -p com.google.android.apps.chromecast.app -c android.intent.category.LAUNCHER 1",
                        }
                    )
                    return

                if action == "reboot":
                    ok, out, err, _ = run_adb(["reboot"], serial=serial, timeout=15)
                    self.send_json(
                        {
                            "ok": ok,
                            "message": f"Rebooting device {serial}..." if ok else (err or out or "Failed to reboot device"),
                            "command": f"adb -s {serial} reboot",
                        }
                    )
                    return

                self.send_json({"ok": False, "error": f"Unsupported controller action: {action}"}, status=400)
                return

        if path == "/api/connect":
            host = (body.get("host") or "").strip()
            port = (body.get("port") or "5555").strip()
            if not host:
                self.send_json({"ok": False, "error": "Please enter a valid device IP address or hostname."}, status=400)
                return
            target = host if ":" in host else f"{host}:{port}"
            ok, out, err, _ = run_adb(["connect", target], timeout=15)
            combined = f"{out} {err}".strip()
            success = ok and ("connected to" in combined.lower() or "already connected" in combined.lower())
            self.send_json(
                {
                    "ok": success,
                    "message": combined or ("Connected" if success else "Connection failed"),
                    "error": None if success else (combined or "Failed to connect to device"),
                }
            )
            return

        if path == "/api/pair":
            host = (body.get("host") or "").strip()
            port = (body.get("port") or "").strip()
            code = (body.get("code") or "").strip()
            if not host or not port or not code:
                self.send_json({"ok": False, "error": "IP address, pairing port, and 6-digit pairing code are required."}, status=400)
                return
            target = host if ":" in host else f"{host}:{port}"
            ok, out, err, _ = run_adb(["pair", target, code], timeout=20)
            combined = f"{out} {err}".strip()
            success = ok and "successfully paired" in combined.lower()
            self.send_json(
                {
                    "ok": success,
                    "message": combined,
                    "error": None if success else (combined or "Pairing failed"),
                }
            )
            return

        if path == "/api/disconnect":
            serial = (body.get("serial") or "").strip()
            args = ["disconnect", serial] if serial else ["disconnect"]
            ok, out, err, _ = run_adb(args, timeout=10)
            self.send_json({"ok": ok, "message": out or err or "Disconnected"})
            return

        if path == "/api/tcpip":
            serial = (body.get("serial") or "").strip()
            port = str(body.get("port") or "5555").strip()
            if not serial:
                self.send_json({"ok": False, "error": "Select a USB-connected device first."}, status=400)
                return
            ip_addr = ""
            ip_ok, ip_out, _, _ = run_adb(["shell", "ip route"], serial=serial, timeout=5)
            if ip_ok and ip_out:
                m = re.search(r"src\s+(\d+\.\d+\.\d+\.\d+)", ip_out)
                if m:
                    ip_addr = m.group(1)
            ok, out, err, _ = run_adb(["tcpip", port], serial=serial, timeout=10)
            combined = f"{out} {err}".strip()
            self.send_json(
                {
                    "ok": ok,
                    "message": combined or f"Restarting in TCP mode port: {port}",
                    "device_ip": ip_addr,
                    "port": port,
                    "error": None if ok else combined,
                }
            )
            return

        if path == "/api/restart-adb":
            run_adb(["kill-server"], timeout=10)
            ok, out, err, _ = run_adb(["start-server"], timeout=15)
            self.send_json({"ok": ok, "message": "ADB server restarted successfully." if ok else (err or out)})
            return

        if path == "/api/screenshot":
            serial = (body.get("serial") or "").strip()
            name = (body.get("name") or "").strip()
            include_ts = bool(body.get("include_timestamp", True))
            if not serial:
                self.send_json({"ok": False, "error": "No connected device selected."}, status=400)
                return
            target_path = build_target_filepath("screenshots", name, "screenshot", "png", include_ts)
            ok, png_bytes, err_text, _ = run_adb(["exec-out", "screencap", "-p"], serial=serial, timeout=20, binary=True)
            if ok and png_bytes and png_bytes.startswith(b"\x89PNG"):
                target_path.write_bytes(png_bytes)
            else:
                remote_tmp = f"/storage/emulated/0/{target_path.name}"
                s_ok, _, s_err, _ = run_adb(["shell", "screencap", "-p", remote_tmp], serial=serial, timeout=20)
                if not s_ok:
                    self.send_json({"ok": False, "error": s_err or err_text or "Failed to capture screenshot on device."}, status=500)
                    return
                p_ok, _, p_err, _ = run_adb(["pull", remote_tmp, str(target_path)], serial=serial, timeout=20)
                run_adb(["shell", "rm", "-f", remote_tmp], serial=serial, timeout=5)
                if not p_ok or not target_path.exists():
                    self.send_json({"ok": False, "error": p_err or "Failed to pull screenshot from device."}, status=500)
                    return
            self.send_json(
                {
                    "ok": True,
                    "message": f"Screenshot saved to screenshots/{target_path.name}",
                    "file": {
                        "name": target_path.name,
                        "category": "screenshots",
                        "path": str(target_path),
                        "url": f"/files/screenshots/{target_path.name}",
                        "size_human": format_size(target_path.stat().st_size),
                    },
                }
            )
            return

        if path == "/api/screenrecord/start":
            serial = (body.get("serial") or "").strip()
            name = (body.get("name") or "").strip()
            include_ts = bool(body.get("include_timestamp", True))
            duration = body.get("duration")
            if not serial:
                self.send_json({"ok": False, "error": "No connected device selected."}, status=400)
                return
            with state_lock:
                if serial in active_recordings:
                    self.send_json({"ok": False, "error": "A screen recording is already in progress on this device."}, status=400)
                    return
            target_path = build_target_filepath("screen_recordings", name, "screen_recording", "mp4", include_ts)
            remote_tmp = f"/storage/emulated/0/{target_path.name}"
            cmd = [ADB_BIN, "-s", serial, "shell", "screenrecord"]
            max_dur = None
            if duration:
                try:
                    max_dur = max(1, min(180, int(duration)))
                    cmd.extend(["--time-limit", str(max_dur)])
                except ValueError:
                    pass
            cmd.append(remote_tmp)
            try:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            except Exception as exc:
                self.send_json({"ok": False, "error": f"Failed to start screenrecord: {exc}"}, status=500)
                return
            time.sleep(0.4)
            if proc.poll() is not None:
                err_out = (proc.stderr.read() or b"").decode("utf-8", errors="replace").strip()
                std_out = (proc.stdout.read() or b"").decode("utf-8", errors="replace").strip()
                self.send_json(
                    {
                        "ok": False,
                        "error": err_out or std_out or "screenrecord exited immediately on this device.",
                    },
                    status=500,
                )
                return
            with state_lock:
                active_recordings[serial] = {
                    "process": proc,
                    "remote_path": remote_tmp,
                    "local_path": target_path,
                    "start_time": time.time(),
                    "max_duration": max_dur,
                }
            if max_dur:
                def _auto_finalize(dev_serial, expected_proc):
                    expected_proc.wait()
                    with state_lock:
                        still_active = active_recordings.get(dev_serial)
                        if still_active and still_active["process"] is expected_proc:
                            stop_screen_recording(dev_serial)
                threading.Thread(target=_auto_finalize, args=(serial, proc), daemon=True).start()
            self.send_json(
                {
                    "ok": True,
                    "message": f"Recording started ({target_path.name}). Click 'Stop & Save Recording' when done.",
                    "filename": target_path.name,
                }
            )
            return

        if path == "/api/screenrecord/stop":
            serial = (body.get("serial") or "").strip()
            if not serial:
                self.send_json({"ok": False, "error": "No device specified."}, status=400)
                return
            res = stop_screen_recording(serial)
            self.send_json(res, status=200 if res["ok"] else 500)
            return

        if path == "/api/logs":
            serial = (body.get("serial") or "").strip()
            name = (body.get("name") or "").strip()
            include_ts = bool(body.get("include_timestamp", True))
            level = (body.get("level") or ":V").strip()
            if not serial:
                self.send_json({"ok": False, "error": "No connected device selected."}, status=400)
                return
            if level not in (":V", ":D", ":I", ":W", ":E", ":F"):
                level = ":V"
            target_path = build_target_filepath("logs", name, "logcat", "txt", include_ts)
            ok, raw_bytes, err_text, _ = run_adb(
                ["logcat", "-d", "-v", "threadtime", level],
                serial=serial,
                timeout=30,
                binary=True,
            )
            if not ok and not raw_bytes:
                self.send_json({"ok": False, "error": err_text or "Failed to capture logcat logs."}, status=500)
                return
            target_path.write_bytes(raw_bytes)
            line_count = raw_bytes.count(b"\n")
            self.send_json(
                {
                    "ok": True,
                    "message": f"Saved {line_count:,} log lines to logs/{target_path.name}",
                    "file": {
                        "name": target_path.name,
                        "category": "logs",
                        "path": str(target_path),
                        "url": f"/files/logs/{target_path.name}",
                        "size_human": format_size(target_path.stat().st_size),
                    },
                }
            )
            return

        if path == "/api/logs/stream/start":
            serial = (body.get("serial") or "").strip()
            name = (body.get("name") or "").strip()
            include_ts = bool(body.get("include_timestamp", True))
            level = (body.get("level") or ":V").strip()
            if not serial:
                self.send_json({"ok": False, "error": "No connected device selected."}, status=400)
                return
            with state_lock:
                if serial in active_log_streams:
                    self.send_json({"ok": False, "error": "Live log capture is already running for this device."}, status=400)
                    return
            target_path = build_target_filepath("logs", name, "logcat", "txt", include_ts)
            fh = open(target_path, "wb")
            cmd = [ADB_BIN, "-s", serial, "logcat", "-v", "threadtime", level]
            try:
                proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT)
            except Exception as exc:
                fh.close()
                self.send_json({"ok": False, "error": f"Failed to start logcat stream: {exc}"}, status=500)
                return
            with state_lock:
                active_log_streams[serial] = {
                    "process": proc,
                    "local_path": target_path,
                    "file_handle": fh,
                    "start_time": time.time(),
                }
            self.send_json(
                {
                    "ok": True,
                    "message": f"Live log stream recording to logs/{target_path.name}",
                    "filename": target_path.name,
                }
            )
            return

        if path == "/api/logs/stream/stop":
            serial = (body.get("serial") or "").strip()
            res = stop_live_log_stream(serial)
            self.send_json(res, status=200 if res["ok"] else 500)
            return

        if path == "/api/logs/clear":
            serial = (body.get("serial") or "").strip()
            if not serial:
                self.send_json({"ok": False, "error": "No connected device selected."}, status=400)
                return
            ok, out, err, _ = run_adb(["logcat", "-c"], serial=serial, timeout=10)
            self.send_json({"ok": ok, "message": "Device logcat buffer cleared." if ok else (err or out)})
            return

        if path == "/api/bugreport":
            serial = (body.get("serial") or "").strip()
            name = (body.get("name") or "").strip()
            include_ts = bool(body.get("include_timestamp", True))
            if not serial:
                self.send_json({"ok": False, "error": "No connected device selected."}, status=400)
                return
            with state_lock:
                for tid, info in active_bugreports.items():
                    if info["serial"] == serial and info["status"] == "running":
                        self.send_json(
                            {"ok": False, "error": f"A bug report ({info['local_path'].name}) is already being generated for this device."},
                            status=400,
                        )
                        return
            target_path = build_target_filepath("bug_reports", name, "bugreport", "zip", include_ts)
            task_id = f"br_{int(time.time() * 1000)}"
            with state_lock:
                active_bugreports[task_id] = {
                    "serial": serial,
                    "status": "running",
                    "local_path": target_path,
                    "start_time": time.time(),
                    "message": "Generating full Android bug report (typically takes 30–90s)...",
                    "error": None,
                }

            def _run_bugreport(tid: str, dev_serial: str, dest: Path):
                ok, out, err, _ = run_adb(["bugreport", str(dest)], serial=dev_serial, timeout=300)
                with state_lock:
                    entry = active_bugreports.get(tid)
                    if not entry:
                        return
                    if ok and dest.exists() and dest.stat().st_size > 0:
                        entry["status"] = "completed"
                        entry["message"] = f"Bug report saved to bug_reports/{dest.name} ({format_size(dest.stat().st_size)})"
                    else:
                        if out and len(out) > 256 and not dest.exists():
                            txt_dest = dest.with_suffix(".txt")
                            txt_dest.write_text(out, encoding="utf-8")
                            entry["local_path"] = txt_dest
                            entry["status"] = "completed"
                            entry["message"] = f"Bug report saved to bug_reports/{txt_dest.name}"
                        else:
                            entry["status"] = "error"
                            entry["error"] = err or out or "Failed to generate bug report."
                            entry["message"] = entry["error"]

            threading.Thread(target=_run_bugreport, args=(task_id, serial, target_path), daemon=True).start()
            self.send_json(
                {
                    "ok": True,
                    "task_id": task_id,
                    "message": f"Started generating bug report -> bug_reports/{target_path.name}",
                    "filename": target_path.name,
                }
            )
            return

        if path == "/api/open-folder":
            category = (body.get("category") or "").strip()
            file_name = (body.get("filename") or "").strip()
            folder = FOLDERS.get(category, BASE_DIR)
            folder.mkdir(parents=True, exist_ok=True)
            if file_name:
                target = folder / os.path.basename(file_name)
                if target.exists():
                    subprocess.Popen(["open", "-R", str(target)])
                    self.send_json({"ok": True, "message": f"Revealed {target.name} in Finder"})
                    return
            subprocess.Popen(["open", str(folder)])
            self.send_json({"ok": True, "message": f"Opened {folder.name}/ in Finder"})
            return

        if path == "/api/delete-file":
            category = (body.get("category") or "").strip()
            file_name = os.path.basename((body.get("filename") or "").strip())
            if category in FOLDERS and file_name:
                target = FOLDERS[category] / file_name
                if target.exists() and target.is_file():
                    target.unlink()
                    self.send_json({"ok": True, "message": f"Deleted {file_name}"})
                    return
            self.send_json({"ok": False, "error": "File not found"}, status=404)
            return

        self.send_json({"ok": False, "error": "Unknown API endpoint"}, status=404)


def main():
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), ADBDashboardHandler)
    url = f"http://127.0.0.1:{port}"
    print("=" * 64)
    print(" ADB Device Manager & One-Click Capture Studio")
    print(f" Web UI URL : {url}")
    print(" Folders :")
    for k, v in FOLDERS.items():
        print(f" - {k:18s}: {v}")
    print("=" * 64)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.server_close()


if __name__ == "__main__":
    main()