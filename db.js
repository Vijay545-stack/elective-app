const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');

function emptyData() {
  return { teachers: [], forms: [], responses: [] };
}

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.teachers) data.teachers = [];
    if (!data.forms) data.forms = [];
    if (!data.responses) data.responses = [];
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      const fresh = emptyData();
      save(fresh);
      return fresh;
    }
    throw err;
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Simple in-process mutex so concurrent requests never read-modify-write
// the JSON file at the same time and clobber each other's changes.
let queue = Promise.resolve();

function withLock(fn) {
  const run = queue.then(async () => {
    const data = load();
    return fn(data);
  });
  // Keep the queue moving even if fn() throws, so later callers aren't stuck.
  queue = run.then(() => {}, () => {});
  return run;
}

module.exports = { load, save, withLock };
