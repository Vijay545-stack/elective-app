# Elective Registration — with a real backend

This is a full Node.js app — no Google Sheets, no Apps Script, no per-teacher
setup. Deployed once. After that, teachers just visit the site, sign up,
and create forms — like using Google Forms.

## Run it locally (to test)

npm install
npm start

Open http://localhost:3000

## Deploy

Push this repo to Render.com or Railway.app as a Node web service.
Build command: npm install
Start command: npm start
Add environment variable SESSION_SECRET set to any random string.
