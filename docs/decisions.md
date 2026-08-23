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