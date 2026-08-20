const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/elective_db';

const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('MongoDB connected successfully');
    } catch (err) {
        console.error('MongoDB connection error:', err.message);
    }
};

const ResponseSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    rollNo: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    elective: { type: String, required: true },
    elective2: { type: String, default: 'None' },
    createdAt: { type: Date, default: Date.now }
});

const Response = mongoose.model('Response', ResponseSchema);

module.exports = { connectDB, Response };
