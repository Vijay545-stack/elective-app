const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { withLock } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const QUESTION_TYPES = ['short_answer', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'elective'];
const CHOICE_TYPES = ['multiple_choice', 'checkboxes', 'dropdown', 'elective'];

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.teacherId) {
    return res.status(401).json({ ok: false, error: 'Please log in.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ ok: false, error: 'Admin login required.' });
  }
  next();
}

// Which standard student-identity fields a form collects. Defaults to all
// four (matches original behavior); a teacher can turn any of them off.
function buildStudentFields(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    name: src.name !== false,
    registerNo: src.registerNo !== false,
    department: src.department !== false,
    email: src.email !== false
  };
}
function getStudentFields(form) {
  return form.studentFields || { name: true, registerNo: true, department: true, email: true };
}
function studentFieldColumns(fields) {
  const cols = [];
  if (fields.name) cols.push({ key: 'name', label: 'Student Name' });
  if (fields.registerNo) cols.push({ key: 'registerNo', label: 'Register Number' });
  if (fields.department) cols.push({ key: 'department', label: 'Department' });
  if (fields.email) cols.push({ key: 'email', label: 'Email' });
  return cols;
}

/* ---------------------- FORM / QUESTION HELPERS ---------------------- */

// Normalizes+validates the teacher-submitted question list into a clean,
// server-owned shape. Throws with a friendly message on bad input.
function buildQuestions(questionsInput, isQuiz) {
  const questions = (Array.isArray(questionsInput) ? questionsInput : []).map(q => {
    const type = QUESTION_TYPES.includes(q.type) ? q.type : 'short_answer';
    const label = String(q.label || '').trim();
    const required = q.required !== false; // default true
    const question = { id: uuidv4(), type, label, required };

    if (CHOICE_TYPES.includes(type)) {
      const rawOptions = Array.isArray(q.options) ? q.options : [];
      question.options = rawOptions
        .map(o => {
          const opt = { id: uuidv4(), text: String(o.text || '').trim() };
          if (type === 'elective') {
            opt.capacity = Math.max(parseInt(o.capacity, 10) || 0, 0);
          }
          return opt;
        })
        .filter(o => o.text && (type !== 'elective' || o.capacity > 0));

      if (isQuiz && type !== 'elective') {
        const correctTexts = new Set(
          (Array.isArray(q.correctOptionIndexes) ? q.correctOptionIndexes : [])
            .map(i => rawOptions[i] && String(rawOptions[i].text || '').trim())
            .filter(Boolean)
        );
        question.correctOptionIds = question.options
          .filter(o => correctTexts.has(o.text))
          .map(o => o.id);
        question.points = Math.max(parseInt(q.points, 10) || 1, 0);
      }
    }
    return question;
  }).filter(q => {
    if (!q.label) return false;
    if (CHOICE_TYPES.includes(q.type) && q.options.length < (q.type === 'checkboxes' ? 1 : 2) && q.type !== 'elective') {
      return q.options.length >= 1; // be lenient; UI already nudges for 2+
    }
    if (CHOICE_TYPES.includes(q.type) && !q.options.length) return false;
    return true;
  });

  return questions;
}

// Adds live "taken/remaining" counts to every elective-type question's options.
function withElectiveStatus(form, responses) {
  const takenByOptionId = {};
  responses
    .filter(r => r.formId === form.id)
    .forEach(r => {
      (r.answers || []).forEach(a => {
        if (Array.isArray(a.value)) {
          a.value.forEach(v => { takenByOptionId[v] = (takenByOptionId[v] || 0) + 1; });
        } else if (a.value) {
          takenByOptionId[a.value] = (takenByOptionId[a.value] || 0) + 1;
        }
      });
    });

  return {
    ...form,
    questions: form.questions.map(q => {
      if (q.type !== 'elective') return q;
      return {
        ...q,
        options: q.options.map(o => {
          const taken = takenByOptionId[o.id] || 0;
          return { ...o, taken, remaining: Math.max(o.capacity - taken, 0) };
        })
      };
    })
  };
}

