const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');
const { withLock } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.teacherId) {
    return res.status(401).json({
      ok: false,
      error: 'Please log in.'
    });
  }
  next();
}

function computeElectiveStatus(form, responses) {
  const taken = {};

  responses
    .filter(r => r.formId === form.id)
    .forEach(r => {
      taken[r.electiveId] = (taken[r.electiveId] || 0) + 1;
    });

  return form.electives.map(el => {
    const t = taken[el.id] || 0;

    return {
      ...el,
      taken: t,
      remaining: Math.max(el.capacity - t, 0)
    };
  });
}


/* =========================
   AUTH
========================= */

app.post('/api/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();

  if (!email || !password || password.length < 6) {
    return res.status(400).json({
      ok: false,
      error: 'Enter a valid email and a password of at least 6 characters.'
    });
  }

  try {
    const teacherId = await withLock(async data => {
      if (data.teachers.some(t => t.email === email)) {
        throw new Error('An account with that email already exists.');
      }

      const id = uuidv4();
      const passwordHash = await bcrypt.hash(password, 10);

      data.teachers.push({
        id,
        email,
        name: name || email.split('@')[0],
        passwordHash,
        createdAt: new Date().toISOString()
      });

      db.save(data);
      return id;
    });

    req.session.teacherId = teacherId;

    res.json({ ok: true });

  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err.message
    });
  }
});


app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const data = db.load();

  const teacher = data.teachers.find(t => t.email === email);

  if (!teacher) {
    return res.status(400).json({
      ok: false,
      error: 'No account with that email.'
    });
  }

  const match = await bcrypt.compare(password, teacher.passwordHash);

  if (!match) {
    return res.status(400).json({
      ok: false,
      error: 'Incorrect password.'
    });
  }

  req.session.teacherId = teacher.id;

  res.json({ ok: true });
});


app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});


app.get('/api/me', (req, res) => {
  if (!req.session.teacherId) {
    return res.json({
      ok: true,
      teacher: null
    });
  }

  const data = db.load();

  const teacher = data.teachers.find(
    t => t.id === req.session.teacherId
  );

  res.json({
    ok: true,
    teacher: teacher
      ? {
          id: teacher.id,
          email: teacher.email,
          name: teacher.name
        }
      : null
  });
});


/* =========================
   TEACHER FORMS
========================= */

app.post('/api/forms', requireAuth, async (req, res) => {

  const title =
    String(req.body.title || '').trim() || 'Untitled form';

  const description =
    String(req.body.description || '').trim();

  const electivesInput =
    Array.isArray(req.body.electives)
      ? req.body.electives
      : [];

  const electives = electivesInput
    .map(el => ({
      id: uuidv4(),
      name: String(el.name || '').trim(),
      capacity: Math.max(
        parseInt(el.capacity, 10) || 0,
        0
      )
    }))
    .filter(el => el.name && el.capacity > 0);

  if (!electives.length) {
    return res.status(400).json({
      ok: false,
      error: 'Add at least one elective with a seat count above 0.'
    });
  }

  const formId = await withLock(async data => {

    const id = uuidv4();

    data.forms.push({
      id,
      teacherId: req.session.teacherId,

      /* Fixed college */
      collegeName: 'KCG College of Technology',

      title,
      description,
      electives,

      createdAt: new Date().toISOString()
    });

    db.save(data);

    return id;
  });

  res.json({
    ok: true,
    formId
  });
});


app.get('/api/forms', requireAuth, (req, res) => {

  const data = db.load();

  const myForms = data.forms.filter(
    f => f.teacherId === req.session.teacherId
  );

  const withCounts = myForms.map(f => {

    const status = computeElectiveStatus(
      f,
      data.responses
    );

    const totalTaken = status.reduce(
      (sum, el) => sum + el.taken,
      0
    );

    const totalCapacity = status.reduce(
      (sum, el) => sum + el.capacity,
      0
    );

    return {
      id: f.id,
      title: f.title,
      description: f.description,
      collegeName: f.collegeName || 'KCG College of Technology',
      createdAt: f.createdAt,
      totalTaken,
      totalCapacity
    };

  }).sort(
    (a, b) =>
      new Date(b.createdAt) -
      new Date(a.createdAt)
  );

  res.json({
    ok: true,
    forms: withCounts
  });
});


