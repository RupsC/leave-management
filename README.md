# Employee Leave Management System

A small web app for a company's leave process: employees apply for leave (with an optional
supporting document), managers approve or reject with a comment, and HR/admin can see
everything. Balances are tracked per leave type, overlapping leave is flagged, and every
action is written to an audit log that the app cannot edit or delete.

Everything runs on one computer. No internet account, paid service or cloud setup is needed.

## How leave is counted

- Only working days are counted: Saturday and Sunday are skipped.
- A half day counts as **0.5** day and is only allowed on a single date.
- A range where the end date is before the start date is refused.
- A request that needs more days than the remaining balance is refused.
- Days are taken from the balance only when a request is approved, and put back when an
  approved request is cancelled.

## Run it on a Windows PC (step by step)

1. **Install Node.js.** Go to <https://nodejs.org>, download the **LTS** version for Windows
   and run the installer. Accept all the defaults.
2. **Download the project.** On the GitHub page of this repository click the green
   **Code** button, then **Download ZIP**. Right-click the downloaded ZIP and choose
   **Extract All…**, then note the folder it was extracted to (for example
   `C:\Users\You\Downloads\leave-management-main`).
3. **Open a terminal in that folder.** Open the extracted folder in File Explorer, click the
   address bar at the top, type `cmd` and press Enter.
4. **Install the packages.** Type `npm install` and press Enter. Wait until it finishes
   (one or two minutes).
5. **Create the demo data.** Type `npm run seed` and press Enter.
6. **Start the app.** Type `npm start` and press Enter. Leave that window open.
7. **Open the app.** In your browser go to <http://localhost:3000> and sign in with one of
   the demo accounts below.

To stop the app press `Ctrl` + `C` in the terminal window. Starting it again later only needs
`npm start`. If you want to start over with fresh demo data use `npm run seed:reset`.

## Demo logins

Every demo account uses the password **`Password@123`**.

| Role | E-mail | Who |
| --- | --- | --- |
| Admin | `anita.admin@example.test` | Anita Deshmukh, People Operations |
| Manager | `rajesh.manager@example.test` | Rajesh Kulkarni, Engineering |
| Manager | `sonal.manager@example.test` | Sonal Verma, Finance |
| Employee | `priya.employee@example.test` | Priya Nair, Engineering |
| Employee | `arjun.employee@example.test` | Arjun Mehta, Engineering |
| Employee | `meera.employee@example.test` | Meera Joshi, Engineering |
| Employee | `sameer.employee@example.test` | Sameer Khan, Engineering |
| Employee | `farah.employee@example.test` | Farah Sheikh, Finance |

These are made-up demo accounts and must never be used in a real deployment.

## Settings

Copy `.env.example` to `.env` and change the values if you need to. The file is ignored by
Git, so it never ends up in the repository. `.env.example` contains placeholders only — no
real passwords or keys.

## API endpoints

All endpoints return JSON and live under `/api`.

**Sign-in and account**
- `POST /auth/signin` — sign in
- `POST /auth/signup` — create an employee account (never an admin)
- `POST /auth/signout` — sign out
- `GET /auth/me` — who am I
- `POST /auth/password` — change own password

**Leave requests**
- `GET /leave-requests` — list requests visible to me
- `GET /leave-requests/:id` — one request
- `POST /leave-requests` — apply for leave (optional document)
- `GET /leave-requests/:id/attachments` — list documents
- `GET /leave-requests/:id/attachment` — download the document (owner, their manager or admin only)
- `POST /leave-requests/:id/decision` — approve or reject (comment required to reject)
- `POST /leave-requests/:id/cancel` — cancel a request
- `POST /leave-requests/:id/reverse` — admin only: reverse a decision

**Balances, calendar and dashboard**
- `GET /balances` — balances for me, or my team when I am a manager
- `GET /leave-types` — leave types
- `GET /calendar` — approved leave for a month (`?month=YYYY-MM`)
- `GET /overlaps` — overlap check for a candidate range
- `GET /dashboard` — balances, pending items and recent history

**Notifications**
- `GET /notifications` — my notifications
- `GET /notifications/unread-count` — unread badge count
- `POST /notifications/:id/read` — mark one read
- `POST /notifications/read-all` — mark all read

**Admin**
- `GET /users` — all users
- `POST /users` — add a user
- `PATCH /users/:id` — change a user's role, manager or status
- `GET /audit-logs` — audit trail, filterable (read-only, no edit or delete endpoint)

## Security notes

- Passwords are stored as salted scrypt hashes, never in plain text.
- Repeated failed sign-ins lock an account for a while.
- Uploaded documents are limited to PDF, PNG and JPEG by type and size, stored outside the
  public folder and served only through a checked endpoint, so they can never be executed or
  opened by guessing a path.
- The audit log is append-only from the app's point of view.

## Tests

`npm test` runs the automated suite that exercises the API (sign-in, roles, leave counting,
balances, approvals, validation, documents, audit log).

## Project layout

- `server/` — the API: routes, database schema (`db.js`), sign-in and roles, seed data
- `public/` — the browser app (HTML, CSS, JavaScript)
- `tests/` — the automated test suite
- `data/` — created on first start: the SQLite database and uploaded documents (ignored by Git)
