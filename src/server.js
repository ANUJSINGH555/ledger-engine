const express = require('express');
const { pool } = require('./db');

const app = express();
app.use(express.json());

app.get('/health', async(req,res)=>{
    try{
        await pool.query('SELECT 1');
        res.json({status: 'ok', db: 'connected'});
    }catch(err){
        console.error('Health check failed: ',err);
        res.status(503).json({status: 'error', message: err.message, code: err.code});
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));

module.exports = app;