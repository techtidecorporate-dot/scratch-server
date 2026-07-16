import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  const { name, user_id } = req.body;
  try {
    const result = await query(
      'INSERT INTO campaigns (name, user_id) VALUES ($1, $2) RETURNING *',
      [name, user_id || 1]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export { router as campaignRoutes };
