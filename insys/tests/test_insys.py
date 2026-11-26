"""End-to-end tests for the InSys server. Standard library only.

Run from the insys folder:   python -m unittest discover -s tests -v
"""

import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

# (password hashing is slowed for real use; the tests turn it down after loading the program)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import insys  # noqa: E402

insys.PBKDF2_ITERATIONS = 1000  # keep the tests fast; the program itself always uses its full setting


class Client:
    """A minimal browser stand-in: keeps the session cookie and CSRF token."""

    def __init__(self, base, context=None):
        self.base = base
        self.cookie = None
        self.csrf = ""
        handlers = [urllib.request.ProxyHandler({})]
        if context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=context))
        self.opener = urllib.request.build_opener(*handlers)

    def request(self, method, path, body=None, headers=None, raw=False, send_csrf=True):
        data = None
        hdrs = {}
        if method != "GET":
            data = json.dumps(body if body is not None else {}).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
            if send_csrf:
                hdrs["X-CSRF-Token"] = self.csrf
        if self.cookie:
            hdrs["Cookie"] = self.cookie
        hdrs.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            resp = self.opener.open(req, timeout=20)
        except urllib.error.HTTPError as exc:
            resp = exc
        payload = resp.read()
        set_cookie = resp.headers.get("Set-Cookie")
        if set_cookie:
            first = set_cookie.split(";")[0]
            self.cookie = first if first.split("=", 1)[1] else None
        self.last_headers = resp.headers
        if raw:
            return resp.status, payload
        try:
            return resp.status, json.loads(payload.decode("utf-8"))
        except ValueError:
            return resp.status, None

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, body=None):
        return self.request("POST", path, body)

    def put(self, path, body=None):
        return self.request("PUT", path, body)

    def delete(self, path):
        return self.request("DELETE", path)

    def upload(self, path, data, send_csrf=True):
        headers = {"Content-Type": "application/octet-stream"}
        if send_csrf:
            headers["X-CSRF-Token"] = self.csrf
        if self.cookie:
            headers["Cookie"] = self.cookie
        req = urllib.request.Request(self.base + path, data=data, method="POST", headers=headers)
        try:
            resp = self.opener.open(req, timeout=60)
        except urllib.error.HTTPError as exc:
            resp = exc
        except (urllib.error.URLError, ConnectionError):
            return 0, None  # refused before the file was read
        payload = resp.read()
        if resp.headers.get("Set-Cookie"):
            self.cookie = None
        try:
            return resp.status, json.loads(payload.decode("utf-8"))
        except ValueError:
            return resp.status, None

    def login(self, username, password):
        status, data = self.post("/api/login", {"username": username, "password": password})
        if status == 200:
            self.csrf = data["csrf"]
        return status, data


class InSysTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="insys-test-")
        insys.RT.data_dir = cls.tmp
        cls.first_password = insys.init_db()
        cls.server = insys.Server(("127.0.0.1", 0), insys.Handler)
        insys.RT.port = cls.server.server_address[1]
        cls.base = "http://127.0.0.1:%d" % insys.RT.port
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

        # Administrator: first sign-in with the generated password.
        cls.admin = Client(cls.base)
        status, data = cls.admin.login("admin", cls.first_password)
        assert status == 200 and data["user"]["must_change"] is True, data
        cls.first_state_status = cls.admin.get("/api/state")
        cls.first_login_file_before = os.path.exists(insys.RT.first_login_file)
        status, data = cls.admin.post("/api/change-password",
                                      {"current": cls.first_password, "new": "Chief-pass-2026"})
        assert status == 200, data
        cls.people = {}
        for username, name, role in [("fiona", "Fiona Finance", "finance"),
                                     ("oscar", "Oscar Office", "office"),
                                     ("sam", "Sam Staff", "staff"),
                                     ("tina", "Tina Staff", "staff")]:
            cls.people[username] = cls.make_user(username, name, role)

    @classmethod
    def make_user(cls, username, name, role):
        status, data = cls.admin.post("/api/admin/users",
                                      {"username": username, "full_name": name, "role": role})
        assert status == 200, data
        client = Client(cls.base)
        status, login = client.login(username, data["temp_password"])
        assert status == 200 and login["user"]["must_change"], login
        password = "%s-Pass-12345" % role
        status, changed = client.post("/api/change-password",
                                      {"current": data["temp_password"], "new": password})
        assert status == 200, changed
        client.user_id = data["user"]["id"]
        client.password = password
        return client

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- helpers ------------------------------------------------------------

    def new_record(self, client, module, title="Item", **extra):
        body = {"module": module, "title": title}
        body.update(extra)
        status, data = client.post("/api/records", body)
        self.assertEqual(status, 200, data)
        return data["record"]

    def state(self, client):
        status, data = client.get("/api/state")
        self.assertEqual(status, 200, data)
        return data

    def find(self, state, record_id):
        return next((r for r in state["records"] if r["id"] == record_id), None)

    # -- first run and sign-in ------------------------------------------------

    def test_first_run_creates_admin_and_forces_password_change(self):
        self.assertTrue(self.first_password)
        self.assertTrue(self.first_login_file_before)
        status, data = self.first_state_status
        self.assertEqual(status, 403)
        self.assertEqual(data["code"], "password_change_required")
        # Once the administrator has chosen a password the file is removed.
        self.assertFalse(os.path.exists(insys.RT.first_login_file))
        self.assertEqual(self.state(self.admin)["me"]["role"], "admin")

    def test_old_password_no_longer_works(self):
        status, _ = Client(self.base).login("admin", self.first_password)
        self.assertEqual(status, 401)

    def test_sign_in_required(self):
        anon = Client(self.base)
        for path in ["/api/state", "/api/version", "/api/me", "/api/admin/users", "/api/activity"]:
            status, data = anon.get(path)
            self.assertEqual(status, 401, path)
        status, _ = anon.post("/api/records", {"module": "project", "title": "x"})
        self.assertEqual(status, 401)

    def test_wrong_password_and_unknown_user_look_the_same(self):
        status1, data1 = Client(self.base).login("admin", "not-the-password")
        status2, data2 = Client(self.base).login("nobody-here", "not-the-password")
        self.assertEqual((status1, status2), (401, 401))
        self.assertEqual(data1["error"], data2["error"])

    def test_repeated_failures_are_throttled(self):
        client = Client(self.base)
        for _ in range(8):
            status, _ = client.login("throttle-me", "wrong-password")
            self.assertEqual(status, 401)
        status, data = client.login("throttle-me", "wrong-password")
        self.assertEqual(status, 429)
        self.assertIn("Too many", data["error"])

    def test_username_is_case_insensitive(self):
        client = Client(self.base)
        status, _ = client.login("  SAM ", self.people["sam"].password)
        self.assertEqual(status, 200)

    def test_csrf_token_is_required_for_changes(self):
        sam = self.people["sam"]
        status, data = sam.request("POST", "/api/records", {"module": "project", "title": "x"},
                                   send_csrf=False)
        self.assertEqual(status, 403)
        self.assertEqual(data["code"], "csrf")
        status, data = sam.request("POST", "/api/records", {"module": "project", "title": "x"},
                                   headers={"X-CSRF-Token": "wrong"}, send_csrf=False)
        self.assertEqual(status, 403)

    def test_only_json_is_accepted(self):
        sam = self.people["sam"]
        req = urllib.request.Request(
            self.base + "/api/login", data=b'{"username":"sam","password":"x"}', method="POST",
            headers={"Content-Type": "text/plain"})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            sam.opener.open(req, timeout=10)
        self.assertEqual(ctx.exception.code, 415)

    def test_oversized_request_is_rejected(self):
        sam = self.people["sam"]
        before = len(self.state(sam)["records"])
        # The server refuses without reading the body. The client either receives
        # the 413 reply or, if it is still sending, finds the connection closed.
        try:
            status, _ = sam.post("/api/records", {"module": "project", "title": "x" * (1024 * 1024 + 10)})
        except (urllib.error.URLError, ConnectionError):
            status = 413
        self.assertEqual(status, 413)
        self.assertEqual(len(self.state(sam)["records"]), before)

    def test_password_policy(self):
        tina = self.people["tina"]
        for bad in ["short1", "allletters-only", "12345678901234", "xx-tina-12345"]:
            status, data = tina.post("/api/change-password", {"current": tina.password, "new": bad})
            self.assertEqual(status, 400, bad)
        status, data = tina.post("/api/change-password", {"current": "wrong", "new": "Valid-pass-9999"})
        self.assertEqual(status, 400)

    def test_session_expires_when_idle(self):
        client = Client(self.base)
        client.login("sam", self.people["sam"].password)
        self.assertEqual(client.get("/api/me")[0], 200)
        conn = sqlite3.connect(insys.RT.db_path)
        token = client.cookie.split("=", 1)[1]
        conn.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?",
                     (time.time() - insys.SESSION_IDLE_SECONDS - 5, insys.session_hash(token, "local")))
        conn.commit()
        conn.close()
        self.assertEqual(client.get("/api/me")[0], 401)

    def test_logout_ends_the_session(self):
        client = Client(self.base)
        client.login("sam", self.people["sam"].password)
        cookie = client.cookie
        self.assertEqual(client.post("/api/logout")[0], 200)
        client.cookie = cookie
        self.assertEqual(client.get("/api/me")[0], 401)

    # -- static files and headers ---------------------------------------------

    def test_static_files_and_security_headers(self):
        anon = Client(self.base)
        status, body = anon.request("GET", "/", raw=True)
        self.assertEqual(status, 200)
        self.assertIn(b"InSys", body)
        headers = anon.last_headers
        self.assertIn("default-src 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        for path in ["/app.js", "/styles.css", "/favicon.svg", "/robots.txt"]:
            self.assertEqual(anon.request("GET", path, raw=True)[0], 200, path)
        for path in ["/insys.py", "/../insys.py", "/data/insys.db", "/web/app.js", "/%2e%2e/insys.py"]:
            self.assertEqual(anon.request("GET", path, raw=True)[0], 404, path)

    def test_ping_is_public_and_minimal(self):
        status, data = Client(self.base).get("/api/ping")
        self.assertEqual(status, 200)
        self.assertEqual(sorted(data), ["app", "instance", "version"])

    # -- records ----------------------------------------------------------------

    def test_record_lifecycle(self):
        sam = self.people["sam"]
        rec = self.new_record(sam, "project", "Website rebuild", organisation="Acme Ltd",
                              owner_id=sam.user_id, amount="12,500.50",
                              last_action="Kick-off call held", last_action_date="2026-11-01",
                              next_action="Send proposal", next_action_date="2026-11-10")
        self.assertRegex(rec["ref"], r"^PRJ-\d{4}$")
        self.assertEqual(rec["status"], "Planning")
        self.assertEqual(rec["amount"], 12500.5)
        self.assertEqual(rec["last_action"], "Kick-off call held")
        self.assertEqual(rec["last_action_by"], sam.user_id)
        self.assertEqual(rec["version"], 1)

        # Edit
        status, data = sam.put("/api/records/%d" % rec["id"],
                               {"version": 1, "status": "In Progress", "priority": "High"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["record"]["status"], "In Progress")
        self.assertEqual(data["record"]["version"], 2)
        self.assertEqual(data["record"]["title"], "Website rebuild")  # untouched fields kept

        # A stale copy cannot overwrite newer changes.
        status, data = sam.put("/api/records/%d" % rec["id"], {"version": 1, "title": "Stale"})
        self.assertEqual(status, 409)
        self.assertEqual(data["code"], "conflict")

        # Saving with nothing changed is harmless and does not bump the version.
        status, data = sam.put("/api/records/%d" % rec["id"], {"version": 2, "priority": "High"})
        self.assertEqual(status, 200)
        self.assertFalse(data["changed"])
        self.assertEqual(data["record"]["version"], 2)

        # Log an action: becomes the last known action and sets the next one.
        status, data = sam.post("/api/records/%d/actions" % rec["id"], {
            "version": 2, "text": "Proposal sent", "date": "2026-11-09", "status": "On Hold",
            "next_action": "Chase reply", "next_action_date": "2026-11-20"})
        self.assertEqual(status, 200, data)
        r = data["record"]
        self.assertEqual((r["last_action"], r["last_action_date"]), ("Proposal sent", "2026-11-09"))
        self.assertEqual((r["next_action"], r["next_action_date"]), ("Chase reply", "2026-11-20"))
        self.assertEqual(r["status"], "On Hold")

        # A back-dated action is recorded in history but does not replace a newer last action.
        status, data = sam.post("/api/records/%d/actions" % rec["id"], {
            "version": r["version"], "text": "Older thing", "date": "2026-10-01"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["record"]["last_action"], "Proposal sent")
        self.assertEqual(data["record"]["next_action"], "Chase reply")

        status, data = sam.post("/api/records/%d/notes" % rec["id"], {"text": "Client prefers email.\nLine 2"})
        self.assertEqual(status, 200)

        status, data = sam.get("/api/records/%d/history" % rec["id"])
        self.assertEqual(status, 200)
        kinds = [x["kind"] for x in data["history"]]
        self.assertEqual(kinds, ["note", "action", "action", "updated", "action", "created"])
        self.assertIn("Status: Planning → In Progress", data["history"][3]["text"])
        self.assertIn("Status: In Progress → On Hold", data["history"][2]["text"])

        # Everyone sees it in their state; only an administrator can delete.
        self.assertIsNotNone(self.find(self.state(self.people["tina"]), rec["id"]))
        self.assertEqual(sam.delete("/api/records/%d" % rec["id"])[0], 403)
        self.assertEqual(self.admin.delete("/api/records/%d" % rec["id"])[0], 200)
        self.assertIsNone(self.find(self.state(sam), rec["id"]))
        self.assertEqual(sam.get("/api/records/%d/history" % rec["id"])[0], 404)

    def test_references_are_sequential_per_section_and_never_reused(self):
        sam = self.people["sam"]
        a = self.new_record(sam, "eoi", "First")
        b = self.new_record(sam, "eoi", "Second")
        number = lambda r: int(r["ref"].split("-")[1])
        self.assertEqual(number(b), number(a) + 1)
        self.assertTrue(a["ref"].startswith("EOI-"))
        self.admin.delete("/api/records/%d" % b["id"])
        c = self.new_record(sam, "eoi", "Third")
        self.assertEqual(number(c), number(b) + 1)

    def test_record_validation(self):
        sam = self.people["sam"]
        bad = [
            {"module": "project", "title": ""},
            {"module": "project", "title": "   "},
            {"module": "project", "title": "x" * 201},
            {"module": "project", "title": "x", "status": "Nonsense"},
            {"module": "project", "title": "x", "priority": "Extreme"},
            {"module": "project", "title": "x", "due_date": "2026-13-40"},
            {"module": "project", "title": "x", "due_date": "tomorrow"},
            {"module": "project", "title": "x", "amount": -5},
            {"module": "project", "title": "x", "amount": "abc"},
            {"module": "project", "title": "x", "owner_id": 999999},
            {"module": "project", "title": "x", "category": "Made up"},
            {"module": "project", "title": "x", "last_action": "Did a thing"},  # date missing
            {"module": "project", "title": ["not", "text"]},
        ]
        for body in bad:
            status, data = sam.post("/api/records", body)
            self.assertEqual(status, 400, body)
            self.assertTrue(data["error"])
        self.assertEqual(sam.post("/api/records", {"module": "nope", "title": "x"})[0], 403)
        rec = self.new_record(sam, "project", "Valid")
        self.assertEqual(sam.put("/api/records/%d" % rec["id"], {"title": "No version"})[0], 400)
        self.assertEqual(sam.post("/api/records/%d/actions" % rec["id"],
                                  {"version": 1, "text": "", "date": "2026-11-01"})[0], 400)
        self.assertEqual(sam.post("/api/records/%d/actions" % rec["id"],
                                  {"version": 1, "text": "x"})[0], 400)
        self.assertEqual(sam.get("/api/records/99999999/history")[0], 404)

    def test_extra_or_protected_fields_in_a_request_are_ignored(self):
        """Only the fields the program knows are ever written; a request cannot
        name its own columns, forge a reference, or reach other tables."""
        sam = self.people["sam"]
        hostile = {"module": "project", "title": "Plain item", "ref": "PRJ-9999", "id": 999999, "version": 50,
                   "deleted_at": "2020-01-01", "created_by": 1, "module ": "finance",
                   "title = 'x', status": "boo", "x); DROP TABLE users; --": 1, "pw_hash": "x", "role": "admin"}
        status, data = sam.post("/api/records", hostile)
        self.assertEqual(status, 200, data)
        rec = data["record"]
        self.assertRegex(rec["ref"], r"^PRJ-\d{4}$")
        self.assertNotEqual(rec["ref"], "PRJ-9999")
        self.assertEqual((rec["version"], rec["deleted_at"], rec["created_by"], rec["module"]), (1, None, sam.user_id, "project"))
        status, data = sam.put("/api/records/%d" % rec["id"], {"version": 1, "title": "Still plain", "ref": "HACK-1",
                                                               "deleted_at": "x", "owner_id = 1, title": "y"})
        self.assertEqual((status, data["record"]["ref"], data["record"]["deleted_at"], data["record"]["title"]),
                         (200, rec["ref"], None, "Still plain"))
        task = sam.post("/api/tasks", {"title": "T", "assignee_id": sam.user_id, "deleted_at": "x", "created_by": 1,
                                       "version": 9, "id": 5, "title, status": "z"})[1]["task"]
        self.assertEqual((task["deleted_at"], task["created_by"], task["version"]), (None, sam.user_id, 1))
        sub = sam.post("/api/subcons", {"name": "Plain Subcon Co", "ref": "SUB-9999", "version": 9, "created_by": 1,
                                        "name = 'x', notes": "y"})[1]["subcon"]
        self.assertRegex(sub["ref"], r"^SUB-\d{4}$")
        self.assertNotEqual(sub["ref"], "SUB-9999")
        self.assertEqual(sam.get("/api/me")[1]["user"]["role"], "staff")
        self.assertEqual(self.state(self.admin)["me"]["role"], "admin")   # the users table is intact

    def test_text_is_stored_exactly_not_interpreted(self):
        sam = self.people["sam"]
        title = '<script>alert(1)</script> & "quotes" O\'Brien é中'
        rec = self.new_record(sam, "enquiry", title)
        self.assertEqual(self.find(self.state(sam), rec["id"])["title"], title)

    # -- team sections ----------------------------------------------------------

    def test_finance_and_office_sections_are_private_to_their_teams(self):
        fiona, oscar, sam = self.people["fiona"], self.people["oscar"], self.people["sam"]
        fin = self.new_record(fiona, "finance", "Invoice 1001", category="Invoice (receivable)", amount=900)
        off = self.new_record(oscar, "office", "Order printer paper")

        self.assertEqual(self.state(sam)["meta"]["visible_modules"], ["project", "enquiry", "eoi"])
        self.assertIn("finance", self.state(fiona)["meta"]["visible_modules"])
        self.assertNotIn("office", self.state(fiona)["meta"]["visible_modules"])
        self.assertEqual(len(self.state(self.admin)["meta"]["visible_modules"]), 5)

        for outsider, rec in [(sam, fin), (sam, off), (oscar, fin), (fiona, off)]:
            self.assertIsNone(self.find(self.state(outsider), rec["id"]))
            self.assertEqual(outsider.get("/api/records/%d/history" % rec["id"])[0], 404)
            self.assertEqual(outsider.put("/api/records/%d" % rec["id"], {"version": 1, "title": "x"})[0], 404)
            self.assertEqual(outsider.post("/api/records/%d/actions" % rec["id"],
                                           {"version": 1, "text": "x", "date": "2026-11-01"})[0], 404)
            self.assertEqual(outsider.post("/api/records/%d/notes" % rec["id"], {"text": "x"})[0], 404)
            self.assertEqual(outsider.post("/api/records/%d/xrefs" % rec["id"],
                                           {"system": "x", "ref": "y"})[0], 404)
        self.assertEqual(sam.post("/api/records", {"module": "finance", "title": "x"})[0], 403)
        self.assertEqual(sam.post("/api/records", {"module": "office", "title": "x"})[0], 403)

        self.assertIsNotNone(self.find(self.state(self.admin), fin["id"]))
        self.assertIsNotNone(self.find(self.state(self.admin), off["id"]))
        activity = sam.get("/api/activity")[1]["activity"]
        self.assertFalse([a for a in activity if a["module"] in ("finance", "office")])

        # Staff cannot be made owner of an item in a section they cannot open.
        status, data = fiona.put("/api/records/%d" % fin["id"], {"version": 1, "owner_id": sam.user_id})
        self.assertEqual(status, 400)
        self.assertIn("does not have access", data["error"])

    def test_cross_references_between_sections(self):
        fiona, sam = self.people["fiona"], self.people["sam"]
        enquiry = self.new_record(sam, "enquiry", "Enquiry about fit-out")
        project = self.new_record(sam, "project", "Fit-out project")
        invoice = self.new_record(fiona, "finance", "Deposit invoice")

        self.assertEqual(sam.post("/api/records/%d/links" % enquiry["id"], {"target_id": project["id"]})[0], 200)
        status, data = sam.post("/api/records/%d/links" % project["id"], {"target_id": enquiry["id"]})
        self.assertEqual(status, 400)  # already linked, either way round
        self.assertEqual(sam.post("/api/records/%d/links" % project["id"], {"target_id": project["id"]})[0], 400)
        # Staff cannot link to (or discover) a finance record...
        self.assertEqual(sam.post("/api/records/%d/links" % project["id"], {"target_id": invoice["id"]})[0], 404)
        # ...but finance can link their invoice to the project.
        self.assertEqual(fiona.post("/api/records/%d/links" % invoice["id"], {"target_id": project["id"]})[0], 200)

        state = self.state(sam)
        pairs = [sorted(p) for p in state["links"]]
        self.assertIn(sorted([enquiry["id"], project["id"]]), pairs)
        self.assertIn(sorted([invoice["id"], project["id"]]), pairs)
        stub = state["restricted"][str(invoice["id"])]
        self.assertEqual(stub, {"id": invoice["id"], "ref": invoice["ref"], "module": "finance"})
        self.assertNotIn("Deposit invoice", json.dumps(state))  # no restricted detail leaks

        fstate = self.state(fiona)
        self.assertEqual(fstate["restricted"], {})
        # Links between two records the viewer cannot see are not sent at all.
        office_item = self.new_record(self.people["oscar"], "office", "Parking permit")
        self.assertEqual(self.admin.post("/api/records/%d/links" % office_item["id"],
                                         {"target_id": invoice["id"]})[0], 200)
        self.assertNotIn(sorted([office_item["id"], invoice["id"]]),
                         [sorted(p) for p in self.state(sam)["links"]])

        # Staff cannot remove a link that involves a record they cannot see.
        self.assertEqual(sam.delete("/api/records/%d/links/%d" % (project["id"], invoice["id"]))[0], 404)
        self.assertEqual(sam.delete("/api/records/%d/links/%d" % (enquiry["id"], project["id"]))[0], 200)
        self.assertNotIn(sorted([enquiry["id"], project["id"]]),
                         [sorted(p) for p in self.state(sam)["links"]])

        # Deleting a record removes its links.
        self.admin.delete("/api/records/%d" % invoice["id"])
        self.assertEqual([p for p in self.state(sam)["links"] if invoice["id"] in p], [])

    def test_external_references(self):
        sam = self.people["sam"]
        rec = self.new_record(sam, "project", "Linked to other systems")
        base = "/api/records/%d/xrefs" % rec["id"]
        self.assertEqual(sam.post(base, {"system": "CRM", "ref": "OPP-77",
                                         "url": "https://crm.example.com/opp/77"})[0], 200)
        self.assertEqual(sam.post(base, {"system": "Xero", "ref": "INV-2041"})[0], 200)
        for bad in [{"system": "", "ref": "x"}, {"system": "x", "ref": ""},
                    {"system": "x", "ref": "y", "url": "javascript:alert(1)"},
                    {"system": "x", "ref": "y", "url": "ftp://example.com/file"},
                    {"system": "x", "ref": "y", "url": "https://exa mple.com"}]:
            self.assertEqual(sam.post(base, bad)[0], 400, bad)
        xrefs = self.find(self.state(sam), rec["id"])["xrefs"]
        self.assertEqual([(x["system"], x["ref"]) for x in xrefs], [("CRM", "OPP-77"), ("Xero", "INV-2041")])
        self.assertEqual(sam.delete("%s/%d" % (base, xrefs[0]["id"]))[0], 200)
        self.assertEqual(len(self.find(self.state(sam), rec["id"])["xrefs"]), 1)

    # -- subcontractors ---------------------------------------------------------

    def new_subcon(self, client, name, **extra):
        body = {"name": name}
        body.update(extra)
        status, data = client.post("/api/subcons", body)
        self.assertEqual(status, 200, data)
        return data["subcon"]

    def test_subcontractor_directory(self):
        sam, tina = self.people["sam"], self.people["tina"]
        sub = self.new_subcon(sam, "Apex Structural Engineers", discipline="Structural",
                              contact_name="Ravi Menon", email="ravi@apex.example", phone="+61 400 000 111",
                              website="apex.example/engineering", registration="RPEQ 12345",
                              address="1 Bridge St\nBrisbane", services="Design\nCertification", notes="Preferred")
        self.assertRegex(sub["ref"], r"^SUB-\d{4}$")
        self.assertTrue(sub["active"])
        self.assertEqual(sub["website"], "https://apex.example/engineering")
        self.assertEqual(sub["address"], "1 Bridge St\nBrisbane")
        # Everyone sees the directory.
        listed = [x for x in self.state(tina)["subcons"] if x["id"] == sub["id"]]
        self.assertEqual(listed[0]["contact_name"], "Ravi Menon")

        # The same company cannot be entered twice, whatever the capitals.
        status, data = tina.post("/api/subcons", {"name": "APEX structural engineers"})
        self.assertEqual(status, 400)
        self.assertIn(sub["ref"], data["error"])
        for bad in [{"name": ""}, {"name": "x" * 151}, {"name": "A", "email": "not-an-email"},
                    {"name": "B", "website": "nonsense"}, {"name": "C", "active": "yes"}]:
            self.assertEqual(sam.post("/api/subcons", bad)[0], 400, bad)

        # Anyone can correct the details; stale edits are refused.
        status, data = tina.put("/api/subcons/%d" % sub["id"], {"version": 1, "phone": "+61 400 999 000"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["subcon"]["phone"], "+61 400 999 000")
        self.assertEqual(data["subcon"]["contact_name"], "Ravi Menon")
        self.assertEqual(sam.put("/api/subcons/%d" % sub["id"], {"version": 1, "phone": "1"})[0], 409)
        other = self.new_subcon(sam, "Delta Surveying")
        self.assertEqual(sam.put("/api/subcons/%d" % other["id"],
                                 {"version": 1, "name": "apex structural engineers"})[0], 400)
        self.assertEqual(sam.put("/api/subcons/99999999", {"version": 1, "name": "x"})[0], 404)

        # Only an administrator deletes from the directory.
        self.assertEqual(sam.delete("/api/subcons/%d" % other["id"])[0], 403)
        self.assertEqual(self.admin.delete("/api/subcons/%d" % other["id"])[0], 200)
        self.assertFalse([x for x in self.state(sam)["subcons"] if x["id"] == other["id"]])
        again = self.new_subcon(sam, "Delta Surveying")
        self.assertNotEqual(again["ref"], other["ref"])  # references are never reused

    def test_subcontractors_on_projects_enquiries_and_eois(self):
        sam, tina, fiona = self.people["sam"], self.people["tina"], self.people["fiona"]
        struct = self.new_subcon(sam, "Northbank Structures", discipline="Structural")
        mech = self.new_subcon(sam, "Coolflow Mechanical", discipline="HVAC")
        fire = self.new_subcon(sam, "Ember Fire Engineering", discipline="Fire protection")
        project = self.new_record(sam, "project", "Depot upgrade")
        enquiry = self.new_record(sam, "enquiry", "Depot enquiry")
        eoi = self.new_record(sam, "eoi", "Depot EOI")

        def on(client, record):
            return sorted((x["subcon_id"], x["scope"]) for x in self.state(client)["record_subcons"]
                          if x["record_id"] == record["id"])

        # Several subcontractors in parallel on one project.
        base = "/api/records/%d/subcons" % project["id"]
        self.assertEqual(sam.post(base, {"subcon_id": struct["id"], "scope": "Structural design"})[0], 200)
        self.assertEqual(tina.post(base, {"subcon_id": mech["id"]})[0], 200)
        self.assertEqual(sam.post(base, {"subcon_id": fire["id"]})[0], 200)
        self.assertEqual(on(tina, project), sorted([(struct["id"], "Structural design"), (mech["id"], ""), (fire["id"], "")]))
        status, data = sam.post(base, {"subcon_id": struct["id"]})
        self.assertEqual(status, 400)
        self.assertIn("already on", data["error"])
        # The same subcontractor on an enquiry and an EOI as well.
        for record in (enquiry, eoi):
            self.assertEqual(sam.post("/api/records/%d/subcons" % record["id"], {"subcon_id": struct["id"]})[0], 200)
        mine = [x["record_id"] for x in self.state(sam)["record_subcons"] if x["subcon_id"] == struct["id"]]
        self.assertEqual(sorted(mine), sorted([project["id"], enquiry["id"], eoi["id"]]))

        # Scope can be changed; removal takes one subcontractor off and leaves the rest.
        self.assertEqual(sam.put("%s/%d" % (base, mech["id"]), {"scope": "Ventilation"})[0], 200)
        self.assertEqual(sam.delete("%s/%d" % (base, fire["id"]))[0], 200)
        self.assertEqual(on(sam, project), sorted([(struct["id"], "Structural design"), (mech["id"], "Ventilation")]))
        self.assertEqual(sam.put("%s/%d" % (base, fire["id"]), {"scope": "x"})[0], 404)

        # It is all in the record's history, with who did it.
        history = sam.get("/api/records/%d/history" % project["id"])[1]["history"]
        texts = [x["text"] for x in history if x["kind"] == "subcon"]
        self.assertIn("Subcontractor added: Northbank Structures (Structural design)", texts)
        self.assertIn("Subcontractor added: Coolflow Mechanical", texts)
        self.assertIn("Subcontractor Coolflow Mechanical - Scope: Ventilation", texts)
        self.assertIn("Subcontractor removed: Ember Fire Engineering", texts)
        added_by_tina = [x for x in history if x["text"] == "Subcontractor added: Coolflow Mechanical"][0]
        self.assertEqual(added_by_tina["user_id"], tina.user_id)

        # Rules: real subcontractor, real record, the three work sections only.
        self.assertEqual(sam.post(base, {"subcon_id": 99999999})[0], 404)
        self.assertEqual(sam.post(base, {})[0], 400)
        self.assertEqual(sam.post("/api/records/99999999/subcons", {"subcon_id": struct["id"]})[0], 404)
        invoice = self.new_record(fiona, "finance", "Subcontractor invoice")
        status, data = fiona.post("/api/records/%d/subcons" % invoice["id"], {"subcon_id": struct["id"]})
        self.assertEqual(status, 400)
        self.assertEqual(sam.post("/api/records/%d/subcons" % invoice["id"], {"subcon_id": struct["id"]})[0], 404)

        # An inactive subcontractor stays on existing work but cannot be put on new work.
        current = [x for x in self.state(sam)["subcons"] if x["id"] == mech["id"]][0]
        self.assertEqual(sam.put("/api/subcons/%d" % mech["id"], {"version": current["version"], "active": False})[0], 200)
        self.assertIn((mech["id"], "Ventilation"), on(sam, project))
        status, data = sam.post("/api/records/%d/subcons" % enquiry["id"], {"subcon_id": mech["id"]})
        self.assertEqual(status, 400)
        self.assertIn("inactive", data["error"])

        # Deleting a record removes its assignments; deleting a subcontractor removes theirs everywhere.
        self.admin.delete("/api/records/%d" % eoi["id"])
        self.assertFalse([x for x in self.state(sam)["record_subcons"] if x["record_id"] == eoi["id"]])
        self.assertEqual(self.admin.delete("/api/subcons/%d" % struct["id"])[0], 200)
        self.assertFalse([x for x in self.state(sam)["record_subcons"] if x["subcon_id"] == struct["id"]])
        self.assertEqual(on(sam, project), [(mech["id"], "Ventilation")])
        history = sam.get("/api/records/%d/history" % project["id"])[1]["history"]
        self.assertTrue(any("deleted from the directory" in x["text"] for x in history))
        events = [a["event"] for a in self.admin.get("/api/admin/audit")[1]["audit"]]
        self.assertIn("subcon_deleted", events)

    # -- 1.2.0: roles ------------------------------------------------------------

    def test_roles_separate_financial_information_from_technical_teams(self):
        roles = self.state(self.admin)["meta"]["roles"]
        self.assertEqual(roles, {"admin": "Administrator", "administration": "Administration",
                                 "staff": "Engineering", "finance": "Finance", "office": "Office Administrator"})
        everything = ["project", "enquiry", "eoi", "finance", "office"]
        technical = ["project", "enquiry", "eoi"]
        engineer = self.make_user("erin", "Erin Engineer", "staff")
        manager = self.make_user("mona", "Mona Manager", "administration")
        self.assertEqual(self.state(engineer)["meta"]["visible_modules"], technical)
        self.assertEqual(self.state(manager)["meta"]["visible_modules"], everything)
        self.assertEqual(self.state(self.admin)["meta"]["visible_modules"], everything)

        invoice = self.new_record(self.people["fiona"], "finance", "Fee invoice 77", amount=5000)
        office = self.new_record(self.people["oscar"], "office", "Lease renewal")
        # Engineering: no trace of finance or office content, by any route.
        state = json.dumps(self.state(engineer))
        self.assertNotIn("Fee invoice 77", state)
        self.assertNotIn("Lease renewal", state)
        self.assertEqual(engineer.get("/api/records/%d/history" % invoice["id"])[0], 404)
        self.assertEqual(engineer.post("/api/records", {"module": "finance", "title": "x"})[0], 403)
        self.assertNotIn("Fee invoice 77", json.dumps(engineer.get("/api/log?kind=all&month=all")[1]))
        # Administration: sees and works on both, but has no Admin area.
        state = json.dumps(self.state(manager))
        self.assertIn("Fee invoice 77", state)
        self.assertIn("Lease renewal", state)
        self.assertEqual(manager.post("/api/records/%d/notes" % invoice["id"], {"text": "Checked"})[0], 200)
        self.assertEqual(manager.put("/api/records/%d" % invoice["id"], {"version": 1, "owner_id": manager.user_id})[0], 200)
        for path in ["/api/admin/users", "/api/admin/audit", "/api/admin/system"]:
            self.assertEqual(manager.get(path)[0], 403, path)
        self.assertEqual(manager.request("GET", "/api/admin/backup", raw=True)[0], 403)
        self.assertEqual(manager.delete("/api/records/%d" % office["id"])[0], 403)

    # -- 1.2.0: deleted items are kept, and the activity log ----------------------

    def test_deleted_records_leave_the_lists_but_keep_their_history(self):
        sam = self.people["sam"]
        rec = self.new_record(sam, "project", "Bridge inspection", last_action="Site visit", last_action_date="2026-09-14")
        other = self.new_record(sam, "enquiry", "Linked enquiry")
        sam.post("/api/records/%d/links" % rec["id"], {"target_id": other["id"]})
        sam.post("/api/records/%d/actions" % rec["id"], {"version": 1, "text": "Report issued", "date": "2026-10-02"})
        task = sam.post("/api/tasks", {"title": "File the report", "assignee_id": sam.user_id, "record_id": rec["id"]})[1]["task"]
        self.assertEqual(self.admin.delete("/api/records/%d" % rec["id"])[0], 200)

        state = self.state(sam)
        self.assertIsNone(self.find(state, rec["id"]))
        self.assertFalse([p for p in state["links"] if rec["id"] in p])
        self.assertNotIn(str(rec["id"]), state["restricted"])
        kept = [t for t in state["tasks"] if t["id"] == task["id"]][0]
        self.assertIsNone(kept["record_id"])
        for call in [lambda: sam.get("/api/records/%d/history" % rec["id"]),
                     lambda: sam.put("/api/records/%d" % rec["id"], {"version": 2, "title": "x"}),
                     lambda: sam.post("/api/records/%d/notes" % rec["id"], {"text": "x"}),
                     lambda: sam.post("/api/records/%d/links" % other["id"], {"target_id": rec["id"]})]:
            self.assertEqual(call()[0], 404)
        self.assertEqual(self.admin.delete("/api/records/%d" % rec["id"])[0], 404)  # already deleted
        self.assertNotIn("Bridge inspection", json.dumps(sam.get("/api/activity")[1]))

        # ...but everything done on it can still be found, under "deleted".
        log = sam.get("/api/log?scope=deleted&kind=all&q=bridge")[1]
        texts = [e["text"] for e in log["entries"]]
        self.assertIn("Report issued", texts)
        self.assertIn("Site visit", texts)
        self.assertTrue(any(t.startswith("Project deleted") for t in texts))
        self.assertTrue(all(e["state"] == "deleted" and e["record"]["ref"] == rec["ref"] for e in log["entries"]))
        self.assertEqual(sam.get("/api/log?scope=open&kind=all&q=bridge")[1]["entries"], [])

        # Only an administrator restores; the record comes back whole.
        self.assertEqual(sam.post("/api/records/%d/restore" % rec["id"])[0], 403)
        self.assertEqual(self.admin.post("/api/records/%d/restore" % other["id"])[0], 404)  # not deleted
        self.assertEqual(self.admin.post("/api/records/%d/restore" % rec["id"])[0], 200)
        state = self.state(sam)
        back = self.find(state, rec["id"])
        self.assertEqual((back["title"], back["last_action"], back["ref"]), ("Bridge inspection", "Report issued", rec["ref"]))
        self.assertIn(sorted([rec["id"], other["id"]]), [sorted(p) for p in state["links"]])
        self.assertEqual([t for t in state["tasks"] if t["id"] == task["id"]][0]["record_id"], rec["id"])
        kinds = [h["kind"] for h in sam.get("/api/records/%d/history" % rec["id"])[1]["history"]]
        self.assertEqual(kinds[:2], ["restored", "deleted"])
        events = [a["event"] for a in self.admin.get("/api/admin/audit")[1]["audit"]]
        self.assertIn("record_restored", events)

    def test_activity_log_is_catalogued_by_month_and_searchable(self):
        sam, tina = self.people["sam"], self.people["tina"]
        rec = self.new_record(sam, "eoi", "Harbour tender zq", status="Preparing")
        version = 1
        for text, day in [("Zq drawings requested", "2026-07-03"), ("Zq drawings received", "2026-07-21"),
                          ("Zq pricing complete", "2026-08-09"), ("Zq submission lodged", "2026-09-30")]:
            version = sam.post("/api/records/%d/actions" % rec["id"], {"version": version, "text": text, "date": day})[1]["record"]["version"]
        sam.post("/api/records/%d/notes" % rec["id"], {"text": "Zq note for the file"})

        log = sam.get("/api/log?q=zq")[1]                      # actions only, all months when searching
        self.assertEqual(log["month"], "all")
        self.assertEqual([(m["month"], m["count"]) for m in log["months"]], [("2026-09", 1), ("2026-08", 1), ("2026-07", 2)])
        self.assertEqual([e["text"] for e in log["entries"]],
                         ["Zq submission lodged", "Zq pricing complete", "Zq drawings received", "Zq drawings requested"])
        self.assertTrue(all(e["kind"] == "action" for e in log["entries"]))
        july = sam.get("/api/log?q=zq&month=2026-07")[1]
        self.assertEqual([e["day"] for e in july["entries"]], ["2026-07-21", "2026-07-03"])
        self.assertEqual(len(july["months"]), 3)               # the catalogue still lists every month
        self.assertEqual(sam.get("/api/log?q=zq&month=2026-01")[1]["entries"], [])
        everything = sam.get("/api/log?q=zq&kind=all")[1]
        self.assertIn("Zq note for the file", [e["text"] for e in everything["entries"]])
        self.assertEqual(len(everything["entries"]), 6)        # 4 actions + note + created
        # With no search the newest month is shown.
        latest = sam.get("/api/log")[1]
        self.assertEqual(latest["month"], latest["months"][0]["month"])
        self.assertTrue(all(e["day"].startswith(latest["month"]) for e in latest["entries"]))
        # Search covers who did it, the reference and the title; anyone with access can look.
        self.assertEqual(len(tina.get("/api/log?q=" + rec["ref"].lower())[1]["entries"]), 4)
        self.assertEqual(len(tina.get("/api/log?q=harbour+tender+zq")[1]["entries"]), 4)
        self.assertEqual(len(tina.get("/api/log?q=sam+staff&month=2026-08")[1]["entries"]) >= 1, True)
        # Completed (closed) items are found under "closed", no longer under "open".
        self.assertEqual(len(sam.get("/api/log?q=zq&scope=open")[1]["entries"]), 4)
        sam.post("/api/records/%d/actions" % rec["id"], {"version": version, "text": "Zq award notice", "date": "2026-10-15", "status": "Successful"})
        self.assertEqual(sam.get("/api/log?q=zq&scope=open")[1]["entries"], [])
        self.assertEqual(len(sam.get("/api/log?q=zq&scope=closed")[1]["entries"]), 5)
        for bad in ["kind=nonsense", "scope=nonsense", "month=2026", "month=2026-1"]:
            self.assertEqual(sam.get("/api/log?" + bad)[0], 400, bad)
        self.assertEqual(Client(self.base).get("/api/log")[0], 401)

    def test_completed_and_deleted_tasks_stay_on_record(self):
        sam, tina = self.people["sam"], self.people["tina"]
        done = sam.post("/api/tasks", {"title": "Qx renew licence", "assignee_id": sam.user_id})[1]["task"]
        gone = sam.post("/api/tasks", {"title": "Qx order samples", "assignee_id": sam.user_id})[1]["task"]
        sam.put("/api/tasks/%d" % done["id"], {"version": 1, "status": "Done"})
        self.assertEqual(sam.delete("/api/tasks/%d" % gone["id"])[0], 200)
        ids = [t["id"] for t in self.state(sam)["tasks"]]
        self.assertIn(done["id"], ids)
        self.assertNotIn(gone["id"], ids)
        self.assertEqual(sam.put("/api/tasks/%d" % gone["id"], {"version": 1, "status": "Done"})[0], 404)
        self.assertEqual(sam.delete("/api/tasks/%d" % gone["id"])[0], 200)  # harmless to repeat
        log = sam.get("/api/log?kind=tasks&q=qx")[1]
        self.assertEqual(sorted(e["text"] for e in log["entries"]), ["Task completed: Qx renew licence", "Task deleted: Qx order samples"])
        self.assertEqual(len(sam.get("/api/log?kind=tasks&q=qx&scope=deleted")[1]["entries"]), 1)
        self.assertEqual(sam.get("/api/log?kind=actions&q=qx")[1]["entries"], [])
        # Private tasks stay private in the log too.
        self.assertEqual(tina.get("/api/log?kind=tasks&q=qx")[1]["entries"], [])
        self.assertEqual(len(self.admin.get("/api/log?kind=tasks&q=qx")[1]["entries"]), 2)

    # -- 1.2.0: subcontractor capabilities and follow-ups -------------------------

    def test_subcontractor_capabilities_are_kept_as_a_tidy_list(self):
        sam = self.people["sam"]
        sub = self.new_subcon(sam, "Quake Risk Partners", discipline="Structural, Geotechnical",
                              capabilities=" Seismic assessment ;  HAZOP\nwind  tunnel study, seismic ASSESSMENT,, ")
        self.assertEqual(sub["capabilities"], "Seismic assessment, HAZOP, wind tunnel study")
        status, data = sam.put("/api/subcons/%d" % sub["id"], {"version": 1, "capabilities": "Blast analysis"})
        self.assertEqual(data["subcon"]["capabilities"], "Blast analysis")
        self.assertEqual(data["subcon"]["discipline"], "Structural, Geotechnical")
        self.assertEqual(self.new_subcon(sam, "Plain Co")["capabilities"], "")

    def test_each_subcontractor_on_a_record_has_its_own_update_and_follow_up(self):
        sam, tina = self.people["sam"], self.people["tina"]
        a = self.new_subcon(sam, "Follow Up Alpha")
        b = self.new_subcon(sam, "Follow Up Beta")
        rec = self.new_record(sam, "enquiry", "Enquiry with two subcons", next_action="Reply to client", next_action_date="2026-12-20")
        base = "/api/records/%d/subcons" % rec["id"]
        sam.post(base, {"subcon_id": a["id"]})
        sam.post(base, {"subcon_id": b["id"], "scope": "Survey"})

        def row(client, sub):
            return [x for x in self.state(client)["record_subcons"]
                    if x["record_id"] == rec["id"] and x["subcon_id"] == sub["id"]][0]

        fresh = row(sam, a)
        self.assertEqual((fresh["last_update"], fresh["last_update_date"], fresh["next_action"], fresh["next_action_date"]), ("", None, "", None))
        status, data = sam.put("%s/%d" % (base, a["id"]), {
            "last_update": "Sent drawings for pricing", "last_update_date": "2026-11-20",
            "next_action": "Chase the quote", "next_action_date": "2026-11-27"})
        self.assertEqual(status, 200, data)
        status, data = tina.put("%s/%d" % (base, b["id"]), {
            "last_update": "Quote received", "last_update_date": "2026-11-22",
            "next_action": "Clarify exclusions", "next_action_date": "2026-12-01"})
        self.assertEqual(status, 200, data)
        ra, rb = row(tina, a), row(tina, b)
        self.assertEqual((ra["last_update"], ra["last_update_date"], ra["next_action"], ra["next_action_date"]),
                         ("Sent drawings for pricing", "2026-11-20", "Chase the quote", "2026-11-27"))
        self.assertEqual((rb["last_update"], rb["next_action_date"], rb["scope"]), ("Quote received", "2026-12-01", "Survey"))
        # The record's own next action is separate and untouched.
        current = self.find(self.state(sam), rec["id"])
        self.assertEqual((current["next_action"], current["next_action_date"], current["version"]), ("Reply to client", "2026-12-20", 1))
        # Updating one field leaves the others; clearing works.
        sam.put("%s/%d" % (base, a["id"]), {"next_action": "", "next_action_date": None})
        ra = row(sam, a)
        self.assertEqual((ra["last_update"], ra["next_action"], ra["next_action_date"]), ("Sent drawings for pricing", "", None))
        for bad in [{"last_update": "No date given"}, {"last_update": "x", "last_update_date": "soon"},
                    {"next_action_date": "2026-02-31"}]:
            self.assertEqual(sam.put("%s/%d" % (base, a["id"]), bad)[0], 400, bad)
        history = [x["text"] for x in sam.get("/api/records/%d/history" % rec["id"])[1]["history"] if x["kind"] == "subcon"]
        self.assertIn("Subcontractor Follow Up Alpha - Last update (2026-11-20): Sent drawings for pricing; "
                      "Next follow-up: Chase the quote; Follow-up expected: 2026-11-27", history)
        self.assertTrue(any(x.startswith("Subcontractor Follow Up Beta - Last update (2026-11-22): Quote received") for x in history))

    # -- 1.2.1: updates from other people (banners and the bell) -------------------

    def test_updates_reach_other_people_who_may_see_them(self):
        sam, tina, fiona, oscar = (self.people[n] for n in ("sam", "tina", "fiona", "oscar"))
        manager = self.make_user("adele", "Adele Office-Manager", "administration")
        boss = self.make_user("boss2", "Second Administrator", "admin")
        everyone = [sam, tina, fiona, oscar, manager, boss, self.admin]

        def feed(client):
            status, data = client.get("/api/events")
            self.assertEqual(status, 200, data)
            return data

        def texts(client):
            return [e["text"] for e in feed(client)["events"]]

        for client in everyone:   # first look: whatever happened earlier is not "new"
            first = feed(client)
            self.assertEqual(first["unread"], 0)
            self.assertFalse([e for e in first["events"] if e["unread"]])

        # A project change: everyone else is told, the person who did it is not.
        project = self.new_record(sam, "project", "Notify project zz")
        created = "Project created with status Planning"
        for client in (tina, fiona, oscar, manager, boss, self.admin):
            data = feed(client)
            newest = data["events"][0]
            self.assertEqual((newest["text"], newest["actor_id"], newest["unread"]), (created, sam.user_id, True))
            self.assertEqual((newest["record"]["ref"], newest["record"]["title"], newest["record"]["module"]),
                             (project["ref"], "Notify project zz", "project"))
            self.assertEqual(data["unread"], 1)
        self.assertNotIn(sam.user_id, [e["actor_id"] for e in feed(sam)["events"]])
        self.assertEqual(feed(sam)["unread"], 0)

        # A finance change: only Finance, Administration and Administrators are told.
        invoice = self.new_record(fiona, "finance", "Notify invoice zz", amount=100)
        fiona.post("/api/records/%d/actions" % invoice["id"], {"version": 1, "text": "Invoice zz sent", "date": "2026-11-25"})
        for client in (manager, boss, self.admin):
            self.assertEqual(texts(client)[0], "Invoice zz sent")
        for client in (sam, tina, oscar):
            dump = json.dumps(feed(client))
            self.assertNotIn("Invoice zz sent", dump)
            self.assertNotIn("Notify invoice zz", dump)
        self.assertEqual(feed(tina)["unread"], 1)   # still just the project

        # An office change: Office Administrators, Administration and Administrators.
        self.new_record(oscar, "office", "Notify office zz")
        self.assertIn("Office item created with status Open", texts(manager)[:1])
        self.assertNotIn("Notify office zz", json.dumps(feed(fiona)))
        self.assertNotIn("Notify office zz", json.dumps(feed(sam)))

        # Administration (logins, settings): Administrators only.
        self.admin.post("/api/admin/users", {"username": "newbie", "full_name": "New Starter", "role": "staff"})
        self.assertEqual(texts(boss)[0], "Login created: New Starter (Engineering)")
        self.assertEqual(feed(boss)["events"][0]["scope"], "admin")
        for client in (sam, fiona, manager):
            self.assertNotIn("Login created", json.dumps(feed(client)))

        # The subcontractor directory belongs to everyone.
        sub = self.new_subcon(sam, "Notify Subcon zz")
        newest = feed(oscar)["events"][0]
        self.assertEqual((newest["text"], newest["subcon"]["ref"]), ("Subcontractor added to the directory: Notify Subcon zz", sub["ref"]))
        sam.post("/api/records/%d/subcons" % project["id"], {"subcon_id": sub["id"]})
        self.assertEqual(texts(tina)[0], "Subcontractor added: Notify Subcon zz")

        # A personal task: the person it is given to (and administrators), nobody else.
        task = sam.post("/api/tasks", {"title": "Notify task zz", "assignee_id": tina.user_id})[1]["task"]
        self.assertEqual(texts(tina)[0], "Task added: Notify task zz (assigned to Tina Staff)")
        self.assertEqual(texts(boss)[0], "Task added: Notify task zz (assigned to Tina Staff)")
        for client in (fiona, oscar, manager):
            self.assertNotIn("Notify task zz", json.dumps(feed(client)))
        tina.put("/api/tasks/%d" % task["id"], {"version": 1, "status": "Done"})
        self.assertEqual(texts(sam)[0], "Task completed: Notify task zz")
        sam.put("/api/tasks/%d" % task["id"], {"version": 2, "due_date": "2026-12-24"})
        self.assertEqual(texts(tina)[0], "Task updated: Notify task zz")

        # A task on a finance item given to an engineer: they hear about the task,
        # and nothing about the finance item it sits on.
        fiona.post("/api/tasks", {"title": "Notify PO check zz", "assignee_id": sam.user_id, "record_id": invoice["id"]})
        mine = feed(sam)["events"][0]
        self.assertEqual((mine["text"], mine["record"], mine["task"]),
                         ("Task added: Notify PO check zz (assigned to Sam Staff)", None, True))
        self.assertNotIn("Notify PO check zz", json.dumps(feed(tina)))
        self.assertEqual(feed(manager)["events"][0]["record"]["ref"], invoice["ref"])

        # Opening the bell marks them seen, for that person only; it never goes backwards.
        data = feed(tina)
        self.assertGreaterEqual(data["unread"], 4)
        self.assertEqual(tina.post("/api/events/seen", {"last_id": data["last_id"]})[0], 200)
        after = feed(tina)
        self.assertEqual(after["unread"], 0)
        self.assertFalse([e for e in after["events"] if e["unread"]])
        self.assertGreaterEqual(feed(oscar)["unread"], 2)
        tina.post("/api/events/seen", {"last_id": 1})
        self.assertEqual(feed(tina)["unread"], 0)
        tina.post("/api/events/seen", {"last_id": 10 ** 9})   # cannot mark the future as seen
        sam.post("/api/records/%d/notes" % project["id"], {"text": "One more zz"})
        again = feed(tina)
        self.assertEqual((again["unread"], again["events"][0]["text"], again["events"][0]["unread"]), (1, "One more zz", True))
        # Deleting is announced too, to the same audience.
        self.admin.delete("/api/records/%d" % project["id"])
        newest = feed(tina)["events"][0]
        self.assertEqual((newest["text"], newest["record"]["deleted"]), ("Project deleted (status was Planning)", True))
        for bad in [{}, {"last_id": "x"}, {"last_id": -1}]:
            self.assertEqual(tina.post("/api/events/seen", bad)[0], 400, bad)
        self.assertEqual(Client(self.base).get("/api/events")[0], 401)

    # -- 1.2.4: the user's own project / enquiry / EOI numbers ----------------------

    def test_users_give_projects_enquiries_and_eois_their_own_numbers(self):
        sam, tina, fiona = self.people["sam"], self.people["tina"], self.people["fiona"]
        meta = self.state(sam)["meta"]["modules"]
        self.assertEqual([(k, meta[k]["numbered"], meta[k]["number_label"]) for k in ("project", "enquiry", "eoi")],
                         [("project", True, "Project number"), ("enquiry", True, "Enquiry number"), ("eoi", True, "EOI number")])
        self.assertFalse(meta["finance"]["numbered"] or meta["office"]["numbered"])

        # Stated when the item is created; the system reference is still issued behind it.
        project = self.new_record(sam, "project", "Numbered project", number="  24-118 / Rev B ")
        self.assertEqual(project["number"], "24-118 / Rev B")
        self.assertRegex(project["ref"], r"^PRJ-\d{4}$")
        self.assertEqual(self.find(self.state(tina), project["id"])["number"], "24-118 / Rev B")
        # Optional: without one, the item simply has its system reference.
        plain = self.new_record(sam, "project", "Unnumbered project")
        other = self.new_record(sam, "project", "Another unnumbered project")
        self.assertEqual((plain["number"], other["number"]), ("", ""))

        # A number identifies one item in its section, whatever the capitals...
        for clash in ["24-118 / Rev B", "24-118 / rev b"]:
            status, data = tina.post("/api/records", {"module": "project", "title": "Clash", "number": clash})
            self.assertEqual(status, 400, clash)
            self.assertIn(project["ref"], data["error"])
            self.assertIn("Project number", data["error"])
        # ...but each section has its own numbering.
        enquiry = self.new_record(sam, "enquiry", "Enquiry sharing a number", number="24-118 / Rev B")
        eoi = self.new_record(sam, "eoi", "EOI sharing a number", number="24-118 / Rev B")
        self.assertEqual((enquiry["number"], eoi["number"]), ("24-118 / Rev B", "24-118 / Rev B"))

        # An existing item is given its number afterwards, by anyone who works on it.
        status, data = tina.put("/api/records/%d" % plain["id"], {"version": 1, "number": "Q-2026/045"})
        self.assertEqual(status, 200, data)
        self.assertEqual((data["record"]["number"], data["record"]["ref"], data["record"]["title"]),
                         ("Q-2026/045", plain["ref"], "Unnumbered project"))
        self.assertEqual(sam.put("/api/records/%d" % other["id"], {"version": 1, "number": "q-2026/045"})[0], 400)
        self.assertEqual(sam.put("/api/records/%d" % plain["id"], {"version": 2, "number": "Q-2026/045"})[1]["changed"], False)
        history = [h["text"] for h in sam.get("/api/records/%d/history" % plain["id"])[1]["history"]]
        self.assertIn("Project number: - \u2192 Q-2026/045", history)
        # It can be changed or cleared again.
        status, data = sam.put("/api/records/%d" % plain["id"], {"version": 2, "number": ""})
        self.assertEqual((status, data["record"]["number"]), (200, ""))
        self.assertEqual(sam.put("/api/records/%d" % other["id"], {"version": 1, "number": "Q-2026/045"})[0], 200)
        self.assertEqual(sam.post("/api/records", {"module": "project", "title": "x", "number": "n" * 61})[0], 400)
        self.assertEqual(sam.post("/api/records", {"module": "project", "title": "x", "number": 12345})[0], 400)

        # Finance and Office Admin items are not numbered this way.
        invoice = self.new_record(fiona, "finance", "Invoice with a number sent anyway", number="INV-9")
        self.assertEqual(invoice["number"], "")

        # The number is what the activity log and other people's updates show and find.
        sam.post("/api/records/%d/actions" % project["id"], {"version": 1, "text": "Numbered action zq9", "date": "2026-11-26"})
        entry = sam.get("/api/log?q=24-118")[1]["entries"][0]
        self.assertEqual((entry["text"], entry["record"]["number"], entry["record"]["ref"]),
                         ("Numbered action zq9", "24-118 / Rev B", project["ref"]))
        update = [e for e in tina.get("/api/events")[1]["events"] if e["text"] == "Numbered action zq9"][0]
        self.assertEqual(update["record"]["number"], "24-118 / Rev B")
        recent = [a for a in tina.get("/api/activity")[1]["activity"] if a["text"] == "Numbered action zq9"][0]
        self.assertEqual(recent["number"], "24-118 / Rev B")

        # Deleting an item frees its number; it cannot then be restored on top of the new holder.
        self.assertEqual(self.admin.delete("/api/records/%d" % project["id"])[0], 200)
        taker = self.new_record(sam, "project", "Takes over the number", number="24-118 / Rev B")
        status, data = self.admin.post("/api/records/%d/restore" % project["id"])
        self.assertEqual(status, 400)
        self.assertIn(taker["ref"], data["error"])
        self.assertEqual(sam.put("/api/records/%d" % taker["id"], {"version": 1, "number": "24-119"})[0], 200)
        self.assertEqual(self.admin.post("/api/records/%d/restore" % project["id"])[0], 200)
        self.assertEqual(self.find(self.state(sam), project["id"])["number"], "24-118 / Rev B")

    # -- tasks ------------------------------------------------------------------

    def test_tasks_belong_to_people(self):
        sam, tina, fiona = self.people["sam"], self.people["tina"], self.people["fiona"]
        project = self.new_record(sam, "project", "Project with tasks")
        invoice = self.new_record(fiona, "finance", "Invoice with a task")

        # Sam gives Tina a private task (not on any record).
        status, data = sam.post("/api/tasks", {"title": "Call the supplier", "assignee_id": tina.user_id,
                                               "due_date": "2026-12-01", "priority": "High"})
        self.assertEqual(status, 200, data)
        private = data["task"]
        self.assertEqual(private["status"], "To Do")
        # Fiona gives Sam a task attached to a finance record he cannot open.
        status, data = fiona.post("/api/tasks", {"title": "Confirm PO number", "assignee_id": sam.user_id,
                                                 "record_id": invoice["id"]})
        self.assertEqual(status, 200, data)
        restricted_task = data["task"]
        # A task on a shared project is visible to everyone who can see the project.
        status, data = sam.post("/api/tasks", {"title": "Draft plan", "assignee_id": sam.user_id,
                                               "record_id": project["id"]})
        shared = data["task"]

        ids = lambda client: set(t["id"] for t in self.state(client)["tasks"])
        self.assertIn(private["id"], ids(tina))
        self.assertIn(private["id"], ids(sam))
        self.assertNotIn(private["id"], ids(fiona))
        self.assertIn(private["id"], ids(self.admin))
        self.assertIn(shared["id"], ids(tina))
        self.assertIn(restricted_task["id"], ids(sam))
        self.assertNotIn(restricted_task["id"], ids(tina))
        self.assertEqual(self.state(sam)["restricted"][str(invoice["id"])]["ref"], invoice["ref"])

        # Staff cannot attach a task to a record they cannot see.
        self.assertEqual(sam.post("/api/tasks", {"title": "x", "assignee_id": sam.user_id,
                                                 "record_id": invoice["id"]})[0], 404)
        # Only assignee, creator or admin may change a task.
        self.assertEqual(tina.put("/api/tasks/%d" % shared["id"], {"version": 1, "status": "Done"})[0], 403)
        self.assertEqual(fiona.put("/api/tasks/%d" % private["id"], {"version": 1, "status": "Done"})[0], 403)

        # The assignee completes it; completion time is recorded.
        status, data = tina.put("/api/tasks/%d" % private["id"], {"version": 1, "status": "Done"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["task"]["status"], "Done")
        self.assertTrue(data["task"]["completed_at"])
        self.assertEqual(tina.put("/api/tasks/%d" % private["id"], {"version": 1, "status": "To Do"})[0], 409)
        status, data = tina.put("/api/tasks/%d" % private["id"], {"version": 2, "status": "To Do"})
        self.assertIsNone(data["task"]["completed_at"])

        # Sam can finish a task on a record he cannot see without needing access to it.
        status, data = sam.put("/api/tasks/%d" % restricted_task["id"],
                               {"version": 1, "status": "Done", "record_id": invoice["id"]})
        self.assertEqual(status, 200, data)

        # Completing a task on a record is written to that record's history.
        sam.put("/api/tasks/%d" % shared["id"], {"version": 1, "status": "Done"})
        history = sam.get("/api/records/%d/history" % project["id"])[1]["history"]
        self.assertTrue(any("Task completed: Draft plan" in x["text"] for x in history))

        # Only the creator (or an admin) deletes.
        self.assertEqual(tina.delete("/api/tasks/%d" % private["id"])[0], 403)
        self.assertEqual(sam.delete("/api/tasks/%d" % private["id"])[0], 200)
        self.assertNotIn(private["id"], ids(sam))

        # Deleting a record keeps its tasks but unlinks them.
        self.admin.delete("/api/records/%d" % project["id"])
        kept = [t for t in self.state(sam)["tasks"] if t["id"] == shared["id"]]
        self.assertEqual(len(kept), 1)
        self.assertIsNone(kept[0]["record_id"])

    def test_task_validation(self):
        sam = self.people["sam"]
        for bad in [{"title": "", "assignee_id": sam.user_id},
                    {"title": "x"},
                    {"title": "x", "assignee_id": 999999},
                    {"title": "x", "assignee_id": sam.user_id, "due_date": "soon"},
                    {"title": "x", "assignee_id": sam.user_id, "status": "Maybe"},
                    {"title": "x", "assignee_id": sam.user_id, "record_id": 99999999}]:
            status, _ = sam.post("/api/tasks", bad)
            self.assertIn(status, (400, 404), bad)
        self.assertEqual(sam.put("/api/tasks/99999999", {"version": 1, "status": "Done"})[0], 404)

    # -- administration ---------------------------------------------------------

    def test_admin_area_is_admin_only(self):
        sam = self.people["sam"]
        self.assertEqual(sam.get("/api/admin/users")[0], 403)
        self.assertEqual(sam.get("/api/admin/audit")[0], 403)
        self.assertEqual(sam.get("/api/admin/system")[0], 403)
        self.assertEqual(sam.request("GET", "/api/admin/backup", raw=True)[0], 403)
        self.assertEqual(sam.post("/api/admin/users", {"username": "evil", "full_name": "E", "role": "admin"})[0], 403)
        self.assertEqual(sam.put("/api/admin/users/%d" % sam.user_id, {"role": "admin"})[0], 403)
        self.assertEqual(sam.put("/api/admin/settings", {"org_name": "x"})[0], 403)
        self.assertEqual(sam.post("/api/admin/users/1/reset-password")[0], 403)

    def test_user_management_rules(self):
        me = self.state(self.admin)["me"]
        # The only administrator cannot remove their own access.
        self.assertEqual(self.admin.put("/api/admin/users/%d" % me["id"], {"active": False})[0], 400)
        self.assertEqual(self.admin.put("/api/admin/users/%d" % me["id"], {"role": "staff"})[0], 400)
        self.assertEqual(self.admin.post("/api/admin/users/%d/reset-password" % me["id"])[0], 400)
        for bad in [{"username": "a", "full_name": "A", "role": "staff"},
                    {"username": "Has Space", "full_name": "A", "role": "staff"},
                    {"username": "sam", "full_name": "Duplicate", "role": "staff"},
                    {"username": "SAM", "full_name": "Duplicate", "role": "staff"},
                    {"username": "okname", "full_name": "", "role": "staff"},
                    {"username": "okname", "full_name": "A", "role": "superuser"}]:
            self.assertEqual(self.admin.post("/api/admin/users", bad)[0], 400, bad)

        temp = self.make_user("leaver", "Lena Leaver", "staff")
        self.assertEqual(temp.get("/api/state")[0], 200)
        # Deactivating signs the person out immediately and blocks sign-in.
        status, data = self.admin.put("/api/admin/users/%d" % temp.user_id, {"active": False})
        self.assertEqual(status, 200, data)
        self.assertEqual(temp.get("/api/state")[0], 401)
        self.assertEqual(Client(self.base).login("leaver", temp.password)[0], 401)
        # Reactivate, then reset the password: old password stops working.
        self.admin.put("/api/admin/users/%d" % temp.user_id, {"active": True})
        fresh = Client(self.base)
        self.assertEqual(fresh.login("leaver", temp.password)[0], 200)
        status, data = self.admin.post("/api/admin/users/%d/reset-password" % temp.user_id)
        self.assertEqual(status, 200)
        self.assertEqual(fresh.get("/api/state")[0], 401)
        self.assertEqual(Client(self.base).login("leaver", temp.password)[0], 401)
        again = Client(self.base)
        status, login = again.login("leaver", data["temp_password"])
        self.assertEqual(status, 200)
        self.assertTrue(login["user"]["must_change"])
        self.assertEqual(again.get("/api/state")[0], 403)

        # Changing a role changes what the person can open.
        self.assertEqual(self.admin.put("/api/admin/users/%d" % self.people["tina"].user_id,
                                        {"role": "office"})[0], 200)
        self.assertIn("office", self.state(self.people["tina"])["meta"]["visible_modules"])
        self.admin.put("/api/admin/users/%d" % self.people["tina"].user_id, {"role": "staff"})
        self.assertNotIn("office", self.state(self.people["tina"])["meta"]["visible_modules"])

        events = [a["event"] for a in self.admin.get("/api/admin/audit")[1]["audit"]]
        for expected in ["login_ok", "login_failed", "user_created", "user_updated", "password_reset",
                         "password_changed"]:
            self.assertIn(expected, events)

    def test_passwords_are_never_sent_or_stored_in_clear(self):
        payload = json.dumps([self.state(self.admin), self.admin.get("/api/admin/users")[1]])
        self.assertNotIn("pw_hash", payload)
        self.assertNotIn("pbkdf2", payload)
        conn = sqlite3.connect(insys.RT.db_path)
        rows = conn.execute("SELECT pw_hash FROM users").fetchall()
        conn.close()
        for (stored,) in rows:
            self.assertTrue(stored.startswith("pbkdf2_sha256$"))
            self.assertNotIn("Pass-12345", stored)

    def test_settings(self):
        self.assertEqual(self.admin.put("/api/admin/settings", {"org_name": "Acme Group", "currency": "AUD"})[0], 200)
        meta = self.state(self.people["sam"])["meta"]
        self.assertEqual((meta["org_name"], meta["currency"]), ("Acme Group", "AUD"))

    def test_backup_download_is_a_valid_database_without_sessions(self):
        status, payload = self.admin.request("GET", "/api/admin/backup", raw=True)
        self.assertEqual(status, 200)
        self.assertTrue(payload.startswith(b"SQLite format 3"))
        path = os.path.join(self.tmp, "downloaded.db")
        with open(path, "wb") as fh:
            fh.write(payload)
        conn = sqlite3.connect(path)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
        self.assertGreaterEqual(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 5)
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        conn.close()
        self.assertFalse([f for f in os.listdir(insys.RT.backup_dir) if f.endswith(".tmp")])

    def test_automatic_backups_rotate(self):
        first = insys.auto_backup(force=True)
        self.assertTrue(first and os.path.exists(first))
        self.assertIsNone(insys.auto_backup())  # one already exists from today
        for index in range(insys.BACKUP_KEEP + 3):
            shutil.copy(first, os.path.join(insys.RT.backup_dir, "insys-20200101-0000%02d.db" % index))
        time.sleep(1.1)
        insys.auto_backup(force=True)
        files = [f for f in os.listdir(insys.RT.backup_dir) if f.startswith("insys-") and f.endswith(".db")]
        self.assertEqual(len(files), insys.BACKUP_KEEP)

    # -- live updates -----------------------------------------------------------

    def test_version_changes_only_when_data_changes(self):
        sam, tina = self.people["sam"], self.people["tina"]
        before = tina.get("/api/version")[1]["version"]
        self.state(sam)
        sam.get("/api/activity")
        self.assertEqual(tina.get("/api/version")[1]["version"], before)
        self.new_record(sam, "enquiry", "Triggers an update")
        after = tina.get("/api/version")[1]["version"]
        self.assertNotEqual(after, before)
        self.assertEqual(self.state(tina)["version"], after)

    def test_many_people_at_once(self):
        sam = self.people["sam"]
        errors = []

        def work(client, index):
            try:
                for n in range(5):
                    status, data = client.post("/api/records", {"module": "enquiry", "title": "Burst %d-%d" % (index, n)})
                    if status != 200:
                        errors.append(data)
                    if client.get("/api/state")[0] != 200:
                        errors.append("state failed")
            except Exception as exc:  # pragma: no cover
                errors.append(repr(exc))

        clients = [self.people[n] for n in ("sam", "tina", "fiona", "oscar")] + [self.admin]
        threads = [threading.Thread(target=work, args=(c, i)) for i, c in enumerate(clients)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        refs = [r["ref"] for r in self.state(sam)["records"]]
        self.assertEqual(len(refs), len(set(refs)))
        self.assertEqual(len([r for r in self.state(sam)["records"] if r["title"].startswith("Burst")]), 25)


FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def build_old_database(path, layout, password="Old-system-pass-1"):
    """Create a database exactly as an older InSys laid it out, with some work in it.
    layout 1 = InSys 1.0.0, layout 2 = InSys 1.1.x. Returns the rows it put in."""
    with open(os.path.join(FIXTURES, "schema_v%d.sql" % layout), encoding="utf-8") as fh:
        schema = fh.read()
    conn = sqlite3.connect(path)
    conn.executescript(schema)
    now = "2026-10-01T09:00:00Z"
    conn.execute("INSERT INTO users (username, full_name, role, pw_hash, must_change, active, created_at) "
                 "VALUES ('admin', 'Old Admin', 'admin', ?, 0, 1, ?)", (insys.hash_password(password), now))
    conn.execute("INSERT INTO users (username, full_name, role, pw_hash, must_change, active, created_at) "
                 "VALUES ('pat', 'Pat Staff', 'staff', ?, 0, 1, ?)", (insys.hash_password(password), now))
    conn.execute("INSERT INTO records (module, ref, title, organisation, status, priority, owner_id, amount, "
                 "last_action, last_action_date, last_action_by, next_action, next_action_date, created_by, "
                 "created_at, updated_by, updated_at, version) VALUES ('project', 'PRJ-0001', 'Work from the old version', "
                 "'Old Client', 'In Progress', 'High', 2, 1250.5, 'Did the survey', '2026-09-20', 2, 'Send the quote', "
                 "'2026-12-01', 1, ?, 2, ?, 4)", (now, now))
    conn.execute("INSERT INTO records (module, ref, title, status, created_at, updated_at) "
                 "VALUES ('finance', 'FIN-0001', 'Old invoice', 'Issued', ?, ?)", (now, now))
    conn.execute("INSERT INTO activity (record_id, user_id, at, kind, text, action_date) "
                 "VALUES (1, 2, ?, 'action', 'Did the survey', '2026-09-20')", (now,))
    conn.execute("INSERT INTO links (a_id, b_id, created_by, created_at) VALUES (1, 2, 1, ?)", (now,))
    conn.execute("INSERT INTO xrefs (record_id, system, ref, url, created_by, created_at) "
                 "VALUES (1, 'CRM', 'OPP-1', '', 1, ?)", (now,))
    conn.execute("INSERT INTO tasks (title, record_id, assignee_id, created_by, created_at, status, updated_at) "
                 "VALUES ('Old task', 1, 2, 1, ?, 'To Do', ?)", (now, now))
    conn.execute("INSERT INTO audit (at, username, event) VALUES (?, 'admin', 'login_ok')", (now,))
    for key, value in [("schema_version", str(layout)), ("org_name", "Old Org"), ("currency", "AUD"),
                       ("seq_project", "1"), ("seq_finance", "1")]:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", (key, value))
    if layout >= 2:
        conn.execute("INSERT INTO subcons (ref, name, discipline, services, created_by, created_at, updated_by, "
                     "updated_at) VALUES ('SUB-0001', 'Old Subcon Ltd', 'Structural', 'Design', 1, ?, 1, ?)", (now, now))
        conn.execute("INSERT INTO record_subcons (record_id, subcon_id, scope, added_by, added_at) "
                     "VALUES (1, 1, 'Old scope', 1, ?)", (now,))
        conn.execute("INSERT INTO meta (key, value) VALUES ('seq_subcon', '1')")
    conn.commit()
    conn.close()


def snapshot(path):
    """Every row of every table, limited to the columns that exist in the file now."""
    conn = sqlite3.connect(path)
    try:
        out = {}
        for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"):
            columns = [row[1] for row in conn.execute("PRAGMA table_info(%s)" % table)]
            out[table] = (columns, conn.execute("SELECT %s FROM %s ORDER BY 1, 2" % (",".join(columns), table)).fetchall())
        return out
    finally:
        conn.close()


class UpgradeTest(unittest.TestCase):
    """Data written by every earlier version must open in this one with nothing lost."""

    def setUp(self):
        self.saved = (insys.RT.data_dir, insys.RT.upgraded_from, insys.RT.upgrade_backup)
        insys.RT.data_dir = tempfile.mkdtemp(prefix="insys-upgrade-")
        insys.RT.upgraded_from = insys.RT.upgrade_backup = None

    def tearDown(self):
        shutil.rmtree(insys.RT.data_dir, ignore_errors=True)
        insys.RT.data_dir, insys.RT.upgraded_from, insys.RT.upgrade_backup = self.saved

    def upgrade_from(self, layout):
        build_old_database(insys.RT.db_path, layout)
        before = snapshot(insys.RT.db_path)
        self.assertEqual(insys.stored_schema_version(), layout)
        self.assertIsNone(insys.init_db())  # no new administrator: the existing one is kept
        self.assertEqual(insys.stored_schema_version(), insys.SCHEMA_VERSION)
        self.assertEqual(insys.RT.upgraded_from, layout)
        after_conn = sqlite3.connect(insys.RT.db_path)
        # Every table, column and row the old version wrote is still there, unchanged.
        for table, (columns, rows) in before.items():
            if table in ("meta", "audit"):
                continue  # the layout number and the upgrade note are the intended changes here
            now_rows = after_conn.execute("SELECT %s FROM %s ORDER BY 1, 2" % (",".join(columns), table)).fetchall()
            self.assertEqual(now_rows, rows, table)
        meta = dict(after_conn.execute("SELECT key, value FROM meta"))
        self.assertEqual((meta["org_name"], meta["currency"], meta["seq_project"]), ("Old Org", "AUD", "1"))
        self.assertEqual(after_conn.execute("SELECT COUNT(*) FROM audit WHERE event = 'login_ok'").fetchone()[0], 1)
        self.assertEqual(after_conn.execute("SELECT COUNT(*) FROM audit WHERE event = 'upgraded'").fetchone()[0], 1)
        # Nothing old is treated as deleted, and the new columns start empty.
        self.assertEqual(after_conn.execute("SELECT COUNT(*) FROM records WHERE deleted_at IS NOT NULL").fetchone()[0], 0)
        self.assertEqual(after_conn.execute("SELECT COUNT(*) FROM tasks WHERE deleted_at IS NOT NULL").fetchone()[0], 0)
        after_conn.close()
        # A copy from before the upgrade exists and is byte-for-byte the old layout and data.
        backup = insys.RT.upgrade_backup
        self.assertTrue(os.path.basename(backup).startswith("before-upgrade-from-v%d-" % layout))
        copy = snapshot(backup)
        for table, (columns, rows) in before.items():
            if table != "sessions":
                self.assertEqual(copy[table], (columns, rows), table)
        # Starting again does nothing further.
        insys.RT.upgraded_from = insys.RT.upgrade_backup = None
        again = snapshot(insys.RT.db_path)
        insys.init_db()
        self.assertIsNone(insys.RT.upgraded_from)
        self.assertEqual(snapshot(insys.RT.db_path), again)
        self.assertEqual(len([f for f in os.listdir(insys.RT.backup_dir) if f.startswith("before-upgrade")]), 1)

    def test_data_from_1_0_0_is_upgraded_and_kept(self):
        self.upgrade_from(1)
        with insys.write_db(bump=False) as conn:
            self.assertEqual(insys.next_ref(conn, "project"), "PRJ-0002")
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM subcons").fetchone()["n"], 0)

    def test_data_from_1_2_1_to_1_2_3_is_upgraded_and_kept(self):
        self.upgrade_from(4)
        with insys.read_db() as conn:
            rows = conn.execute("SELECT ref, number FROM records ORDER BY id").fetchall()
        # Existing items keep their system reference and start with no number of their own.
        self.assertEqual([tuple(r) for r in rows], [("PRJ-0001", ""), ("FIN-0001", "")])

    def test_data_already_in_the_current_layout_opens_as_it_is(self):
        """Starting the same version again converts and copies nothing."""
        insys.init_db()
        before = snapshot(insys.RT.db_path)
        self.assertEqual(insys.stored_schema_version(), insys.SCHEMA_VERSION)
        insys.RT.upgraded_from = insys.RT.upgrade_backup = None
        self.assertIsNone(insys.init_db())
        self.assertIsNone(insys.RT.upgraded_from)
        self.assertEqual(snapshot(insys.RT.db_path), before)
        self.assertFalse([f for f in os.listdir(insys.RT.backup_dir) if f.startswith("before-upgrade")])

    def test_data_from_1_2_0_is_upgraded_and_kept(self):
        self.upgrade_from(3)
        with insys.read_db() as conn:
            link = conn.execute("SELECT * FROM record_subcons").fetchone()
            events = conn.execute("SELECT scope, kind, text, record_id, actor_id FROM events").fetchall()
        self.assertEqual(link["scope"], "Old scope")
        # The updates feed starts with the existing history, so the bell is not empty.
        self.assertEqual([tuple(e) for e in events], [("record", "action", "Did the survey", 1, 2)])

    def test_data_from_1_1_x_is_upgraded_and_kept(self):
        self.upgrade_from(2)
        with insys.read_db() as conn:
            sub = conn.execute("SELECT * FROM subcons").fetchone()
            link = conn.execute("SELECT * FROM record_subcons").fetchone()
        self.assertEqual((sub["name"], sub["discipline"], sub["capabilities"]), ("Old Subcon Ltd", "Structural", ""))
        self.assertEqual((link["scope"], link["last_update"], link["last_update_date"], link["next_action"],
                          link["next_action_date"]), ("Old scope", "", None, "", None))

    def test_upgraded_data_works_in_the_running_program(self):
        """Sign in to data from 1.0.0 with its old password and use old and new features."""
        build_old_database(insys.RT.db_path, 1)
        insys.init_db()
        server = insys.Server(("127.0.0.1", 0), insys.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            client = Client("http://127.0.0.1:%d" % server.server_address[1])
            self.assertEqual(client.login("admin", "Old-system-pass-1")[0], 200)
            state = client.get("/api/state")[1]
            self.assertEqual(sorted(r["ref"] for r in state["records"]), ["FIN-0001", "PRJ-0001"])
            project = [r for r in state["records"] if r["ref"] == "PRJ-0001"][0]
            self.assertEqual((project["title"], project["last_action"], project["next_action_date"], project["amount"],
                              project["xrefs"][0]["ref"]), ("Work from the old version", "Did the survey", "2026-12-01", 1250.5, "OPP-1"))
            self.assertEqual(state["links"], [[1, 2]])
            self.assertEqual(state["tasks"][0]["title"], "Old task")
            self.assertEqual(state["meta"]["roles"]["staff"], "Engineering")
            log = client.get("/api/log?month=all")[1]
            self.assertEqual([(e["text"], e["day"]) for e in log["entries"]], [("Did the survey", "2026-09-20")])
            # The bell shows the earlier history, none of it marked as new.
            updates = client.get("/api/events")[1]
            self.assertEqual([(e["text"], e["unread"]) for e in updates["events"]], [("Did the survey", False)])
            self.assertEqual(updates["unread"], 0)
            # Old staff login still works and still cannot see finance.
            pat = Client(client.base)
            self.assertEqual(pat.login("pat", "Old-system-pass-1")[0], 200)
            self.assertEqual(pat.get("/api/state")[1]["meta"]["visible_modules"], ["project", "enquiry", "eoi"])
            # New features work on the old record.
            sub = client.post("/api/subcons", {"name": "New Subcon", "capabilities": "Seismic"})[1]["subcon"]
            self.assertEqual(client.post("/api/records/1/subcons", {"subcon_id": sub["id"]})[0], 200)
            self.assertEqual(client.put("/api/records/1/subcons/%d" % sub["id"],
                                        {"next_action": "Call", "next_action_date": "2026-12-05"})[0], 200)
            self.assertEqual(client.delete("/api/records/1")[0], 200)
            self.assertEqual(client.post("/api/records/1/restore")[0], 200)
            self.assertEqual(client.post("/api/records/1/actions", {"version": 5, "text": "Sent the quote", "date": "2026-11-25"})[0], 200)
        finally:
            server.shutdown()
            server.server_close()

    def test_upgrade_copies_are_not_rotated_away(self):
        build_old_database(insys.RT.db_path, 1)
        insys.init_db()
        for index in range(insys.BACKUP_KEEP + 5):
            shutil.copy(insys.RT.upgrade_backup, os.path.join(insys.RT.backup_dir, "insys-20200101-0000%02d.db" % index))
        insys.auto_backup(force=True)
        self.assertTrue(os.path.exists(insys.RT.upgrade_backup))

    def test_data_from_a_newer_version_is_refused_untouched(self):
        insys.init_db()
        with insys.write_db(bump=False) as conn:
            insys.meta_set(conn, "schema_version", insys.SCHEMA_VERSION + 1)
        with open(insys.RT.db_path, "rb") as fh:
            before = fh.read()
        with self.assertRaises(insys.DatabaseTooNew):
            insys.init_db()
        with open(insys.RT.db_path, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_new_installation_starts_at_the_current_layout(self):
        self.assertIsNone(insys.stored_schema_version())
        self.assertTrue(insys.init_db())  # administrator password generated
        self.assertEqual(insys.stored_schema_version(), insys.SCHEMA_VERSION)
        self.assertIsNone(insys.RT.upgraded_from)
        self.assertFalse([f for f in os.listdir(insys.RT.backup_dir) if f.startswith("before-upgrade")])


class TransferTest(unittest.TestCase):
    """An administrator can download the database and load it into another InSys."""

    @classmethod
    def setUpClass(cls):
        cls.saved = insys.RT.data_dir
        insys.RT.data_dir = tempfile.mkdtemp(prefix="insys-transfer-")
        password = insys.init_db()
        cls.server = insys.Server(("127.0.0.1", 0), insys.Handler)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base)
        cls.admin.login("admin", password)
        cls.admin.post("/api/change-password", {"current": password, "new": "Host-system-pass-1"})
        data = cls.admin.post("/api/admin/users", {"username": "stan", "full_name": "Stan Staff", "role": "staff"})[1]
        cls.staff = Client(cls.base)
        cls.staff.login("stan", data["temp_password"])
        cls.staff.post("/api/change-password", {"current": data["temp_password"], "new": "Stan-system-pass-1"})

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(insys.RT.data_dir, ignore_errors=True)
        insys.RT.data_dir = cls.saved

    def titles(self, client):
        return sorted(r["title"] for r in client.get("/api/state")[1]["records"])

    def sign_in_admin(self, password="Host-system-pass-1"):
        self.admin.__init__(self.base)
        status, _ = self.admin.login("admin", password)
        self.assertEqual(status, 200)

    def test_1_only_an_administrator_can_download_or_load(self):
        self.admin.post("/api/records", {"module": "project", "title": "Stays put"})
        status, payload = self.staff.request("GET", "/api/admin/backup", raw=True)
        self.assertEqual(status, 403)
        good = self.admin.request("GET", "/api/admin/backup", raw=True)[1]
        self.assertIn(self.staff.upload("/api/admin/restore", good)[0], (403, 0))
        self.assertIn(Client(self.base).upload("/api/admin/restore", good)[0], (401, 0))
        self.assertIn(self.admin.upload("/api/admin/restore", good, send_csrf=False)[0], (403, 0))
        self.assertEqual(self.titles(self.admin), ["Stays put"])
        self.assertEqual(self.staff.get("/api/me")[0], 200)  # nobody was signed out
        self.assertFalse([f for f in os.listdir(insys.RT.data_dir) if f.startswith("upload-")])

    def test_2_files_that_are_not_a_usable_database_are_refused(self):
        self.sign_in_admin()
        before = self.titles(self.admin)
        good = self.admin.request("GET", "/api/admin/backup", raw=True)[1]
        newer = os.path.join(insys.RT.data_dir, "newer.db")
        with open(newer, "wb") as fh:
            fh.write(good)
        conn = sqlite3.connect(newer)
        conn.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", (str(insys.SCHEMA_VERSION + 1),))
        conn.commit()
        conn.close()
        with open(newer, "rb") as fh:
            too_new = fh.read()
        conn = sqlite3.connect(newer)
        conn.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", (str(insys.SCHEMA_VERSION),))
        conn.execute("UPDATE users SET active = 0 WHERE role = 'admin'")
        conn.commit()
        conn.close()
        with open(newer, "rb") as fh:
            no_admin = fh.read()
        os.remove(newer)
        other = os.path.join(insys.RT.data_dir, "other.db")
        conn = sqlite3.connect(other)
        conn.execute("CREATE TABLE something (x)")
        conn.commit()
        conn.close()
        with open(other, "rb") as fh:
            not_insys = fh.read()
        os.remove(other)
        cases = [(b"this is not a database at all" * 50, "not an InSys database"),
                 (good[:len(good) // 2], None), (not_insys, "not an InSys database"),
                 (too_new, "newer version"), (no_admin, "no active administrator")]
        for payload, expected in cases:
            status, data = self.admin.upload("/api/admin/restore", payload)
            self.assertEqual(status, 400, expected)
            if expected:
                self.assertIn(expected, data["error"])
        self.assertEqual(self.admin.upload("/api/admin/restore", b"")[0], 400)
        self.assertEqual(self.titles(self.admin), before)
        self.assertFalse([f for f in os.listdir(insys.RT.backup_dir) if f.startswith("before-loading")])
        self.assertFalse([f for f in os.listdir(insys.RT.data_dir) if f.startswith("upload-")])

    def test_3_a_downloaded_database_can_be_loaded_back(self):
        self.sign_in_admin()
        self.admin.post("/api/records", {"module": "enquiry", "title": "Travels with the file"})
        status, travelling = self.admin.request("GET", "/api/admin/backup", raw=True)
        self.assertEqual(status, 200)
        self.assertIn("insys-database-", self.admin.last_headers["Content-Disposition"])
        self.admin.post("/api/records", {"module": "eoi", "title": "Made after the download"})
        self.assertIn("Made after the download", self.titles(self.admin))

        status, data = self.admin.upload("/api/admin/restore", travelling)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["records"], 2)
        # Everyone is signed out and signs in again with the logins in the file.
        self.assertEqual(self.staff.get("/api/me")[0], 401)
        self.assertEqual(self.admin.get("/api/me")[0], 401)
        self.sign_in_admin()
        self.assertEqual(self.titles(self.admin), ["Stays put", "Travels with the file"])
        # What was here before the load was kept, whole.
        kept = os.path.join(insys.RT.backup_dir, data["kept"])
        conn = sqlite3.connect(kept)
        self.assertEqual(sorted(r[0] for r in conn.execute("SELECT title FROM records")),
                         ["Made after the download", "Stays put", "Travels with the file"])
        conn.close()
        events = [a["event"] for a in self.admin.get("/api/admin/audit")[1]["audit"]]
        self.assertIn("database_loaded", events)
        # The loaded data is fully usable.
        status, data = self.admin.post("/api/records", {"module": "project", "title": "New work after loading"})
        self.assertEqual(status, 200, data)

    def test_4_a_database_from_an_older_version_is_upgraded_as_it_is_loaded(self):
        self.sign_in_admin()
        old = os.path.join(insys.RT.data_dir, "from-1.0.0.db")
        build_old_database(old, 1, password="Other-office-pass-9")
        with open(old, "rb") as fh:
            payload = fh.read()
        os.remove(old)
        status, data = self.admin.upload("/api/admin/restore", payload)
        self.assertEqual(status, 200, data)
        self.assertEqual(insys.stored_schema_version(), insys.SCHEMA_VERSION)
        # The other office's logins now apply here.
        self.assertEqual(Client(self.base).login("admin", "Host-system-pass-1")[0], 401)
        self.sign_in_admin("Other-office-pass-9")
        state = self.admin.get("/api/state")[1]
        self.assertEqual(sorted(r["ref"] for r in state["records"]), ["FIN-0001", "PRJ-0001"])
        self.assertEqual(state["meta"]["org_name"], "Old Org")
        sub = self.admin.post("/api/subcons", {"name": "Works after transfer"})
        self.assertEqual(sub[0], 200)
        self.assertEqual(self.admin.post("/api/records/1/subcons", {"subcon_id": sub[1]["subcon"]["id"]})[0], 200)
        self.assertEqual(self.admin.delete("/api/records/2")[0], 200)
        self.assertEqual(len(self.admin.get("/api/log?scope=deleted&kind=all&month=all")[1]["entries"]), 1)


class FakeConnection:
    """Stands in for an accepted network connection in the connection-filter tests."""

    def __init__(self, arrived_on):
        self.arrived_on = arrived_on

    def getsockname(self):
        return (self.arrived_on, 8080)


class LocalOnlyTest(unittest.TestCase):
    """Choices 1 and 2 must not serve, or reach, the internet."""

    @classmethod
    def setUpClass(cls):
        cls.saved = (insys.RT.data_dir, insys.RT.lan, insys.RT.online_requested, insys.RT.tunnel_active,
                     set(insys.RT.local_names))
        insys.RT.data_dir = tempfile.mkdtemp(prefix="insys-local-")
        insys.RT.lan = insys.RT.online_requested = insys.RT.tunnel_active = False
        insys.RT.local_names = set(["insys-pc"])
        password = insys.init_db()
        cls.server = insys.Server(("127.0.0.1", 0), insys.Handler)
        cls.port = cls.server.server_address[1]
        cls.base = "http://127.0.0.1:%d" % cls.port
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base)
        cls.admin.login("admin", password)
        cls.admin.post("/api/change-password", {"current": password, "new": "Local-only-pass-1"})
        cls.admin.post("/api/records", {"module": "project", "title": "Confidential tender price"})

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(insys.RT.data_dir, ignore_errors=True)
        (insys.RT.data_dir, insys.RT.lan, insys.RT.online_requested, insys.RT.tunnel_active,
         insys.RT.local_names) = cls.saved

    def setUp(self):
        insys.RT.lan = insys.RT.online_requested = insys.RT.tunnel_active = False
        insys._blocked_seen.clear()   # the security log limits repeats; each test starts fresh

    def fetch(self, path, headers, client=None):
        """GET with extra headers; returns (status, body bytes)."""
        client = client or Client(self.base)
        return client.request("GET", path, headers=headers, raw=True)

    # -- what counts as local ------------------------------------------------------

    def test_which_addresses_are_local(self):
        for address in ["127.0.0.1", "127.8.9.1", "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.255",
                        "192.168.0.1", "192.168.1.20", "169.254.10.10", "::1", "fd00::1", "fe80::1",
                        "::ffff:192.168.1.5", "192.168.1.20:8080", "[::1]:8080", "fe80::1%eth0"]:
            self.assertTrue(insys.is_local_address(address), address)
        for address in ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "100.64.0.1",
                        "203.0.113.9", "198.51.100.17", "2001:4860:4860::8888", "::ffff:8.8.8.8", "0.0.0.0",
                        "255.255.255.255", "", "not-an-address", "192.168.1", None]:
            self.assertFalse(insys.is_local_address(address), address)

    def test_which_site_addresses_are_local(self):
        for host in ["localhost", "localhost:8080", "LOCALHOST", "127.0.0.1", "127.0.0.1:8080", "192.168.1.20:8080",
                     "10.0.0.5", "[::1]:8080", "[fd00::2]", "insys-pc", "INSYS-PC:8080", "fileserver", "office.local",
                     "pc7.lan:8080", "tracker.internal", "box.home.arpa", "app.localhost"]:
            self.assertTrue(insys.is_local_host_name(host), host)
        for host in ["example.com", "quiet-maple-site.trycloudflare.com", "0.tcp.ngrok.io:12345", "8.8.8.8",
                     "203.0.113.9:8080", "[2001:4860:4860::8888]:80", "insys.mycompany.com", "local.evil.com",
                     "localhost.evil.com", "evil.com.", "", "   ", "bad host", "a_b!c", None]:
            self.assertFalse(insys.is_local_host_name(host), host)
        # The address a connection actually arrived on is acceptable; any other public one is not.
        self.assertTrue(insys.is_local_host_name("203.0.113.9:8080", arrived_on="203.0.113.9"))
        self.assertFalse(insys.is_local_host_name("203.0.113.10:8080", arrived_on="203.0.113.9"))
        insys.RT.local_names.add("tracker.mycompany.example")   # as given with --allow-host
        try:
            self.assertTrue(insys.is_local_host_name("Tracker.MyCompany.example:8080"))
        finally:
            insys.RT.local_names.discard("tracker.mycompany.example")

    # -- who may connect -----------------------------------------------------------

    def test_choice_1_serves_this_computer_only(self):
        verify = self.server.verify_request
        self.assertTrue(verify(FakeConnection("127.0.0.1"), ("127.0.0.1", 50000)))
        for peer in ["192.168.1.5", "10.0.0.9", "8.8.8.8", "203.0.113.9", "2001:4860:4860::8888"]:
            self.assertFalse(verify(FakeConnection("192.168.1.20"), (peer, 50000)), peer)

    def test_choice_2_serves_local_network_addresses_and_nothing_else(self):
        insys.RT.lan = True
        verify = self.server.verify_request
        for peer in ["127.0.0.1", "192.168.1.5", "10.20.30.40", "172.20.1.1", "169.254.3.3"]:
            self.assertTrue(verify(FakeConnection("192.168.1.20"), (peer, 50000)), peer)
        for peer in ["8.8.8.8", "203.0.113.9", "100.64.0.7", "172.32.0.1", "2001:4860:4860::8888"]:
            self.assertFalse(verify(FakeConnection("192.168.1.20"), (peer, 50000)), peer)
        # Even on a computer that has a public address of its own: outsiders are
        # refused, while the computer reaching itself by that address is not.
        self.assertFalse(verify(FakeConnection("203.0.113.9"), ("198.51.100.4", 50000)))
        self.assertTrue(verify(FakeConnection("203.0.113.9"), ("203.0.113.9", 50000)))
        entries = [a for a in self.admin.get("/api/admin/audit")[1]["audit"] if a["event"] == "blocked"]
        self.assertTrue(entries and "not a local network address" in entries[0]["detail"])

    # -- requests that have been through the internet --------------------------------

    def test_requests_relayed_from_the_internet_are_refused_in_choices_1_and_2(self):
        relayed = [
            {"CF-Connecting-IP": "203.0.113.50"}, {"CF-Ray": "8a1b2c3d4e5f-LHR"}, {"Cdn-Loop": "cloudflare"},
            {"CF-Visitor": '{"scheme":"https"}'}, {"Ngrok-Agent-Ips": "203.0.113.50"}, {"True-Client-IP": "203.0.113.50"},
            {"X-Forwarded-For": "203.0.113.50"}, {"X-Forwarded-For": "192.168.1.5, 203.0.113.50"},
            {"X-Forwarded-For": "2001:4860:4860::8888"}, {"X-Real-IP": "198.51.100.17"},
            {"Forwarded": 'for=198.51.100.17;proto=https'}, {"Forwarded": 'for="[2001:db8:cafe::17]:4711"'},
            {"Host": "quiet-maple-site.trycloudflare.com"}, {"Host": "0.tcp.ngrok.io:12345"},
            {"Host": "insys.mycompany.com"}, {"Host": "203.0.113.9:8080"},
            {"X-Forwarded-Host": "quiet-maple-site.trycloudflare.com"},
        ]
        for lan in (False, True):
            insys.RT.lan = lan
            for headers in relayed:
                for path, client in [("/", None), ("/app.js", None), ("/api/ping", None),
                                     ("/api/state", self.admin), ("/api/admin/backup", self.admin)]:
                    status, body = self.fetch(path, headers, client)
                    self.assertEqual(status, 403, (lan, headers, path))
                    self.assertEqual(body, insys.LOCAL_ONLY_PAGE, (headers, path))
                    self.assertNotIn(b"Confidential", body)
            # Signing in through a relay is refused too, before the password is even looked at.
            relay = Client(self.base)
            status, body = relay.request("POST", "/api/login", {"username": "admin", "password": "Local-only-pass-1"},
                                         headers={"CF-Connecting-IP": "203.0.113.50"}, raw=True)
            self.assertEqual((status, body), (403, insys.LOCAL_ONLY_PAGE))
            self.assertIsNone(relay.cookie)
        self.assertEqual(self.admin.get("/api/state")[0], 200)   # the real local session is unaffected
        events = [a for a in self.admin.get("/api/admin/audit")[1]["audit"] if a["event"] == "blocked"]
        self.assertTrue(any("relayed by an internet service" in a["detail"] or "public address" in a["detail"]
                            or "not a local address" in a["detail"] for a in events))

    def test_ordinary_local_requests_are_served(self):
        for headers in [{}, {"Host": "localhost:%d" % self.port}, {"Host": "insys-pc:%d" % self.port},
                        {"Host": "192.168.1.20:%d" % self.port}, {"Host": "office-server.local"},
                        {"X-Forwarded-For": "192.168.1.5"}, {"Via": "1.1 office-proxy"},
                        {"Forwarded": "for=192.168.1.5;by=10.0.0.1"}]:
            status, body = self.fetch("/api/state", headers, self.admin)
            self.assertEqual(status, 200, headers)
            self.assertIn(b"Confidential tender price", body)

    def test_forwarding_headers_are_never_believed_in_choices_1_and_2(self):
        Client(self.base).request("POST", "/api/login", {"username": "admin", "password": "wrong-password-zz"},
                                  headers={"X-Forwarded-For": "192.168.77.77"})
        failed = [a for a in self.admin.get("/api/admin/audit")[1]["audit"] if a["event"] == "login_failed"][0]
        self.assertEqual(failed["ip"], "127.0.0.1")   # where it really came from, not what it claimed

    def test_choice_3_is_the_only_mode_that_accepts_the_tunnel(self):
        insys.RT.online_requested = insys.RT.tunnel_active = True
        headers = {"CF-Connecting-IP": "203.0.113.50", "X-Forwarded-Proto": "https",
                   "Host": "quiet-maple-site.trycloudflare.com"}
        status, body = self.fetch("/api/state", headers, self.admin)
        self.assertEqual(status, 200)
        Client(self.base).request("POST", "/api/login", {"username": "admin", "password": "wrong-password-zz"},
                                  headers=headers)
        failed = [a for a in self.admin.get("/api/admin/audit")[1]["audit"] if a["event"] == "login_failed"][0]
        self.assertEqual(failed["ip"], "203.0.113.50")
        # The tunnel connects from this computer; nothing else may connect even then.
        self.assertFalse(self.server.verify_request(FakeConnection("192.168.1.20"), ("192.168.1.5", 50000)))

    # -- nothing goes out -----------------------------------------------------------

    def test_code_that_reaches_the_internet_cannot_run_outside_choice_3(self):
        target = os.path.join(insys.RT.data_dir, "should-never-exist.bin")
        for lan in (False, True):
            insys.RT.lan = lan
            with self.assertRaises(RuntimeError):
                insys.download_file("https://example.invalid/file", target)
            with self.assertRaises(RuntimeError):
                insys.ensure_cloudflared(interactive=False)
            with self.assertRaises(RuntimeError):
                insys.Tunnel("cloudflared", self.port).run_once()
            with self.assertRaises(RuntimeError):
                insys.require_internet_mode("Anything")
        self.assertFalse(os.path.exists(target) or os.path.exists(target + ".part"))
        self.assertFalse(os.path.exists(insys.tunnel_pid_path()))

    def test_the_menu_never_goes_online_by_itself(self):
        waits = []

        def ask(valid, default, seconds):
            waits.append((default, seconds))
            return default

        for remembered, expect_timer in [("1", True), ("2", True), ("3", False)]:
            insys.remember_mode(remembered)
            insys.start_menu(ask=ask)
            default, seconds = waits[-1]
            self.assertEqual(default, remembered)
            if expect_timer:
                self.assertEqual(seconds, insys.MENU_SECONDS)
            else:
                self.assertGreater(seconds, 24 * 3600)   # waits for a person; no countdown into Online
        insys.remember_mode("1")

    @unittest.skipUnless(os.name == "posix", "process handling is checked on POSIX here")
    def test_a_tunnel_left_running_by_an_earlier_session_is_closed(self):
        import subprocess
        fake = os.path.join(insys.RT.data_dir, "cloudflared")
        with open(fake, "w") as fh:     # one process, so nothing outlives the test
            fh.write("import time\ntime.sleep(300)\n")
        quiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        leftover = subprocess.Popen([sys.executable, fake, "tunnel", "--url", "http://127.0.0.1:8080"], **quiet)
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"], **quiet)
        try:
            time.sleep(0.3)
            insys.write_tunnel_pid(leftover.pid)
            self.assertTrue(insys.stop_leftover_tunnel())
            self.assertIsNotNone(leftover.wait(timeout=10))
            self.assertFalse(os.path.exists(insys.tunnel_pid_path()))
            # A stale number that now belongs to some other program is left alone.
            insys.write_tunnel_pid(unrelated.pid)
            self.assertFalse(insys.stop_leftover_tunnel())
            self.assertIsNone(unrelated.poll())
            self.assertFalse(os.path.exists(insys.tunnel_pid_path()))
            self.assertFalse(insys.stop_leftover_tunnel())   # nothing on file: nothing to do
        finally:
            for proc in (leftover, unrelated):
                if proc.poll() is None:
                    proc.kill()
                proc.wait()


def trusting(folder, strict=True):
    """A browser stand-in's TLS settings: trusts nothing but the InSys local
    certificate in `folder`, and checks everything a careful browser checks."""
    import ssl
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    with open(os.path.join(folder, "InSys-certificate.crt"), "rb") as fh:
        context.load_verify_locations(cadata=fh.read())
    if strict:
        context.verify_flags |= ssl.VERIFY_X509_STRICT
    return context


def handshake(server_context, client_context, name):
    """A complete TLS handshake in memory, as a browser opening https://<name>
    would do it. Raises ssl.SSLError if the browser would refuse the site."""
    import ssl
    to_server, to_client = ssl.MemoryBIO(), ssl.MemoryBIO()
    client = client_context.wrap_bio(to_client, to_server, server_hostname=name)
    server = server_context.wrap_bio(to_server, to_client, server_side=True)
    done = set()
    for _ in range(12):
        for side in (client, server):
            if side not in done:
                try:
                    side.do_handshake()
                    done.add(side)
                except ssl.SSLWantReadError:
                    pass
        if len(done) == 2:
            return client
    raise AssertionError("handshake did not finish")


class CertificateTest(unittest.TestCase):
    """The certificates InSys makes for encrypting the local network."""

    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="insys-enc-")
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)

    def start(self, addresses=("192.168.1.10", "127.0.0.1", "::1"), own="desktop-7gh2k1l", extra=()):
        enc = insys.Encryption(self.folder)
        allowed, names = insys.certificate_names(own, set(extra))
        enc.start(own.upper(), allowed, names, list(addresses))
        return enc

    def test_signing_matches_the_published_test_values(self):
        # RFC 6979, appendix A.2.5: P-256 with SHA-256.
        key = 0xC9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721
        public = insys.ec_public(key)
        self.assertEqual("%064X" % public[0], "60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6")
        self.assertEqual("%064X" % public[1], "7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299")
        for message, r, s in [
                (b"sample", "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716",
                 "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8"),
                (b"test", "F1ABB023518351CD71D881567B1EA663ED3EFCF6C5132B354F28D3B0B7D38367",
                 "019F4113742A2B14BD25926B49C649155F267E60D3814B4C0CC84250E46F0083")]:
            signature = insys.ecdsa_sign(key, message)
            self.assertEqual(("%064X" % signature[0], "%064X" % signature[1]), (r, s))
            self.assertTrue(insys.ecdsa_verify(public, message, signature))
            self.assertFalse(insys.ecdsa_verify(public, message + b"!", signature))
            self.assertFalse(insys.ecdsa_verify(public, message, (signature[0], signature[1] ^ 1)))
        self.assertTrue(insys.ec_on_curve(insys.EC_G))
        self.assertFalse(insys.ec_on_curve((insys.EC_G[0], insys.EC_G[1] + 1)))

    def test_keys_are_different_every_time_and_well_formed(self):
        keys = set(insys.ec_new_key() for _ in range(20))
        self.assertEqual(len(keys), 20)
        for key in keys:
            self.assertTrue(1 <= key < insys.EC_N)
            self.assertTrue(insys.ec_on_curve(insys.ec_public(key)))
            self.assertEqual(insys.read_private_key(insys.write_private_key(key, insys.ec_public(key))), key)

    def test_a_device_that_installed_the_certificate_accepts_insys(self):
        enc = self.start()
        browser = trusting(self.folder)
        for name in ["192.168.1.10", "127.0.0.1", "::1", "localhost", "desktop-7gh2k1l",
                     "desktop-7gh2k1l.local", "desktop-7gh2k1l.lan"]:
            connection = handshake(enc.context, browser, name)
            self.assertIn(connection.version(), ("TLSv1.3", "TLSv1.2"), name)
        import ssl
        # ...but not at an address the certificate does not name,
        for name in ["192.168.1.11", "10.0.0.1", "otherpc", "desktop-7gh2k1l.example.com"]:
            with self.assertRaises(ssl.SSLCertVerificationError, msg=name):
                handshake(enc.context, browser, name)
        # and a device that has not installed it refuses the connection outright.
        stranger = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with self.assertRaises(ssl.SSLCertVerificationError):
            handshake(enc.context, stranger, "192.168.1.10")

    def test_only_modern_encryption_is_offered(self):
        import ssl
        enc = self.start()
        self.assertEqual(enc.context.minimum_version, ssl.TLSVersion.TLSv1_2)
        import warnings
        old = trusting(self.folder)
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                old.minimum_version = ssl.TLSVersion.TLSv1
                old.maximum_version = ssl.TLSVersion.TLSv1_1
        except ValueError:
            self.skipTest("this OpenSSL cannot even attempt the old versions")
        with self.assertRaises(ssl.SSLError):
            handshake(enc.context, old, "192.168.1.10")
        for cipher in enc.context.get_ciphers():
            if cipher["protocol"] == "TLSv1.2":
                self.assertTrue(cipher["name"].startswith("ECDHE-"), cipher["name"])   # forward secrecy
                self.assertTrue("GCM" in cipher["name"] or "CHACHA20" in cipher["name"], cipher["name"])

    def test_the_local_certificate_cannot_vouch_for_public_sites(self):
        import datetime
        import ipaddress
        import ssl
        enc = self.start()
        browser = trusting(self.folder)
        # Sign, with the real local certificate key, a certificate for a public
        # site - as someone who stole the key would. A device must refuse it.
        for label, alt in [("a public name", insys.general_name("www.example.com")),
                           ("a public address", insys.general_name(ipaddress.ip_address("8.8.8.8"))),
                           ("a public ending", insys.general_name("login.example.dev"))]:
            key = insys.ec_new_key()
            public = insys.ec_public(key)
            now = insys.utc_now()
            forged = insys.build_certificate(
                enc.authority_key, enc.authority["subject"], insys.x509_name("forged"), public,
                now - datetime.timedelta(days=1), now + datetime.timedelta(days=30), [
                    insys.x509_extension(insys.OID_BASIC_CONSTRAINTS, insys.der_seq(), critical=True),
                    insys.x509_extension(insys.OID_EXT_KEY_USAGE, insys.der_seq(insys.OID_SERVER_AUTH)),
                    insys.x509_extension(insys.OID_ALT_NAME, insys.der_seq(alt)),
                    insys.x509_extension(insys.OID_SUBJECT_KEY_ID, insys.der(0x04, insys.key_identifier(public))),
                    insys.x509_extension(insys.OID_AUTHORITY_KEY_ID, insys.der_seq(
                        insys.der(0x80, insys.key_identifier(enc.authority["public"])))),
                ])
            cert_path, key_path = os.path.join(self.folder, "forged.pem"), os.path.join(self.folder, "forged-key.pem")
            with open(cert_path, "w") as fh:
                fh.write(insys.pem_encode("CERTIFICATE", forged))
            with open(key_path, "w") as fh:
                fh.write(insys.write_private_key(key, public))
            impostor = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            impostor.load_cert_chain(cert_path, key_path)
            target = {"a public name": "www.example.com", "a public address": "8.8.8.8",
                      "a public ending": "login.example.dev"}[label]
            with self.assertRaises(ssl.SSLCertVerificationError, msg=label) as caught:
                handshake(impostor, trusting(self.folder, strict=False), target)
            self.assertIn("permitted subtree", str(caught.exception), label)
        # InSys itself never puts such a name or address on its certificate.
        enc.issue_server(["localhost", "www.example.com", "pc.local"], ["8.8.8.8", "192.168.1.10", "203.0.113.5"])
        self.assertEqual(enc.names, ["localhost", "pc.local"])
        self.assertEqual(enc.covered, set(["192.168.1.10", "127.0.0.1", "::1"]))
        handshake(enc.context, browser, "192.168.1.10")

    def test_which_names_the_certificate_may_be_allowed_to_vouch_for(self):
        for name in ["desktop-7gh2k1l", "pc-01", "laptop7", "insys.office.example", "server.lan", "pc.home.arpa"]:
            self.assertTrue(insys.constraint_safe(name), name)
        # A one-word name made of letters only could be a public ending (.dev, .app, .shop ...).
        for name in ["dev", "app", "studio", "reception", "xn--p1ai", "", "bad_name", "-pc", "a..b", "pc 1"]:
            self.assertFalse(insys.constraint_safe(name), name)
        # A whole organisation's or country's names, and anything that reads as an address, are refused.
        for name in ["example.com", "co.uk", "acme.io", "192.168.1.20", "10.0.0.1", "12345", "host.123", "::1"]:
            self.assertFalse(insys.constraint_safe(name), name)
        allowed, names = insys.certificate_names("studio", set(["insys.office.example", "dev"]))
        self.assertEqual(allowed, ["insys.office.example"])
        self.assertIn("studio.local", names)
        self.assertNotIn("studio", names)
        self.assertNotIn("dev", names)
        enc = self.start(own="studio")
        self.assertNotIn("studio", enc.permitted()[0])
        handshake(enc.context, trusting(self.folder), "studio.local")
        # A computer whose name cannot be written in a certificate is still reachable by its address.
        allowed, names = insys.certificate_names("büro_pc", set())
        self.assertEqual((allowed, names), ([], ["localhost"]))

    def test_installing_once_is_enough(self):
        first = self.start()
        with open(os.path.join(self.folder, "InSys-certificate.crt"), "rb") as fh:
            installed = fh.read()
        browser = trusting(self.folder)
        self.assertTrue(first.created)
        # InSys is restarted: the same certificate is used, nothing is made anew.
        second = self.start()
        self.assertFalse(second.created)
        self.assertIsNone(second.replaced)
        self.assertEqual(second.authority_der, installed)
        with open(os.path.join(self.folder, "server.pem")) as fh:
            server_before = fh.read()
        handshake(second.context, browser, "192.168.1.10")
        # The network hands this computer a different address: it is added on the
        # spot, the device needs nothing new, and the old address keeps working.
        context = second.context_for("192.168.1.57")
        handshake(context, browser, "192.168.1.57")
        handshake(context, browser, "192.168.1.10")
        with open(os.path.join(self.folder, "server.pem")) as fh:
            self.assertNotEqual(fh.read(), server_before)
        # ...also across the next restart, when the computer has only the new address.
        third = self.start(addresses=("192.168.1.57", "127.0.0.1", "::1"))
        self.assertEqual(third.authority_der, installed)
        handshake(third.context, browser, "192.168.1.57")
        handshake(third.context, browser, "192.168.1.10")
        # An address that is not a private one is never added.
        self.assertIs(third.context_for("203.0.113.9"), third.context)
        self.assertNotIn("203.0.113.9", third.covered)
        with open(os.path.join(self.folder, "InSys-certificate.crt"), "rb") as fh:
            self.assertEqual(fh.read(), installed)

    def test_the_server_certificate_renews_itself(self):
        import datetime
        enc = self.start()
        browser = trusting(self.folder)
        original, installed = enc.SERVER_DAYS, enc.authority_der
        try:
            insys.Encryption.SERVER_DAYS = 20          # as if it were made long ago and is near its end
            enc.issue_server(enc.names, enc.addresses)
            self.assertLess(enc.server_until - insys.utc_now(), datetime.timedelta(days=insys.Encryption.RENEW_DAYS))
        finally:
            insys.Encryption.SERVER_DAYS = original
        context = enc.context_for("192.168.1.10")      # the next connection finds it due and renews it
        self.assertGreater(enc.server_until - insys.utc_now(), datetime.timedelta(days=300))
        handshake(context, browser, "192.168.1.10")
        try:
            insys.Encryption.SERVER_DAYS = 20
            enc.issue_server(enc.names, enc.addresses)
        finally:
            insys.Encryption.SERVER_DAYS = original
        again = self.start()                           # and so does a restart
        self.assertGreater(again.server_until - insys.utc_now(), datetime.timedelta(days=300))
        self.assertEqual(again.authority_der, installed)
        # Browsers refuse server certificates that last much more than a year.
        self.assertLessEqual(insys.Encryption.SERVER_DAYS, 398)

    def test_damaged_or_missing_files_are_replaced_and_reported(self):
        first = self.start()
        installed = first.authority_der
        # The server certificate alone is lost: a new one is made, devices notice nothing.
        os.remove(os.path.join(self.folder, "server.pem"))
        second = self.start()
        self.assertFalse(second.created)
        self.assertEqual(second.authority_der, installed)
        handshake(second.context, trusting(self.folder), "192.168.1.10")
        with open(os.path.join(self.folder, "server-key.pem"), "w") as fh:
            fh.write("nonsense")
        self.assertEqual(self.start().authority_der, installed)
        # The local certificate's key is damaged: InSys cannot keep using it, makes
        # a new one, says why, and keeps the old files aside.
        with open(os.path.join(self.folder, "local-certificate-key.pem"), "w") as fh:
            fh.write("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n")
        third = self.start()
        self.assertTrue(third.created)
        self.assertIn("damaged", third.replaced)
        self.assertNotEqual(third.authority_der, installed)
        self.assertTrue([n for n in os.listdir(self.folder) if n.startswith("replaced-") and n.endswith(".crt")])
        handshake(third.context, trusting(self.folder), "192.168.1.10")
        # A certificate file swapped for another one is noticed too.
        other = tempfile.mkdtemp(prefix="insys-enc-other-")
        self.addCleanup(shutil.rmtree, other, ignore_errors=True)
        stranger = insys.Encryption(other)
        stranger.start("OTHER", [], ["localhost"], ["127.0.0.1"])
        shutil.copy(os.path.join(other, "InSys-certificate.crt"), os.path.join(self.folder, "InSys-certificate.crt"))
        fourth = self.start()
        self.assertTrue(fourth.created)
        self.assertIn("does not belong", fourth.replaced)

    def test_a_passing_read_error_never_replaces_the_installed_certificate(self):
        import builtins
        first = self.start()
        installed = first.authority_der
        key_path = os.path.join(self.folder, "local-certificate-key.pem")
        failures = {"left": 0, "seen": 0}

        def flaky_open(path, *args, **kwargs):
            if path == key_path and failures["left"]:
                failures["left"] -= 1
                failures["seen"] += 1
                raise PermissionError(13, "The process cannot access the file because it is being used by another process")
            return builtins.open(path, *args, **kwargs)
        naps = []
        original_sleep = insys.time.sleep
        insys.open = flaky_open
        insys.time.sleep = naps.append
        try:
            # In use for a moment (a virus scanner, a backup program): InSys waits and carries on.
            failures["left"] = 3
            second = self.start()
            self.assertEqual((second.created, second.authority_der, failures["seen"]), (False, installed, 3))
            # In use for good: InSys stops and says so. It does not make a new certificate.
            failures["left"] = 1000
            with self.assertRaises(insys.EncryptionError) as caught:
                self.start()
            self.assertIn("could not be read", str(caught.exception))
            self.assertIn("Nothing has been changed", str(caught.exception))
        finally:
            del insys.open
            insys.time.sleep = original_sleep
        self.assertFalse([n for n in os.listdir(self.folder) if n.startswith("replaced-")])
        third = self.start()
        self.assertEqual((third.created, third.authority_der), (False, installed))

    def test_a_wrong_date_never_replaces_the_installed_certificate(self):
        import datetime
        first = self.start()
        installed = first.authority_der
        real_now = insys.utc_now
        insys.utc_now = lambda: real_now() + datetime.timedelta(days=365 * 11)
        try:
            with self.assertRaises(insys.EncryptionError) as caught:
                self.start()
        finally:
            insys.utc_now = real_now
        self.assertIn("--new-certificate", str(caught.exception))
        self.assertIn("date", str(caught.exception))
        self.assertFalse([n for n in os.listdir(self.folder) if n.startswith("replaced-")])
        self.assertEqual(self.start().authority_der, installed)

    def test_every_kind_of_damage_is_handled_without_a_crash(self):
        import random
        first = self.start()
        installed = first.authority_der
        key_path = os.path.join(self.folder, "local-certificate-key.pem")
        # A key file whose wrapping is intact but whose contents are not a key.
        for body in ["MAA=", "", "AAAA", "MAMCAQE=", "not base64 !!"]:
            with open(key_path, "w") as fh:
                fh.write("-----BEGIN EC PRIVATE KEY-----\n%s\n-----END EC PRIVATE KEY-----\n" % body)
            enc = self.start()
            self.assertTrue(enc.created, body)
            self.assertIn("damaged", enc.replaced, body)
            handshake(enc.context, trusting(self.folder), "192.168.1.10")
        # Only the key file is gone.
        os.remove(key_path)
        enc = self.start()
        self.assertEqual((enc.created, enc.replaced), (True, "its key file is missing"))
        # Random damage anywhere in any file: InSys either carries on or makes new files; it never crashes.
        rng = random.Random(20261126)
        names = ["InSys-certificate.crt", "local-certificate-key.pem", "server.pem", "server-key.pem"]
        for _ in range(60):
            name = rng.choice(names)
            with open(os.path.join(self.folder, name), "rb") as fh:
                data = bytearray(fh.read())
            for _ in range(rng.choice([1, 1, 2, 8])):
                data[rng.randrange(len(data))] ^= 1 << rng.randrange(8)
            if rng.random() < 0.2:
                data = data[:rng.randrange(len(data))]
            with open(os.path.join(self.folder, name), "wb") as fh:
                fh.write(bytes(data))
            enc = self.start()
            handshake(enc.context, trusting(self.folder), "192.168.1.10")
        self.assertNotEqual(self.start().authority_der, installed)
        # A server key whose private part is damaged while the copy of its public
        # part is intact - which OpenSSL alone would not notice until a device connects.
        enc = self.start()
        path = os.path.join(self.folder, "server-key.pem")
        with open(path) as fh:
            parts = insys.der_items(insys.der_items(insys.pem_decode("EC PRIVATE KEY", fh.read()))[0][1])
        private = bytearray(parts[1][1])
        private[7] ^= 0x10
        damaged = insys.der_seq(parts[0][2], insys.der(0x04, bytes(private)), parts[2][2], parts[3][2])
        with open(path, "w") as fh:
            fh.write(insys.pem_encode("EC PRIVATE KEY", damaged))
        with open(os.path.join(self.folder, "server.pem")) as fh:
            before = fh.read()
        healed = self.start()
        with open(os.path.join(self.folder, "server.pem")) as fh:
            self.assertNotEqual(fh.read(), before)
        self.assertEqual(healed.authority_der, enc.authority_der)
        handshake(healed.context, trusting(self.folder), "192.168.1.10")

    def test_a_failed_renewal_is_not_retried_on_every_connection(self):
        enc = self.start()
        attempts = []
        real_issue = enc.issue_server

        def failing(names, addresses):
            attempts.append(addresses[0])
            raise OSError(28, "No space left on device")
        saved_dir = insys.RT.data_dir
        insys.RT.data_dir = self.folder
        enc.issue_server = failing
        try:
            before = enc.context
            for _ in range(20):
                self.assertIs(enc.context_for("192.168.1.99"), before)    # carries on with what it has
            self.assertEqual(attempts, ["192.168.1.99"])
            with open(os.path.join(self.folder, "insys.log")) as fh:
                self.assertEqual(fh.read().count("could not be renewed"), 1)
            enc.retry_after = 0                                            # ten minutes later
            enc.issue_server = real_issue
            handshake(enc.context_for("192.168.1.99"), trusting(self.folder), "192.168.1.99")
        finally:
            insys.RT.data_dir = saved_dir

    def test_renewal_stops_when_the_local_certificate_itself_is_ending(self):
        original = insys.Encryption.AUTHORITY_DAYS
        insys.Encryption.AUTHORITY_DAYS = 20        # a local certificate with twenty days left
        try:
            enc = self.start()
        finally:
            insys.Encryption.AUTHORITY_DAYS = original
        # A new server certificate could last no longer than the present one, so none is made:
        self.assertEqual(enc.server_until, enc.authority["not_after"])
        self.assertFalse(enc.renewal_due())
        issued = []
        real_issue = enc.issue_server
        enc.issue_server = lambda names, addresses: issued.append(1) or real_issue(names, addresses)
        for _ in range(10):
            enc.context_for("192.168.1.10")
        self.assertEqual(issued, [])
        with open(os.path.join(self.folder, "server.pem")) as fh:
            before = fh.read()
        again = self.start()                        # nor at a restart
        with open(os.path.join(self.folder, "server.pem")) as fh:
            self.assertEqual(fh.read(), before)
        self.assertFalse(again.created)
        handshake(again.context, trusting(self.folder), "192.168.1.10")

    def test_this_computers_own_addresses_are_never_pushed_out(self):
        enc = self.start()
        for number in range(40):
            enc.context_for("10.20.30.%d" % number)
        self.assertLessEqual(len(enc.addresses), insys.Encryption.MAX_ADDRESSES)
        for address in ["192.168.1.10", "127.0.0.1", "::1", "10.20.30.39"]:
            self.assertIn(address, enc.covered, address)
        handshake(enc.context, trusting(self.folder), "192.168.1.10")
        self.assertEqual(enc.seen[:2], ["10.20.30.0", "10.20.30.1"])
        enc.context_for("127.0.0.1")
        self.assertNotIn("127.0.0.1", enc.seen)

    def test_names_given_on_purpose_are_declared(self):
        enc = self.start(extra=["tracker.office.example", "example.com", "192.168.1.20"])
        self.assertEqual(enc.other_names(), ["desktop-7gh2k1l", "tracker.office.example"])
        self.assertIn("tracker.office.example", enc.names)
        self.assertNotIn("example.com", enc.names)
        self.assertNotIn("192.168.1.20", enc.names)
        handshake(enc.context, trusting(self.folder), "tracker.office.example")

    def test_private_keys_stay_private(self):
        enc = self.start()
        if os.name == "posix":
            for name in ("local-certificate-key.pem", "server-key.pem"):
                self.assertEqual(os.stat(os.path.join(self.folder, name)).st_mode & 0o077, 0, name)
        with open(os.path.join(self.folder, "local-certificate-key.pem"), "rb") as fh:
            secret = insys.pem_decode("EC PRIVATE KEY", fh.read().decode("ascii"))
        key_bytes = enc.authority_key.to_bytes(32, "big")
        self.assertIn(key_bytes, secret)
        # The file a device installs holds no private key.
        with open(os.path.join(self.folder, "InSys-certificate.crt"), "rb") as fh:
            self.assertNotIn(key_bytes, fh.read())
        self.assertTrue(os.path.exists(os.path.join(self.folder, "READ-ME.txt")))

    def test_what_the_administrator_is_shown_matches_the_file(self):
        import hashlib
        enc = self.start()
        shown = insys.describe_certificate(enc.authority_der)
        self.assertTrue(shown["name"].startswith("InSys local certificate - DESKTOP-7GH2K1L - "), shown["name"])
        self.assertEqual(shown["sha256"].replace(":", "").lower(), hashlib.sha256(enc.authority_der).hexdigest())
        self.assertEqual(shown["sha1"].replace(":", "").lower(), hashlib.sha1(enc.authority_der).hexdigest())
        self.assertRegex(shown["valid_until"], r"^20\d\d-\d\d-\d\d$")
        self.assertGreater(int(shown["valid_until"][:4]), time.gmtime().tm_year + 8)

    @unittest.skipUnless(shutil.which("openssl"), "the openssl program is not installed")
    def test_certificates_pass_an_independent_check(self):
        import subprocess
        self.start()
        ca_pem = os.path.join(self.folder, "ca.pem")
        with open(os.path.join(self.folder, "InSys-certificate.crt"), "rb") as fh:
            with open(ca_pem, "w") as out:
                out.write(insys.pem_encode("CERTIFICATE", fh.read()))
        server = os.path.join(self.folder, "server.pem")

        def verify(*extra):
            return subprocess.run(["openssl", "verify", "-x509_strict", "-purpose", "sslserver", "-CAfile", ca_pem]
                                  + list(extra) + [server], capture_output=True, text=True)
        self.assertEqual(verify("-verify_ip", "192.168.1.10").returncode, 0)
        self.assertEqual(verify("-verify_hostname", "desktop-7gh2k1l.local").returncode, 0)
        self.assertNotEqual(verify("-verify_ip", "192.168.1.99").returncode, 0)
        text = subprocess.run(["openssl", "x509", "-in", ca_pem, "-noout", "-text"],
                              capture_output=True, text=True).stdout
        self.assertIn("CA:TRUE, pathlen:0", text)
        self.assertIn("Name Constraints: critical", text)
        self.assertIn("IP:192.168.0.0/255.255.0.0", text)
        self.assertNotIn("Excluded", text)
        key = subprocess.run(["openssl", "ec", "-in", os.path.join(self.folder, "server-key.pem"), "-noout", "-check"],
                             capture_output=True, text=True)
        self.assertEqual(key.returncode, 0, key.stderr)


class EncryptedNetworkTest(unittest.TestCase):
    """Choice 2: what crosses the network is encrypted, and nothing else is served."""

    @classmethod
    def setUpClass(cls):
        cls.saved = (insys.RT.data_dir, insys.RT.lan, insys.RT.online_requested, insys.RT.tunnel_active,
                     set(insys.RT.local_names), insys.RT.tls, insys.RT.lan_ips, insys.RT.port)
        insys.RT.data_dir = tempfile.mkdtemp(prefix="insys-tls-")
        insys.RT.online_requested = insys.RT.tunnel_active = False
        insys.RT.lan = True
        insys.RT.local_names = set(["insys-pc7"])
        password = insys.init_db()
        encryption = insys.Encryption(insys.encryption_folder())
        allowed, names = insys.certificate_names("insys-pc7", set())
        encryption.start("INSYS-PC7", allowed, names, ["192.168.1.10", "127.0.0.1", "::1"])
        insys.RT.tls = encryption
        insys.RT.lan_ips = ["192.168.1.10"]
        cls.server = insys.Server(("127.0.0.1", 0), insys.Handler)
        cls.port = insys.RT.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.secure = "https://127.0.0.1:%d" % cls.port
        cls.plain = "http://127.0.0.1:%d" % cls.port
        cls.trust = trusting(insys.encryption_folder())
        cls.admin = Client(cls.secure, context=cls.trust)
        assert cls.admin.login("admin", password)[0] == 200
        assert cls.admin.post("/api/change-password", {"current": password, "new": "Sealed-office-2026"})[0] == 200
        assert cls.admin.post("/api/records", {"module": "finance", "title": "Confidential fee proposal"})[0] == 200

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(insys.RT.data_dir, ignore_errors=True)
        (insys.RT.data_dir, insys.RT.lan, insys.RT.online_requested, insys.RT.tunnel_active,
         insys.RT.local_names, insys.RT.tls, insys.RT.lan_ips, insys.RT.port) = cls.saved

    def from_the_network(self):
        """Makes InSys see the test's connections as coming from another device
        on the network, not from this computer, until the test ends."""
        original = insys.is_loopback
        insys.is_loopback = lambda address: False
        self.addCleanup(setattr, insys, "is_loopback", original)

    def sessions(self):
        conn = sqlite3.connect(insys.RT.db_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        finally:
            conn.close()

    def test_a_trusting_device_works_normally_over_the_encrypted_address(self):
        self.from_the_network()
        client = Client(self.secure, context=self.trust)
        self.assertEqual(client.get("/api/ping")[0], 200)
        self.assertEqual(client.login("admin", "Sealed-office-2026")[0], 200)
        cookie = client.last_headers.get("Set-Cookie")
        self.assertTrue(cookie.startswith("__Host-insys_session="), cookie)
        for flag in ("Secure", "HttpOnly", "SameSite=Lax", "Path=/"):
            self.assertIn(flag, cookie)
        self.assertNotIn("Domain", cookie)
        status, state = client.get("/api/state")
        self.assertEqual(status, 200)
        self.assertIn("Confidential fee proposal", [r["title"] for r in state["records"]])
        self.assertEqual(client.post("/api/records", {"module": "project", "title": "Made over TLS"})[0], 200)
        for path in ["/", "/app.js", "/styles.css", "/connect", "/connect.js", "/InSys-certificate.crt"]:
            self.assertEqual(client.request("GET", path, raw=True)[0], 200, path)
        self.assertEqual(client.post("/api/logout")[0], 200)
        self.assertIn("Secure", client.last_headers.get("Set-Cookie"))
        self.assertEqual(client.get("/api/me")[0], 401)

    def test_nothing_is_served_to_the_network_without_encryption(self):
        self.from_the_network()
        client = Client(self.plain)
        before = self.sessions()
        # No data, and no way to sign in.
        for path in ["/api/ping", "/api/state", "/api/me", "/api/version", "/api/admin/backup", "/api/admin/system"]:
            status, data = client.get(path)
            self.assertEqual((status, data["code"]), (403, "encrypted_only"), path)
        status, data = client.post("/api/login", {"username": "admin", "password": "Sealed-office-2026"})
        self.assertEqual((status, data["code"]), (403, "encrypted_only"))
        self.assertIsNone(client.last_headers.get("Set-Cookie"))
        self.assertEqual(self.sessions(), before)
        self.assertEqual(client.put("/api/records/1", {"title": "x"})[0], 403)
        self.assertEqual(client.delete("/api/records/1")[0], 403)
        self.assertEqual(client.upload("/api/admin/restore", b"SQLite format 3\x00")[0], 403)
        # Every page address gives the set-up page, never the application.
        with open(os.path.join(insys.WEB_DIR, "connect.html"), "rb") as fh:
            connect_page = fh.read()
        for path in ["/", "/index.html", "/app.js", "/anything", "/connect"]:
            status, body = client.request("GET", path, raw=True)
            self.assertEqual((status, body), (200, connect_page), path)
            self.assertNotIn(b"Confidential", body)
        policy = client.last_headers.get("Content-Security-Policy")
        self.assertIn("connect-src 'self' https://127.0.0.1:%d;" % self.port, policy)
        self.assertIn("default-src 'none'", policy)
        self.assertIn("script-src 'self'", policy)
        # What the set-up page needs, and the certificate itself, are available.
        for path in ["/connect.js", "/styles.css", "/favicon.svg"]:
            self.assertEqual(client.request("GET", path, raw=True)[0], 200, path)
        status, certificate = client.request("GET", "/InSys-certificate.crt", raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(client.last_headers.get("Content-Type"), "application/x-x509-ca-cert")
        self.assertEqual(certificate, insys.RT.tls.authority_der)
        self.assertNotIn(insys.RT.tls.authority_key.to_bytes(32, "big"), certificate)

    def test_this_computer_itself_is_served_as_before(self):
        client = Client(self.plain)     # the host's own browser, on http://localhost
        self.assertEqual(client.login("admin", "Sealed-office-2026")[0], 200)
        cookie = client.last_headers.get("Set-Cookie")
        self.assertTrue(cookie.startswith("insys_session="), cookie)
        self.assertEqual(client.get("/api/state")[0], 200)
        status, body = client.request("GET", "/", raw=True)
        self.assertIn(b'<script src="/app.js">', body)

    def test_a_sign_in_only_works_on_the_kind_of_connection_it_was_made_on(self):
        over_tls = Client(self.secure, context=self.trust)
        self.assertEqual(over_tls.login("admin", "Sealed-office-2026")[0], 200)
        token = over_tls.cookie.split("=", 1)[1]
        local = Client(self.plain)
        self.assertEqual(local.login("admin", "Sealed-office-2026")[0], 200)
        local_token = local.cookie.split("=", 1)[1]
        # An encrypted sign-in presented on the unencrypted side, under either cookie name:
        for cookie in ("insys_session=" + token, "__Host-insys_session=" + token):
            probe = Client(self.plain)
            probe.cookie = cookie
            self.assertEqual(probe.get("/api/me")[0], 401, cookie)
        # and the other way round.
        for cookie in ("insys_session=" + local_token, "__Host-insys_session=" + local_token):
            probe = Client(self.secure, context=self.trust)
            probe.cookie = cookie
            self.assertEqual(probe.get("/api/me")[0], 401, cookie)
        self.assertEqual(over_tls.get("/api/me")[0], 200)
        self.assertEqual(local.get("/api/me")[0], 200)

    def test_sign_ins_from_before_encryption_no_longer_work(self):
        import hashlib
        import secrets
        # A sign-in exactly as InSys 1.2.5 and earlier stored it, when the network was not encrypted.
        token = secrets.token_urlsafe(32)
        conn = sqlite3.connect(insys.RT.db_path)
        conn.execute("INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen) VALUES (?,?,?,?,?)",
                     (hashlib.sha256(token.encode()).hexdigest(), 1, "c", time.time(), time.time()))
        conn.commit()
        conn.close()
        for base, context in ((self.secure, self.trust), (self.plain, None)):
            for cookie in ("insys_session=" + token, "__Host-insys_session=" + token):
                probe = Client(base, context=context)
                probe.cookie = cookie
                self.assertEqual(probe.get("/api/me")[0], 401, base + " " + cookie)

    def test_a_cookie_sent_without_encryption_ends_that_sign_in(self):
        local = Client(self.plain)
        self.assertEqual(local.login("admin", "Sealed-office-2026")[0], 200)
        self.assertEqual(local.get("/api/me")[0], 200)
        exposed = local.cookie
        self.from_the_network()
        leaky = Client(self.plain)
        leaky.cookie = exposed
        self.assertEqual(leaky.request("GET", "/", raw=True)[0], 200)   # (the set-up page)
        insys.is_loopback = lambda address: address == "127.0.0.1"
        self.assertEqual(local.get("/api/me")[0], 401)
        status, data = self.admin.get("/api/admin/audit")
        self.assertIn("session_exposed", [entry["event"] for entry in data["audit"]])

    def test_a_device_without_the_certificate_cannot_be_fooled_or_break_anything(self):
        import socket
        import ssl
        # A device that does not trust the certificate refuses the connection.
        stranger = Client(self.secure, context=ssl.create_default_context())
        with self.assertRaises(urllib.error.URLError) as caught:
            stranger.get("/api/ping")
        self.assertIn("CERTIFICATE_VERIFY_FAILED", str(caught.exception))
        # Half-open connections, rubbish and an abandoned handshake leave the server unharmed.
        for payload in (b"", b"\x16", b"\x16\x03\x01\x00\x05hello", b"\x00\x01\x02garbage\r\n\r\n", b"GET"):
            with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
                if payload:
                    sock.sendall(payload)
        self.assertEqual(Client(self.secure, context=self.trust).get("/api/ping")[0], 200)
        self.assertEqual(Client(self.plain).get("/api/ping")[0], 200)

    def test_what_is_on_the_wire_is_unreadable(self):
        """Carries a whole encrypted session through a relay that records every
        byte, as a sniffer on the network would see it."""
        import socket
        seen = []
        relay = socket.socket()
        relay.bind(("127.0.0.1", 0))
        relay.listen(8)
        relay_port = relay.getsockname()[1]
        stop = threading.Event()

        def pump(source, sink):
            try:
                while True:
                    data = source.recv(65536)
                    if not data:
                        break
                    seen.append(data)
                    sink.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    sink.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        def carry(inbound):
            outbound = socket.create_connection(("127.0.0.1", self.port))
            with inbound, outbound:
                back = threading.Thread(target=pump, args=(outbound, inbound), daemon=True)
                back.start()
                pump(inbound, outbound)
                back.join(10)

        def accept():
            relay.settimeout(0.2)
            while not stop.is_set():
                try:
                    inbound, _ = relay.accept()
                except OSError:
                    continue
                worker = threading.Thread(target=carry, args=(inbound,), daemon=True)
                workers.append(worker)
                worker.start()

        workers = []
        acceptor = threading.Thread(target=accept, daemon=True)
        acceptor.start()
        try:
            client = Client("https://127.0.0.1:%d" % relay_port, context=self.trust)
            self.assertEqual(client.login("admin", "Sealed-office-2026")[0], 200)
            token = client.cookie.split("=", 1)[1]
            title = "Tender price 4815162342 strictly private"
            self.assertEqual(client.post("/api/records", {"module": "finance", "title": title, "amount": "98765.43"})[0], 200)
            status, state = client.get("/api/state")
            self.assertIn(title, [r["title"] for r in state["records"]])
            self.assertEqual(client.request("GET", "/api/admin/backup", raw=True)[0], 200)
        finally:
            client.opener.close()
            stop.set()
            acceptor.join(5)
            relay.close()
            for worker in workers:
                worker.join(10)
        captured = b"".join(seen)
        self.assertGreater(len(captured), 20000)
        for secret in [b"Sealed-office-2026", b"admin", token.encode(), b"Tender price", b"4815162342", b"98765.43",
                       b"Confidential fee proposal", b"insys_session", b"/api/", b"HTTP/1.1", b"SQLite format 3",
                       client.csrf.encode()]:
            self.assertNotIn(secret, captured, secret)

    def test_the_administrator_sees_the_encryption_details(self):
        status, system = self.admin.get("/api/admin/system")
        self.assertEqual(status, 200)
        enc = system["encryption"]
        self.assertTrue(enc["on"])
        # Only addresses this computer has now, or that a device has actually used.
        self.assertEqual(enc["addresses"], ["https://192.168.1.10:%d" % self.port])
        self.assertEqual(enc["setup_addresses"], ["http://192.168.1.10:%d" % self.port])
        self.assertEqual(enc["also_covers"], [])
        self.assertEqual(enc["certificate"], insys.describe_certificate(insys.RT.tls.authority_der))
        self.assertEqual(enc["certificate_url"], "/InSys-certificate.crt")
        self.assertEqual(system["mode"], "lan")
        # Not for anyone else.
        status, data = self.admin.post("/api/admin/users", {"username": "eng1", "full_name": "Eng One", "role": "staff"})
        staff = Client(self.secure, context=self.trust)
        staff.login("eng1", data["temp_password"])
        staff.post("/api/change-password", {"current": data["temp_password"], "new": "Engineer-pass-77"})
        self.assertEqual(staff.get("/api/admin/system")[0], 403)

    def test_a_program_on_this_computer_cannot_pass_network_requests_on(self):
        insys._blocked_seen.clear()
        local = Client(self.plain)
        self.assertEqual(local.login("admin", "Sealed-office-2026")[0], 200)
        self.assertEqual(local.get("/api/state")[0], 200)
        # The same sign-in, but the request arrives by way of a proxy or forwarder
        # on this computer: whatever brought it there was not InSys's encryption.
        for headers in [{"X-Forwarded-For": "192.168.1.33"}, {"Via": "1.1 office-proxy"},
                        {"Forwarded": "for=192.168.1.33"}, {"X-Real-IP": "10.0.0.7"},
                        {"X-Forwarded-Proto": "https"}, {"X-Forwarded-Host": "192.168.1.10"}]:
            for path in ["/api/state", "/", "/api/ping"]:
                status, body = local.request("GET", path, headers=headers, raw=True)
                self.assertEqual(status, 403, (headers, path))
                self.assertEqual(body, insys.PASSED_ON_PAGE, (headers, path))
                self.assertNotIn(b"Confidential", body)
        status, data = self.admin.get("/api/admin/audit")
        self.assertIn("passed on by another program", " ".join(e["detail"] for e in data["audit"]))
        self.assertEqual(local.get("/api/state")[0], 200)      # the host's own browser is unaffected

    def test_the_certificate_is_public_only_on_the_office_network(self):
        # While InSys serves the office network any device may fetch it (it must, to connect).
        self.from_the_network()
        status, body = Client(self.plain).request("GET", "/InSys-certificate.crt", raw=True)
        self.assertEqual((status, body), (200, insys.RT.tls.authority_der))
        insys.is_loopback = lambda address: address == "127.0.0.1"
        # Android is handed a file to save, since it installs certificates from Settings.
        phone = Client(self.plain)
        status, body = phone.request("GET", "/InSys-certificate.crt", raw=True,
                                     headers={"User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0"})
        self.assertEqual((status, body), (200, insys.RT.tls.authority_der))
        self.assertEqual(phone.last_headers.get("Content-Type"), "application/octet-stream")
        self.assertEqual(phone.last_headers.get("Content-Disposition"), 'attachment; filename="InSys-certificate.crt"')
        # In choice 1, or online, it is for a signed-in administrator only: it names this computer.
        encryption, lan = insys.RT.tls, insys.RT.lan
        for online in (False, True):
            insys.RT.tls, insys.RT.lan, insys.RT.tunnel_active = (encryption if online else None), online, online
            try:
                self.assertEqual(Client(self.plain).request("GET", "/InSys-certificate.crt", raw=True)[0], 403)
                admin = Client(self.plain)
                self.assertEqual(admin.login("admin", "Sealed-office-2026")[0], 200)
                self.assertEqual(admin.request("GET", "/InSys-certificate.crt", raw=True),
                                 (200, encryption.authority_der))
                self.assertFalse(admin.get("/api/admin/system")[1]["encryption"]["on"])
            finally:
                insys.RT.tls, insys.RT.lan, insys.RT.tunnel_active = encryption, lan, False

    def test_a_bare_one_line_request_is_dropped_quietly(self):
        import socket
        log = os.path.join(insys.RT.data_dir, "insys.log")
        before = os.path.getsize(log) if os.path.exists(log) else 0
        for line in (b"GET /api/state\r\n\r\n", b"GET /\r\n", b"GET /api/ping\r\n\r\n"):
            with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
                sock.sendall(line)
                sock.settimeout(5)
                self.assertEqual(sock.recv(4096), b"")          # no answer, connection closed
        time.sleep(0.2)
        self.assertEqual(os.path.getsize(log) if os.path.exists(log) else 0, before)
        self.assertEqual(Client(self.plain).get("/api/ping")[0], 200)

    def test_keys_are_not_part_of_backups_or_transfers(self):
        status, backup = self.admin.request("GET", "/api/admin/backup", raw=True)
        self.assertEqual(status, 200)
        for name in ("local-certificate-key.pem", "server-key.pem"):
            with open(os.path.join(insys.encryption_folder(), name), "rb") as fh:
                secret = insys.pem_decode("EC PRIVATE KEY", fh.read().decode("ascii"))
            private = insys.der_items(insys.der_items(secret)[0][1])[1][1]
            self.assertEqual(len(private), 32)
            self.assertNotIn(private, backup, name)
        self.assertFalse(os.path.commonpath([insys.RT.backup_dir, insys.encryption_folder()])
                         == insys.encryption_folder())

    def test_many_devices_at_once(self):
        results = []

        def work(number):
            try:
                client = Client(self.secure, context=self.trust)
                ok = client.login("admin", "Sealed-office-2026")[0] == 200
                for _ in range(5):
                    ok = ok and client.get("/api/state")[0] == 200
                results.append(ok)
            except Exception as exc:      # pragma: no cover - reported below
                results.append(repr(exc))
        threads = [threading.Thread(target=work, args=(n,)) for n in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertEqual(results, [True] * 12)


EGRESS_PROBE = r"""
import json, sys
LOG, HOME = sys.argv[1], sys.argv[2]
WATCH = ("socket.connect", "socket.bind", "socket.sendto", "socket.sendmsg", "socket.getaddrinfo",
         "socket.gethostbyname", "socket.gethostbyaddr", "subprocess.Popen", "os.system", "os.exec",
         "os.posix_spawn", "os.startfile", "urllib.Request", "webbrowser.open", "ftplib.connect",
         "smtplib.connect", "http.client.connect")

def hook(event, args):
    if event not in WATCH:
        return
    detail = args[1:] if event in ("socket.connect", "socket.bind", "socket.sendto", "socket.sendmsg") else args
    with open(LOG, "a") as fh:
        fh.write(json.dumps([event, repr(detail)]) + "\n")

sys.addaudithook(hook)
sys.path.insert(0, HOME)
import insys
sys.exit(insys.main(sys.argv[3:]))
"""


class EgressTest(unittest.TestCase):
    """Runs the real program under Python's audit hooks, uses it, and inspects
    every network and process action it took."""

    def run_program(self, extra_args, leave_stale_lock=False):
        import signal
        import socket
        import subprocess
        work = tempfile.mkdtemp(prefix="insys-egress-")
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        data = os.path.join(work, "data")
        log = os.path.join(work, "audit.jsonl")
        probe = os.path.join(work, "probe.py")
        with open(probe, "w") as fh:
            fh.write(EGRESS_PROBE)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if leave_stale_lock:   # as if an earlier run had been cut off without tidying up
            os.makedirs(data)
            with open(os.path.join(data, "insys.lock"), "w") as fh:
                json.dump({"port": port, "instance": "gone", "pid": 1}, fh)
        home = os.path.dirname(os.path.abspath(insys.__file__))
        env = dict(os.environ)
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
            env.pop(name, None)
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        out = open(os.path.join(work, "console.txt"), "wb")
        self.addCleanup(out.close)
        proc = subprocess.Popen([sys.executable, probe, log, home, "--no-browser", "--no-menu", "--data-dir", data,
                                 "--port", str(port)] + extra_args, stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, env=env, creationflags=flags,
                                start_new_session=os.name != "nt")
        try:
            client = Client("http://127.0.0.1:%d" % port)
            for _ in range(200):
                try:
                    if client.get("/api/ping")[0] == 200:
                        break
                except (urllib.error.URLError, ConnectionError):
                    time.sleep(0.1)
            else:
                self.fail("the program did not start")
            # A realistic session: first sign-in, records, a subcontractor, a person, the log, a backup.
            with open(os.path.join(data, "ADMIN-FIRST-LOGIN.txt"), encoding="utf-8") as fh:
                password = re.search(r"Password:\s*(\S+)", fh.read()).group(1)
            self.assertEqual(client.login("admin", password)[0], 200)
            self.assertEqual(client.post("/api/change-password", {"current": password, "new": "Egress-check-2026"})[0], 200)
            rec = client.post("/api/records", {"module": "project", "title": "Egress check", "number": "E-1"})[1]["record"]
            client.post("/api/records/%d/actions" % rec["id"], {"version": 1, "text": "Did it", "date": "2026-11-26"})
            client.post("/api/records/%d/xrefs" % rec["id"], {"system": "CRM", "ref": "X-1", "url": "https://crm.example.com/x/1"})
            sub = client.post("/api/subcons", {"name": "Egress Subcon", "website": "www.example.org", "email": "a@example.org"})[1]["subcon"]
            client.post("/api/records/%d/subcons" % rec["id"], {"subcon_id": sub["id"]})
            client.post("/api/admin/users", {"username": "eve", "full_name": "Eve Engineer", "role": "staff"})
            client.post("/api/tasks", {"title": "A task", "assignee_id": 1})
            for path in ["/api/state", "/api/activity", "/api/events", "/api/log?month=all&kind=all", "/api/admin/system",
                         "/api/admin/audit", "/", "/app.js", "/styles.css"]:
                self.assertEqual(client.request("GET", path, raw=True)[0], 200, path)
            status, backup = client.request("GET", "/api/admin/backup", raw=True)
            self.assertEqual(status, 200)
            self.assertEqual(client.upload("/api/admin/restore", backup)[0], 200)
            if "--lan" in extra_args:
                # The same again the way another device does it: over the encrypted
                # address, trusting only the certificate InSys made at start-up.
                folder = os.path.join(data, "encryption")
                secure = Client("https://127.0.0.1:%d" % port, context=trusting(folder))
                self.assertEqual(secure.login("admin", "Egress-check-2026")[0], 200)
                self.assertEqual(secure.post("/api/records", {"module": "enquiry", "title": "Over TLS"})[0], 200)
                for path in ["/api/state", "/api/admin/system", "/InSys-certificate.crt", "/connect", "/"]:
                    self.assertEqual(secure.request("GET", path, raw=True)[0], 200, path)
                self.assertTrue(secure.get("/api/admin/system")[1]["encryption"]["on"])
        finally:
            if proc.poll() is None:
                if os.name == "nt":
                    proc.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    os.killpg(proc.pid, signal.SIGINT)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        with open(log) as fh:
            return port, [json.loads(line) for line in fh]

    def check_nothing_left_the_network(self, events, port, listen_on, allow_route_probe):
        binds = [detail for event, detail in events if event == "socket.bind"]
        self.assertEqual(binds, ["(('%s', %d),)" % (listen_on, port)], binds)
        for event, detail in events:
            if event == "socket.bind":
                continue
            if event == "socket.connect":
                address = re.search(r"\('([^']+)', (\d+)\)", detail)
                self.assertIsNotNone(address, detail)
                self.assertTrue(insys.is_local_address(address.group(1)), "connected to %s" % detail)
                if address.group(1) != "127.0.0.1":
                    # Only the route probe that reads this computer's own LAN address (no packet is sent).
                    self.assertTrue(allow_route_probe and address.group(1) == "10.255.255.255", detail)
                continue
            if event == "urllib.Request":
                self.assertIn("http://127.0.0.1:%d/api/ping" % port, detail)   # "is InSys already running here?"
                continue
            if event == "socket.getaddrinfo":
                # Only ever the numeric address of this computer, which needs no lookup.
                self.assertTrue(detail.startswith("('127.0.0.1', %d," % port), detail)
                continue
            if event == "http.client.connect":
                self.assertIn("'127.0.0.1', %d)" % port, detail)               # the same check, one layer down
                continue
            self.fail("unexpected %s %s" % (event, detail))

    def test_choice_1_makes_no_network_connection_of_any_kind(self):
        port, events = self.run_program([])
        self.check_nothing_left_the_network(events, port, "127.0.0.1", allow_route_probe=False)
        self.assertFalse([e for e in events if e[0] != "socket.bind"], events)   # it listened, and nothing else

    def test_choice_2_makes_no_network_connection_either(self):
        port, events = self.run_program(["--lan"])
        self.check_nothing_left_the_network(events, port, "0.0.0.0", allow_route_probe=True)
        names = set(e[0] for e in events)
        self.assertFalse(names & set(["socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr",
                                      "socket.sendto", "socket.sendmsg", "subprocess.Popen", "webbrowser.open"]), names)

    def test_checking_for_a_copy_already_running_stays_on_this_computer(self):
        port, events = self.run_program([], leave_stale_lock=True)
        self.check_nothing_left_the_network(events, port, "127.0.0.1", allow_route_probe=False)
        self.assertTrue([e for e in events if e[0] == "urllib.Request"])   # the check did happen


class ToolingTest(unittest.TestCase):
    def test_every_file_the_program_serves_is_packed_into_the_executable(self):
        build = os.path.join(os.path.dirname(os.path.abspath(insys.__file__)), "packaging", "build_exe.py")
        with open(build, encoding="utf-8") as fh:
            packed = re.search(r"APP_FILES = \[(.*?)\]", fh.read(), re.S).group(1)
        for filename, _ in insys.STATIC_FILES.values():
            self.assertIn('"web/%s"' % filename, packed, filename)
            self.assertTrue(os.path.isfile(os.path.join(insys.WEB_DIR, filename)), filename)

    def test_generated_passwords_meet_the_policy(self):
        for _ in range(200):
            password = insys.generate_password()
            insys.check_password_policy(password, "someone")
            self.assertRegex(password, r"^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$")
            self.assertFalse(set(password) & set("0O1lI"))

    def test_password_strength_cannot_be_turned_down_from_outside(self):
        import subprocess
        home = os.path.dirname(os.path.abspath(insys.__file__))
        env = dict(os.environ, INSYS_PBKDF2_ITERATIONS="1")   # the switch earlier versions honoured
        out = subprocess.run([sys.executable, "-c", "import insys; print(insys.PBKDF2_ITERATIONS, "
                              "insys.hash_password('x').split('$')[1])"], cwd=home, env=env,
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(out.stdout.split(), ["600000", "600000"], out.stderr)

    def test_password_hashing(self):
        stored = insys.hash_password("correct horse 1")
        self.assertTrue(insys.verify_password("correct horse 1", stored))
        self.assertFalse(insys.verify_password("correct horse 2", stored))
        self.assertFalse(insys.verify_password("x", "garbage"))
        self.assertNotEqual(stored, insys.hash_password("correct horse 1"))  # salted

    def test_tunnel_address_detection(self):
        match = insys.TUNNEL_URL_RE.search
        line = "2026-11-24T10:00:00Z INF |  https://calm-river-demo-site.trycloudflare.com   |"
        self.assertEqual(match(line).group(0), "https://calm-river-demo-site.trycloudflare.com")
        self.assertIsNone(match('failed: Post "https://api.trycloudflare.com/tunnel": EOF'))
        self.assertIsNone(match("https://example.com"))

    def test_default_run_is_not_reachable_from_other_computers(self):
        self.assertTrue(insys.is_loopback("127.0.0.1"))
        self.assertFalse(insys.is_loopback("192.168.1.20"))

    def test_start_menu_choices_and_memory(self):
        saved = insys.RT.data_dir
        insys.RT.data_dir = tempfile.mkdtemp(prefix="insys-menu-")
        try:
            answer = lambda key: (lambda valid, default, seconds: key)
            accept_default = lambda valid, default, seconds: default
            self.assertEqual(insys.start_menu(ask=accept_default), "local")   # nothing remembered yet
            self.assertEqual(insys.start_menu(ask=answer("3")), "online")
            self.assertEqual(insys.start_menu(ask=accept_default), "online")  # remembered
            self.assertEqual(insys.start_menu(ask=answer("4")), "reset")
            self.assertEqual(insys.start_menu(ask=accept_default), "online")  # a reset is not remembered
            self.assertEqual(insys.start_menu(ask=answer("2")), "lan")
            # Anything that is not a real choice falls back to the remembered one.
            for junk in ["", "9", "x", "12", None]:
                self.assertEqual(insys.start_menu(ask=answer(junk)), "lan", junk)
            with open(os.path.join(insys.RT.data_dir, "start-mode.txt"), "w") as fh:
                fh.write("nonsense")
            self.assertEqual(insys.start_menu(ask=accept_default), "local")
        finally:
            shutil.rmtree(insys.RT.data_dir, ignore_errors=True)
            insys.RT.data_dir = saved

    def test_temporary_folders_are_recognised(self):
        temp = tempfile.gettempdir()
        self.assertTrue(insys.inside_temp_folder(temp))
        self.assertTrue(insys.inside_temp_folder(os.path.join(temp, "Temp1_InSys.zip")))
        self.assertFalse(insys.inside_temp_folder(os.path.dirname(os.path.abspath(insys.__file__))))
        self.assertFalse(insys.inside_temp_folder(temp.rstrip("\\/") + "-not-really-temp"))

    def test_data_folder_when_run_from_source(self):
        self.assertFalse(insys.PACKAGED)
        self.assertEqual(insys.default_data_dir(), os.path.join(insys.APP_DIR, "data"))
        self.assertEqual(insys.WEB_DIR, os.path.join(insys.APP_DIR, "web"))


if __name__ == "__main__":
    unittest.main()
