"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

/* ============================================================
   FIREBASE INIT
============================================================ */
const serviceAccountPath = path.join(
  __dirname,
  "firebase-service-account.json",
);
if (fs.existsSync(serviceAccountPath)) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
  });
  console.log("🔥 Firebase initialized from service account file");
} else if (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
  console.log("🔥 Firebase initialized from .env");
} else {
  console.error("❌ No Firebase credentials found");
  console.error(
    "   Provide firebase-service-account.json or FIREBASE_* in .env",
  );
  process.exit(1);
}

const db = admin.firestore();
const examsCol = db.collection("exams");
const materialsCol = db.collection("materials");
const leadsCol = db.collection("leads");
const couponsCol = db.collection("coupons");
const ordersCol = db.collection("orders");
const tokensCol = db.collection("tokens");
const settingsCol = db.collection("settings");

/* ============================================================
   RAZORPAY
============================================================ */
let razorpay = null;
let PAYMENTS_ENABLED = false;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const Razorpay = require("razorpay");
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    PAYMENTS_ENABLED = true;
    console.log("💳 Razorpay enabled");
  }
} catch (e) {
  console.log("ℹ Razorpay not configured — add keys to .env");
}

/* ============================================================
   MIDDLEWARE
============================================================ */
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* Rate limiter */
const rateBuckets = new Map();
function rateLimit(windowMs, max, keyFn) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      rateBuckets.set(key, b);
    }
    b.count++;
    if (b.count > max)
      return res
        .status(429)
        .json({ error: "Too many requests. Try again later." });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets)
    if (now - v.start > 300000) rateBuckets.delete(k);
}, 60000);

/* ============================================================
   HELPERS
============================================================ */
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function slugify(s) {
  return (
    String(s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || uid()
  );
}

async function getSettings() {
  const doc = await settingsCol.doc("site").get();
  return doc.exists ? doc.data() : null;
}
async function saveSettings(patch) {
  const current = (await getSettings()) || {};
  const merged = { ...current, ...patch };
  await settingsCol.doc("site").set(merged);
  return merged;
}

/* ============================================================
   PASSWORD HASHING (scrypt — built into Node, no extra deps)
============================================================ */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 32).toString("hex");
  return "scrypt$" + salt + "$" + hash;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== "string") return false;
  /* Hashed format: scrypt$salt$hash */
  if (stored.indexOf("scrypt$") === 0) {
    const parts = stored.split("$");
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const expected = parts[2];
    let actual;
    try {
      actual = crypto.scryptSync(String(plain), salt, 32).toString("hex");
    } catch (e) {
      return false;
    }
    const a = Buffer.from(actual, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(a, b);
    } catch (e) {
      return false;
    }
  }
  /* Legacy plain text (admin123, seed password, etc.) */
  return String(plain) === stored;
}

function looksHashed(v) {
  return typeof v === "string" && v.indexOf("scrypt$") === 0;
}

