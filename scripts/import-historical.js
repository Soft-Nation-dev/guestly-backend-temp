const mongoose = require('mongoose');
const Historical = require('../src/modules/historical/model');
const { validateSources } = require('../src/modules/historical/validation');

const names = ['bookings', 'guests', 'payments', 'service-requests'];

function loadSources() {
  return Object.fromEntries(names.map(name => [name, require('../data/historical/' + name + '.json')]));
}

async function importHistorical({ apply = false, model = Historical } = {}) {
  const { rows, summary } = validateSources(loadSources());
  if (!apply) return { ...summary, mode: 'dry-run', inserted: 0, alreadyPresent: 0 };

  let inserted = 0;
  let alreadyPresent = 0;
  for (const source of names) {
    const subset = rows.filter(item => item.source === source);
    const stored = await model.find({ source }).select('rowKey hash').lean();
    const hashes = new Map(stored.map(item => [item.rowKey, item.hash]));
    for (const item of subset) {
      if (hashes.has(item.rowKey) && hashes.get(item.rowKey) !== item.hash) {
        throw new Error(source + ': source record changed since import: ' + item.rowKey);
      }
    }
    alreadyPresent += subset.filter(item => hashes.has(item.rowKey)).length;
    const additions = subset.filter(item => !hashes.has(item.rowKey));
    for (let offset = 0; offset < additions.length; offset += 100) {
      const batch = additions.slice(offset, offset + 100);
      const result = await model.bulkWrite(batch.map(item => ({
        updateOne: {
          filter: { source: item.source, rowKey: item.rowKey },
          update: { $setOnInsert: item }, upsert: true,
        },
      })), { ordered: false });
      inserted += result.upsertedCount;
    }
  }
  return { ...summary, mode: 'applied', inserted, alreadyPresent };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg))) throw new Error('Only --apply and --dry-run are supported');
  const apply = args.includes('--apply') && !args.includes('--dry-run');
  if (apply) {
    const env = require('../src/config/env');
    await mongoose.connect(env.MONGODB_URI);
  }
  try {
    const report = await importHistorical({ apply });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (apply) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { loadSources, importHistorical };
