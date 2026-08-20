# Form Builder

A Google-Forms-style app: teachers log in, build forms with multiple question
types, and share a link with students.

## Question types
- Short answer
- Paragraph
- Multiple choice (single select)
- Checkboxes (multi select)
- Dropdown
- Elective (seat-limited single choice — seats fill up live and close automatically)

## Quiz mode
Toggle "Make this a quiz" in the builder. For multiple choice / checkboxes /
dropdown questions you can mark correct option(s) and assign points. Students
see their score immediately after submitting. Short answer, paragraph, and
elective questions are never auto-graded.

## Run locally
```
npm install
npm start
```
Then open http://localhost:3000

## Deploy (e.g. Render)
Push this folder to your GitHub repo and redeploy — Render will run
`npm install` then `npm start` automatically (uses the `PORT` env var).

Data is stored in a local `data.json` file (see `db.js`). On Render's free
tier this resets on redeploy/restart since the filesystem isn't persistent —
fine for a class project, but swap in a real database if you need the data
to survive restarts.