/* ============================================================
   SEED
============================================================ */
async function ensureSeed() {
  const snapshot = await examsCol.limit(1).get();
  if (!snapshot.empty) {
    console.log("ℹ Database already seeded");
    return;
  }
  console.log("📦 Seeding initial data...");
  const now = Date.now(),
    day = 864e5;
  const stamp = (n) => new Date(now - n * day).toISOString();
  const G = "Government exams",
    C = "Career & skills";

  const exams = [
    {
      id: "ssc",
      name: "SSC",
      short: "SSC",
      hue: 222,
      group: G,
      status: "live",
      blurb: "CGL, CHSL, MTS and more",
      order: 1,
    },
    {
      id: "banking",
      name: "Banking",
      short: "BK",
      hue: 158,
      group: G,
      status: "live",
      blurb: "IBPS, SBI and RBI exams",
      order: 2,
    },
    {
      id: "railway",
      name: "Railway",
      short: "RRB",
      hue: 24,
      group: G,
      status: "live",
      blurb: "NTPC, Group D and ALP",
      order: 3,
    },
    {
      id: "upsc",
      name: "UPSC",
      short: "UP",
      hue: 272,
      group: G,
      status: "live",
      blurb: "Prelims, Mains and strategy",
      order: 4,
    },
    {
      id: "defence",
      name: "Defence",
      short: "DEF",
      hue: 96,
      group: G,
      status: "live",
      blurb: "NDA, CDS and Agniveer",
      order: 5,
    },
    {
      id: "teaching",
      name: "Teaching",
      short: "TCH",
      hue: 336,
      group: G,
      status: "live",
      blurb: "CTET, KVS and state TET",
      order: 6,
    },
    {
      id: "police",
      name: "Police",
      short: "POL",
      hue: 200,
      group: G,
      status: "live",
      blurb: "Constable and SI exams",
      order: 7,
    },
    {
      id: "statepsc",
      name: "State PSC",
      short: "PSC",
      hue: 44,
      group: G,
      status: "live",
      blurb: "State civil services",
      order: 8,
    },
    {
      id: "data-analyst",
      name: "Data Analyst",
      short: "DA",
      hue: 190,
      group: C,
      status: "live",
      blurb: "Excel, SQL, Power BI and Python",
      order: 9,
    },
    {
      id: "software",
      name: "Software Developer",
      short: "DEV",
      hue: 250,
      group: C,
      status: "soon",
      blurb: "DSA, web basics and interviews",
      order: 10,
    },
    {
      id: "digital-marketing",
      name: "Digital Marketing",
      short: "DM",
      hue: 320,
      group: C,
      status: "soon",
      blurb: "SEO, ads and analytics",
      order: 11,
    },
    {
      id: "accounts",
      name: "Accounts & Finance",
      short: "FIN",
      hue: 150,
      group: C,
      status: "soon",
      blurb: "Tally, GST and accounting",
      order: 12,
    },
    {
      id: "data-science",
      name: "Data Science",
      short: "DS",
      hue: 280,
      group: C,
      status: "soon",
      blurb: "Statistics, ML and projects",
      order: 13,
    },
    {
      id: "cloud",
      name: "Cloud & DevOps",
      short: "CLD",
      hue: 205,
      group: C,
      status: "soon",
      blurb: "AWS, Linux and CI/CD",
      order: 14,
    },
  ];
  const examBatch = db.batch();
  exams.forEach((e) => examBatch.set(examsCol.doc(e.id), e));
  await examBatch.commit();

  const mat = (
    id,
    title,
    exam,
    type,
    language,
    pages,
    price,
    mrp,
    featured,
    description,
    includes,
    age,
  ) => ({
    id,
    title,
    exam,
    type,
    language,
    pages,
    price,
    mrp,
    featured,
    description,
    includes,
    fileUrl: "",
    buyUrl: "",
    privateFileUrl: "",
    thumbnailUrl: "",
    status: "published",
    publishAt: "",
    expiresAt: "",
    razorpay: false,
    createdAt: stamp(age),
  });

  const materials = [
    mat(
      "ssc-cgl-quant-notes",
      "SSC CGL Quantitative Aptitude: Complete Notes",
      "ssc",
      "Notes PDF",
      "Bilingual",
      240,
      199,
      399,
      true,
      "Every quant topic in the CGL syllabus with worked examples, shortcut methods and a practice set at the end of each chapter.",
      "Chapter-wise theory and formulas\nShortcut methods for speed\n1,200+ practice questions with answers",
      3,
    ),
    mat(
      "ssc-cgl-pyq",
      "SSC CGL Previous Year Papers with Solutions",
      "ssc",
      "Previous Year Papers",
      "English",
      620,
      149,
      299,
      true,
      "Solved papers from recent exam cycles, arranged by subject so you can practise one section at a time.",
      "Full solutions for every question\nSubject-wise and year-wise index\nDifficulty and trend notes",
      9,
    ),
    mat(
      "ibps-po-ebook",
      "IBPS PO Prelims + Mains Master E-book",
      "banking",
      "E-book",
      "English",
      480,
      299,
      599,
      true,
      "One book covering reasoning, quant, English and banking awareness for both stages of the PO exam.",
      "Prelims and Mains in one book\nBanking awareness capsule\nSectional practice sets",
      5,
    ),
    mat(
      "banking-reasoning-free",
      "Banking Reasoning Shortcuts (Free)",
      "banking",
      "Notes PDF",
      "English",
      60,
      0,
      0,
      false,
      "A short free pack covering seating arrangement, puzzles and syllogism tricks.",
      "Seating arrangement patterns\nPuzzle solving steps\nSyllogism Venn method",
      12,
    ),
    mat(
      "rrb-ntpc-gs",
      "RRB NTPC General Awareness Notes",
      "railway",
      "Notes PDF",
      "Hindi",
      180,
      129,
      249,
      true,
      "History, geography, polity, science and current affairs written in short, revision-friendly points.",
      "Topic-wise short notes\nStatic GK tables\nLast-year question pattern",
      7,
    ),
    mat(
      "upsc-polity",
      "UPSC Prelims: Indian Polity Notes",
      "upsc",
      "Notes PDF",
      "English",
      310,
      249,
      499,
      true,
      "The whole polity syllabus in structured notes, with article numbers, amendments and quick-revision tables.",
      "Article and amendment tables\nMap of constitutional bodies\nPrelims-style MCQs per chapter",
      4,
    ),
    mat(
      "data-analyst-sql",
      "SQL for Data Analysts: Notes with 150 Practice Queries",
      "data-analyst",
      "Notes PDF",
      "English",
      170,
      199,
      399,
      true,
      "SELECT, joins, grouping and window functions explained step by step with business examples.",
      "Query patterns explained\n150 practice queries with answers\nInterview question bank",
      2,
    ),
    mat(
      "excel-analytics-free",
      "Excel for Analytics: Starter Guide (Free)",
      "data-analyst",
      "Notes PDF",
      "English",
      50,
      0,
      0,
      false,
      "Pivot tables, lookups and charts explained with simple datasets.",
      "Pivot tables in 30 minutes\nXLOOKUP and IF patterns\nClean-data checklist",
      1,
    ),
  ];
  const matBatch = db.batch();
  materials.forEach((m) => matBatch.set(materialsCol.doc(m.id), m));
  await matBatch.commit();

  await couponsCol.doc("welcome10").set({
    id: "welcome10",
    code: "WELCOME10",
    type: "percent",
    value: 10,
    maxDiscount: 200,
    minOrder: 99,
    uses: 0,
    maxUses: 1000,
    expiresAt: "",
    active: true,
    createdAt: stamp(0),
  });

  const settings = {
    siteName: "PrepShelf",
    tagline: "Study material for government exams and career prep.",
    whatsapp: "",
    telegram: "",
    email: "",
    adminPassword: hashPassword(ADMIN_PASSWORD),
    adminUsers: [],
    parent: { name: "TEMPRIFY", url: "" },
    bundle: {
      enabled: true,
      title: "All-Exam Pass",
      subtitle: "every exam, one payment",
      price: 999,
      mrp: 2499,
      url: "",
      points:
        "Every e-book and notes PDF on the site\nNew material added at no extra cost\nPriority help on WhatsApp",
      buttonLabel: "Get the pass",
    },
    ads: {
      enabled: false,
      clientId: "",
      placeholders: false,
      slots: {
        "home-mid": "",
        "list-top": "",
        "detail-side": "",
        "detail-bottom": "",
      },
    },
    razorpay: { enabled: false, keyId: "" },
    google: { clientId: "", allowedEmails: "" },
    home: {
      tracksTitle: "Choose your path",
      tracksText: "Pick an exam or career track to open its study material.",
      featuredTitle: "Popular study material",
      featuredText: "Chosen by students preparing right now.",
      leadTitle: "Hear first when new material goes live",
      leadText: "Leave your email or WhatsApp number.",
      faqTitle: "Questions students ask",
      faq: [
        {
          q: "Is the study material free?",
          a: "Some packs are free and others are paid. Each pack page shows the price before you decide.",
        },
        {
          q: "What format are the notes in?",
          a: "PDF. They open on any phone, tablet or computer.",
        },
        {
          q: "Which exams do you cover?",
          a: "Government exams such as SSC, Banking, Railway and UPSC, plus career tracks like Data Analyst.",
        },
      ],
      show: {
        tracks: true,
        featured: true,
        bundle: true,
        lead: true,
        faq: true,
      },
    },
    materialsPage: {
      title: "Study material",
      text: "E-books, notes, previous year papers and mock tests. Filter by exam, type or price.",
    },
  };
  await settingsCol.doc("site").set(settings);
  console.log("✅ Seed complete");
}

