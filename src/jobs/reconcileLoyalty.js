const logger = require('../config/logger');
const { reconcileAll } = require('../modules/loyalty/service');

let task = null;
function start() {
  if (task) return task;
  task = require('node-cron').schedule('15 13 * * *', () => {
    reconcileAll().catch(error => logger.error('Loyalty reconciliation failed', { message: error.message }));
  }, { timezone: 'Africa/Lagos' });
  return task;
}
module.exports = { start };
