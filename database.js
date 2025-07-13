const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor() {
        this.db = null;
        this.isInitialized = false;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const dbPath = path.join(__dirname, 'data', 'donations.db');
            
            this.db = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    console.error('Error opening database:', err);
                    reject(err);
                    return;
                }
                
                console.log('Connected to SQLite database');
                this.createTables()
                    .then(() => {
                        this.isInitialized = true;
                        resolve();
                    })
                    .catch(reject);
            });
        });
    }

    async createTables() {
        return new Promise((resolve, reject) => {
            const createDonationsTable = `
                CREATE TABLE IF NOT EXISTS donations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    amount REAL NOT NULL,
                    description TEXT,
                    comment TEXT,
                    counterName TEXT,
                    timestamp INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `;

            const createStatsTable = `
                CREATE TABLE IF NOT EXISTS stats (
                    id INTEGER PRIMARY KEY,
                    totalAmount REAL DEFAULT 0,
                    totalCount INTEGER DEFAULT 0,
                    lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `;

            const createIndexes = `
                CREATE INDEX IF NOT EXISTS idx_donations_timestamp ON donations(timestamp);
                CREATE INDEX IF NOT EXISTS idx_donations_name ON donations(name);
            `;

            this.db.serialize(() => {
                this.db.run(createDonationsTable);
                this.db.run(createStatsTable);
                this.db.run(createIndexes, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });
    }

    async addDonation(donation) {
        if (!this.isInitialized) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO donations 
                (id, name, amount, description, comment, counterName, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            stmt.run([
                donation.id,
                donation.name,
                donation.amount,
                donation.description || '',
                donation.comment || '',
                donation.counterName || '',
                donation.timestamp
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });

            stmt.finalize();
        });
    }

    async getDonations(limit = 100, offset = 0) {
        if (!this.isInitialized) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM donations ORDER BY timestamp DESC LIMIT ? OFFSET ?',
                [limit, offset],
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows);
                    }
                }
            );
        });
    }

    async getStats() {
        if (!this.isInitialized) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            const queries = {
                totalAmount: 'SELECT SUM(amount) as total FROM donations',
                totalCount: 'SELECT COUNT(*) as count FROM donations',
                uniqueDonors: 'SELECT COUNT(DISTINCT name) as unique_count FROM donations',
                latestDonation: 'SELECT * FROM donations ORDER BY timestamp DESC LIMIT 1'
            };

            const results = {};
            let completed = 0;
            const totalQueries = Object.keys(queries).length;

            Object.entries(queries).forEach(([key, query]) => {
                this.db.get(query, (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    switch (key) {
                        case 'totalAmount':
                            results.totalAmount = row.total || 0;
                            break;
                        case 'totalCount':
                            results.totalCount = row.count || 0;
                            break;
                        case 'uniqueDonors':
                            results.uniqueDonors = row.unique_count || 0;
                            break;
                        case 'latestDonation':
                            results.latestDonation = row ? {
                                ...row,
                                time: new Date(row.timestamp).toLocaleString('uk-UA')
                            } : null;
                            break;
                    }

                    completed++;
                    if (completed === totalQueries) {
                        resolve(results);
                    }
                });
            });
        });
    }

    async getTopDonors(limit = 10) {
        if (!this.isInitialized) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT name, SUM(amount) as totalAmount
                FROM donations 
                GROUP BY name 
                ORDER BY totalAmount DESC 
                LIMIT ?
            `, [limit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows.map(row => ({
                        name: row.name,
                        amount: row.totalAmount
                    })));
                }
            });
        });
    }

    async getRecentDonations(limit = 10) {
        if (!this.isInitialized) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM donations ORDER BY timestamp DESC LIMIT ?',
                [limit],
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows.map(row => ({
                            ...row,
                            time: new Date(row.timestamp).toLocaleString('uk-UA')
                        })));
                    }
                }
            );
        });
    }

    async loadExistingData() {
        if (!this.isInitialized) {
            throw new Error('Database not initialized');
        }

        try {
            const donations = await this.getDonations(1000);
            return donations;
        } catch (error) {
            console.error('Error loading existing data:', error);
            return [];
        }
    }

    async close() {
        if (this.db) {
            return new Promise((resolve) => {
                this.db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err);
                    } else {
                        console.log('Database connection closed');
                    }
                    resolve();
                });
            });
        }
    }
}

module.exports = Database;