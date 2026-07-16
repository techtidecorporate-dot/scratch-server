import express from 'express';

const router = express.Router();

router.post('/register', (req, res) => res.json({ message: 'Register placeholder' }));
router.post('/login', (req, res) => res.json({ message: 'Login placeholder' }));

export { router as authRoutes };
