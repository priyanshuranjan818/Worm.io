'use strict';

/**
 * logger.js — Structured JSON logger using pino.
 *
 * In production (NODE_ENV=production): emits JSON lines → CloudWatch reads natively.
 * In development: pretty-prints with colours via pino-pretty.
 *
 * Usage: const logger = require('./logger');
 *        logger.info({ playerId }, 'Player joined');
 */

const pino = require('pino');
const cfg  = require('./config');

const transport = cfg.NODE_ENV !== 'production'
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
  : undefined;

const logger = pino(
  {
    level:       cfg.LOG_LEVEL,
    base:        { service: 'haxxworm-game-server', env: cfg.NODE_ENV },
    timestamp:   pino.stdTimeFunctions.isoTime,
    redact:      [], // add sensitive field paths here if needed
  },
  transport ? pino.transport(transport) : undefined,
);

module.exports = logger;
