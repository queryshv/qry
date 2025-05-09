import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

// Configure WebSocket for Neon
neonConfig.webSocketConstructor = ws;

// Initialize database connections
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 2000, // How long to wait for a connection
  maxUses: 7500, // Close & replace a connection after it has been used this many times
});

// Add connection error handling
pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle database client:', err);
  process.exit(-1); // Exit on connection error to allow the process manager to restart
});

// Create drizzle instance with error handling wrapper
const db = drizzle(pool, { schema });

// Initial connection validation with error handling
async function validateDatabaseConnection(pool: Pool) {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to database');
    client.release();
  } catch (err) {
    console.error('Failed to validate database connection:', err);
    throw err;
  }
}

validateDatabaseConnection(pool).catch((err: Error) => {
  console.error('Failed to validate database connection:', err);
  process.exit(1); // Exit on connection error to allow the process manager to restart
});

// Export the database connections
export { pool, db };