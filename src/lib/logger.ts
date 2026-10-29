import pino from 'pino';

export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers["x-fortix-token"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'currentPassword',
  'newPassword',
  'secret',
  'secretHash',
  'rawKey',
  'token',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.secret',
  '*.secretHash',
  '*.rawKey',
  '*.token',
  'data.secret',
  'data.rawKey',
  'data.password',
  'data.token',
];

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: REDACTED_LOG_PATHS,
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
