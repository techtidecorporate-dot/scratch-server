import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import dotenv from 'dotenv';

dotenv.config();

// Required for Node.js environments
neonConfig.webSocketConstructor = ws;

// Neon connection string should be provided in .env as DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = (text, params) => pool.query(text, params);

// Helper to initialize tables
export const initDb = async () => {
  const createTablesQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      credits INTEGER DEFAULT 100,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      business_name TEXT NOT NULL,
      website TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      rating DECIMAL,
      reviews_count INTEGER,
      niche TEXT,
      location TEXT,
      score INTEGER,
      audit_details JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(business_name, location)
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await query(createTablesQuery);
    
    // Ensure columns exist (for existing databases)
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS rating DECIMAL');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS reviews_count INTEGER');
    await query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS crm_status TEXT DEFAULT 'new'");
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMP');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_follow_up TIMESTAMP');
    
    // 1. Remove duplicates before adding unique constraint
    // This keeps the latest record for each (business_name, location) pair
    const removeDuplicatesQuery = `
      DELETE FROM leads a USING (
        SELECT MIN(id) as id, business_name, location
        FROM leads 
        GROUP BY business_name, location 
        HAVING COUNT(*) > 1
      ) b
      WHERE a.business_name = b.business_name 
      AND a.location = b.location 
      AND a.id <> b.id
    `;
    await query(removeDuplicatesQuery);

    // 2. Add the unique constraint properly
    // Check if it exists first to avoid error on restart
    const checkConstraintQuery = `
      SELECT count(*)
      FROM pg_constraint
      WHERE conname = 'unique_business_location'
    `;
    const { rows } = await query(checkConstraintQuery);
    
    if (parseInt(rows[0].count) === 0) {
      await query('ALTER TABLE leads ADD CONSTRAINT unique_business_location UNIQUE (business_name, location)');
      console.log('✅ Unique constraint added to leads table');
    }

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Error initializing database:', err);
    throw err;
  }
};
