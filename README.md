# Ledger Engine — Double-Entry Bookkeeping Core

> A production-grade double-entry ledger in Node.js + PostgreSQL.
> Built to demonstrate correctness under concurrency — the core problem of every fintech backend.

**Status:** In development
**Author:** Anuj Singh
**Started:** July 2026

---

## Why this exists

Every fintech company — Razorpay, PhonePe, CRED, Stripe — runs on a ledger.
Not a `balance` column that gets updated. A **journal of immutable entries** where
balance is always *derived*, never *mutated*.

This project implements that correctly, and proves it under load:

- 500 concurrent transfers → zero lost updates, zero duplicate charges
- Same request replayed 100 times → applied exactly once
- Deliberate data corruption → caught by reconciliation within 60 seconds

If you're reviewing this repo: start with [Invariants](#invariants), then
[Test Scenarios](#test-scenarios) — they define what "correct" means here.

---

## Invariants (the rules that can never break)

1. **Balanced entries.** Every transaction produces ≥ 2 journal entries, and
   the sum of debits always equals the sum of credits. Enforced at the DB
   level, not just in application code.
2. **Immutable journal.** Entries are never updated or deleted. Mistakes are
   corrected by posting a *reversal* transaction. (No `UPDATE` or `DELETE`
   grants on the entries table — the DB role physically cannot do it.)
3. **Derived balances.** No `balance` column on accounts. Balance =
   `SUM(credits) - SUM(debits)` for that account, computed via query or
   materialized view. This makes "balance at any point in time" trivial.
4. **Idempotency.** Every write request carries an `Idempotency-Key`. The
   same key always returns the same result, and the transaction is applied
   at most once — even under concurrent replays.
5. **No negative balances** on asset accounts (configurable per account
   type) — enforced inside the same serializable transaction that writes
   the entries, so it holds under any concurrency.

---

## Architecture

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│  REST API    │────▶│  Transfer Service  │────▶│  PostgreSQL  │
│  (Express)   │     │  (tx orchestrator) │     │  (journal)   │
└──────────────┘     └───────────────────┘     └──────┬───────┘
                                                      │
                     ┌───────────────────┐            │
                     │  Reconciliation    │◀──────────┘
                     │  worker (cron)     │
                     └───────────────────┘
```

Deliberately simple: one service, one database. The complexity lives in
**getting the transaction semantics right**, not in microservice sprawl.

**Stack:** Node.js + Express, `node-postgres` (raw SQL — no ORM, on purpose:
the point is to learn transactions, not hide them), PostgreSQL 16, k6 for
load testing, Docker Compose for one-command startup.

---

## Schema

```sql
CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE entry_direction AS ENUM ('debit', 'credit');
CREATE TYPE tx_status AS ENUM ('pending', 'posted', 'failed', 'reversed');

CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          account_type NOT NULL,
  currency      CHAR(3) NOT NULL,             -- ISO 4217
  allow_negative BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,       -- the dedup guarantee
  status          tx_status NOT NULL DEFAULT 'pending',
  description     TEXT,
  reverses        UUID REFERENCES transactions(id),  -- set on reversal txns
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at       TIMESTAMPTZ
);

CREATE TABLE entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  account_id     UUID NOT NULL REFERENCES accounts(id),
  direction      entry_direction NOT NULL,
  amount         BIGINT NOT NULL CHECK (amount > 0),  -- paise, never floats
  currency       CHAR(3) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entries_account ON entries (account_id, created_at);
CREATE INDEX idx_entries_tx ON entries (transaction_id);
```

Design notes:

- **Amounts are `BIGINT` in paise.** Never floats, never `NUMERIC` unless you
  need sub-paise precision. `₹49.99` is stored as `4999`.
- **`idempotency_key UNIQUE`** is the backbone of the dedup guarantee. The
  unique constraint means two concurrent requests with the same key — the
  classic double-click / retry scenario — can't both insert. One wins, the
  other detects the conflict and returns the original result.
- **`reverses`** links a reversal to the transaction it undoes, keeping the
  audit trail navigable.

### The balanced-entries constraint

Application code checks this, but the DB is the last line of defense:

```sql
CREATE OR REPLACE FUNCTION check_transaction_balanced()
RETURNS TRIGGER AS $$
DECLARE imbalance BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0)
    INTO imbalance
    FROM entries WHERE transaction_id = NEW.id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'Transaction % is unbalanced by %', NEW.id, imbalance;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fired when a transaction is marked posted (a DEFERRABLE constraint
-- trigger on entries is the more advanced alternative — see docs/decisions.md)
```

---

## API

```
POST   /accounts                      create an account
GET    /accounts/:id/balance          current balance (optionally ?at=<timestamp>)
POST   /transfers                     move money between two accounts
GET    /transactions/:id              fetch a transaction + its entries
POST   /transactions/:id/reverse      post a compensating reversal
GET    /accounts/:id/statement        paginated entry history
```

### POST /transfers

```http
POST /transfers
Idempotency-Key: pay_7f3a-...-uuid
Content-Type: application/json

