# InSys — Internal Systems

A work tracker for a small team, built for a free pilot on one Windows computer
with optional access from anywhere over the internet.

- **Projects, Enquiries and Expressions of Interest** as separate tabs. Every
  item shows its current status, the **last known action** and the **next
  action with its due date**. Overdue actions are flagged everywhere.
- **Subcontractor directory**: keep every subcontractor's details in one place,
  put one or several on any project, enquiry or expression of interest, and see
  who is working on what, most urgent action first.
- **Activity log**: everything that has been done, catalogued by month and
  searchable, including work on items that have since been completed or deleted.
- **Finance** and **Office Admin** sections, kept away from the technical teams.
- **Overview** of current status across every section, with pilot KPIs.
- **Cross-references**: link any record to any other (an enquiry to the project
  it became, a project to its invoices), and record the reference an item has
  in your other systems (CRM, accounting, tender portal, shared drive).
- **A login for each person**, with their own tasks under *My Work*.
- **An administrator login** with the overall view, team workload, people
  management, a security log and backups.
- Changes made by one person appear on everyone else's screen within about
  five seconds — no refreshing.

It is one Python file plus a small web page, with no database server and no
subscription. There are two ways to run it:

- **`InSys.exe`** — a single program with everything inside it. Nothing to
  install, nothing to download, works with no internet connection.
- **From the source folder** with `Start-InSys.bat`, which needs Python on the
  computer.

Both use the same data format, so you can switch between them.

## InSys.exe — one file, works offline

1. Put `InSys.exe` in a permanent folder of its own, for example `C:\InSys`.
   (Not inside a ZIP file and not in a temporary folder — InSys refuses to
   create its database there, because Windows would later delete it.)
2. Double-click it. The first start takes a few seconds longer while it unpacks
   its own private copy of Python; later starts are quick.
3. Choose how to run it:

   | Choice | Who can use it | Internet needed |
   |---|---|---|
   | **1** This computer only | You, on this computer | No |
   | **2** This computer and the office network | Anyone on the same office network or Wi-Fi, at the `http://…` address shown | No |
   | **3** Online | Anyone, anywhere, at the `https://…` address shown | Yes |
   | **4** Reset the administrator password | — | No |

   InSys remembers your last choice: next time just press Enter, or wait 15
   seconds and it starts by itself.
4. Your browser opens the sign-in page. Keep the InSys window open — closing it
   stops InSys.

Your data is stored in a folder called **`InSys-data`** next to `InSys.exe`. To
move InSys to another computer, copy `InSys.exe` and `InSys-data` together.

Things to know:

- **Windows may warn about an unknown publisher** ("Windows protected your PC")
  the first time, because the program is not code-signed. Click **More info** →
  **Run anyway**. Some antivirus products are suspicious of any unsigned program
  that unpacks files; if yours blocks InSys, allow `InSys.exe`.
- **Choice 2** uses plain (unencrypted) HTTP inside your office network, and
  Windows will ask once whether to allow InSys through the firewall — choose
  **Allow** for private networks. Use it on a network you trust.
- **Choice 3** downloads Cloudflare's tunnel tool the first time (about 60 MB),
  so it needs the internet. If there is no connection, InSys says so and keeps
  working on the computer itself. See *Online access* below.
- With choice 2 or 3, InSys asks Windows not to go to sleep by itself while it
  is running, since other people depend on it. Closing the lid or pressing the
  power button still sleeps the computer.
- Needs 64-bit Windows 10 or 11.
- The private copy of Python is unpacked to
  `%LocalAppData%\InSys\runtime`. It can be deleted at any time while InSys is
  not running; InSys recreates it.

The first-sign-in, team, tracking, backup and security sections below apply to
both ways of running InSys. Where they mention `Start-InSys-Online.bat` or
`Reset-Admin-Password.bat`, the `InSys.exe` equivalents are choices 3 and 4,
and the `data` folder is `InSys-data`.

## Starting InSys from the source folder

1. Copy the whole `insys` folder to the computer that will host it, for example
   `C:\InSys`. (If it arrived as a ZIP file, right-click the ZIP → **Properties**
   → tick **Unblock** → OK, then **Extract All**.)