/* ============================================================
   AUTH — token store with expiry
============================================================ */
const TOKENS = new Map(); /* token -> expiresAt (ms) */
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; /* 7 days */

function issueToken() {
  const token = crypto.randomBytes(32).toString("hex");
  TOKENS.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.replace(/^Bearer\s+/i, "");
  if (t && TOKENS.has(t)) {
    const exp = TOKENS.get(t);
    if (exp > Date.now()) return next();
    TOKENS.delete(t);
  }
  res.status(401).json({ error: "unauthorized" });
}

/* Periodic cleanup of expired tokens */
setInterval(
  () => {
    const now = Date.now();
    for (const [t, exp] of TOKENS) {
      if (exp <= now) TOKENS.delete(t);
    }
  },
  1000 * 60 * 60,
); /* every hour */

/* ============================================================
   LOGIN — password
============================================================ */
app.post(
  "/api/login",
  rateLimit(60000, 10, (r) => r.ip),
  async (req, res) => {
    try {
      const { password } = req.body || {};
      if (!password) return res.status(401).json({ error: "Wrong password" });
      const settings = (await getSettings()) || {};
      const stored = settings.adminPassword || ADMIN_PASSWORD;
      if (!verifyPassword(password, stored))
        return res.status(401).json({ error: "Wrong password" });
      const token = issueToken();
      res.json({ token });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Login failed" });
    }
  },
);

/* ============================================================
   GOOGLE SIGN-IN
   Verifies the Google ID token via Google's tokeninfo endpoint.
============================================================ */
app.post(
  "/api/auth/google",
  rateLimit(60000, 20, (r) => r.ip),
  async (req, res) => {
    try {
      const { credential } = req.body || {};
      if (!credential)
        return res.status(400).json({ error: "Missing Google credential" });

      /* Node 18+ has global fetch. Fallback for older Node: */
      const fetchFn =
        typeof fetch === "function" ? fetch : require("node-fetch");

      const url =
        "https://oauth2.googleapis.com/tokeninfo?id_token=" +
        encodeURIComponent(credential);
      const gr = await fetchFn(url);
      if (!gr.ok)
        return res.status(401).json({ error: "Invalid Google token" });
      const payload = await gr.json();

      const settings = (await getSettings()) || {};
      const g = settings.google || {};

      /* Audience check — token must be issued for our client ID */
      if (g.clientId && payload.aud && payload.aud !== g.clientId) {
        return res
          .status(401)
          .json({ error: "Token was not issued for this application" });
      }

      /* Email + verification */
      const email = String(payload.email || "")
        .trim()
        .toLowerCase();
      if (!email)
        return res.status(401).json({ error: "No email in Google token" });
      const verified =
        payload.email_verified === true || payload.email_verified === "true";
      if (!verified)
        return res.status(401).json({ error: "Google email is not verified" });

      /* Allowlist — check settings.google.allowedEmails, env ADMIN_EMAILS,
         and any signed-up adminUsers */
      const allowedSetting = String(g.allowedEmails || "")
        .split(/\r?\n/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const allowedEnv = String(process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const adminUsers = Array.isArray(settings.adminUsers)
        ? settings.adminUsers
        : [];
      const allowedUsers = adminUsers
        .map((u) => String(u.email || "").toLowerCase())
        .filter(Boolean);

      const allAllowed = []
        .concat(allowedSetting)
        .concat(allowedEnv)
        .concat(allowedUsers);

      if (allAllowed.length && allAllowed.indexOf(email) === -1) {
        return res
          .status(403)
          .json({ error: "This Google account is not authorised" });
      }

      const token = issueToken();
      res.json({
        token,
        email,
        name: payload.name || "",
      });
    } catch (e) {
      console.error("google auth error:", e);
      res.status(500).json({ error: "Google sign-in failed" });
    }
  },
);

/* ============================================================
   SIGNUP — create an additional admin account
============================================================ */
app.post(
  "/api/auth/signup",
  rateLimit(60000, 5, (r) => r.ip),
  async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || "").trim();
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      const password = String(body.password || "");

      if (name.length < 2)
        return res.status(400).json({ error: "Name is too short" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: "Invalid email address" });
      if (password.length < 6)
        return res
          .status(400)
          .json({ error: "Password must be at least 6 characters" });

      const settings = (await getSettings()) || {};
      const users = Array.isArray(settings.adminUsers)
        ? settings.adminUsers.slice()
        : [];

      if (users.some((u) => String(u.email).toLowerCase() === email)) {
        return res
          .status(409)
          .json({ error: "An admin with this email already exists" });
      }

      const entry = {
        id: uid(),
        name,
        email,
        password: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      users.push(entry);
      await saveSettings({ adminUsers: users });

      const token = issueToken();
      res.json({ token, email, name });
    } catch (e) {
      console.error("signup error:", e);
      res.status(500).json({ error: "Sign up failed" });
    }
  },
);

