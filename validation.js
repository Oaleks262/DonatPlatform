const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const { logger } = require('./logger');

// Схеми валідації для різних ендпоінтів
const schemas = {
    // Валідація параметрів запиту для статистики
    statsQuery: Joi.object({
        detailed: Joi.boolean().optional()
    }),

    // Валідація параметрів для топ донатерів
    topDonorsQuery: Joi.object({
        limit: Joi.number().integer().min(1).max(100).default(10)
    }),

    // Валідація параметрів для останніх донатів
    recentDonationsQuery: Joi.object({
        limit: Joi.number().integer().min(1).max(100).default(10)
    }),

    // Валідація тестового донату
    testDonation: Joi.object({
        name: Joi.string().min(1).max(100).optional(),
        amount: Joi.number().positive().max(100000).optional(),
        comment: Joi.string().max(500).optional()
    }),

    // Валідація параметрів пагінації
    pagination: Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
        sortBy: Joi.string().valid('timestamp', 'amount', 'name').default('timestamp'),
        sortOrder: Joi.string().valid('asc', 'desc').default('desc')
    })
};

// Створення валідаторів middleware
const createValidator = (schema, target = 'query') => {
    return (req, res, next) => {
        const data = target === 'body' ? req.body : 
                    target === 'params' ? req.params : 
                    req.query;

        const { error, value } = schema.validate(data, {
            abortEarly: false,
            stripUnknown: true,
            convert: true
        });

        if (error) {
            const errorDetails = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message,
                value: detail.context?.value
            }));

            logger.warn('API Validation Error', {
                endpoint: req.path,
                method: req.method,
                errors: errorDetails,
                ip: req.ip
            });

            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errorDetails
            });
        }

        // Замінюємо оригінальні дані валідованими і конвертованими
        if (target === 'body') {
            req.body = value;
        } else if (target === 'params') {
            req.params = value;
        } else {
            req.query = value;
        }

        next();
    };
};

// Rate limiting конфігурації
const rateLimiters = {
    // Загальний rate limit для API
    general: rateLimit({
        windowMs: 15 * 60 * 1000, // 15 хвилин
        max: 100, // максимум 100 запитів на IP за 15 хвилин
        message: {
            success: false,
            error: 'Too many requests, please try again later.',
            retryAfter: '15 minutes'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            logger.warn('Rate limit exceeded', {
                ip: req.ip,
                endpoint: req.path,
                method: req.method,
                userAgent: req.get('User-Agent')
            });

            res.status(429).json({
                success: false,
                error: 'Too many requests, please try again later.',
                retryAfter: '15 minutes'
            });
        }
    }),

    // Суворий rate limit для тестових донатів
    testDonation: rateLimit({
        windowMs: 5 * 60 * 1000, // 5 хвилин
        max: 10, // максимум 10 тестових донатів на IP за 5 хвилин
        message: {
            success: false,
            error: 'Too many test donations, please wait before trying again.',
            retryAfter: '5 minutes'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            logger.warn('Test donation rate limit exceeded', {
                ip: req.ip,
                userAgent: req.get('User-Agent')
            });

            res.status(429).json({
                success: false,
                error: 'Too many test donations, please wait before trying again.',
                retryAfter: '5 minutes'
            });
        }
    }),

    // Більш суворий rate limit для Monobank API ендпоінтів
    monobank: rateLimit({
        windowMs: 60 * 1000, // 1 хвилина
        max: 5, // максимум 5 запитів на хвилину для Monobank ендпоінтів
        message: {
            success: false,
            error: 'Too many requests to Monobank API, please wait.',
            retryAfter: '1 minute'
        },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            logger.warn('Monobank API rate limit exceeded', {
                ip: req.ip,
                endpoint: req.path,
                userAgent: req.get('User-Agent')
            });

            res.status(429).json({
                success: false,
                error: 'Too many requests to Monobank API, please wait.',
                retryAfter: '1 minute'
            });
        }
    })
};

// Middleware для валідації JWT токенів (якщо буде потреба в майбутньому)
const validateAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({
            success: false,
            error: 'Authorization header required'
        });
    }

    // Тут можна додати перевірку JWT токену
    // Поки що просто пропускаємо
    next();
};

// Middleware для логування помилок валідації
const errorLogger = (err, req, res, next) => {
    if (err.isJoi) {
        logger.error('Joi Validation Error', {
            error: err.message,
            details: err.details,
            endpoint: req.path,
            method: req.method,
            ip: req.ip
        });

        return res.status(400).json({
            success: false,
            error: 'Validation error',
            details: err.details
        });
    }

    // Інші помилки
    logger.error('Unhandled API Error', {
        error: err.message,
        stack: err.stack,
        endpoint: req.path,
        method: req.method,
        ip: req.ip
    });

    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
};

// Middleware для санітізації вводу
const sanitizeInput = (req, res, next) => {
    // Базова санітізація для запобігання XSS
    const sanitize = (obj) => {
        if (typeof obj === 'string') {
            return obj
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/javascript:/gi, '')
                .replace(/on\w+\s*=/gi, '');
        }
        
        if (typeof obj === 'object' && obj !== null) {
            const sanitized = {};
            for (const [key, value] of Object.entries(obj)) {
                sanitized[key] = sanitize(value);
            }
            return sanitized;
        }
        
        return obj;
    };

    if (req.body) {
        req.body = sanitize(req.body);
    }
    
    if (req.query) {
        req.query = sanitize(req.query);
    }
    
    if (req.params) {
        req.params = sanitize(req.params);
    }

    next();
};

// Валідатори для конкретних ендпоінтів
const validators = {
    statsQuery: createValidator(schemas.statsQuery, 'query'),
    topDonorsQuery: createValidator(schemas.topDonorsQuery, 'query'),
    recentDonationsQuery: createValidator(schemas.recentDonationsQuery, 'query'),
    testDonation: createValidator(schemas.testDonation, 'query'),
    pagination: createValidator(schemas.pagination, 'query')
};

module.exports = {
    schemas,
    validators,
    rateLimiters,
    validateAuth,
    errorLogger,
    sanitizeInput,
    createValidator
};