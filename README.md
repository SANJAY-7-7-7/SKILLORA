# SKILLORA

**Learn One. Teach One. Grow Together.**

SKILLORA is a student-to-student learning exchange. Students list what they can teach and want to learn, find compatible peers, and share knowledge without paying for courses.

## Run locally

Requirements: Node.js 20+ and a MongoDB instance.

1. Copy `.env.example` to `server/.env` and set `MONGODB_URI` and a long, unique `JWT_SECRET`.
2. Copy `client/.env.example` to `client/.env` if the API is not at `http://localhost:4000/api`.
3. Run `npm install` from the repository root.
4. Run `npm run seed` to add optional demo accounts, then run `npm run dev`.
5. Open <http://localhost:5173>.

Demo accounts created by the seed command:

- Student: `maya@skillora.demo` / `SkilloraDemo!2026`
- Admin: `admin@skillora.demo` / `SkilloraAdmin!2026`

Seed data is for local development. Do not seed a production database. Without SMTP credentials, development auth responses include verification/reset links and the server logs them. Configure SMTP for email delivery. Cloudinary uploads are optional; profile image URLs work without it.

## Product features

- Account registration, email verification, login/logout, password reset, protected routes and HTTP-only JWT cookies.
- Editable student profiles, image upload, availability and separate teach/learn skill CRUD.
- Search and discovery with database-backed reciprocal matching, compatibility explanations and filters.
- Exchange requests, status tracking, active exchange details and private real-time messaging with unread indicators.
- Session scheduling, calendar, details, mutually available time suggestions, automatic in-app reminders, completion and cancellation.
- Reviews tied to completed sessions, independent overall/teaching/communication/knowledge-sharing scores, and public profile ratings.
- SkillCoins for completing sessions and joining skill circles, learning streaks, badges, five leaderboard views, learning passport and skill-gap discovery.
- Interactive personal skill exchange map, community knowledge graph and 3–6 person skill circles.
- Live public landing-page statistics, popular teaching skills and feedback stories drawn from application records.
- Admin analytics, student suspension/reactivation, skill category management, user reports and moderation.

## Commands

- `npm run dev` — start the API and Vite client.
- `npm run typecheck` — type-check server and client.
- `npm run build` — compile the server and create the client production bundle.
- `npm run start` — start the compiled API after a production build.
- `npm run seed` — create/reset the local demo accounts and skill records.

The REST API is mounted at `/api`; `/api/health` reports API and database state. The client and API can be deployed separately; set `VITE_API_URL` when building the client, and set `CLIENT_URL` to the deployed client origin.

## Configuration and security

See `.env.example` for server settings and optional SMTP/Cloudinary credentials. Production requires HTTPS, a long random `JWT_SECRET`, a correctly scoped `CLIENT_URL`, MongoDB, and SMTP for verification and password reset. The API applies Helmet, origin-checked CORS, rate limits, Zod validation, bcrypt password hashing, authentication and admin authorization, upload validation, and centralized error handling. Keep secrets and demo credentials out of source control.

## Verification status

The TypeScript checks and production builds run locally without a database. Full persistence and end-to-end workflows require a reachable MongoDB instance and configured service credentials where those integrations are used.
