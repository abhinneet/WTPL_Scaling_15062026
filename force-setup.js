const { Client } = require('pg');

const client = new Client({
  user: 'postgres',
  host: '127.0.0.1',
  database: 'mitra',
  password: 'poPBIbwGZgvIlJjDPGkYWonl',
  port: 5433
});

async function setup() {
  try {
    await client.connect();
    // Create the essential table [cite: 3, 6]
    await client.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE, password TEXT, name TEXT, role TEXT)');
    
    // Insert the Master Admin [cite: 6, 7]
    const sql = 'INSERT INTO users (email, password, name, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING';
    await client.query(sql, ['admin@mitra.com', 'admin123', 'Master Admin', 'admin']);
    
    console.log('SUCCESS: Database is ready and Admin user exists!');
  } catch (err) {
    console.error('DATABASE ERROR:', err.message);
  } finally {
    await client.end();
    process.exit(0);
  }
}

setup();