/* ============================================================
   ADMIN PASSWORD CHANGE
============================================================ */
app.post("/api/admin/password", auth, async (req, res) => {
  try {
    const { current, next } = req.body || {};
    if (!current || !next)
      return res.status(400).json({ error: "Missing fields" });
    if (String(next).length < 6)
      return res
        .status(400)
        .json({ error: "New password must be at least 6 characters" });

    const settings = (await getSettings()) || {};
    const stored = settings.adminPassword || ADMIN_PASSWORD;

    if (!verifyPassword(current, stored))
      return res.status(401).json({ error: "Current password is wrong" });

    await saveSettings({ adminPassword: hashPassword(next) });
    res.json({ ok: true });
  } catch (e) {
    console.error("password change error:", e);
    res.status(500).json({ error: "Could not change password" });
  }
});

/* ============================================================
   FILE UPLOADS
============================================================ */
const uploadRoot = process.env.VERCEL
  ? path.join("/tmp", "prepshelf-uploads")
  : __dirname;
const PUBLIC_UPLOAD = process.env.VERCEL
  ? path.join(uploadRoot, "public", "uploads")
  : path.join(__dirname, "public", "uploads");
const PRIVATE_UPLOAD = process.env.VERCEL
  ? path.join(uploadRoot, "private-uploads")
  : path.join(__dirname, "private-uploads");
fs.mkdirSync(PUBLIC_UPLOAD, { recursive: true });
fs.mkdirSync(PRIVATE_UPLOAD, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const scope = String(req.query.scope || req.body.scope || "public");
    cb(null, scope === "private" ? PRIVATE_UPLOAD : PUBLIC_UPLOAD);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = /^\.(pdf|png|jpg|jpeg|webp|gif)$/.test(ext) ? ext : ".bin";
    cb(
      null,
      Date.now() + "-" + Math.random().toString(36).slice(2, 8) + safeExt,
    );
  },
});
const uploadMw = multer({
  storage: uploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
      "image/gif",
    ].includes(file.mimetype);
    cb(ok ? null : new Error("Only PDF and image files allowed"), ok);
  },
});

app.post("/api/upload", auth, (req, res) => {
  uploadMw.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file received" });
    const scope = String(req.query.scope || "public");
    const url =
      scope === "private"
        ? "/private/" + req.file.filename
        : "/uploads/" + req.file.filename;
    res.json({
      url,
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype,
    });
  });
});