/* =========================
   CSV EXPORT
========================= */

app.get(
  '/api/forms/:id/export',
  requireAuth,
  (req, res) => {

    const data = db.load();

    const form = data.forms.find(
      f =>
        f.id === req.params.id &&
        f.teacherId === req.session.teacherId
    );

    if (!form) {
      return res.status(404).json({
        ok: false,
        error: 'Form not found.'
      });
    }

    const rows = data.responses.filter(
      r => r.formId === form.id
    );

    const electiveNameById = Object.fromEntries(
      form.electives.map(el => [
        el.id,
        el.name
      ])
    );

    const csvLines = [
      'Timestamp,Student Name,Register Number,Department,Elective,Email'
    ];

    rows.forEach(r => {

      const line = [
        r.createdAt,
        r.name,
        r.registerNo,
        r.department || '',
        electiveNameById[r.electiveId] || '',
        r.email
      ]
        .map(v =>
          `"${String(v).replace(/"/g, '""')}"`
        )
        .join(',');

      csvLines.push(line);
    });

    const safeTitle =
      form.title.replace(/[^a-z0-9]/gi, '_');

    res.setHeader(
      'Content-Type',
      'text/csv; charset=utf-8'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeTitle}_responses.csv"`
    );

    res.send(csvLines.join('\n'));
  }
);


/* =========================
   PUBLIC FORM
========================= */

app.get(
  '/api/public/forms/:id',
  (req, res) => {

    const data = db.load();

    const form = data.forms.find(
      f => f.id === req.params.id
    );

    if (!form) {
      return res.status(404).json({
        ok: false,
        error: 'This form does not exist or was removed.'
      });
    }

    const status = computeElectiveStatus(
      form,
      data.responses
    );

    res.json({
      ok: true,

      form: {
        id: form.id,

        collegeName:
          form.collegeName ||
          'KCG College of Technology',

        title: form.title,

        description:
          form.description,

        electives: status
      }
    });
  }
);


/* =========================
   STUDENT RESPONSE
========================= */

app.post(
  '/api/public/forms/:id/responses',
  async (req, res) => {

    const formId = req.params.id;

    const name =
      String(req.body.name || '').trim();

    const registerNo =
      String(req.body.registerNo || '').trim();

    const department =
      String(req.body.department || '').trim();

    const email =
      String(req.body.email || '').trim();

    const electiveId =
      String(req.body.electiveId || '').trim();

    if (
      !name ||
      !registerNo ||
      !department ||
      !email ||
      !electiveId
    ) {
      return res.status(400).json({
        ok: false,
        error: 'All fields are required.'
      });
    }

    const emailPattern =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
      return res.status(400).json({
        ok: false,
        error: 'That email address looks invalid.'
      });
    }

    try {

      const message = await withLock(async data => {

        const form = data.forms.find(
          f => f.id === formId
        );

        if (!form) {
          throw new Error(
            'This form does not exist or was removed.'
          );
        }

        const alreadyRegistered =
          data.responses.some(
            r =>
              r.formId === formId &&
              r.registerNo.toLowerCase() ===
                registerNo.toLowerCase()
          );

        if (alreadyRegistered) {
          throw new Error(
            'This register number has already submitted a response for this form.'
          );
        }

        const elective =
          form.electives.find(
            el => el.id === electiveId
          );

        if (!elective) {
          throw new Error(
            'That elective no longer exists on this form.'
          );
        }

        const status =
          computeElectiveStatus(
            form,
            data.responses
          );

        const liveElective =
          status.find(
            el => el.id === electiveId
          );

        if (liveElective.remaining <= 0) {
          throw new Error(
            'Sorry, that elective just filled up. Please pick another.'
          );
        }

        data.responses.push({
          id: uuidv4(),
          formId,
          electiveId,

          name,
          registerNo,
          department,
          email,

          createdAt:
            new Date().toISOString()
        });

        db.save(data);

        return `You're registered for ${elective.name}.`;
      });

      res.json({
        ok: true,
        message
      });

    } catch (err) {

      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);


/* =========================
   SPA FALLBACK
========================= */

app.get(/.*/, (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'public',
      'index.html'
    )
  );
});


app.listen(PORT, () => {
  console.log(
    `Elective registration server running on http://localhost:${PORT}`
  );
});
