import express from 'express';
import { getLeads, searchLeads, triggerScrape, updateLead } from '../controllers/leads.js';

const router = express.Router();

router.get('/', getLeads);
router.post('/search', searchLeads);
router.post('/scrape', triggerScrape);
router.put('/:id', updateLead);

export { router as leadRoutes };
