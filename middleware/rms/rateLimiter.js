import rateLimit from 'express-rate-limit';

// OTP generation rate limiter - 5 requests per IP per 15 minutes
export const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: true, message: 'Too many OTP requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
});

// OTP verification rate limiter - 5 attempts per IP per 15 minutes
export const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: true, message: 'Too many verification attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
});

// Search rate limiter - 30 requests per IP per minute
export const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: true, message: 'Too many search requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
});

// General API rate limiter - 100 requests per IP per minute
export const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: true, message: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
});
