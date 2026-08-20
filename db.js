/**
 * Tiny JSON-file database. Good enough for a class-scale app without
 * needing to install/configure a real database server.
 *
 * All reads/writes go through a promise queue (withLock) so two
 * requests arriving at the same instant (e.g. two students racing
 * for the last seat) can't corrupt the file or double-book a seat.
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const empty = { teachers: [], forms: [], responses: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// --- serialize all writes so concurrent requests don't race ---
let queue = Promise.resolve();
function withLock(fn) {
  const result = queue.then(() => {
    const data = load();
    return fn(data);
  });
  queue = result.catch(() => {}); // keep the chain alive even if one call throws
  return result;
}

module.exports = { load, save, withLock };