{
  "from_account": "acc_merchant_001",
  "to_account":   "acc_platform_wallet",
  "amount":       4999,
  "currency":     "INR",
  "description":  "Order #789 settlement"
}
```

Responses:
- `201` — transfer posted (body includes transaction id + entries)
- `200` — idempotent replay: this key was already processed, returning the
  original result (body identical to the original 201)
- `409` — same key, *different* payload → client bug, reject loudly
- `422` — would violate an invariant (insufficient balance, currency mismatch)

### Transfer flow (the core logic)

```
BEGIN ISOLATION LEVEL SERIALIZABLE;
  1. INSERT transaction (idempotency_key, status='pending')
     → on unique violation: look up existing txn, return stored result
  2. Lock both account rows: SELECT ... FOR UPDATE (ordered by id — always
     lock in a consistent order to prevent deadlocks)
  3. Compute source balance; reject if it would go negative
  4. INSERT debit entry + credit entry
  5. UPDATE transaction SET status='posted', posted_at=now()
COMMIT;
On serialization failure (SQLSTATE 40001): retry up to 3x with jittered backoff.
```

---

## Reconciliation worker

Runs every 60s. Three checks:

1. **Zero-sum check:** global `SUM(debits) - SUM(credits)` across all entries
   must equal 0. If not, something catastrophic happened — page immediately.
2. **Per-transaction balance check:** any `posted` transaction whose entries
   don't sum to zero.
3. **Stuck transactions:** `pending` for > 5 minutes → flag for investigation.

Findings go to a `reconciliation_reports` table + a log line. In the demo,
we deliberately corrupt a row with raw SQL and show the worker catching it.

---

## Test Scenarios (this is the proof-of-work)

Each scenario is a script in `/tests/scenarios`, runnable via `npm run scenario:<name>`.
Results (throughput, p99, invariant checks) are committed to `/docs/results/`.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | **Idempotency replay** — fire the identical transfer 100× sequentially, then 100× in parallel | Exactly 1 transaction row, exactly 2 entries, all responses identical |
| 2 | **Concurrent transfers** — 500 parallel transfers between a shared pool of 10 accounts | Zero-sum invariant holds, no lost updates, no deadlock crashes (retries OK) |
| 3 | **Overdraw race** — account has ₹100; 50 parallel requests each try to move ₹10 | Exactly 10 succeed, 40 get 422, final balance is exactly 0 |
| 4 | **Crash mid-transfer** — kill the process between entry inserts (fault injection flag) | On restart: no half-posted transaction visible; pending txn flagged by reconciler |
| 5 | **Reconciliation drift** — manually corrupt one entry amount via psql | Worker detects and reports within 60s |
| 6 | **Load test** — k6, 10k transfers, ramping VUs | Report throughput + p99 latency; all invariants still hold after |
| 7 | **Point-in-time balance** — post 1,000 entries with known timestamps | `?at=` balance matches hand-computed value at 5 checkpoints |

---

## Milestones

| Week | Deliverable |
|------|-------------|
| 1 | Repo, Docker Compose (Postgres + app), schema + migrations, seed script |
| 2 | POST /transfers happy path inside a real transaction; GET balance |
| 3 | Idempotency (unique key + replay semantics + 409 on payload mismatch) |
| 4 | Concurrency hardening: FOR UPDATE ordering, serializable retries; scenarios 1–3 passing |
| 5 | Reconciliation worker + reversal endpoint; scenarios 4–5 passing |
| 6 | k6 load test, results in README, architecture diagram, blog post draft |

---

## Non-goals (v1)

Multi-currency FX, authnz, sharding, event streaming, admin UI. Each is a
deliberate cut — noted in `docs/decisions.md` with the reasoning. (Saying
what you *didn't* build and why is a senior-engineer signal.)

## Blog post that ships with this

**"I built a double-entry ledger in PostgreSQL — here's what broke under 500 concurrent transfers"**
Outline: why balance columns are a bug → the journal model → the idempotency
race and how UNIQUE saves you → lock ordering and the deadlock I hit →
serialization failures and retries → load test numbers.

## Running it

```bash
git clone https://github.com/ANUJSINGH555/ledger-engine
cd ledger-engine
docker compose up -d        # postgres + app
npm run migrate && npm run seed
npm test                    # unit + integration
npm run scenario:all        # the 7 proof scenarios
npm run load                # k6, writes report to docs/results/
```
