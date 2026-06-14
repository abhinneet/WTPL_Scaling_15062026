const { Client } = require('pg');

const hashedPass = '$2b$10$6p9/qjM.oHk8A/8m.8rKHeOqIuJzG.B5r5E5r5E5r5E5r5E5r5E5.'; 

const client = new Client({
  user: 'postgres',
  host: '127.0.0.1',
  database: 'mitra', // Connecting to the new mitra DB
  password: 'poPBIbwGZgvIlJjDPGkYWonl',
  port: 5433
});

async function setup() {
  try {
    await client.connect();
    
    // 1. Create the Users table (the missing relation)
    console.log('Creating users table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        role TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 2. Insert or Update the admin user
    console.log('Upserting admin user...');
    const sql = `
      INSERT INTO users (email, password, name, role) 
      VALUES ($1, $2, $3, $4) 
      ON CONFLICT (email) 
      DO UPDATE SET password = $2, name = $3, role = $4
    `;
    await client.query(sql, ['admin@mitra.com', hashedPass, 'Master Admin', 'admin']);
    
    console.log('SUCCESS: Table created and admin@mitra.com is ready!');
  } catch (err) {
    console.error('DATABASE ERROR:', err.message);
  } finally {
    await client.end();
    process.exit(0);
  }
}

setup();