function gradeResponse(form, answers) {
  if (!form.isQuiz) return { score: null, maxScore: null };
  let score = 0;
  let maxScore = 0;
  form.questions.forEach(q => {
    if (!CHOICE_TYPES.includes(q.type) || q.type === 'elective' || !q.correctOptionIds) return;
    maxScore += q.points || 0;
    const answer = answers.find(a => a.questionId === q.id);
    if (!answer) return;
    const given = Array.isArray(answer.value) ? answer.value.slice().sort() : [answer.value];
    const correct = q.correctOptionIds.slice().sort();
    const isMatch = given.length === correct.length && given.every((v, i) => v === correct[i]);
    if (isMatch) score += q.points || 0;
  });
  return { score, maxScore };
}

/* ---------------------- AUTH ---------------------- */

app.post('/api/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  const securityQuestion = String(req.body.securityQuestion || '').trim();
  const securityAnswer = String(req.body.securityAnswer || '').trim();

  if (!email || !password || password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email and a password of at least 6 characters.' });
  }
  if (!securityQuestion || !securityAnswer) {
    return res.status(400).json({ ok: false, error: 'Add a security question and answer for password recovery.' });
  }

  try {
    const teacherId = await withLock(async (data) => {
      if (data.teachers.some(t => t.email === email)) {
        throw new Error('An account with that email already exists.');
      }
      const id = uuidv4();
      const passwordHash = await bcrypt.hash(password, 10);
      const securityAnswerHash = await bcrypt.hash(securityAnswer.toLowerCase(), 10);
      data.teachers.push({
        id,
        email,
        name: name || email.split('@')[0],
        passwordHash,
        securityQuestion,
        securityAnswerHash,
        createdAt: new Date().toISOString()
      });
      require('./db').save(data);
      return id;
    });
    req.session.teacherId = teacherId;
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const data = require('./db').load();
  const teacher = data.teachers.find(t => t.email === email);
  if (!teacher) {
    return res.status(400).json({ ok: false, error: 'No account with that email.' });
  }
  const match = await bcrypt.compare(password, teacher.passwordHash);
  if (!match) {
    return res.status(400).json({ ok: false, error: 'Incorrect password.' });
  }
  req.session.teacherId = teacher.id;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.teacherId) return res.json({ ok: true, teacher: null });
  const data = require('./db').load();
  const teacher = data.teachers.find(t => t.id === req.session.teacherId);
  res.json({ ok: true, teacher: teacher ? { id: teacher.id, email: teacher.email, name: teacher.name, wallpaperUrl: teacher.wallpaperUrl || '' } : null });
});

// Lets a teacher set (or clear, by sending an empty string) a background
// image URL for their own dashboard. Purely cosmetic, stored per-teacher.
app.patch('/api/me/wallpaper', requireAuth, async (req, res) => {
  const wallpaperUrl = String(req.body.wallpaperUrl || '').trim();
  try {
    await withLock(async (data) => {
      const teacher = data.teachers.find(t => t.id === req.session.teacherId);
      if (!teacher) throw new Error('Account not found.');
      teacher.wallpaperUrl = wallpaperUrl;
      require('./db').save(data);
    });
    res.json({ ok: true, wallpaperUrl });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ---- Forgot password: look up security question, then verify + reset ---- */

app.post('/api/forgot-password/question', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const data = require('./db').load();
  const teacher = data.teachers.find(t => t.email === email);
  if (!teacher) {
    return res.status(400).json({ ok: false, error: 'No account with that email.' });
  }
  res.json({ ok: true, question: teacher.securityQuestion });
});

app.post('/api/forgot-password/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const answer = String(req.body.answer || '').trim().toLowerCase();
  const newPassword = String(req.body.newPassword || '');

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
  }

  try {
    await withLock(async (data) => {
      const teacher = data.teachers.find(t => t.email === email);
      if (!teacher) throw new Error('No account with that email.');

      const match = await bcrypt.compare(answer, teacher.securityAnswerHash);
      if (!match) throw new Error('That answer does not match what we have on file.');

      teacher.passwordHash = await bcrypt.hash(newPassword, 10);
      require('./db').save(data);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* ---------------------- TEACHER: FORMS ---------------------- */

app.post('/api/forms', requireAuth, async (req, res) => {
  const title = String(req.body.title || '').trim() || 'Untitled form';
  const description = String(req.body.description || '').trim();
  const collegeName = String(req.body.collegeName || '').trim();
  const department = String(req.body.department || '').trim();
  const isQuiz = !!req.body.isQuiz;
  const studentFields = buildStudentFields(req.body.studentFields);

  const questions = buildQuestions(req.body.questions, isQuiz);
  if (!questions.length) {
    return res.status(400).json({ ok: false, error: 'Add at least one question.' });
  }

  const formId = await withLock(async (data) => {
    const id = uuidv4();
    data.forms.push({
      id,
      teacherId: req.session.teacherId,
      title,
      description,
      collegeName,
      department,
      isQuiz,
      studentFields,
      questions,
      closed: false,
      createdAt: new Date().toISOString()
    });
    require('./db').save(data);
    return id;
  });

  res.json({ ok: true, formId });
});

app.get('/api/forms', requireAuth, (req, res) => {
  const data = require('./db').load();
  const myForms = data.forms.filter(f => f.teacherId === req.session.teacherId);
  const withCounts = myForms.map(f => {
    const responseCount = data.responses.filter(r => r.formId === f.id).length;
    return {
      id: f.id,
      title: f.title,
      description: f.description,
      collegeName: f.collegeName || '',
      department: f.department || '',
      isQuiz: !!f.isQuiz,
      questionCount: f.questions.length,
      closed: !!f.closed,
      createdAt: f.createdAt,
      responseCount
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, forms: withCounts });
});

app.get('/api/forms/:id', requireAuth, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });
  res.json({ ok: true, form });
});

app.get('/api/forms/:id/export', requireAuth, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });

  const rows = data.responses.filter(r => r.formId === form.id);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${form.title.replace(/[^a-z0-9]/gi, '_')}_responses.csv"`);
  res.send(buildCsv(form, rows));
});

