const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Database = require('./database');
const { 
    logger, 
    httpLoggerMiddleware, 
    logDonation, 
    logMonobankAPI, 
    logWebSocket, 
    logDatabase 
} = require('./logger');
const {
    validators,
    rateLimiters,
    errorLogger,
    sanitizeInput
} = require('./validation');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 8080;

const MONO_TOKEN = process.env.MONO_TOKEN;
const CHECK_INTERVAL = 30000; // Збільшуємо інтервал до 30 секунд щоб уникнути rate limit

let lastTransactionId = null;
let donations = [];
let stats = {
    totalAmount: 0,
    totalCount: 0,
    uniqueDonors: new Set()
};

// Ініціалізуємо базу даних
const database = new Database();

// Кеш для client-info API (обмеження: не частіше 1 разу в 60 секунд)
let clientInfoCache = {
    data: null,
    lastFetch: 0,
    CACHE_DURATION: 60000 // 60 секунд
};

const wss = new WebSocket.Server({ port: WS_PORT });

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sanitizeInput);
app.use(httpLoggerMiddleware);
app.use('/api/', rateLimiters.general);

const donationsDB = {
    async add(donation) {
        // Додаємо до пам'яті для зворотної сумісності
        donations.push(donation);
        stats.totalAmount += donation.amount;
        stats.totalCount++;
        stats.uniqueDonors.add(donation.name);
        
        // Зберігаємо в базу даних
        try {
            await database.addDonation(donation);
            logDatabase('donation_saved', { donationId: donation.id, amount: donation.amount });
        } catch (error) {
            logDatabase('donation_save_failed', { donationId: donation.id }, error);
        }
        
        this.broadcastNewDonation(donation);
        logDonation(donation, 'received');
    },

    addTest(donation) {
        // Тестові донати тільки показуються, але не додаються до статистики
        this.broadcastNewDonation(donation);
        logDonation(donation, 'test');
    },

    async getStats() {
        try {
            // Отримуємо статистику з бази даних для більшої точності
            const dbStats = await database.getStats();
            return dbStats;
        } catch (error) {
            logDatabase('get_stats_failed', {}, error);
            // Fallback до статистики з пам'яті
            const latestDonation = donations.length > 0 ? donations[donations.length - 1] : null;
            return {
                totalAmount: stats.totalAmount,
                totalCount: stats.totalCount,
                uniqueDonors: stats.uniqueDonors.size,
                latestDonation: latestDonation ? {
                    ...latestDonation,
                    time: new Date(latestDonation.timestamp).toLocaleString('uk-UA')
                } : null
            };
        }
    },

    async getTop(limit = 10) {
        try {
            return await database.getTopDonors(limit);
        } catch (error) {
            logDatabase('get_top_donors_failed', {}, error);
            // Fallback до статистики з пам'яті
            const donors = {};
            donations.forEach(donation => {
                if (!donors[donation.name]) {
                    donors[donation.name] = 0;
                }
                donors[donation.name] += donation.amount;
            });

            return Object.entries(donors)
                .sort(([,a], [,b]) => b - a)
                .slice(0, limit)
                .map(([name, amount]) => ({ name, amount }));
        }
    },

    async getRecent(limit = 10) {
        try {
            return await database.getRecentDonations(limit);
        } catch (error) {
            logDatabase('get_recent_donations_failed', {}, error);
            // Fallback до статистики з пам'яті
            return donations
                .slice(-limit)
                .reverse()
                .map(donation => ({
                    ...donation,
                    time: new Date(donation.timestamp).toLocaleString('uk-UA')
                }));
        }
    },

    broadcastNewDonation(donation) {
        const message = JSON.stringify({
            type: 'new_donation',
            data: donation
        });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
};

// Безпечне отримання client-info з дотриманням rate limit
async function getClientInfoSafely() {
    const now = Date.now();
    
    // Перевіряємо чи можемо використати кеш
    if (clientInfoCache.data && (now - clientInfoCache.lastFetch) < clientInfoCache.CACHE_DURATION) {
        logMonobankAPI('using_cached_client_info');
        return clientInfoCache.data;
    }
    
    try {
        logMonobankAPI('fetching_client_info');
        const response = await axios.get('https://api.monobank.ua/personal/client-info', {
            headers: {
                'X-Token': MONO_TOKEN
            },
            timeout: 10000
        });
        
        // Оновлюємо кеш
        clientInfoCache.data = response.data;
        clientInfoCache.lastFetch = now;
        
        return response.data;
        
    } catch (error) {
        logMonobankAPI('client_info_error', {
            status: error.response?.status,
            data: error.response?.data
        }, error);
        
        // Якщо є старі дані в кеші, повертаємо їх
        if (clientInfoCache.data) {
            logMonobankAPI('using_stale_cache_due_to_error');
            return clientInfoCache.data;
        }
        
        throw error;
    }
}

function extractNameFromDescription(description) {
    const patterns = [
        /від\s+([А-Яа-яІіЇїЄєЁё\w\s]+)/i,
        /from\s+([A-Za-z\w\s]+)/i,
        /([А-Яа-яІіЇїЄєЁё\w\s]{2,})\s*-/,
        /^([А-Яа-яІіЇїЄєЁё\w\s]{2,})/
    ];

    for (const pattern of patterns) {
        const match = description.match(pattern);
        if (match) {
            return match[1].trim();
        }
    }

    return 'Анонім';
}

async function checkMonobankTransactions() {
    if (!MONO_TOKEN) {
        logger.warn('MONO_TOKEN not provided, skipping Monobank check');
        return;
    }

    try {
        // Спочатку отримуємо інформацію про клієнта та банки
        const clientInfo = await getClientInfoSafely();
        const cameraJar = clientInfo.jars.find(jar => jar.title === 'На фотоапарат');
        
        if (!cameraJar) {
            logMonobankAPI('camera_jar_not_found');
            return;
        }

        // Використовуємо ID банки замість основного рахунку
        const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
        const now = Math.floor(Date.now() / 1000);
        
        const response = await axios.get(`https://api.monobank.ua/personal/statement/${cameraJar.id}/${thirtyDaysAgo}/${now}`, {
            headers: {
                'X-Token': MONO_TOKEN
            },
            timeout: 10000
        });

        const transactions = response.data;
        
        if (!Array.isArray(transactions)) {
            logMonobankAPI('invalid_response', { response: transactions });
            return;
        }

        // Фільтруємо тільки вхідні платежі (позитивні суми)
        const incomingTransactions = transactions.filter(t => t.amount > 0);
        
        const newTransactions = lastTransactionId 
            ? incomingTransactions.filter(t => t.id !== lastTransactionId && t.time * 1000 > (lastTransactionId ? Date.now() - 24 * 60 * 60 * 1000 : 0))
            : incomingTransactions.slice(0, 3); // Беремо останні 3 для початку

        if (newTransactions.length > 0) {
            lastTransactionId = newTransactions[0].id;
            logMonobankAPI('new_transactions_found', { count: newTransactions.length });
        }

        for (const transaction of newTransactions) {
            const donation = {
                id: transaction.id,
                name: transaction.counterName || extractNameFromDescription(transaction.description),
                amount: transaction.amount / 100,
                description: transaction.description,
                comment: transaction.comment || '',
                counterName: transaction.counterName || 'Невідомий відправник',
                timestamp: transaction.time * 1000
            };

            await donationsDB.add(donation);
        }

    } catch (error) {
        if (error.response) {
            const status = error.response.status;
            if (status === 429) {
                logMonobankAPI('rate_limit_exceeded', { status });
                // Збільшуємо інтервал при rate limit
                setTimeout(() => {
                    logMonobankAPI('resuming_normal_interval');
                }, 60000); // Чекаємо 1 хвилину
            } else if (status === 400) {
                logMonobankAPI('bad_request', { status }, error);
            } else if (status === 401) {
                logMonobankAPI('invalid_token', { status }, error);
            } else {
                logMonobankAPI('api_error', { status, data: error.response.data }, error);
            }
        } else {
            logMonobankAPI('network_error', {}, error);
        }
    }
}

wss.on('connection', (ws) => {
    const clientCount = wss.clients.size;
    logWebSocket('client_connected', clientCount);
    
    ws.on('close', () => {
        const clientCount = wss.clients.size;
        logWebSocket('client_disconnected', clientCount);
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/donations', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'donations.html'));
});

app.get('/obs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'obs.html'));
});

app.get('/camera-jar', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'camera-jar.html'));
});