/* ============================================================
   PUBLIC API
============================================================ */
app.get("/api/exams", async (req, res) => {
  res.set("X-Robots-Tag", "noindex");
  try {
    const snap = await examsCol.orderBy("order").get();
    const exams = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(exams);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.get("/api/materials", async (req, res) => {
  res.set("X-Robots-Tag", "noindex");
  try {
    const snap = await materialsCol.orderBy("createdAt", "desc").get();
    const list = snap.docs.map((doc) => {
      const m = { id: doc.id, ...doc.data() };
      delete m.privateFileUrl;
      delete m.buyUrl;
      return m;
    });
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.get("/api/material/:id", async (req, res) => {
  res.set("X-Robots-Tag", "noindex");
  try {
    const doc = await materialsCol.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });
    const m = { id: doc.id, ...doc.data() };
    delete m.privateFileUrl;
    delete m.buyUrl;
    res.json(m);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.get("/api/settings", async (req, res) => {
  res.set("X-Robots-Tag", "noindex");
  try {
    const s = (await getSettings()) || {};
    const safe = { ...s };
    delete safe.adminPassword;
    /* Never leak adminUsers passwords */
    if (Array.isArray(safe.adminUsers)) {
      safe.adminUsers = safe.adminUsers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
      }));
    }
    safe.paymentsEnabled = PAYMENTS_ENABLED;
    res.json(safe);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.post(
  "/api/leads",
  rateLimit(60000, 5, (r) => r.ip),
  async (req, res) => {
    try {
      const contact = String((req.body && req.body.contact) || "").trim();
      if (!contact) return res.status(400).json({ error: "contact required" });
      const lead = { id: uid(), contact, createdAt: new Date().toISOString() };
      await leadsCol.doc(lead.id).set(lead);
      res.json(lead);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "DB error" });
    }
  },
);

/* ============================================================
   COUPON
============================================================ */
app.post(
  "/api/coupon/validate",
  rateLimit(60000, 20, (r) => r.ip),
  async (req, res) => {
    try {
      const { code, materialId } = req.body || {};
      if (!code || !materialId)
        return res
          .status(400)
          .json({ valid: false, message: "Missing code or material" });
      const matDoc = await materialsCol.doc(materialId).get();
      if (!matDoc.exists)
        return res
          .status(404)
          .json({ valid: false, message: "Material not found" });
      const mat = matDoc.data();
      if (!(mat.price > 0))
        return res
          .status(400)
          .json({ valid: false, message: "This material is free" });

      const normalCode = String(code).trim().toUpperCase();
      const couponSnap = await couponsCol
        .where("code", "==", normalCode)
        .limit(1)
        .get();
      const coupon = couponSnap.empty ? null : couponSnap.docs[0].data();
      const result = applyCoupon(coupon, mat.price);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ valid: false, message: "DB error" });
    }
  },
);

function applyCoupon(coupon, price) {
  if (!coupon) return { valid: false, message: "Invalid coupon code" };
  if (!coupon.active)
    return { valid: false, message: "This coupon is no longer active" };
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now())
    return { valid: false, message: "This coupon has expired" };
  if (coupon.maxUses && coupon.uses >= coupon.maxUses)
    return { valid: false, message: "This coupon has reached its usage limit" };
  if (coupon.minOrder && price < coupon.minOrder)
    return {
      valid: false,
      message: "Minimum order ₹" + coupon.minOrder + " required",
    };

  let discount = 0;
  if (coupon.type === "percent")
    discount = Math.round((price * coupon.value) / 100);
  else if (coupon.type === "flat") discount = Math.round(coupon.value);
  if (coupon.maxDiscount && discount > coupon.maxDiscount)
    discount = coupon.maxDiscount;
  if (discount > price) discount = price;
  const finalPrice = price - discount;

  return {
    valid: true,
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    discount,
    finalPrice,
    message:
      coupon.type === "percent"
        ? coupon.value + "% off applied — you save ₹" + discount
        : "₹" + discount + " off applied",
  };
}

/* ============================================================
   FREE REGISTER
============================================================ */
app.post(
  "/api/free/register",
  rateLimit(60000, 20, (r) => r.ip),
  async (req, res) => {
    try {
      const { materialId, customer } = req.body || {};
      const matDoc = await materialsCol.doc(materialId).get();
      if (!matDoc.exists)
        return res.status(404).json({ error: "Material not found" });
      const mat = matDoc.data();
      if (mat.price > 0)
        return res.status(400).json({ error: "This material is not free" });
      if (mat.status === "draft")
        return res
          .status(400)
          .json({ error: "This material is not available" });

      const clean = validateCustomer(customer);
      if (!clean.ok) return res.status(400).json({ error: clean.error });

      const token = crypto.randomBytes(24).toString("hex");
      const expiresAt = Date.now() + 60 * 60 * 1000;
      const orderId =
        "free_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

      await tokensCol.doc(token).set({
        token,
        orderId,
        materialId,
        free: true,
        createdAt: Date.now(),
        expiresAt,
        downloads: 0,
      });
      await ordersCol.doc(orderId).set({
        orderId,
        materialId,
        materialTitle: mat.title,
        originalPrice: 0,
        discount: 0,
        finalAmount: 0,
        couponCode: "",
        customer: clean.customer,
        status: "free",
        createdAt: new Date().toISOString(),
      });

      res.json({ ok: true, downloadUrl: "/api/download/" + token, expiresAt });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "DB error" });
    }
  },
);

/* ============================================================
   PAYMENT — ORDER
============================================================ */
app.post(
  "/api/pay/order",
  rateLimit(60000, 10, (r) => r.ip),
  async (req, res) => {
    if (!razorpay)
      return res.status(503).json({ error: "Payments not configured" });
    try {
      const { materialId, customer, couponCode } = req.body || {};
      const matDoc = await materialsCol.doc(materialId).get();
      if (!matDoc.exists)
        return res.status(404).json({ error: "Material not found" });
      const mat = matDoc.data();
      if (!(mat.price > 0))
        return res.status(400).json({ error: "This material is free" });
      if (mat.status === "draft")
        return res
          .status(400)
          .json({ error: "This material is not available" });

      const clean = validateCustomer(customer);
      if (!clean.ok) return res.status(400).json({ error: clean.error });

      let discount = 0,
        finalAmount = mat.price,
        appliedCoupon = null;
      if (couponCode) {
        const couponSnap = await couponsCol
          .where("code", "==", String(couponCode).toUpperCase())
          .limit(1)
          .get();
        const coupon = couponSnap.empty ? null : couponSnap.docs[0].data();
        const r = applyCoupon(coupon, mat.price);
        if (!r.valid) return res.status(400).json({ error: r.message });
        discount = r.discount;
        finalAmount = r.finalPrice;
        appliedCoupon = r.code;
      }

      if (finalAmount < 1)
        return res.status(400).json({ error: "Final amount too small." });

      const order = await razorpay.orders.create({
        amount: finalAmount * 100,
        currency: "INR",
        receipt: "ps_" + materialId + "_" + Date.now(),
        notes: {
          materialId,
          materialTitle: mat.title,
          coupon: appliedCoupon || "",
        },
      });

      await ordersCol.doc(order.id).set({
        orderId: order.id,
        materialId,
        materialTitle: mat.title,
        originalPrice: mat.price,
        discount,
        finalAmount,
        couponCode: appliedCoupon,
        customer: clean.customer,
        status: "created",
        createdAt: new Date().toISOString(),
      });

      res.json({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        material: { id: mat.id, title: mat.title, price: mat.price },
        customer: clean.customer,
        discount,
        finalAmount,
      });
    } catch (e) {
      console.error("razorpay order error:", e);
      res.status(500).json({ error: "Could not create order. Try again." });
    }
  },
);

