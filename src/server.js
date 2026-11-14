const express = require("express");
const { pool } = require("./db");
const { getBalance } = require("./balances");
const crypto = require('crypto');

const app = express();
app.use(express.json());

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error("Health check failed: ", err);
    res
      .status(503)
      .json({ status: "error", message: err.message, code: err.code });
  }
});

app.post("/transfers", async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"];
  const { from_account, to_account, amount, currency, description } = req.body;

  // ── Validation (outside the transaction — no DB needed) ──
  // YOUR CODE: reject with 400 if any of these fail
  //   - idempotencyKey missing
  //   - from_account or to_account missing
  //   - from_account === to_account
  //   - amount not a positive integer
  //   - currency missing

  if (
    !idempotencyKey ||
    !from_account ||
    !to_account ||
    from_account === to_account ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    !currency
  ) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const client = await pool.connect();

  const fingerprint = crypto.createHash('sha256')
        .update(JSON.stringify({from_account, to_account, amount, currency}))
        .digest('hex');

  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

    // 1. Insert the transaction row (status 'pending').
    //    A unique violation on idempotency_key means this key already ran.
    //    Postgres error code for that is '23505' — catch it separately and
    //    return the ORIGINAL transaction with 200.

    
    
    const txResult = await client.query(
      "INSERT INTO transactions (idempotency_key, status, description, request_fingerprint) VALUES ($1,'pending',$2, $3) RETURNING id",
      [idempotencyKey, description, fingerprint],
    );

    const transactionId = txResult.rows[0].id;

    // 2. Lock both accounts, in a consistent order:
    //    SELECT * FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE
    //    (passing both ids sorted — this is your deadlock prevention)

    const accountResult = await client.query(
      "SELECT * FROM accounts WHERE id=ANY($1) ORDER BY id FOR UPDATE",
      [[from_account, to_account].sort()],
    );

    const accounts = accountResult.rows;
    // 3. Both accounts exist? Currencies match each other and the request?
    //    → 422 if not

    const sender = accounts.find((acc) => acc.id === from_account);
    const receiver = accounts.find((acc) => acc.id === to_account);

    if (
      accounts.length !== 2 ||
      !sender ||
      !receiver ||
      sender.currency !== currency ||
      receiver.currency !== currency
    ) {
      await client.query("ROLLBACK");
      return res
        .status(422)
        .json({ message: "Accounts do not exist or currencies do not match" });
    }
    // 4. Compute the sender's balance from entries.
    //    If allow_negative is false and balance < amount → 422

    const senderBalance = await getBalance(client, from_account);

    if (!sender.allow_negative && senderBalance < amount) {
      await client.query("ROLLBACK");
      return res.status(422).json({ message: "Insufficient funds" });
    }

    // 5. Insert the two entries: source = 'credit', destination = 'debit'
    await client.query(
      "INSERT INTO entries (transaction_id, account_id, direction, amount, currency) VALUES ($1, $2, 'credit', $3, $4), ($1, $5, 'debit', $3, $4)",
      [transactionId, from_account, amount, currency, to_account],
    );
    // 6. UPDATE transactions SET status='posted', posted_at=now()
    await client.query(
      "UPDATE transactions SET status='posted', posted_at=now() WHERE id=$1",
      [transactionId],
    );

    await client.query("COMMIT");
    res.status(201).json({ transaction_id: transactionId, status: "posted" });
  } catch (err) {
    await client.query("ROLLBACK");
    if(err.code === '23505'){
        const original = await client.query(
            'SELECT id, status, request_fingerprint FROM transactions WHERE idempotency_key = $1',[idempotencyKey]
        );

        const row = original.rows[0];

        if(!row){
            return res.status(500).json({message: 'Idempotency conflict but original not found'});
        }

        if(row.request_fingerprint !== fingerprint){
            return res.status(409).json({
                message: 'Idempotency key already used with different payload'
            });
        }
        return res.status(200).json({transaction_id: row.id, status: row.status});
    }

    console.error("Transaction failed: ", err);
    return res
      .status(500)
      .json({ status: "error", message: err.message, code: err.code });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));

module.exports = app;
