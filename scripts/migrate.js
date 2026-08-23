const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'ledger',
    password: 'ledger_dev',
    database: 'ledger',
});

async function main(){
    await client.connect();
    console.log('Connected to database');

    const result = await client.query(`SELECT filename from schema_migrations`);
    const applied = new Set(result.rows.map(r => r.filename));
    console.log("Already applied: ", applied);

    const pending = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .filter(f => !applied.has(f));

    console.log(pending);

    for(const file of pending) {
        console.log('pending items', file);
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR,file),'utf-8');
        console.log(sql);
        try{
            await client.query("BEGIN");
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)",[file]);
            await client.query("COMMIT");
            console.log(`Applied: ${file}`);
        }catch(err){
            await client.query("ROLLBACK");
            console.error(`Failed: ${file}`);
            throw err;
        }
    };

    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations(
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
        )
    `);
}


main()
.catch((err)=>{
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
})
.finally(()=> client.end());