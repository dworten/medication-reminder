'use strict';

const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');

function weekdayInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: timezone,
  }).format(date);
}

function shouldSkipDose(dose, date = new Date()) {
  return dose === 'morning' && weekdayInTimezone(date, config.timezone) === 'Sunday';
}

function start() {
  const callManager = require('./callManager');

  function trigger(dose) {
    return async () => {
      if (shouldSkipDose(dose)) {
        logger.info(`Cron skipped: ${dose} call`, {
          reason: 'Sunday morning Sunday school',
          timezone: config.timezone,
        });
        return;
      }

      logger.info(`Cron fired: ${dose} call`, { timezone: config.timezone });
      try {
        await callManager.initiateCall(dose, 1);
      } catch (err) {
        logger.error(`${dose} call failed`, { error: err.message });
      }
    };
  }

  cron.schedule(config.morningCron, trigger('morning'), { timezone: config.timezone });
  cron.schedule(config.eveningCron, trigger('evening'), { timezone: config.timezone });

  logger.info('Scheduler running', {
    morning:  config.morningCron,
    evening:  config.eveningCron,
    timezone: config.timezone,
    sundayMorning: 'skipped',
  });
}

module.exports = { start, shouldSkipDose, weekdayInTimezone };
