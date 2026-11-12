const express = require("express");
const { pool } = require("./db");

const app = express();
app.use(express.json());

async function getBalance(client, accountId){
    const result = await client.query(
    `SELECT COALESCE(SUM(
        CASE WHEN a.type = 'asset' OR a.type = 'expense'
             THEN CASE WHEN direction = 'debit' THEN amount ELSE -amount END
             ELSE  CASE WHEN direction = 'credit' THEN amount ELSE -amount END
        END
    ), 0) AS balance
      FROM entries e
      JOIN accounts a
      ON a.id = e.account_id
      WHERE e.account_id = $1`, [accountId]
    );

    return Number(result.rows[0].balance);
        
}

module.exports = {getBalance};