app.get('/api/donations/stats', validators.statsQuery, async (req, res) => {
    try {
        const stats = await donationsDB.getStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        logger.error('Error getting stats:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to get stats' 
        });
    }
});

app.get('/api/donations/top', validators.topDonorsQuery, async (req, res) => {
    try {
        const { limit } = req.query;
        const topDonors = await donationsDB.getTop(limit);
        res.json({
            success: true,
            data: topDonors,
            meta: { limit }
        });
    } catch (error) {
        logger.error('Error getting top donors:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to get top donors' 
        });
    }
});

app.get('/api/donations/recent', validators.recentDonationsQuery, async (req, res) => {
    try {
        const { limit } = req.query;
        const recentDonations = await donationsDB.getRecent(limit);
        res.json({
            success: true,
            data: recentDonations,
            meta: { limit }
        });
    } catch (error) {
        logger.error('Error getting recent donations:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to get recent donations' 
        });
    }
});

app.get('/api/donations/latest', async (req, res) => {
    try {
        const latest = await donationsDB.getRecent(1);
        res.json({
            success: true,
            data: latest.length > 0 ? latest[0] : null
        });
    } catch (error) {
        logger.error('Error getting latest donation:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to get latest donation' 
        });
    }
});

// API для отримання інформації про банку "На фотоапарат"
// API для отримання всіх банок
app.get('/api/jars', rateLimiters.monobank, async (req, res) => {
    if (!MONO_TOKEN) {
        return res.status(500).json({ 
            success: false,
            error: 'MONO_TOKEN not configured' 
        });
    }

    try {
        const clientInfo = await getClientInfoSafely();
        
        const jars = clientInfo.jars.map(jar => {
            const balance = jar.balance / 100;
            const goal = jar.goal / 100;
            const progress = goal > 0 ? (balance / goal) * 100 : 0;
            
            return {
                id: jar.id,
                title: jar.title,
                description: jar.description,
                balance: balance,
                goal: goal,
                progress: progress.toFixed(1),
                sendId: jar.sendId
            };
        });

        res.json({
            jars: jars,
            cached: clientInfo === clientInfoCache.data,
            cacheAge: Date.now() - clientInfoCache.lastFetch
        });

    } catch (error) {
        console.error('Error fetching jars info:', error);
        if (error.response?.status === 429) {
            res.status(429).json({ 
                error: 'Rate limit exceeded. Please wait before next request.',
                retryAfter: 60 
            });
        } else {
            res.status(500).json({ error: 'Failed to fetch jars info' });
        }
    }
});

