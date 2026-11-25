#!/usr/bin/env python3
"""Start a built InSys program, use it like a first-time user, and stop it.

    python packaging/smoke_test.py dist/InSys.exe

Exits 0 only if every step works: the program starts with nothing but itself,
serves the web page from inside itself, creates its database beside itself,
signs the administrator in, stores a record, and shuts down cleanly on Ctrl+C.
"""

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

with socket.socket() as _probe:  # a port nothing else is using
    _probe.bind(("127.0.0.1", 0))
    PORT = _probe.getsockname()[1]
BASE = "http://127.0.0.1:%d" % PORT
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(method, path, body=None, cookie=None, csrf=None, raw=False):
    headers = {}
    data = None
    if method != "GET":
        data = json.dumps(body or {}).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["X-CSRF-Token"] = csrf or ""
    if cookie:
        headers["Cookie"] = cookie
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        response = OPENER.open(request, timeout=20)
    except urllib.error.HTTPError as exc:
        response = exc
    payload = response.read()
    set_cookie = response.headers.get("Set-Cookie")
    return response.status, (payload if raw else json.loads(payload.decode("utf-8"))), set_cookie


def check(condition, message):
    print(("  ok    " if condition else "  FAIL  ") + message, flush=True)
    if not condition:
        raise AssertionError(message)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = os.path.abspath(sys.argv[1])
    # A folder of its own, outside the system temp folder (InSys refuses to
    # create a database in a temporary folder), with a space in its name.
    home = os.path.join(os.path.dirname(source), "smoke test run")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    exe = os.path.join(home, os.path.basename(source))
    shutil.copy2(source, exe)
    data = os.path.join(home, "InSys-data")
    log_path = os.path.join(home, "console.txt")

    env = dict(os.environ)
    env["PYTHONHOME"] = os.path.join(tempfile.gettempdir(), "no-such-python")  # must be ignored
    env["PYTHONPATH"] = os.path.join(tempfile.gettempdir(), "no-such-path")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    started = time.time()
    with open(log_path, "wb") as log:
        proc = subprocess.Popen([exe, "--no-browser", "--port", str(PORT)], cwd=home, env=env,
                                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                creationflags=flags, start_new_session=os.name != "nt")
    ok = False
    try:
        ping = None
        for _ in range(240):
            if proc.poll() is not None:
                break
            try:
                ping = call("GET", "/api/ping")[1]
                break
            except (OSError, ValueError):
                time.sleep(0.5)
        check(proc.poll() is None, "program is running")
        check(ping is not None and ping.get("app") == "insys",
              "program started and answers (%.1f s, including first-time unpacking)" % (time.time() - started))

        status, page, _ = call("GET", "/", raw=True)
        check(status == 200 and b"InSys" in page, "web page is served from inside the program")
        for path in ("/app.js", "/styles.css", "/favicon.svg"):
            check(call("GET", path, raw=True)[0] == 200, "serves %s" % path)

        check(os.path.isfile(os.path.join(data, "insys.db")), "database created beside the program, in InSys-data")
        with open(os.path.join(data, "ADMIN-FIRST-LOGIN.txt"), encoding="utf-8") as fh:
            password = re.search(r"Password:\s*(\S+)", fh.read()).group(1)

        status, login, set_cookie = call("POST", "/api/login", {"username": "admin", "password": password})
        check(status == 200 and login["user"]["must_change"], "administrator signs in with the generated password")
        cookie, csrf = set_cookie.split(";")[0], login["csrf"]
        status, _, _ = call("POST", "/api/change-password", {"current": password, "new": "Smoke-test-2026"},
                            cookie, csrf)
        check(status == 200, "password change accepted (password hashing works)")
        check(not os.path.exists(os.path.join(data, "ADMIN-FIRST-LOGIN.txt")), "first-login file removed")

        status, created, _ = call("POST", "/api/records", {
            "module": "project", "title": "Smoke test project", "last_action": "Created by the smoke test",
            "last_action_date": "2026-11-01", "next_action": "Check it", "next_action_date": "2026-12-01"},
            cookie, csrf)
        check(status == 200 and created["record"]["ref"] == "PRJ-0001", "record stored as PRJ-0001")
        status, state, _ = call("GET", "/api/state", cookie=cookie)
        check(status == 200 and len(state["records"]) == 1 and state["me"]["role"] == "admin",
              "state returned with the record")
        status, system, _ = call("GET", "/api/admin/system", cookie=cookie)
        check(status == 200, "runtime inside the program: Python %s on %s" % (system["python"], system["platform"]))
        check(os.path.normcase(os.path.realpath(system["data_dir"])) == os.path.normcase(os.path.realpath(data)),
              "data folder is the one beside the program")
        status, backup, _ = call("GET", "/api/admin/backup", cookie=cookie, raw=True)
        check(status == 200 and backup.startswith(b"SQLite format 3"), "backup download works")

        # Ctrl+C goes to the launcher and to InSys together, as it does when typed
        # in the window. (On Windows a script can only send Ctrl+Break, which both
        # treat the same way.)
        if os.name == "nt":
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            os.killpg(proc.pid, signal.SIGINT)
        try:
            code = proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            code = None
        check(code == 0, "shuts down cleanly on Ctrl+C (exit code %r)" % code)
        check(not os.path.exists(os.path.join(data, "insys.lock")), "lock file removed on shutdown")
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            console = fh.read()
        check("InSys has stopped" in console, "printed its shutdown message")
        check(not os.path.exists(os.path.join(data, "insys.log")), "no errors were logged")
        ok = True
    except AssertionError:
        pass
    finally:
        if proc.poll() is None:
            if os.name == "nt":  # the launcher and the InSys process it started
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            else:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=30)
    if not ok:
        print("\n----- console output -----")
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            print(fh.read())
        for name in ("insys.log",):
            path = os.path.join(data, name)
            if os.path.exists(path):
                print("----- %s -----" % name)
                with open(path, encoding="utf-8", errors="replace") as fh:
                    print(fh.read())
        sys.exit(1)
    shutil.rmtree(home, ignore_errors=True)
    print("\nAll smoke-test steps passed.")


if __name__ == "__main__":
    main()
