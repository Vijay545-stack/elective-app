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
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.teacherId) return res.status(401).json({ ok: false, error: 'Please log in.' });
  next();
}

/* ---------------------- STUDENT FIELD SETTINGS ---------------------- */
function defaultStudentFields() {
  return { name: true, registerNo: true, email: true, department: true };
}

function normalizeStudentFields(fields) {
  const d = defaultStudentFields();
  return {
    name: typeof fields?.name === 'boolean' ? fields.name : d.name,
    registerNo: typeof fields?.registerNo === 'boolean' ? fields.registerNo : d.registerNo,
    email: typeof fields?.email === 'boolean' ? fields.email : d.email,
    department: typeof fields?.department === 'boolean' ? fields.department : d.department
  };
}

/* ---------------------- FORM / QUESTION HELPERS ---------------------- */
function buildQuestions(questionsInput, isQuiz) {
  const questions = (Array.isArray(questionsInput) ? questionsInput : []).map(q => {
    const type = QUESTION_TYPES.includes(q.type) ? q.type : 'short_answer';
    const label = String(q.label || '').trim();
    const required = q.required !== false;
    const question = { id: uuidv4(), type, label, required };

    if (CHOICE_TYPES.includes(type)) {
      const rawOptions = Array.isArray(q.options) ? q.options : [];
      question.options = rawOptions.map(o => {
        const opt = { id: uuidv4(), text: String(o.text || '').trim() };
        if (type === 'elective') opt.capacity = Math.max(parseInt(o.capacity, 10) || 0, 0);
        return opt;
      }).filter(o => o.text && (type !== 'elective' || o.capacity > 0));

      if (isQuiz && type !== 'elective') {
        const correctTexts = new Set((Array.isArray(q.correctOptionIndexes) ? q.correctOptionIndexes : [])
          .map(i => rawOptions[i] && String(rawOptions[i].text || '').trim()).filter(Boolean));
        question.correctOptionIds = question.options.filter(o => correctTexts.has(o.text)).map(o => o.id);
        question.points = Math.max(parseInt(q.points, 10) || 1, 0);
      }
    }
    return question;
  }).filter(q => {
    if (!q.label) return false;
    if (CHOICE_TYPES.includes(q.type) && q.options.length < (q.type === 'checkboxes' ? 1 : 2) && q.type !== 'elective') return q.options.length >= 1;
    if (CHOICE_TYPES.includes(q.type) && !q.options.length) return false;
    return true;
  });
  return questions;
}

function withElectiveStatus(form, responses) {
  const takenByOptionId = {};
  responses.filter(r => r.formId === form.id).forEach(r => {
    (r.answers || []).forEach(a => {
      if (Array.isArray(a.value)) a.value.forEach(v => { takenByOptionId[v] = (takenByOptionId[v] || 0) + 1; });
      else if (a.value) takenByOptionId[a.value] = (takenByOptionId[a.value] || 0) + 1;
    });
  });
  return {
    ...form,
    questions: form.questions.map(q => {
      if (q.type !== 'elective') return q;
      return { ...q, options: q.options.map(o => {
        const taken = takenByOptionId[o.id] || 0;
        return { ...o, taken, remaining: Math.max(o.capacity - taken, 0) };
      }) };
    })
  };
}

