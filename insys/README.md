# InSys — Internal Systems

A work tracker for a small team, built for a free pilot on one Windows computer
with optional access from anywhere over the internet.

- **Projects, Enquiries and Expressions of Interest** as separate tabs. Every
  item shows its current status, the **last known action** and the **next
  action with its due date**. Overdue actions are flagged everywhere.
- **Finance** and **Office Admin** sections, private to those teams.
- **Overview** of current status across every section, with pilot KPIs.
- **Cross-references**: link any record to any other (an enquiry to the project
  it became, a project to its invoices), and record the reference an item has
  in your other systems (CRM, accounting, tender portal, shared drive).
- **A login for each person**, with their own tasks under *My Work*.
- **An administrator login** with the overall view, team workload, people
  management, a security log and backups.
- Changes made by one person appear on everyone else's screen within about
  five seconds — no refreshing.

It is one Python file plus a small web page. There is nothing to install besides
Python itself, no database server, and no subscription.

## Starting InSys on Windows

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
| Staff | Overview, My Work, Tasks, Projects, Enquiries, Expressions of Interest |
| Finance | Everything Staff can, plus **Finance** |
| Office Administrator | Everything Staff can, plus **Office Admin** |
| Administrator | Everything, plus **Admin** |

People outside the Finance or Office Admin team cannot see those records at
all. If one of them is linked to a project, they see only its reference number
marked "Restricted".

## Online access (use it from anywhere)

Double-click **`Start-InSys-Online.bat`** instead of `Start-InSys.bat`.

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

Without `--online`, InSys accepts connections from the host computer only.

## How tracking works

- **Log action** (on any record) is the everyday button: say what was done and
  when, update the status if it changed, and set what happens next and by when.
  It becomes the record's *last known action*, and every entry is kept in the
  record's history with who did it.
- **Edit** changes the details (title, owner, dates, value). Changes are listed
  in the history as "Status: New → In Review" and so on.
- **Next action due** dates drive the red "Overdue" flags, the counts in the
  sidebar, the *Overdue next actions* list on the Overview, and the KPIs.
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

## Your data and backups

Everything is stored in the `data` folder next to `insys.py`:

| File | What it is |
|---|---|
| `insys.db` | The database (SQLite). All records, tasks, people and history. |
| `backups\` | Automatic daily backups; the latest 20 are kept. |
| `insys.log` | Error log, if anything goes wrong. |
| `tunnel.log` | Output of the online-access tool. |

- **Download a backup** at any time from **Admin → System & online access**.
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

- Requires Python 3.9 or newer; standard library only. Runs the same way on
  macOS and Linux (`python3 insys.py`). On macOS, install `cloudflared` yourself
  (`brew install cloudflared`) to use `--online`.
- `--lan` also accepts connections from other computers on the local network
  (plain HTTP — prefer `--online` outside a trusted office network; Windows will
  ask for firewall permission).
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
