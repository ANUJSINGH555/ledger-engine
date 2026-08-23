const { Client } = require('pg');


const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'ledger',
    password: 'ledger_dev',
    database: 'ledger'
});

async function main(){
    await client.connect();
    console.log('Connected to database');

    const accounts = [
        ['user_wallet_001', 'asset', 'INR'],
        ['user_wallet_002', 'asset', 'INR'],
        ['user_wallet_003', 'asset', 'INR'],
        ['user_wallet_004', 'asset', 'INR'],
        ['user_wallet_005', 'asset', 'INR'],
        ['merchant_payable', 'liability', 'INR'],
        ['platform_fees', 'revenue', 'INR'],
        ['opening_balances', 'equity', 'INR'],
        ['gateway_charges', 'expense', 'INR'],
    ]
    
    //delete accounts : seed data needs to be the starting state
    await client.query('DELETE FROM accounts');

    //then insert new data
    for (const acc of accounts) {
        const result = await client.query('INSERT INTO ACCOUNTS( name, type, currency ) VALUES ($1, $2, $3)', acc);        
    }

    console.log(`Seeded ${accounts.length} accounts`);
}

main()
.catch((err) => {
    console.log(err);
    process.exitCode = 1;
})
.finally(()=>{
    client.end();
});