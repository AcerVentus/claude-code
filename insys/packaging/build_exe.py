#!/usr/bin/env python3
"""Build InSys.exe - InSys as one self-contained Windows program.

    python packaging/build_exe.py            ->  dist/InSys.exe

The result needs nothing installed on the computer that runs it and makes no
downloads: it carries the official Python runtime for Windows plus insys.py and
the web folder, and unpacks them on first start (see launcher/main.go).

To build you need Python 3.9+ and Go 1.21+ (https://go.dev/dl/), on Windows,
macOS or Linux, and an internet connection for the one-off download of the
Python runtime, which is checked against a pinned SHA-256.

    --host-test   builds dist/InSys-host-test for THIS computer instead, with a
                  stand-in for the Windows runtime that calls the local Python.
                  Used to test the launcher on a non-Windows machine.
"""

import argparse
import hashlib
import io
import os
import shutil
import stat
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAUNCHER = os.path.join(HERE, "launcher")
DIST = os.path.join(ROOT, "dist")
CACHE = os.path.join(ROOT, "build")

# The official CPython build for 64-bit Windows, as published by the Python
# Software Foundation on nuget.org (https://www.nuget.org/packages/python).
PYTHON_VERSION = "3.13.17"
PYTHON_URL = ("https://api.nuget.org/v3-flatcontainer/python/%s/python.%s.nupkg"
              % (PYTHON_VERSION, PYTHON_VERSION))
PYTHON_SHA256 = "dce409744b088f94c6e37ba41f8100c384c27e029e843237364c602d30d475e5"

# Parts of the runtime InSys never uses. Leaving them out keeps InSys.exe small.
SKIP_DIRS = ("tools/include/", "tools/libs/", "tools/Lib/ensurepip/", "tools/Lib/site-packages/",
             "tools/Lib/venv/", "tools/Lib/pydoc_data/", "tools/Lib/idlelib/", "tools/Lib/tkinter/",
             "tools/Lib/turtledemo/", "tools/Lib/test/")
SKIP_FILES = ("tools/pythonw.exe",)

APP_FILES = ["insys.py", "web/index.html", "web/app.js", "web/styles.css",
             "web/favicon.svg", "web/robots.txt", "web/connect.html", "web/connect.js"]


def fetch_python():
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, "python.%s.nupkg" % PYTHON_VERSION)
    if not os.path.exists(path):
        print("Downloading Python %s for Windows from nuget.org ..." % PYTHON_VERSION)
        request = urllib.request.Request(PYTHON_URL, headers={"User-Agent": "InSys-build"})
        with urllib.request.urlopen(request, timeout=120) as response, open(path + ".part", "wb") as out:
            shutil.copyfileobj(response, out)
        os.replace(path + ".part", path)
    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    if digest != PYTHON_SHA256:
        os.remove(path)
        sys.exit("The downloaded Python runtime does not match the expected SHA-256.\n"
                 "  expected %s\n  received %s\nNothing was built." % (PYTHON_SHA256, digest))
    return path


def windows_runtime():
    """{path inside the payload: bytes} for the trimmed Windows runtime."""
    files = {}
    with zipfile.ZipFile(fetch_python()) as package:
        for info in package.infolist():
            name = info.filename
            if info.is_dir() or not name.startswith("tools/"):
                continue
            if name.startswith(SKIP_DIRS) or name in SKIP_FILES or "/__pycache__/" in name:
                continue
            files["python/" + name[len("tools/"):]] = package.read(info)
    dlls = [n for n in files if n.count("/") == 1 and n.startswith("python/python3") and n.endswith(".dll")
            and n != "python/python3.dll"]
    if len(dlls) != 1 or "python/python.exe" not in files or "python/Lib/os.py" not in files:
        sys.exit("The Python package does not have the expected layout; nothing was built.")
    # A "._pth" file beside the runtime fixes its module search path to exactly
    # these folders and switches it to isolated mode: it ignores the registry,
    # PYTHON* environment variables and any Python the user has installed.
    files[dlls[0][:-len(".dll")] + "._pth"] = b"Lib\r\nDLLs\r\n"
    return files


def host_test_runtime():
    """A stand-in runtime that runs the Python used for this build."""
    script = '#!/bin/sh\nexec "%s" "$@"\n' % sys.executable
    return {"python/python.exe": script.encode("utf-8")}


def build_payload(runtime):
    files = dict(runtime)
    for name in APP_FILES:
        with open(os.path.join(ROOT, name), "rb") as fh:
            files["app/" + name] = fh.read()
    buffer = io.BytesIO()
    # Sorted names and fixed timestamps: the same inputs always give the same file.
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            executable = name == "python/python.exe"
            info.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
            archive.writestr(info, files[name])
    return buffer.getvalue(), len(files)


def main():
    parser = argparse.ArgumentParser(description="Build InSys.exe")
    parser.add_argument("--host-test", action="store_true",
                        help="build a launcher for this computer with a stand-in runtime (for testing)")
    args = parser.parse_args()

    go = shutil.which("go")
    if not go:
        sys.exit("Go is needed to build the launcher. Install it from https://go.dev/dl/ and try again.")

    payload, count = build_payload(host_test_runtime() if args.host_test else windows_runtime())
    digest = hashlib.sha256(payload).hexdigest()
    os.makedirs(DIST, exist_ok=True)
    if args.host_test:
        output = os.path.join(DIST, "InSys-host-test" + (".exe" if os.name == "nt" else ""))
        env = dict(os.environ, CGO_ENABLED="0")
    else:
        output = os.path.join(DIST, "InSys.exe")
        env = dict(os.environ, GOOS="windows", GOARCH="amd64", CGO_ENABLED="0")

    payload_file = os.path.join(LAUNCHER, "payload.zip")
    hash_file = os.path.join(LAUNCHER, "payload.sha256")
    try:
        with open(payload_file, "wb") as fh:
            fh.write(payload)
        with open(hash_file, "w", encoding="ascii") as fh:
            fh.write(digest + "\n")
        subprocess.run([go, "build", "-trimpath", "-ldflags", "-s -w", "-o", output, "."],
                       cwd=LAUNCHER, env=env, check=True)
    finally:
        for path in (payload_file, hash_file):
            if os.path.exists(path):
                os.remove(path)

    with open(output, "rb") as fh:
        built = fh.read()
    print("Built %s" % output)
    print("  %d files inside, %.1f MB, SHA-256 %s"
          % (count, len(built) / 1048576.0, hashlib.sha256(built).hexdigest()))


if __name__ == "__main__":
    main()