function validateCustomer(c) {
  if (!c || typeof c !== "object")
    return { ok: false, error: "Customer details required" };
  const name = String(c.name || "").trim();
  const email = String(c.email || "")
    .trim()
    .toLowerCase();
  const phone = String(c.phone || "").trim();

  if (name.length < 2 || name.length > 60)
    return {
      ok: false,
      error: "Please enter your full name (2–60 characters)",
    };
  if (!/^[A-Za-z\s.'-]+$/.test(name))
    return {
      ok: false,
      error: "Name can only contain letters, spaces, and . ' -",
    };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { ok: false, error: "Please enter a valid email address" };
  if (email.length > 120) return { ok: false, error: "Email is too long" };

  const digits = phone.replace(/[^\d+]/g, "");
  const plain = digits.replace(/^\+/, "");
  if (plain.length < 10 || plain.length > 15)
    return { ok: false, error: "Phone must be 10–15 digits" };
  if (!/^\d+$/.test(plain))
    return { ok: false, error: "Phone can only contain digits" };

  return { ok: true, customer: { name, email, phone: digits } };
}

/* ============================================================
   PAYMENT — VERIFY
============================================================ */
app.post(
  "/api/pay/verify",
  rateLimit(60000, 20, (r) => r.ip),
  async (req, res) => {
    if (!razorpay)
      return res.status(503).json({ error: "Payments not configured" });
    try {
      const { orderId, paymentId, signature } = req.body || {};
      if (!orderId || !paymentId || !signature)
        return res.status(400).json({ error: "Missing payment details" });

      const orderDoc = await ordersCol.doc(orderId).get();
      if (!orderDoc.exists)
        return res.status(404).json({ error: "Order not found" });
      const order = orderDoc.data();

      const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(orderId + "|" + paymentId)
        .digest("hex");

      if (expected !== signature) {
        await ordersCol
          .doc(orderId)
          .update({ status: "failed", failedReason: "Signature mismatch" });
        return res.status(400).json({ error: "Payment verification failed" });
      }

      if (order.status === "paid" && order.downloadToken) {
        const tDoc = await tokensCol.doc(order.downloadToken).get();
        if (tDoc.exists) {
          const t = tDoc.data();
          if (t.expiresAt > Date.now()) {
            return res.json({
              ok: true,
              downloadUrl: "/api/download/" + order.downloadToken,
              expiresAt: t.expiresAt,
            });
          }
        }
      }

      if (order.couponCode) {
        const couponSnap = await couponsCol
          .where("code", "==", order.couponCode)
          .limit(1)
          .get();
        if (!couponSnap.empty) {
          const cDoc = couponSnap.docs[0];
          await couponsCol
            .doc(cDoc.id)
            .update({ uses: (cDoc.data().uses || 0) + 1 });
        }
      }

      const token = crypto.randomBytes(24).toString("hex");
      const expiresAt = Date.now() + 60 * 60 * 1000;
      await tokensCol.doc(token).set({
        token,
        orderId,
        materialId: order.materialId,
        createdAt: Date.now(),
        expiresAt,
        downloads: 0,
      });

      await ordersCol.doc(orderId).update({
        status: "paid",
        paymentId,
        paidAt: new Date().toISOString(),
        downloadToken: token,
      });

      res.json({ ok: true, downloadUrl: "/api/download/" + token, expiresAt });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Verification failed" });
    }
  },
);

/* ============================================================
   DOWNLOAD — robust with diagnostics
============================================================ */
app.get("/api/download/:token", async (req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  try {
    const tDoc = await tokensCol.doc(req.params.token).get();
    if (!tDoc.exists) return res.status(404).send("Invalid download link");
    const t = tDoc.data();
    if (t.expiresAt < Date.now())
      return res.status(410).send("This download link has expired");

    const mDoc = await materialsCol.doc(t.materialId).get();
    if (!mDoc.exists) return res.status(404).send("Material not found");
    const m = mDoc.data();

    console.log("─── Download request ───");
    console.log("Material ID:   ", t.materialId);
    console.log("Title:         ", m.title);
    console.log("Free item:     ", !!t.free);
    console.log("fileUrl:       ", m.fileUrl || "(empty)");
    console.log("privateFileUrl:", m.privateFileUrl || "(empty)");
    console.log("Private folder:", PRIVATE_UPLOAD);
    console.log("Public folder: ", PUBLIC_UPLOAD);

    try {
      const privFiles = fs.readdirSync(PRIVATE_UPLOAD);
      const pubFiles = fs.readdirSync(PUBLIC_UPLOAD);
      console.log(
        "Files in private-uploads:",
        privFiles.length,
        privFiles.slice(0, 5),
      );
      console.log(
        "Files in public/uploads: ",
        pubFiles.length,
        pubFiles.slice(0, 5),
      );
    } catch (e) {
      console.log("Could not read upload folders:", e.message);
    }

    const candidates = [];
    if (m.privateFileUrl) candidates.push(m.privateFileUrl);
    if (m.fileUrl && m.fileUrl !== m.privateFileUrl) candidates.push(m.fileUrl);

    let filePath = null;
    let externalUrl = null;

    for (const url of candidates) {
      if (/^https?:\/\//i.test(url)) {
        externalUrl = externalUrl || url;
        continue;
      }
      const base = path.basename(String(url).split("?")[0]);
      if (!base) continue;

      const tryPaths = [
        path.join(PRIVATE_UPLOAD, base),
        path.join(PUBLIC_UPLOAD, base),
      ];
      for (const p of tryPaths) {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          if (stat.isFile()) {
            filePath = p;
            console.log("✓ Found file at:", p, "(" + stat.size + " bytes)");
            break;
          }
        }
      }
      if (filePath) break;
    }

    if (!filePath && externalUrl) {
      console.log("→ Redirecting to external URL:", externalUrl);
      await tokensCol
        .doc(req.params.token)
        .update({ downloads: (t.downloads || 0) + 1 });
      return res.redirect(externalUrl);
    }

    if (!filePath) {
      console.error("✗ File NOT found for any of these URLs:", candidates);
      return res
        .status(404)
        .send(
          "The file for this product has not been uploaded yet. " +
            "Please contact support with your order ID: " +
            t.orderId,
        );
    }

    await tokensCol
      .doc(req.params.token)
      .update({ downloads: (t.downloads || 0) + 1 });

    const safeName =
      (m.title || "prepshelf")
        .replace(/[^\w\s.-]/g, "")
        .trim()
        .slice(0, 80) + ".pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="' + safeName + '"',
    );
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error("Download route error:", e);
    res.status(500).send("Server error while preparing download");
  }
});

