"""End-to-end tests for the InSys server. Standard library only.

Run from the insys folder:   python -m unittest discover -s tests -v
"""

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

os.environ["INSYS_PBKDF2_ITERATIONS"] = "1000"  # keep the tests fast
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import insys  # noqa: E402


class Client:
    """A minimal browser stand-in: keeps the session cookie and CSRF token."""

    def __init__(self, base):
        self.base = base
        self.cookie = None
        self.csrf = ""
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

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
        import hashlib
        conn.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?",
                     (time.time() - insys.SESSION_IDLE_SECONDS - 5,
                      hashlib.sha256(token.encode()).hexdigest()))
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


class ToolingTest(unittest.TestCase):
    def test_generated_passwords_meet_the_policy(self):
        for _ in range(200):
            password = insys.generate_password()
            insys.check_password_policy(password, "someone")
            self.assertRegex(password, r"^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$")
            self.assertFalse(set(password) & set("0O1lI"))

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
