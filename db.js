const fs = require('fs');
const path = require('path');

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, 'data.json');

function emptyData() {
  return {
    teachers: [],
    forms: [],
    responses: [],

    // Faculty can enable/disable these student fields.
    studentFields: {
      name: true,
      registerNo: true,
      email: true,
      department: true
    }
  };
}

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);

    // Keep existing database data safe.
    if (!data.teachers) {
      data.teachers = [];
    }

    if (!data.forms) {
      data.forms = [];
    }

    if (!data.responses) {
      data.responses = [];
    }

    /*
     * Backward compatibility:
     * If your existing data.json doesn't have studentFields,
     * create it automatically.
     */
    if (!data.studentFields) {
      data.studentFields = {
        name: true,
        registerNo: true,
        email: true,
        department: true
      };
    }

    // Make sure every field has a valid true/false value.
    if (typeof data.studentFields.name !== 'boolean') {
      data.studentFields.name = true;
    }

    if (typeof data.studentFields.registerNo !== 'boolean') {
      data.studentFields.registerNo = true;
    }

    if (typeof data.studentFields.email !== 'boolean') {
      data.studentFields.email = true;
    }

    if (typeof data.studentFields.department !== 'boolean') {
      data.studentFields.department = true;
    }

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
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify(data, null, 2),
    'utf8'
  );
}


/*
 * Simple in-process lock.
 *
 * This prevents two requests from reading and writing
 * data.json at the same time and accidentally overwriting
 * each other's changes.
 */

let queue = Promise.resolve();

function withLock(fn) {

  const run = queue.then(async () => {

    const data = load();

    return fn(data);

  });

  // Keep the queue working even if one request fails.
  queue = run.then(
    () => {},
    () => {}
  );

  return run;
}


module.exports = {
  load,
  save,
  withLock
};
