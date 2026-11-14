## 001: Raw SQL over an ORM

**Decision:** Use `node-postgres` with hand-written SQL. No Prisma, Sequelize,
or TypeORM.

**Rejected:** An ORM would be faster to write and handle migrations for me.

**Why:** The point of this project is understanding transaction semantics —
isolation levels, lock ordering, serialization failures. An ORM abstracts
exactly the layer I'm trying to learn. Writing the SQL myself means I can
explain what every query does at the database level, and I'll understand what
an ORM is doing for me when I use one later.

**Trade-off:** More boilerplate, no compile-time type safety on queries, and
I have to write my own migration runner (done — `scripts/migrate.js`).

## 002: Delete-first seeding

**Decision:** `seed.js` clears the accounts table before inserting.

**Rejected:** `ON CONFLICT DO NOTHING` on a unique name constraint.

**Why:** Seed data is a known starting state, not accumulated history. During
development I'll run this repeatedly after getting balances into a confusing
state, and I want a guaranteed clean slate every time — not nine more accounts
on top of the mess.

**Trade-off:** Destructive by design, so this must never run against anything
but a local dev database. Once entries exist, the plain DELETE will hit a
foreign key violation and need to become
`TRUNCATE accounts, transactions, entries RESTART IDENTITY CASCADE`.

## 003: Debit/credit convention

**Decision:** Every transfer writes two entries — the source account gets
`credit`, the destination gets `debit`. Debit and credit are just names for
the two ends of a movement (where it went to, where it came from), not
synonyms for "in" and "out".

**Why:** Double-entry means recording both ends of every movement. If every
movement has a from and a to, then across the whole ledger all credits must
equal all debits — which is the invariant reconciliation checks.

**Gotcha:** This feels backwards because bank statements use the opposite
convention. That's because a statement is the bank's ledger, where my account
is their liability, not their asset. Different book, inverted signs.

**Consequence:** Whether a debit increases or decreases a balance depends on
account type (Assets = Liabilities + Equity). For asset accounts, debit
increases. For liability/equity/revenue, credit increases. So writing entries
doesn't need to know the account type, but the balance query does —
`SUM(debits) - SUM(credits)` for assets, flipped for the rest.


## 008: Balance sign depends on account type. 

The reasoning you worked out: assets and expenses are where value lands, so debits are positive; liabilities, equity and revenue are where value originates, so credits are positive. Worth noting that allow_negative on opening_balances was a workaround masking the real defect.

## 009: Idempotency via unique constraint and request fingerprint.

**Decision**: insert-and-catch-23505 rather than check-then-insert. The UNIQUE constraint does the deduplication; the database serializes concurrent retries for free.
**Rejected**: SELECT-then-INSERT (race: two concurrent retries both see nothing, both proceed), and caching the key (a second source of truth that can disagree with the money).
**The fingerprint**: SHA-256 over {from_account, to_account, amount, currency}. description deliberately excluded — it doesn’t affect the money, so changing it shouldn’t trigger a 409.
**Nullable column**: in production this would be add-nullable → backfill → tighten. Legacy rows can’t be retrofitted since the original request wasn’t captured.
**Contract:**
- New key → 201, process normally
- Same key, same fingerprint → 200, return the original transaction
- Same key, different fingerprint → 409, client reused a key for a different
  transfer. Returning the original would tell them their ₹5000 transfer
  succeeded when a ₹100 one did.