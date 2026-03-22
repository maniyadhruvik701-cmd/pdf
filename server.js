const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;
const SECRET_KEY = 'scaniq-super-secret-key'; 

app.use(cors());
app.use(bodyParser.json());

// Serve static files (HTML, CSS, JS) from the current folder
app.use(express.static(__dirname));

// Send index.html of any other routes for SPA (optional)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Database Setup ──
const db = new sqlite3.Database('./scaniq.sqlite', (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected to the ScanIQ SQLite database.');
});

// Initialize Tables
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // History table
    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid INTEGER NOT NULL,
        file TEXT,
        order_no TEXT,
        sku TEXT,
        total_amount TEXT,
        tracking_no TEXT,
        scanned_at TEXT,
        date_iso TEXT,
        timestamp INTEGER,
        FOREIGN KEY (uid) REFERENCES users (id) ON DELETE CASCADE
    )`);
});

// ── Auth Endpoints ──

// Signup
app.post('/api/auth/signup', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = `INSERT INTO users (name, email, password) VALUES (?, ?, ?)`;
        db.run(sql, [name, email, hashedPassword], function (err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: 'Email already registered' });
                }
                return res.status(500).json({ error: err.message });
            }
            const token = jwt.sign({ id: this.lastID, email }, SECRET_KEY, { expiresIn: '7d' });
            res.status(201).json({ token, user: { id: this.lastID, name, email } });
        });
    } catch (e) {
        res.status(500).json({ error: 'Encryption failed' });
    }
});

// Login
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

    const sql = `SELECT * FROM users WHERE email = ?`;
    db.get(sql, [email], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(400).json({ error: 'User not found' });

        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: 'Invalid password' });

        const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    });
});

// ── History Endpoints ──

// Middleware to verify JWT
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });

    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

// Get History
app.get('/api/history', verifyToken, (req, res) => {
    const sql = `SELECT * FROM history WHERE uid = ? ORDER BY timestamp DESC`;
    db.all(sql, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add to History
app.post('/api/history', verifyToken, (req, res) => {
    const { file, order_no, sku, total_amount, tracking_no, scanned_at, date_iso, timestamp } = req.body;
    const sql = `INSERT INTO history (uid, file, order_no, sku, total_amount, tracking_no, scanned_at, date_iso, timestamp) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [req.user.id, file, order_no, sku, total_amount, tracking_no, scanned_at, date_iso, timestamp], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID, ...req.body });
    });
});

// Clear History
app.delete('/api/history', verifyToken, (req, res) => {
    const sql = `DELETE FROM history WHERE uid = ?`;
    db.run(sql, [req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'History cleared' });
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
