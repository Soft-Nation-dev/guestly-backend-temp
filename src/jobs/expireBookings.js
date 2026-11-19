const cron = require('node-cron');

function startExpireBookingsJob() {
  return cron.schedule('*/5 * * * *', () => {
    // Booking expiration behavior will be added with the bookings module.
  });
}

module.exports = startExpireBookingsJob;

