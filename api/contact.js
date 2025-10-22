// api/contact.js
import nodemailer from "nodemailer";

// ---- simple in-memory rate limit ----
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 5;
let hits = [];
function rateLimited(ip) {
  const now = Date.now();
  hits = hits.filter(h => now - h.time < WINDOW_MS);
  const count = hits.filter(h => h.ip === ip).length;
  if (count >= MAX_PER_WINDOW) return true;
  hits.push({ ip, time: now });
  return false;
}

// ---- simple denylist with TTL ----
const BLOCK_MS = 60 * 60 * 1000; // 1h
let blocked = new Map(); // ip -> untilTs
function isBlocked(ip) {
  const until = blocked.get(ip);
  if (until && Date.now() < until) return true;
  if (until && Date.now() >= until) blocked.delete(ip);
  return false;
}
function punish(ip, ms = BLOCK_MS) { blocked.set(ip, Date.now() + ms); }

// track bad events to trigger punish
let badHits = [];
function markBad(ip) {
  const now = Date.now();
  badHits.push({ ip, time: now });
  badHits = badHits.filter(h => now - h.time < 10 * 60 * 1000); // last 10 min
  const count = badHits.filter(h => h.ip === ip).length;
  if (count >= 8) punish(ip); // 8 bad actions in 10 min -> block 1h
}

// ---- field guards ----
const MAX_MESSAGE_LEN = 5000;
const MAX_NAME_LEN = 120;
const MAX_ORG_LEN = 200;
const MAX_INTEREST_LEN = 80;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    if (!ctype.includes("application/json")) {
      return res.status(400).json({ ok: false, error: "Send JSON body" });
    }
    const body = req.body || {};

    const {
      name = "",
      email = "",
      organization = "",
      interest = "",
      org = "",
      topic = "",
      message = "",
      _gotcha = ""
    } = body;

    // honeypot
    if (_gotcha && String(_gotcha).trim()) {
      return res.status(200).json({ ok: true });
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.socket?.remoteAddress || "unknown";

    // fast gates before external call
    if (isBlocked(ip)) {
      return res.status(403).json({ ok:false, error:"IP temporarily blocked." });
    }
    if (rateLimited(ip)) {
      return res.status(429).json({ ok: false, error: "Too many requests, try again later." });
    }

    // ---- Cloudflare Turnstile verification ----
    const token = body["cf-turnstile-response"];
    if (!token) {
      markBad(ip);
      return res.status(400).json({ ok: false, error: "missing_turnstile_token" });
    }

    const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY || "",
        response: token,
        remoteip: ip,
      }),
    });

    const data = await verifyRes.json();
    if (!data.success) {
      markBad(ip);
      console.error("Turnstile failed:", data["error-codes"]);
      return res.status(400).json({ ok: false, error: "turnstile_failed" });
    }
    // --------------------------------------------

    // normalize inputs
    const clean = s => String(s || "").trim();
    const vName = clean(name).slice(0, MAX_NAME_LEN);
    const vEmail = clean(email).toLowerCase();
    const vOrg = clean(organization || org).slice(0, MAX_ORG_LEN);
    const vInterest = clean(interest || topic).slice(0, MAX_INTEREST_LEN);
    const vMessage = clean(message).slice(0, MAX_MESSAGE_LEN);

    // required + basic email
    if (!vName || !vEmail || !vMessage) {
      return res.status(400).json({ ok: false, error: "name, email and message are required." });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(vEmail)) {
      markBad(ip);
      return res.status(400).json({ ok: false, error: "Invalid email." });
    }

    // --- extra validation (reject random strings, require spaces) ---
    const hasTwoWords = s => /\S+\s+\S+/.test(s);
    const tooManyUrls = s => (s.match(/https?:\/\//gi) || []).length > 2;
    function looksGibberish(s) {
      const t = String(s || "").replace(/[^a-z]/gi, "");
      if (!t) return true;
      const vow = (t.match(/[aeiou]/gi) || []).length;
      const ratio = vow / t.length;
      if (ratio < 0.15 || ratio > 0.7) return true;
      if (/[bcdfghjklmnpqrstvwxyz]{6,}/i.test(t)) return true;
      if (/^[A-Za-z0-9+/=]{20,}$/.test(s)) return true; // base64-like
      return false;
    }
    if (!hasTwoWords(vName) || looksGibberish(vName)) {
      markBad(ip);
      return res.status(400).json({ ok:false, error:"Invalid name." });
    }
    if (vOrg && looksGibberish(vOrg)) {
      markBad(ip);
      return res.status(400).json({ ok:false, error:"Invalid organization." });
    }
    if (vMessage.length < 20 || tooManyUrls(vMessage) || looksGibberish(vMessage)) {
      markBad(ip);
      return res.status(400).json({ ok:false, error:"Invalid message." });
    }
    // ---------------------------------------------------------------

    // ---- env mapping: prefer generic SMTP_* ; fallback to M365_* ----
    const SMTP_HOST   = process.env.SMTP_HOST   || "smtp.office365.com";
    const SMTP_PORT   = Number(process.env.SMTP_PORT || 587);
    const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
    const SMTP_USER   = process.env.SMTP_USER   || process.env.M365_USER;
    const SMTP_PASS   = process.env.SMTP_PASS   || process.env.M365_PASS;
    const CONTACT_TO  = process.env.CONTACT_TO  || process.env.SMTP_TO   || SMTP_USER;

    if (!SMTP_USER || !SMTP_PASS) {
      return res.status(500).json({ ok: false, error: "SMTP credentials missing." });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE, // false for STARTTLS on 587
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { ciphers: "TLSv1.2" },
      requireTLS: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    });

    // verify SMTP early for clearer errors
    try {
      await transporter.verify();
    } catch (e) {
      console.error("SMTP verify failed:", e);
      return res.status(500).json({
        ok: false,
        error: `SMTP verify failed: ${e?.code || ""} ${e?.message || e}`
      });
    }

    const subject = `Nuevo contacto — ${vName}`;
    const text = [
      `Nombre: ${vName}`,
      `Email: ${vEmail}`,
      `Organización: ${vOrg || "-"}`,
      `Interés: ${vInterest || "-"}`,
      "",
      "Mensaje:",
      vMessage
    ].join("\n");

    const html = `
      <h2>Nuevo contacto (SustTech)</h2>
      <p><b>Nombre:</b> ${escapeHtml(vName)}</p>
      <p><b>Email:</b> ${escapeHtml(vEmail)}</p>
      <p><b>Organización:</b> ${escapeHtml(vOrg || "-")}</p>
      <p><b>Interés:</b> ${escapeHtml(vInterest || "-")}</p>
      <p><b>Mensaje:</b><br>${escapeHtml(vMessage).replace(/\n/g, "<br>")}</p>
      <hr>
      <p style="font-size:12px;color:#64748b">IP: ${escapeHtml(ip)}</p>
    `;

    // Many M365 tenants require FROM to be the authenticated user
    const fromAddress = `"SustTech Contact" <${SMTP_USER}>`;

    try {
      await transporter.sendMail({
        from: fromAddress,
        to: CONTACT_TO,
        replyTo: vEmail,
        subject,
        text,
        html
      });
    } catch (e) {
      console.error("sendMail failed:", e);
      return res.status(500).json({
        ok: false,
        error: `SMTP send failed: ${e?.code || ""} ${e?.response || e?.message || e}`
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Contact API error:", err);
    return res.status(500).json({ ok: false, error: `Server error: ${err?.message || err}` });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const config = { api: { bodyParser: { sizeLimit: "100kb" } } };

