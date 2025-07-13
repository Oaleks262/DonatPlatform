const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Створюємо папку logs якщо її немає
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Створюємо транспорти для різних рівнів логування
const transports = [
    // Консольний вивід з кольорами
    new winston.transports.Console({
        level: 'info',
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
                let log = `${timestamp} [${level}]: ${message}`;
                
                // Додаємо мета-дані якщо є
                if (Object.keys(meta).length > 0) {
                    log += ` ${JSON.stringify(meta)}`;
                }
                
                return log;
            })
        )
    }),

    // Файл для всіх логів з ротацією
    new DailyRotateFile({
        filename: path.join(__dirname, 'logs', 'application-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        level: 'debug',
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        )
    }),

    // Окремий файл для помилок
    new DailyRotateFile({
        filename: path.join(__dirname, 'logs', 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '30d',
        level: 'error',
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        )
    }),

    // Файл для донатів (окрема категорія)
    new DailyRotateFile({
        filename: path.join(__dirname, 'logs', 'donations-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '10m',
        maxFiles: '30d',
        level: 'info',
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        )
    })
];

// Створюємо основний логер
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'monobank-obs-server' },
    transports
});

// Створюємо спеціалізований логер для донатів
const donationLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'donations' },
    transports: [
        new DailyRotateFile({
            filename: path.join(__dirname, 'logs', 'donations-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '10m',
            maxFiles: '30d'
        })
    ]
});

// Створюємо спеціалізований логер для API запитів
const apiLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'api' },
    transports: [
        new DailyRotateFile({
            filename: path.join(__dirname, 'logs', 'api-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '10m',
            maxFiles: '14d'
        })
    ]
});

// Middleware для логування HTTP запитів
const httpLoggerMiddleware = (req, res, next) => {
    const start = Date.now();
    
    // Логуємо початок запиту
    apiLogger.info('HTTP Request Start', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
    });

    // Перехоплюємо завершення відповіді
    const originalSend = res.send;
    res.send = function(data) {
        const duration = Date.now() - start;
        
        apiLogger.info('HTTP Request Complete', {
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            timestamp: new Date().toISOString()
        });
        
        originalSend.call(this, data);
    };

    next();
};

// Функції-хелпери для спеціалізованого логування
const logDonation = (donation, action = 'received') => {
    donationLogger.info(`Donation ${action}`, {
        donationId: donation.id,
        donorName: donation.name,
        amount: donation.amount,
        currency: 'UAH',
        description: donation.description,
        timestamp: donation.timestamp,
        action
    });

    logger.info(`New donation: ${donation.name} - ${donation.amount} UAH`);
};

const logMonobankAPI = (action, data = {}, error = null) => {
    const logData = {
        action,
        timestamp: new Date().toISOString(),
        ...data
    };

    if (error) {
        logger.error(`Monobank API Error: ${action}`, {
            ...logData,
            error: error.message,
            stack: error.stack
        });
    } else {
        logger.info(`Monobank API: ${action}`, logData);
    }
};

const logWebSocket = (action, clientCount = 0, data = {}) => {
    logger.info(`WebSocket: ${action}`, {
        action,
        clientCount,
        timestamp: new Date().toISOString(),
        ...data
    });
};

const logDatabase = (action, data = {}, error = null) => {
    const logData = {
        action,
        timestamp: new Date().toISOString(),
        ...data
    };

    if (error) {
        logger.error(`Database Error: ${action}`, {
            ...logData,
            error: error.message,
            stack: error.stack
        });
    } else {
        logger.debug(`Database: ${action}`, logData);
    }
};

// Обробник для необроблених помилок
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
    });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', {
        reason: reason.toString(),
        promise: promise.toString(),
        timestamp: new Date().toISOString()
    });
});

module.exports = {
    logger,
    donationLogger,
    apiLogger,
    httpLoggerMiddleware,
    logDonation,
    logMonobankAPI,
    logWebSocket,
    logDatabase
};