function csvEscape(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}
function formatAnswer(value, optionTextById) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(v => optionTextById[v] || v).join('; ');
  return optionTextById[value] || value;
}

// Shared by the teacher and admin CSV-export routes.
function buildCsv(form, rows) {
  const optionTextById = {};
  form.questions.forEach(q => (q.options || []).forEach(o => { optionTextById[o.id] = o.text; }));
  const fields = getStudentFields(form);
  const cols = studentFieldColumns(fields);

  const header = ['Timestamp']
    .concat(cols.map(c => c.label))
    .concat(form.questions.map(q => q.label))
    .concat(form.isQuiz ? ['Score'] : []);
  const csvLines = [header.map(csvEscape).join(',')];

  rows.forEach(r => {
    const answerByQ = Object.fromEntries((r.answers || []).map(a => [a.questionId, a.value]));
    const row = [r.createdAt]
      .concat(cols.map(c => r[c.key] || ''))
      .concat(form.questions.map(q => formatAnswer(answerByQ[q.id], optionTextById)))
      .concat(form.isQuiz ? [`${r.score ?? ''}/${r.maxScore ?? ''}`] : []);
    csvLines.push(row.map(csvEscape).join(','));
  });

  return csvLines.join('\n');
}

// Shared by the teacher and admin responses-listing routes.
function buildResponsesPayload(form, rows) {
  const optionTextById = {};
  form.questions.forEach(q => (q.options || []).forEach(o => { optionTextById[o.id] = o.text; }));
  const fields = getStudentFields(form);

  return rows
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(r => ({
      name: fields.name ? r.name : undefined,
      registerNo: fields.registerNo ? r.registerNo : undefined,
      department: fields.department ? (r.department || '') : undefined,
      email: fields.email ? r.email : undefined,
      createdAt: r.createdAt,
      score: r.score,
      maxScore: r.maxScore,
      answers: (r.answers || []).map(a => {
        const q = form.questions.find(qq => qq.id === a.questionId);
        return {
          questionId: a.questionId,
          label: q ? q.label : '(removed question)',
          value: formatAnswer(a.value, optionTextById)
        };
      })
    }));
}

app.get('/api/forms/:id/responses', requireAuth, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });

  const rows = data.responses.filter(r => r.formId === form.id);
  res.json({
    ok: true,
    form: { title: form.title, isQuiz: !!form.isQuiz, questions: form.questions, studentFields: getStudentFields(form) },
    responses: buildResponsesPayload(form, rows)
  });
});

