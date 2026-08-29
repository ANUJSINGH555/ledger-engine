const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    user: 'ledger',
    password: 'ledger_dev',
    database: 'ledger',
    max: 20,
    idleTimeoutMillis : 30000,
});

module.exports = { pool };