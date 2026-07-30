'use strict';

const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');

let _tasks = [];

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

  _tasks = [
    cron.schedule(config.morningCron, trigger('morning'), { timezone: config.timezone }),
    cron.schedule(config.eveningCron, trigger('evening'), { timezone: config.timezone }),
  ];

  logger.info('Scheduler running', {
    morning:  config.morningCron,
    evening:  config.eveningCron,
    timezone: config.timezone,
    sundayMorning: 'skipped',
  });
}

// Called on SIGTERM so a deploy doesn't fire a cron job mid-shutdown.
function stop() {
  for (const task of _tasks) {
    try {
      task.stop();
    } catch (err) {
      logger.warn('Failed to stop cron task', { error: err.message });
    }
  }
  _tasks = [];
}

module.exports = { start, stop, shouldSkipDose, weekdayInTimezone };
