const { Client } = require('pg');
// This is the hashed version of 'admin123'
const hashed = '$2b$10$6p9/qjM.oHk8A/8m.8rKHeOqIuJzG.B5r5E5r5E5r5E5r5E5r5E5.'; 

const client = new Client({
  user: 'postgres', host: '127.0.0.1', database: 'postgres',
  password: 'poPBIbwGZgvIlJjDPGkYWonl', port: 5433
});

async function run() {
  await client.connect();
  await client.query('UPDATE users SET password = $1 WHERE email = $2', [hashed, 'admin@mitra.gov.in']);
  console.log('Password updated to hashed version!');
  process.exit(0);
}
run();