2. Double-click **`Start-InSys.bat`**.
   - If Python is not on the computer, the launcher offers to install it for
     you (it uses Windows' own `winget` installer). Say **Y** and wait a minute.
   - If Windows shows "Windows protected your PC", click **More info** →
     **Run anyway**. This appears because the file came from the internet.
3. A black window opens and your browser shows the InSys sign-in page at
   `http://localhost:8080`. **Keep the black window open** — closing it stops
   InSys.

### First sign-in (administrator)

The first time InSys starts it creates the administrator account and shows the
sign-in details in the black window:

```
Username: admin
Password: (a random password, different for every installation)
```

The same details are saved in `data\ADMIN-FIRST-LOGIN.txt`. Sign in, and InSys
asks you to choose your own password straight away. The file is then deleted
automatically. The password is generated on your computer rather than being a
fixed default, so nobody who has seen this software knows it.

Forgot the administrator password? Double-click **`Reset-Admin-Password.bat`** on
the host computer.

### Adding your team

Sign in as the administrator → **Admin** → **People & logins** → **+ Add person**.
InSys shows a temporary password once; pass it on privately. Each person chooses
their own password at first sign-in.

| Role | Can open |
|---|---|
| Engineering | Overview, My Work, Tasks, Activity log, Projects, Enquiries, Expressions of Interest, Subcontractors. **No Finance or Office Admin.** |
| Finance | Everything Engineering can, plus **Finance** |
| Office Administrator | Everything Engineering can, plus **Office Admin** |
| Administration | Every section, including **Finance** and **Office Admin**. No Admin area. |
| Administrator | Everything, plus the **Admin** area (logins, backups, database transfer) |

Choose the role when you add a person; it can be changed later with **Edit**.
This is what keeps financial information away from the technical teams: an
Engineering login cannot see Finance or Office Admin records at all — not in
lists, searches, the activity log or exports. If one is linked to a project,
they see only its reference number marked "Restricted". The separation is
enforced on the server, not just hidden on the page.

(Engineering is the role that versions 1.0 and 1.1 called "Staff". Existing
Staff logins become Engineering automatically, with exactly the access they had.
Value fields on projects, enquiries and expressions of interest are part of
those records and remain visible to Engineering.)

## Online access (use it from anywhere)

Choose **3** in `InSys.exe`, or double-click **`Start-InSys-Online.bat`** instead
of `Start-InSys.bat`.

InSys starts as normal and also opens a secure (HTTPS) connection through
Cloudflare's free tunnel service. After a few seconds the black window shows an
address like:

```
https://some-random-words.trycloudflare.com
```

Anyone on your team can open that address on any device, anywhere, and sign in.
The address is also shown inside InSys under **Admin → System & online access**.

The first time, InSys downloads Cloudflare's `cloudflared` tool (about 60 MB,
from Cloudflare's official GitHub releases) into the `tools` folder. Nothing is
installed system-wide and no Cloudflare account is needed.

Things to know for the pilot:

- **The host computer must stay on, awake and connected.** Set Windows to never
  sleep while plugged in (Settings → System → Power).
- **The address changes every time InSys is restarted.** Send the new one to the
  team after a restart. This is how Cloudflare's free, account-less tunnels work.
- Cloudflare offers these account-less tunnels for testing, without an uptime
  guarantee. That suits a pilot. For a permanent deployment with a fixed address,
  move to a named Cloudflare Tunnel on your own domain, or host InSys on a small
  server — the application itself does not change.
- Your data stays on the host computer. The tunnel only carries the encrypted
  traffic between your team's browsers and that computer.

Without online access (or the office-network choice), InSys accepts connections
from the host computer only.

## How tracking works

- **Log action** (on any record) is the everyday button: say what was done and
  when, update the status if it changed, and set what happens next and by when.
  It becomes the record's *last known action*, and every entry is kept in the
  record's history with who did it.
- **Edit** changes the details (title, owner, dates, value). Changes are listed
  in the history as "Status: New → In Review" and so on.
- **Next action due** dates drive the red "Overdue" flags, the counts in the
  sidebar, the *Overdue next actions* list on the Overview, and the KPIs.
- **Subcontractors** live in a directory of their own (the *Subcontractors*
  page). On a project, enquiry or expression of interest, **Add subcontractor**
  opens a searchable list: type part of a name, discipline or contact and click
  to add. Several can be on the same item in parallel, each with a note of
  their scope. The Projects, Enquiries and Expressions of Interest lists
  have a **Subcons** column naming everyone on each item; click a name to open
  that subcontractor, or the column heading to sort by it. A subcontractor not yet in the directory can be added from the
  same pop-up. The directory shows, for each subcontractor, the open work they
  are on across all three sections and their most urgent action; *Work by
  priority* lists every subcontractor's open work in one list, soonest next
  action first (overdue first; on the same date, higher priority first; items
  with no next-action date last). Marking a subcontractor *Inactive* keeps
  their history but stops them being added to new work.
- **Each subcontractor on an item is tracked separately.** *Update* next to a
  subcontractor records the last known update from them and the next follow-up
  with its expected date — independent of the item's own last and next action,
  and of the other subcontractors on it. Their follow-up date is what the
  directory and *Work by priority* use for that subcontractor; an overdue one
  is flagged in the Subcons column.
- **Find by capability** (a tab on the Subcontractors page) answers "who can do
  this scope?". Give each subcontractor their disciplines and a list of
  capabilities and specialised studies, then type what a scope needs —
  `structural, seismic assessment, geotechnical investigation` — and InSys
  lists who covers which requirement, best match first, and points out any
  requirement nobody covers. Tick the ones to approach and add them all to the
  enquiry in one step, or start an email to them.
- **Activity log** (in the sidebar) is the long-term record. Every logged
  action is filed under the month it was done; pick a month from the catalogue
  on the left, or search across all months by what was done, a reference, a
  title or a person. Switch between *Actions done*, *Tasks* and *All
  activity*, and between open, completed/closed and deleted items.
- **Deleting does not destroy.** A deleted project, enquiry, EOI, finance or
  office item disappears from every list, but it and its whole history stay
  in the Activity log under *Deleted items*, where an administrator can
  **Restore** it. Deleted and completed tasks stay on record there too.
  (Items deleted in version 1.0 or 1.1, before this existed, were removed
  outright and cannot be recovered.)
- **Tasks** are jobs for a named person, optionally attached to a record. Each
  person sees theirs under **My Work**; only the assignee, the creator or an
  administrator can change a task.
- **Cross-references** on each record: *Link a record*, *Create linked…* (for
  example turn an enquiry into a project, carrying the details across) and *Add
  external ref* for references in other systems. The search box at the top finds
  records by any of these references.
- Every record has a permanent reference (`PRJ-0001`, `ENQ-0001`, `EOI-0001`,
  `FIN-0001`, `OFF-0001`) and a direct web address you can paste into an email.
- **Export CSV** on each section downloads the rows currently shown, for Excel.
- If two people edit the same record at once, the second save is refused with a
  message rather than silently overwriting the first.

## Upgrading to a new version

Your work is kept. To upgrade:

1. Close InSys (close its window).
2. Replace the old `InSys.exe` with the new one **in the same folder**, so it
   sits next to your existing `InSys-data` folder. (Rename the old one first,
   for example to `InSys-old.exe`, if you would like to keep it.) (Running from the source
   folder instead: replace `insys.py` and the `web` folder, keep `data`.)
3. Start it as usual.

This works from any earlier version, including straight from 1.0.0. On the
first start, the new version makes a copy of your data exactly as the
old version left it — `backups\before-upgrade-from-v1-(date).db` inside the data
folder — and only then adds what it needs (upgrades only ever add tables and
columns; nothing existing is changed or removed). Existing records, history, links,
tasks, people and passwords are not altered. The window tells you this has
happened, and it is noted in Admin → Security log. These copies are never
deleted automatically.

To go back to how things were before an upgrade: close InSys, replace
`insys.db` in the data folder with that copy (renamed to `insys.db`), and start
the older `InSys.exe`.

If you use the office-network choice, Windows may ask again whether to allow
"Python" through the firewall after an upgrade — choose Allow.

| Version | What changed |
|---|---|
| 1.2.0 | Activity log by month with completed and deleted items; deleted items kept and restorable; per-subcontractor last update and next follow-up; capability search; Administration and Engineering roles; database transfer between systems; optional Samaritan look. |
| 1.1.1 | A Subcons column in the Projects, Enquiries and Expressions of Interest lists. No change to stored data. |
| 1.1.0 | Subcontractor directory; subcontractors on projects, enquiries and expressions of interest. |
| 1.0.0 | First version. |

## Your data and backups

Everything is stored in the `data` folder next to `insys.py`:

| File | What it is |
|---|---|
| `insys.db` | The database (SQLite). All records, tasks, people and history. |
| `backups\` | Automatic daily backups (the latest 20 are kept) and the copies made before each upgrade (kept for good). |
| `insys.log` | Error log, if anything goes wrong. |
| `tunnel.log` | Output of the online-access tool. |

- **Download a backup** at any time from **Admin → System & online access**.
- **Transfer to another system** (administrators only, same page): *Download
  database* gives one file holding everything — records, history,
  subcontractors and logins. Copy it to the other computer, start InSys there,
  sign in as its administrator and use *Load a database file*. That InSys then
  hosts the same data on its own network. Before loading, it saves a copy of
  whatever it held (`backups\before-loading-transfer-…`). Afterwards everyone
  signs in with the usernames and passwords from the system the file came from.
  A file from an older version of InSys is upgraded as it is loaded; a file
  from a newer version is refused. The two systems are then independent:
  loading replaces, it does not merge, and later changes are not synchronised.
- To restore: stop InSys, replace `data\insys.db` with a backup file (renamed to
  `insys.db`), start InSys again.
- To move InSys to another computer: stop it, copy the whole folder.
- Automatic backups sit on the same disk as the database. For protection against
  disk failure or theft, copy a downloaded backup somewhere else regularly.

## Security, in plain terms

- Passwords are never stored; only a salted, deliberately slow hash is
  (PBKDF2-HMAC-SHA256, 600,000 rounds). Minimum 10 characters, with a letter and
  a number.
- Repeated wrong passwords are throttled (8 attempts per person per 15 minutes).
- Sign-in sessions expire after 12 hours of inactivity and after 7 days at most.
  Deactivating a person or resetting their password signs them out immediately.
- Section access is enforced on the server, not just hidden in the page.
- Online traffic is encrypted (HTTPS) by the tunnel. On the host computer itself
  InSys listens only on `localhost`.
- Sign-ins, failed sign-ins, password resets, deletions and backup downloads are
  recorded under **Admin → Security log**.

This is appropriate for a pilot with ordinary business information. Before
putting highly sensitive data in it or scaling beyond a pilot, have the
deployment reviewed and plan for a fixed address and off-site backups.

## The Samaritan look

InSys has a second appearance: stark white, black monospace type and a single
red mark. Switch with **Theme** at the bottom of the sidebar, by clicking the
InSys logo five times, or by typing `samaritan` in the search box and pressing
Enter. The same actions switch back to the standard look. It is remembered per
browser and affects only the person who chose it.

## Troubleshooting

| Problem | What to do |
|---|---|
| The black window closes immediately | Open `data\insys.log` if it exists. Make sure the whole folder was extracted, not run from inside the ZIP. |
| "Python was installed but this window cannot see it yet" | Close the window and double-click `Start-InSys.bat` again. |
| Browser says the site can't be reached | InSys is not running. Start it and keep the black window open. |
| "InSys is already running" | It is — the launcher opens it for you. To restart, close the other black window first. |
| Port 8080 is in use | InSys automatically uses the next free port; the address in the black window is always the right one. |
| Online address stopped working | The host computer slept, lost its connection, or InSys was restarted. Check the black window for the current address. |
| Online access could not be set up | Check the internet connection. Some office networks block tunnels; `data\tunnel.log` has the detail. |
| Someone is locked out | Admin → People & logins → **Reset password**. |

## For the technically minded

```
python insys.py [--online] [--lan] [--port N] [--data-dir PATH] [--no-browser]
python insys.py --reset-admin [--user NAME]
```

`InSys.exe` accepts the same options (for example `InSys.exe --online` in a
shortcut skips the menu; `--no-menu` skips it and runs for this computer only).

### Building InSys.exe

```
python packaging/build_exe.py
```

This needs Python 3.9+ and [Go](https://go.dev/dl/) 1.21+ and works on Windows,
macOS or Linux; the result is `dist/InSys.exe`. The build downloads the official
Python runtime for Windows from nuget.org once and checks it against a pinned
SHA-256. `InSys.exe` is a small launcher (`packaging/launcher/main.go`) with
that runtime, `insys.py` and the `web` folder embedded in it. The runtime is
unmodified and runs in isolated mode, so a Python already installed on the
computer is neither used nor affected.

`python packaging/smoke_test.py dist/InSys.exe` starts a built program, signs
in, stores a record and stops it again. The GitHub workflow
`.github/workflows/insys-windows.yml` runs the server tests, the build and that
smoke test on a Windows machine and keeps the resulting `InSys.exe` as a
downloadable artifact.

- Requires Python 3.9 or newer; standard library only. Runs the same way on
  macOS and Linux (`python3 insys.py`). On macOS, install `cloudflared` yourself
  (`brew install cloudflared`) to use `--online`.
- `--lan` (choice 2 in `InSys.exe`) also accepts connections from other
  computers on the local network (plain HTTP — prefer `--online` outside a
  trusted office network; Windows will ask for firewall permission).
- If `cloudflared` is already installed and on the PATH, InSys uses it instead of
  downloading its own copy.
- Tests: `python -m unittest discover -s tests -v` from this folder.
- Scale: designed for a team-sized pilot (tens of people, a few thousand
  records). Each browser holds the full visible data set and checks for changes
  every five seconds.

### Files

| File | Purpose |
|---|---|
| `insys.py` | The server: sign-in, permissions, storage, backups, online access. |
| `web/` | The page that runs in the browser (`index.html`, `app.js`, `styles.css`). |
| `Start-InSys.bat` | Windows launcher (this computer only). |
| `Start-InSys-Online.bat` | Windows launcher with internet access. |
| `Reset-Admin-Password.bat` | Administrator password recovery. |
| `tests/` | Automated tests for the server. |
| `packaging/build_exe.py` | Builds `InSys.exe`. |
| `packaging/launcher/` | The launcher that `InSys.exe` is made from. |
| `packaging/smoke_test.py` | Starts a built `InSys.exe` and checks it works. |