// API для отримання інформації про банку "На фотоапарат"
app.get('/api/jar/camera', rateLimiters.monobank, async (req, res) => {
    if (!MONO_TOKEN) {
        return res.status(500).json({ 
            success: false,
            error: 'MONO_TOKEN not configured' 
        });
    }

    try {
        const clientInfo = await getClientInfoSafely();
        const cameraJar = clientInfo.jars.find(jar => jar.title === 'На фотоапарат');
        
        if (!cameraJar) {
            return res.status(404).json({ error: 'Camera jar not found' });
        }

        // Конвертуємо копійки в гривні та обчислюємо прогрес
        const balance = cameraJar.balance / 100;
        const goal = cameraJar.goal / 100;
        const progress = goal > 0 ? (balance / goal) * 100 : 0;

        res.json({
            id: cameraJar.id,
            title: cameraJar.title,
            description: cameraJar.description,
            balance: balance,
            goal: goal,
            progress: progress.toFixed(1),
            sendId: cameraJar.sendId,
            cached: clientInfo === clientInfoCache.data // Показуємо чи дані з кешу
        });

    } catch (error) {
        console.error('Error fetching camera jar info:', error);
        if (error.response) {
            const status = error.response.status;
            if (status === 429) {
                res.status(429).json({ 
                    error: 'Rate limit exceeded. Please wait before next request.',
                    retryAfter: 60 
                });
            } else if (status === 401) {
                res.status(401).json({ error: 'Invalid token' });
            } else {
                res.status(500).json({ error: 'Monobank API error' });
            }
        } else {
            res.status(500).json({ error: 'Network error' });
        }
    }
});

app.get('/api/test-donation', rateLimiters.testDonation, validators.testDonation, (req, res) => {
    const testDonation = {
        id: 'test_' + Date.now(),
        name: 'Тестовий Донатер',
        amount: Math.floor(Math.random() * 500) + 50,
        description: 'Поповнення На фотоапарат',
        comment: 'Тримайте на новий об\'єктив! 📸',
        counterName: 'ПриватБанк',
        timestamp: Date.now()
    };

    donationsDB.addTest(testDonation);
    res.json({ 
        success: true, 
        data: testDonation, 
        note: 'Test donation - not counted in stats' 
    });
});

setInterval(checkMonobankTransactions, CHECK_INTERVAL);

// Функція для завантаження існуючих донатів з бази даних при старті
async function loadExistingDonations() {
    try {
        const existingDonations = await database.loadExistingData();
        
        // Оновлюємо статистику в пам'яті
        existingDonations.forEach(donation => {
            donations.push(donation);
            stats.totalAmount += donation.amount;
            stats.totalCount++;
            stats.uniqueDonors.add(donation.name);
        });
        
        // Встановлюємо останню транзакцію для продовження перевірок
        if (existingDonations.length > 0) {
            lastTransactionId = existingDonations[0].id;
        }
        
        logger.info('Existing donations loaded', {
            count: existingDonations.length,
            totalAmount: stats.totalAmount,
            uniqueDonors: stats.uniqueDonors.size
        });
    } catch (error) {
        logDatabase('load_existing_donations_failed', {}, error);
    }
}

// Ініціалізація сервера
async function startServer() {
    try {
        // Ініціалізуємо базу даних
        await database.init();
        logDatabase('database_initialized');
        
        // Завантажуємо існуючі донати
        await loadExistingDonations();
        
        // Запускаємо HTTP сервер
        app.listen(PORT, () => {
            logger.info('Server started', {
                httpPort: PORT,
                wsPort: WS_PORT,
                url: `http://localhost:${PORT}`,
                monobankEnabled: !!MONO_TOKEN
            });
            
            if (MONO_TOKEN) {
                logMonobankAPI('integration_enabled');
                checkMonobankTransactions();
            } else {
                logger.warn('Monobank integration disabled (no MONO_TOKEN provided)');
            }
        });
        
    } catch (error) {
        logger.error('Failed to start server', {
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down server...');
    if (database) {
        await database.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down server...');
    if (database) {
        await database.close();
    }
    process.exit(0);
});

// Додаємо обробник помилок в кінці
app.use(errorLogger);

// Запускаємо сервер
startServer();