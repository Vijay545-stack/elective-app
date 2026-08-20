const express = require('express');
const path = require('path');
const { connectDB, Response } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Connect Database
connectDB();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin Credentials
const ADMIN_CREDENTIALS = {
    username: process.env.ADMIN_USER || 'Vijay',
    password: process.env.ADMIN_PASSWORD || 'Vijay@1108'
};

// 1. Submit Student Elective Form (Logic Intact)
app.post('/api/submit', async (req, res) => {
    try {
        const { name, rollNo, email, department, elective, elective2 } = req.body;

        if (!name || !rollNo || !email || !department || !elective) {
            return res.status(400).json({ success: false, message: 'All required fields must be filled.' });
        }

        const newResponse = new Response({
            name,
            rollNo,
            email,
            department,
            elective,
            elective2: elective2 || 'None'
        });

        await newResponse.save();
        res.status(201).json({ success: true, message: 'Elective choice submitted successfully!' });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Roll number or Email already submitted.' });
        }
        res.status(500).json({ success: false, message: 'Server error saving form submission.', error: error.message });
    }
});

// 2. Admin Login Endpoint
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        return res.json({ success: true, token: 'admin-auth-session-token' });
    }
    return res.status(401).json({ success: false, message: 'Invalid Admin username or password.' });
});

// 3. Admin: Fetch All Submissions
app.get('/api/admin/responses', async (req, res) => {
    try {
        const responses = await Response.find().sort({ createdAt: -1 });
        res.json({ success: true, count: responses.length, data: responses });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not fetch records.', error: error.message });
    }
});

// 4. Admin: Delete a Submission
app.delete('/api/admin/responses/:id', async (req, res) => {
    try {
        await Response.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Record removed successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete record.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