app.patch('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    const updated = await withLock(async (data) => {
      const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
      if (!form) throw new Error('Form not found.');

      // Simple toggle used from the dashboard (Close/Reopen).
      if (typeof req.body.closed === 'boolean') form.closed = req.body.closed;

      // Full edit, used from "Edit form" — every field is optional so this
      // route still works for the simple {closed} toggle above.
      if (req.body.title !== undefined) form.title = String(req.body.title || '').trim() || 'Untitled form';
      if (req.body.description !== undefined) form.description = String(req.body.description || '').trim();
      if (req.body.collegeName !== undefined) form.collegeName = String(req.body.collegeName || '').trim();
      if (req.body.department !== undefined) form.department = String(req.body.department || '').trim();
      if (req.body.isQuiz !== undefined) form.isQuiz = !!req.body.isQuiz;
      if (req.body.studentFields !== undefined) form.studentFields = buildStudentFields(req.body.studentFields);
      if (req.body.questions !== undefined) {
        const questions = buildQuestions(req.body.questions, form.isQuiz);
        if (!questions.length) throw new Error('Add at least one question.');
        form.questions = questions;
      }

      require('./db').save(data);
      return form;
    });
    res.json({ ok: true, form: updated, closed: !!updated.closed });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    await withLock(async (data) => {
      const idx = data.forms.findIndex(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
      if (idx === -1) throw new Error('Form not found.');
      data.forms.splice(idx, 1);
      data.responses = data.responses.filter(r => r.formId !== req.params.id);
      require('./db').save(data);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

/* ---------------------- ADMIN: SEE EVERY TEACHER'S FORMS ---------------------- */
// Admin credentials come from environment variables (set these in Render's
// dashboard under Environment): ADMIN_EMAIL and ADMIN_PASSWORD.
// If they're not set, admin login is disabled (always rejected) — safe default.

app.post('/api/admin/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');

  if (!adminEmail || !adminPassword) {
    return res.status(400).json({ ok: false, error: 'Admin login is not configured on this server yet.' });
  }
  if (email !== adminEmail || password !== adminPassword) {
    return res.status(400).json({ ok: false, error: 'Incorrect admin email or password.' });
  }
  req.session.isAdmin = true;
  req.session.adminEmail = adminEmail;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  req.session.adminEmail = null;
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ ok: true, admin: !!req.session.isAdmin ? { email: req.session.adminEmail } : null });
});

// Every form from every teacher — same shape as GET /api/forms, plus who made it.
app.get('/api/admin/forms', requireAdmin, (req, res) => {
  const data = require('./db').load();
  const teacherById = Object.fromEntries(data.teachers.map(t => [t.id, t]));
  const withCounts = data.forms.map(f => {
    const responseCount = data.responses.filter(r => r.formId === f.id).length;
    const teacher = teacherById[f.teacherId];
    return {
      id: f.id,
      title: f.title,
      description: f.description,
      collegeName: f.collegeName || '',
      department: f.department || '',
      isQuiz: !!f.isQuiz,
      questionCount: f.questions.length,
      closed: !!f.closed,
      createdAt: f.createdAt,
      responseCount,
      teacherName: teacher ? teacher.name : '(deleted teacher)',
      teacherEmail: teacher ? teacher.email : ''
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, forms: withCounts });
});

app.get('/api/admin/forms/:id/responses', requireAdmin, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });

  const rows = data.responses.filter(r => r.formId === form.id);
  res.json({
    ok: true,
    form: { title: form.title, isQuiz: !!form.isQuiz, questions: form.questions, studentFields: getStudentFields(form) },
    responses: buildResponsesPayload(form, rows)
  });
});

app.get('/api/admin/forms/:id/export', requireAdmin, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });

  const rows = data.responses.filter(r => r.formId === form.id);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${form.title.replace(/[^a-z0-9]/gi, '_')}_responses.csv"`);
  res.send(buildCsv(form, rows));
});

app.patch('/api/admin/forms/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await withLock(async (data) => {
      const form = data.forms.find(f => f.id === req.params.id);
      if (!form) throw new Error('Form not found.');
      if (typeof req.body.closed === 'boolean') form.closed = req.body.closed;
      require('./db').save(data);
      return form;
    });
    res.json({ ok: true, closed: !!updated.closed });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

