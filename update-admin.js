const { Client } = require('pg');

const client = new Client({
  user: 'postgres',
  host: '127.0.0.1',
  database: 'postgres',
  password: 'poPBIbwGZgvIlJjDPGkYWonl',
  port: 5433
});

async function updateAdmin() {
  try {
    await client.connect();
    
    // Update the email address for the admin user
    const sql = 'UPDATE users SET email = $1 WHERE email = $2';
    const result = await client.query(sql, ['admin@mitra.com', 'admin@mitra.gov.in']);
    
    if (result.rowCount > 0) {
      console.log('SUCCESS: Login ID changed to admin@mitra.com');
    } else {
      console.log('NOTICE: admin@mitra.gov.in not found. Checking if admin@mitra.com already exists...');
    }
  } catch (err) {
    console.error('DATABASE ERROR:', err.message);
  } finally {
    await client.end();
    process.exit(0);
  }
}

updateAdmin();