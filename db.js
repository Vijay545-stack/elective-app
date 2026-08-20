const fs = require('fs');
const path = require('path');

// Simple JSON database for the Elective Registration app.
// The file data.json is created automatically in this same folder.
const DB_FILE = path.join(__dirname, 'data.json');

const DEFAULT_DATA = {
  teachers: [],
  forms: [],
  responses: [],
  studentFields: {
    name: true,
    registerNo: true,
    email: true,
    department: true
  }
};

let writeQueue = Promise.resolve();

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function ensureDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
  }
}

function load() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      teachers: Array.isArray(data.teachers) ? data.teachers : [],
      forms: Array.isArray(data.forms) ? data.forms : [],
      responses: Array.isArray(data.responses) ? data.responses : [],
      studentFields: data.studentFields || cloneDefault().studentFields
    };
  } catch (err) {
    console.error('Database read error:', err.message);
    return cloneDefault();
  }
}

function save(data) {
  ensureDb();
  const tempFile = DB_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempFile, DB_FILE);
}

function withLock(task) {
  const run = writeQueue.then(() => task(load()));
  writeQueue = run.catch(() => {});
  return run;
}

ensureDb();

module.exports = {
  DB_FILE,
  load,
  save,
  withLock
};
