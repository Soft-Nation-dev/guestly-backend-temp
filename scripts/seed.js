const mongoose = require('mongoose');
const env = require('../src/config/env');
const Hotel = require('../src/modules/hotels/model');
const Room = require('../src/modules/rooms/model');
const hotel = require('../src/modules/hotels/defaults');

const rooms = [
  {
    slug: 'standard-cozy-haven', name: 'Standard Cozy Haven', category: 'Standard',
    image: '/images/standard-cozy-haven.jpg', nightlyRate: 55000, capacity: 2, size: 34,
    bed: 'Queen bed', view: 'City view', amenities: ['Wi-Fi', 'Rainfall shower', 'Breakfast included'],
    description: 'A warm, thoughtfully furnished retreat for a relaxed city stay.', inventory: 4, featured: true,
  },
  {
    slug: 'deluxe-executive-suite', name: 'Deluxe Executive Suite', category: 'Executive',
    image: '/images/deluxe-executive-suite.jpg', nightlyRate: 85000, capacity: 2, size: 62,
    bed: 'King bed', view: 'City view', amenities: ['High-speed Wi-Fi', 'Soaking bathtub', 'Lounge area'],
    description: 'Spacious interiors and refined comforts make this suite a peaceful escape.', inventory: 3, featured: true,
  },
  {
    slug: 'garden-view-room', name: 'Deluxe Garden Suite', category: 'Deluxe',
    image: '/images/garden-view-room.jpg', nightlyRate: 75000, capacity: 2, size: 38,
    bed: 'King bed', view: 'Garden view', amenities: ['Wi-Fi', 'Private balcony', 'Breakfast included'],
    description: 'Take in a calming garden view from this light-filled, comfortable suite.', inventory: 3, featured: true,
  },
  {
    slug: 'ocean-panorama-suite', name: 'Executive Ocean View Suite', category: 'Executive',
    image: '/images/ocean-panorama-suite.jpg', nightlyRate: 120000, capacity: 3, size: 54,
    bed: 'Super king bed', view: 'Ocean view', amenities: ['Lounge access', 'Jacuzzi', 'Wi-Fi'],
    description: 'Enjoy panoramic views and generous space for a memorable stay.', inventory: 2, featured: false,
  },
  {
    slug: 'city-view-room', name: 'Standard King Room', category: 'Standard',
    image: '/images/city-view-room.jpg', nightlyRate: 52000, capacity: 2, size: 26,
    bed: 'Queen bed', view: 'City view', amenities: ['Fast Wi-Fi', 'Work desk', 'Daily housekeeping'],
    description: 'A practical and inviting room for business or leisure.', inventory: 4, featured: false,
  },
  {
    slug: 'executive-suite', name: 'Executive Suite', category: 'Executive',
    image: '/images/executive-suite.jpg', nightlyRate: 95000, capacity: 3, size: 50,
    bed: 'King bed', view: 'Hotel grounds', amenities: ['Wi-Fi', 'Sitting area', 'Private bathroom'],
    description: 'An elegant suite with extra room to settle in and recharge.', inventory: 2, featured: false,
  },
];

async function seed() {
  await mongoose.connect(env.MONGODB_URI);
  await Hotel.updateOne({ key: 'primary' }, { $setOnInsert: { key: 'primary', ...hotel } }, { upsert: true });
  let created = 0;
  for (const room of rooms) {
    const result = await Room.updateOne({ slug: room.slug }, { $setOnInsert: room }, { upsert: true });
    if (result.upsertedCount) created += 1;
  }
  process.stdout.write('Hotel seeded; ' + created + ' room types created; existing rooms preserved\n');
}

seed().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
});