function gradeResponse(form, answers) {
  if (!form.isQuiz) return { score: null, maxScore: null };
  let score = 0, maxScore = 0;
  form.questions.forEach(q => {
    if (!CHOICE_TYPES.includes(q.type) || q.type === 'elective' || !q.correctOptionIds) return;
    maxScore += q.points || 0;
    const answer = answers.find(a => a.questionId === q.id);
    if (!answer) return;
    const given = Array.isArray(answer.value) ? answer.value.slice().sort() : [answer.value];
    const correct = q.correctOptionIds.slice().sort();
    if (given.length === correct.length && given.every((v, i) => v === correct[i])) score += q.points || 0;
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
  if (!email || !password || password.length < 6) return res.status(400).json({ ok: false, error: 'Enter a valid email and a password of at least 6 characters.' });
  if (!securityQuestion || !securityAnswer) return res.status(400).json({ ok: false, error: 'Add a security question and answer for password recovery.' });
  try {
    const teacherId = await withLock(async data => {
      if (data.teachers.some(t => t.email === email)) throw new Error('An account with that email already exists.');
      const id = uuidv4();
      const passwordHash = await bcrypt.hash(password, 10);
      const securityAnswerHash = await bcrypt.hash(securityAnswer.toLowerCase(), 10);
      data.teachers.push({ id, email, name: name || email.split('@')[0], passwordHash, securityQuestion, securityAnswerHash, createdAt: new Date().toISOString() });
      require('./db').save(data);
      return id;
    });
    req.session.teacherId = teacherId;
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const data = require('./db').load();
  const teacher = data.teachers.find(t => t.email === email);
  if (!teacher) return res.status(400).json({ ok: false, error: 'No account with that email.' });
  const match = await bcrypt.compare(password, teacher.passwordHash);
  if (!match) return res.status(400).json({ ok: false, error: 'Incorrect password.' });
  req.session.teacherId = teacher.id;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', (req, res) => {
  if (!req.session.teacherId) return res.json({ ok: true, teacher: null });
  const data = require('./db').load();
  const teacher = data.teachers.find(t => t.id === req.session.teacherId);
  res.json({ ok: true, teacher: teacher ? { id: teacher.id, email: teacher.email, name: teacher.name } : null });
});

app.post('/api/forgot-password/question', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const data = require('./db').load();
  const teacher = data.teachers.find(t => t.email === email);
  if (!teacher) return res.status(400).json({ ok: false, error: 'No account with that email.' });
  res.json({ ok: true, question: teacher.securityQuestion });
});

app.post('/api/forgot-password/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const answer = String(req.body.answer || '').trim().toLowerCase();
  const newPassword = String(req.body.newPassword || '');
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
  try {
    await withLock(async data => {
      const teacher = data.teachers.find(t => t.email === email);
      if (!teacher) throw new Error('No account with that email.');
      const match = await bcrypt.compare(answer, teacher.securityAnswerHash);
      if (!match) throw new Error('That answer does not match what we have on file.');
      teacher.passwordHash = await bcrypt.hash(newPassword, 10);
      require('./db').save(data);
    });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

/* ---------------------- TEACHER: STUDENT FIELD SETTINGS ---------------------- */
app.get('/api/student-fields', requireAuth, (req, res) => {
  const data = require('./db').load();
  res.json({ ok: true, fields: normalizeStudentFields(data.studentFields) });
});

app.put('/api/student-fields', requireAuth, async (req, res) => {
  try {
    const fields = normalizeStudentFields(req.body.fields);
    await withLock(async data => {
      data.studentFields = fields;
      require('./db').save(data);
    });
    res.json({ ok: true, fields });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

/* ---------------------- TEACHER: FORMS ---------------------- */
app.post('/api/forms', requireAuth, async (req, res) => {
  const title = String(req.body.title || '').trim() || 'Untitled form';
  const description = String(req.body.description || '').trim();
  const collegeName = String(req.body.collegeName || '').trim();
  const department = String(req.body.department || '').trim();
  const isQuiz = !!req.body.isQuiz;
  const questions = buildQuestions(req.body.questions, isQuiz);
  if (!questions.length) return res.status(400).json({ ok: false, error: 'Add at least one question.' });
  const formId = await withLock(async data => {
    const id = uuidv4();
    data.forms.push({
      id, teacherId: req.session.teacherId, title, description, collegeName, department,
      isQuiz, questions, closed: false,
      studentFields: normalizeStudentFields(data.studentFields),
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
  const withCounts = myForms.map(f => ({
    id: f.id, title: f.title, description: f.description,
    collegeName: f.collegeName || '', department: f.department || '', isQuiz: !!f.isQuiz,
    questionCount: f.questions.length, closed: !!f.closed, createdAt: f.createdAt,
    responseCount: data.responses.filter(r => r.formId === f.id).length,
    studentFields: normalizeStudentFields(f.studentFields || data.studentFields)
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, forms: withCounts });
});

app.get('/api/forms/:id', requireAuth, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });
  res.json({ ok: true, form: { ...form, studentFields: normalizeStudentFields(form.studentFields || data.studentFields) } });
});

app.get('/api/forms/:id/export', requireAuth, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });
  const rows = data.responses.filter(r => r.formId === form.id);
  const optionTextById = {};
  form.questions.forEach(q => (q.options || []).forEach(o => { optionTextById[o.id] = o.text; }));
  const header = ['Timestamp', 'Student Name', 'Register Number', 'Department', 'Email'].concat(form.questions.map(q => q.label)).concat(form.isQuiz ? ['Score'] : []);
  const csvLines = [header.map(csvEscape).join(',')];
  rows.forEach(r => {
    const answerByQ = Object.fromEntries((r.answers || []).map(a => [a.questionId, a.value]));
    const row = [r.createdAt, r.name, r.registerNo, r.department || '', r.email]
      .concat(form.questions.map(q => formatAnswer(answerByQ[q.id], optionTextById)))
      .concat(form.isQuiz ? [`${r.score ?? ''}/${r.maxScore ?? ''}`] : []);
    csvLines.push(row.map(csvEscape).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${form.title.replace(/[^a-z0-9]/gi, '_')}_responses.csv"`);
  res.send(csvLines.join('\n'));
});

function csvEscape(v) { return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; }
function formatAnswer(value, optionTextById) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(v => optionTextById[v] || v).join('; ');
  return optionTextById[value] || value;
}

app.get('/api/forms/:id/responses', requireAuth, (req, res) => {
  const data = require('./db').load();
  const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
  if (!form) return res.status(404).json({ ok: false, error: 'Form not found.' });
  const optionTextById = {};
  form.questions.forEach(q => (q.options || []).forEach(o => { optionTextById[o.id] = o.text; }));
  const rows = data.responses.filter(r => r.formId === form.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(r => ({
    name: r.name, registerNo: r.registerNo, department: r.department || '', email: r.email,
    createdAt: r.createdAt, score: r.score, maxScore: r.maxScore,
    answers: (r.answers || []).map(a => {
      const q = form.questions.find(qq => qq.id === a.questionId);
      return { questionId: a.questionId, label: q ? q.label : '(removed question)', value: formatAnswer(a.value, optionTextById) };
    })
  }));
  res.json({ ok: true, form: { title: form.title, isQuiz: !!form.isQuiz, questions: form.questions, studentFields: normalizeStudentFields(form.studentFields || data.studentFields) }, responses: rows });
});

app.patch('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    const updated = await withLock(async data => {
      const form = data.forms.find(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
      if (!form) throw new Error('Form not found.');
      if (typeof req.body.closed === 'boolean') form.closed = req.body.closed;
      require('./db').save(data);
      return form;
    });
    res.json({ ok: true, closed: !!updated.closed });
  } catch (err) { res.status(404).json({ ok: false, error: err.message }); }
});

app.delete('/api/forms/:id', requireAuth, async (req, res) => {
  try {
    await withLock(async data => {
      const idx = data.forms.findIndex(f => f.id === req.params.id && f.teacherId === req.session.teacherId);
      if (idx === -1) throw new Error('Form not found.');
      data.forms.splice(idx, 1);
      data.responses = data.responses.filter(r => r.formId !== req.params.id);
      require('./db').save(data);
    });
    res.json({ ok: true });
  } catch (err) { res.status(404).json({ ok: false, error: err.message }); }
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
      id: form.id, title: form.title, description: form.description,
      collegeName: form.collegeName || '', department: form.department || '',
      isQuiz: !!form.isQuiz, closed: !!form.closed,
      studentFields: normalizeStudentFields(form.studentFields || data.studentFields),
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

  try {
    const result = await withLock(async data => {
      const form = data.forms.find(f => f.id === formId);
      if (!form) throw new Error('This form does not exist or was removed.');
      if (form.closed) throw new Error('This form is closed and no longer accepting responses.');

      const fields = normalizeStudentFields(form.studentFields || data.studentFields);
      if (fields.name && !name) throw new Error('Please enter your name.');
      if (fields.registerNo && !registerNo) throw new Error('Please enter your register number.');
      if (fields.department && !department) throw new Error('Please enter your department.');
      if (fields.email && !email) throw new Error('Please enter your email.');

      if (fields.email) {
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(email)) throw new Error('That email address looks invalid.');
      }

      if (fields.registerNo) {
        const alreadyRegistered = data.responses.some(r =>
          r.formId === formId && String(r.registerNo || '').toLowerCase() === registerNo.toLowerCase()
        );
        if (alreadyRegistered) throw new Error('This register number has already submitted a response for this form.');
      }

      const answerByQ = Object.fromEntries(answersInput.map(a => [a.questionId, a.value]));
      const cleanAnswers = [];
      const electiveStatus = withElectiveStatus(form, data.responses);

      for (const q of form.questions) {
        const raw = answerByQ[q.id];
        const isEmpty = raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0);
        if (q.required && isEmpty) throw new Error(`Please answer: "${q.label}"`);
        if (isEmpty) continue;

        if (q.type === 'checkboxes') {
          const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
          const validIds = new Set(q.options.map(o => o.id));
          cleanAnswers.push({ questionId: q.id, value: values.filter(v => validIds.has(v)) });
        } else if (CHOICE_TYPES.includes(q.type)) {
          const value = String(raw);
          const opt = q.options.find(o => o.id === value);
          if (!opt) throw new Error(`Invalid choice for: "${q.label}"`);
          if (q.type === 'elective') {
            const liveQuestion = electiveStatus.questions.find(qq => qq.id === q.id);
            const liveOpt = liveQuestion.options.find(o => o.id === value);
            if (liveOpt.remaining <= 0) throw new Error(`Sorry, "${opt.text}" just filled up. Please pick another option for "${q.label}".`);
          }
          cleanAnswers.push({ questionId: q.id, value });
        } else {
          cleanAnswers.push({ questionId: q.id, value: String(raw).trim() });
        }
      }

      const { score, maxScore } = gradeResponse(form, cleanAnswers);
      data.responses.push({
        id: uuidv4(), formId,
        name: fields.name ? name : '',
        registerNo: fields.registerNo ? registerNo : '',
        department: fields.department ? department : '',
        email: fields.email ? email : '',
        answers: cleanAnswers, score, maxScore,
        createdAt: new Date().toISOString()
      });
      require('./db').save(data);
      return { score, maxScore };
    });

    res.json({ ok: true, message: form_isQuizMessage(result), score: result.score, maxScore: result.maxScore });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

function form_isQuizMessage(result) {
  if (result.maxScore == null) return 'Your response has been recorded.';
  return `Your response has been recorded. You scored ${result.score} out of ${result.maxScore}.`;
}

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Form builder server running on http://localhost:${PORT}`);
});