/* ============================================================
   ADMIN API
============================================================ */
app.get("/api/admin/all", auth, async (req, res) => {
  try {
    const [examsSnap, materialsSnap, leadsSnap, couponsSnap, settings] =
      await Promise.all([
        examsCol.orderBy("order").get(),
        materialsCol.orderBy("createdAt", "desc").get(),
        leadsCol.orderBy("createdAt", "desc").get(),
        couponsCol.orderBy("createdAt", "desc").get(),
        getSettings(),
      ]);
    const clean = (snap) =>
      snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    /* Strip password fields from settings before sending to admin */
    const safeSettings = settings ? { ...settings } : {};
    delete safeSettings.adminPassword;
    if (Array.isArray(safeSettings.adminUsers)) {
      safeSettings.adminUsers = safeSettings.adminUsers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
      }));
    }
    res.json({
      exams: clean(examsSnap),
      materials: clean(materialsSnap),
      leads: clean(leadsSnap),
      coupons: clean(couponsSnap),
      settings: safeSettings,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Exams */
app.post("/api/exams", auth, async (req, res) => {
  try {
    const item = { ...req.body };
    item.id = item.id || slugify(item.name);
    item.updatedAt = new Date().toISOString();
    const doc = await examsCol.doc(item.id).get();
    if (doc.exists) {
      await examsCol.doc(item.id).set(item, { merge: true });
    } else {
      item.createdAt = item.createdAt || new Date().toISOString();
      await examsCol.doc(item.id).set(item);
    }
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete("/api/exams/:id", auth, async (req, res) => {
  try {
    await examsCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Materials */
app.post("/api/materials", auth, async (req, res) => {
  try {
    const item = { ...req.body };
    item.id = item.id || slugify(item.title);
    item.updatedAt = new Date().toISOString();
    const doc = await materialsCol.doc(item.id).get();
    if (doc.exists) {
      await materialsCol.doc(item.id).set(item, { merge: true });
    } else {
      item.createdAt = item.createdAt || new Date().toISOString();
      await materialsCol.doc(item.id).set(item);
    }
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete("/api/materials/:id", auth, async (req, res) => {
  try {
    await materialsCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Settings — auto-hash adminPassword if it arrives as plain text */
app.put("/api/settings", auth, async (req, res) => {
  try {
    const patch = req.body || {};
    /* Hash plain password if it was sent through the settings fallback */
    if (patch.adminPassword && !looksHashed(patch.adminPassword)) {
      patch.adminPassword = hashPassword(patch.adminPassword);
    }
    /* Do not let settings silently wipe adminUsers passwords */
    if (Array.isArray(patch.adminUsers)) {
      const current = (await getSettings()) || {};
      const existing = Array.isArray(current.adminUsers)
        ? current.adminUsers
        : [];
      patch.adminUsers = patch.adminUsers.map((u) => {
        const old = existing.find((x) => x.id === u.id);
        if (old && old.password && !u.password) {
          return { ...u, password: old.password };
        }
        if (u.password && !looksHashed(u.password)) {
          return { ...u, password: hashPassword(u.password) };
        }
        return u;
      });
    }
    const merged = await saveSettings(patch);
    const safe = { ...merged };
    delete safe.adminPassword;
    if (Array.isArray(safe.adminUsers)) {
      safe.adminUsers = safe.adminUsers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
      }));
    }
    res.json(safe);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Leads */
app.get("/api/leads", auth, async (req, res) => {
  try {
    const snap = await leadsCol.orderBy("createdAt", "desc").get();
    res.json(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete("/api/leads/:id", auth, async (req, res) => {
  try {
    await leadsCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete("/api/leads", auth, async (req, res) => {
  try {
    const snap = await leadsCol.get();
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Coupons */
app.get("/api/coupons", auth, async (req, res) => {
  try {
    const snap = await couponsCol.orderBy("createdAt", "desc").get();
    res.json(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.post("/api/coupons", auth, async (req, res) => {
  try {
    const item = { ...req.body };
    item.code = String(item.code || "")
      .trim()
      .toUpperCase();
    if (!item.code) return res.status(400).json({ error: "Code required" });
    item.id = item.id || slugify(item.code);
    item.uses = item.uses || 0;
    item.active = item.active !== false;
    item.updatedAt = new Date().toISOString();
    const doc = await couponsCol.doc(item.id).get();
    if (doc.exists) {
      await couponsCol.doc(item.id).set(item, { merge: true });
    } else {
      item.createdAt = new Date().toISOString();
      await couponsCol.doc(item.id).set(item);
    }
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete("/api/coupons/:id", auth, async (req, res) => {
  try {
    await couponsCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Payments log */
app.get("/api/payments", auth, async (req, res) => {
  try {
    const snap = await ordersCol.orderBy("createdAt", "desc").get();
    res.json(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Delete an order — admin.html tries /api/payments/:id first */
async function deleteOrderById(id) {
  const doc = await ordersCol.doc(id).get();
  if (doc.exists) {
    await ordersCol.doc(id).delete();
    return true;
  }
  /* Fallback: search by orderId field */
  const snap = await ordersCol.where("orderId", "==", id).limit(1).get();
  if (!snap.empty) {
    await snap.docs[0].ref.delete();
    return true;
  }
  return false;
}

app.delete("/api/payments/:id", auth, async (req, res) => {
  try {
    const ok = await deleteOrderById(req.params.id);
    if (!ok) return res.status(404).json({ error: "Order not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.delete("/api/orders/:id", auth, async (req, res) => {
  try {
    const ok = await deleteOrderById(req.params.id);
    if (!ok) return res.status(404).json({ error: "Order not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* Export / Import / Reset */
app.get("/api/export", auth, async (req, res) => {
  try {
    const [
      examsSnap,
      materialsSnap,
      leadsSnap,
      couponsSnap,
      settings,
      ordersSnap,
    ] = await Promise.all([
      examsCol.get(),
      materialsCol.get(),
      leadsCol.get(),
      couponsCol.get(),
      getSettings(),
      ordersCol.get(),
    ]);
    const clean = (snap) =>
      snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const safe = settings ? { ...settings } : {};
    delete safe.adminPassword;
    if (Array.isArray(safe.adminUsers)) {
      safe.adminUsers = safe.adminUsers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
      }));
    }
    res.json({
      exams: clean(examsSnap),
      materials: clean(materialsSnap),
      leads: clean(leadsSnap),
      coupons: clean(couponsSnap),
      orders: clean(ordersSnap),
      settings: safe,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.post("/api/import", auth, async (req, res) => {
  try {
    const data = req.body || {};
    const writeAll = async (col, arr) => {
      if (!Array.isArray(arr)) return;
      const existing = await col.get();
      const batch = db.batch();
      existing.docs.forEach((doc) => batch.delete(doc.ref));
      arr.forEach((item) => batch.set(col.doc(item.id), item));
      await batch.commit();
    };
    await writeAll(examsCol, data.exams);
    await writeAll(materialsCol, data.materials);
    await writeAll(leadsCol, data.leads);
    await writeAll(couponsCol, data.coupons);
    if (data.settings) {
      const patch = { ...data.settings };
      /* Hash plain password if importing older backup */
      if (patch.adminPassword && !looksHashed(patch.adminPassword)) {
        patch.adminPassword = hashPassword(patch.adminPassword);
      }
      if (Array.isArray(patch.adminUsers)) {
        patch.adminUsers = patch.adminUsers.map((u) => {
          if (u.password && !looksHashed(u.password)) {
            return { ...u, password: hashPassword(u.password) };
          }
          return u;
        });
      }
      await saveSettings(patch);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

app.post("/api/reset", auth, async (req, res) => {
  try {
    const cols = [
      examsCol,
      materialsCol,
      leadsCol,
      couponsCol,
      ordersCol,
      tokensCol,
      settingsCol,
    ];
    for (const col of cols) {
      const snap = await col.get();
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
    await ensureSeed();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* ============================================================
   STATIC
============================================================ */
app.use("/admin", express.static(path.join(__dirname, "admin")));
app.get("/admin", (req, res) => res.redirect("/admin/admin.html"));
app.get("/admin/", (req, res) => res.redirect("/admin/admin.html"));

app.use(
  "/uploads",
  express.static(PUBLIC_UPLOAD, {
    setHeaders: (res) => res.setHeader("X-Robots-Tag", "noindex"),
  }),
);

app.use(express.static(path.join(__dirname, "public")));

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    `User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /private/
Disallow: /uploads/
Disallow: /pay.html
`,
  );
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (req.path.startsWith("/admin/")) return next();
  if (req.path.startsWith("/private/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================================================
  START
============================================================ */
module.exports = app;

if (require.main === module) {
  (async function start() {
    try {
      console.log("🔌 Connecting to Firestore...");
      await ensureSeed();

      app.listen(PORT, () => {
        console.log("");
        console.log("  🚀  PrepShelf running");
        console.log("      Site:    http://localhost:" + PORT);
        console.log("      Admin:   http://localhost:" + PORT + "/admin");
        console.log(
          "      Pay:     http://localhost:" +
            PORT +
            "/pay.html?id=<material-id>",
        );
        console.log("      Pass:    " + ADMIN_PASSWORD);
        console.log(
          "      Pay:     " +
            (PAYMENTS_ENABLED
              ? "💳 Razorpay ENABLED"
              : "❌ Razorpay not configured"),
        );
        console.log("");
      });
    } catch (e) {
      console.error("❌ Startup failed:", e.message);
      process.exit(1);
    }
  })();
}
