import { config } from '../config/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.logLevel];

/**
 * Minimal structured logger. Logs are JSON in production (so a log aggregator
 * can index them) and human-readable in development.
 *
 * A dependency-free logger is enough at this size; the scaling notes in
 * docs/ARCHITECTURE.md cover moving to pino + a real log pipeline.
 */
function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;

  const record = { level, time: new Date().toISOString(), message, ...fields };

  if (config.isProduction) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }

  const extras = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  process.stdout.write(`${record.time} ${level.toUpperCase().padEnd(5)} ${message}${extras}\n`);
}

export const logger = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};

export default logger;