app.delete('/api/admin/forms/:id', requireAdmin, async (req, res) => {
  try {
    await withLock(async (data) => {
      const idx = data.forms.findIndex(f => f.id === req.params.id);
      if (idx === -1) throw new Error('Form not found.');
      data.forms.splice(idx, 1);
      data.responses = data.responses.filter(r => r.formId !== req.params.id);
      require('./db').save(data);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

/* ---------------------- PUBLIC: STUDENT VIEW ---------------------- */

app.get('/api/public/forms/:id', (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id);
  if (!form) return res.status(404).json({ ok: false, error: 'This form does not exist or was removed.' });

  const withStatus = withElectiveStatus(form, data.responses);
  res.json({
    ok: true,
    form: {
      id: form.id,
      title: form.title,
      description: form.description,
      collegeName: form.collegeName || '',
      department: form.department || '',
      isQuiz: !!form.isQuiz,
      closed: !!form.closed,
      studentFields: getStudentFields(form),
      // Never leak correct answers to the public form.
      questions: withStatus.questions.map(q => {
        const { correctOptionIds, ...rest } = q;
        return rest;
      })
    }
  });
});

app.post('/api/public/forms/:id/responses', async (req, res) => {
  const formId = req.params.id;
  const name = String(req.body.name || '').trim();
  const registerNo = String(req.body.registerNo || '').trim();
  const department = String(req.body.department || '').trim();
  const email = String(req.body.email || '').trim();
  const answersInput = Array.isArray(req.body.answers) ? req.body.answers : [];
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  try {
    const result = await withLock(async (data) => {
      const form = data.forms.find(f => f.id === formId);
      if (!form) throw new Error('This form does not exist or was removed.');
      if (form.closed) throw new Error('This form is closed and no longer accepting responses.');

      // Only the student-info fields the teacher chose to collect for this
      // form are required — others are simply not stored.
      const fields = getStudentFields(form);
      const missing = [];
      if (fields.name && !name) missing.push('name');
      if (fields.registerNo && !registerNo) missing.push('register number');
      if (fields.department && !department) missing.push('department');
      if (fields.email && !email) missing.push('email');
      if (missing.length) throw new Error(`Please fill in your ${missing.join(', ')}.`);
      if (fields.email && email && !emailPattern.test(email)) throw new Error('That email address looks invalid.');

      // Duplicate-submission protection only applies when register number is
      // actually being collected for this form.
      if (fields.registerNo && registerNo) {
        const alreadyRegistered = data.responses.some(
          r => r.formId === formId && r.registerNo && r.registerNo.toLowerCase() === registerNo.toLowerCase()
        );
        if (alreadyRegistered) throw new Error('This register number has already submitted a response for this form.');
      }

      const answerByQ = Object.fromEntries(answersInput.map(a => [a.questionId, a.value]));
      const cleanAnswers = [];
      const electiveStatus = withElectiveStatus(form, data.responses);

      for (const q of form.questions) {
        const raw = answerByQ[q.id];
        const isEmpty = raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0);
        if (q.required && isEmpty) {
          throw new Error(`Please answer: "${q.label}"`);
        }
        if (isEmpty) continue;

        if (q.type === 'checkboxes') {
          const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
          const validIds = new Set(q.options.map(o => o.id));
          const filtered = values.filter(v => validIds.has(v));
          cleanAnswers.push({ questionId: q.id, value: filtered });
        } else if (CHOICE_TYPES.includes(q.type)) {
          const value = String(raw);
          const opt = q.options.find(o => o.id === value);
          if (!opt) throw new Error(`Invalid choice for: "${q.label}"`);
          if (q.type === 'elective') {
            const liveOpt = electiveStatus.questions.find(qq => qq.id === q.id).options.find(o => o.id === value);
            if (liveOpt.remaining <= 0) throw new Error(`Sorry, "${opt.text}" just filled up. Please pick another option for "${q.label}".`);
          }
          cleanAnswers.push({ questionId: q.id, value });
        } else {
          cleanAnswers.push({ questionId: q.id, value: String(raw).trim() });
        }
      }

      const { score, maxScore } = gradeResponse(form, cleanAnswers);

      data.responses.push({
        id: uuidv4(),
        formId,
        name: fields.name ? name : '',
        registerNo: fields.registerNo ? registerNo : '',
        department: fields.department ? department : '',
        email: fields.email ? email : '',
        answers: cleanAnswers,
        score,
        maxScore,
        createdAt: new Date().toISOString()
      });
      require('./db').save(data);
      return { score, maxScore };
    });

    const message = form_isQuizMessage(result);
    res.json({ ok: true, message, score: result.score, maxScore: result.maxScore });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

function form_isQuizMessage(result) {
  if (result.maxScore == null) return 'Your response has been recorded.';
  return `Your response has been recorded. You scored ${result.score} out of ${result.maxScore}.`;
}

// Unknown API routes get a proper JSON 404 instead of silently returning the HTML page
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Not found.' });
});

// Any other route falls through to the single-page app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Form builder server running on http://localhost:${PORT}`);
});
