import { query } from '../db/index.js';
import { runScraper } from '../services/scraper.js';

export const getLeads = async (req, res) => {
  try {
    const result = await query('SELECT * FROM leads ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const searchLeads = async (req, res) => {
  const { niche, location } = req.body;
  try {
    const sql = 'SELECT * FROM leads WHERE (niche ILIKE $1 OR business_name ILIKE $1) AND location ILIKE $2 ORDER BY score DESC LIMIT 50';
    const params = [`%${niche}%`, `%${location}%`];
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const updateLead = async (req, res) => {
  const { id } = req.params;
  const { crm_status, notes, next_follow_up } = req.body;
  try {
    const updates = [];
    const params = [];
    let idx = 1;

    if (crm_status) {
      updates.push(`crm_status = $${idx++}`);
      params.push(crm_status);
      if (crm_status === 'contacted') {
        updates.push(`contacted_at = $${idx++}`);
        params.push(new Date().toISOString());
      }
    }
    if (notes !== undefined) {
      updates.push(`notes = $${idx++}`);
      params.push(notes);
    }
    if (next_follow_up) {
      updates.push(`next_follow_up = $${idx++}`);
      params.push(next_follow_up);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    const sql = `UPDATE leads SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await query(sql, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const triggerScrape = async (req, res) => {
  const { niche, location, filters } = req.body;
  try {
    // Run scraper in background with the intelligence layer
    runScraper(niche, location, filters).catch(err => console.error('Background scrape failed:', err));
    
    res.json({ 
      status: 'started',
      message: `🚀 Client Machine is now hunting for ${niche} in ${location}. Check back in a few seconds.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
