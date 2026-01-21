"use strict";

/**
 * ============================================
 *  PENGELUARAN BOT WA — FINAL STABLE VERSION
 *  Target: GitHub Codespaces / Cloud Gratis
 * ============================================
 */

require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const schedule = require("node-schedule");
const os = require("os");
const axios = require("axios");
const dayjs = require("dayjs");
const fs = require("fs");

const {
  initDoc,
  appendTransaksi,
  getTotalPengeluaranBulanIni,
  laporanHariIni,
  hapusTransaksiRow,
  setIncome,
  getIncomeData,
} = require("./googleSheet");

/* ======================================================
 * ENV CHECK — WAJIB
 * ====================================================== */
console.log("🔐 ENV CHECK (startup):", {
  GOOGLE_SHEET_ID: !!process.env.GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
  OWNER_JID: !!process.env.OWNER_JID,
});

if (
  !process.env.GOOGLE_SHEET_ID ||
  !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
  !process.env.GOOGLE_PRIVATE_KEY
) {
  console.error("❌ ENV tidak lengkap. Bot dihentikan.");
  process.exit(1);
}

/* ======================================================
 * HELPER
 * ====================================================== */
function ensureAuthDir() {
  if (!fs.existsSync("./auth")) {
    fs.mkdirSync("./auth");
  }
}

/* ======================================================
 * BROADCAST REMINDER
 * ====================================================== */
async function broadcastReminderPengeluaran(sock) {
  try {
    const doc = await initDoc();
    const sheet = doc.sheetsByTitle["Income"];
    if (!sheet) return;

    const rows = await sheet.getRows();
    const today = dayjs().format("YYYY-MM-DD");
    const bulanIni = dayjs().format("YYYY-MM");
    const sudah = new Set();

    for (const row of rows) {
      const user = row.User || row._rawData?.[0];
      const bulan = row.BulanAwal || row._rawData?.[1];

      if (!user || bulan !== bulanIni || sudah.has(user)) continue;

      const transaksi = await laporanHariIni(user, today);
      if (transaksi.length === 0) {
        await sock.sendMessage(user, {
          text:
            `👋 Hai!\n\n` +
            `Kamu belum mencatat pengeluaran hari ini (${dayjs().format("DD/MM/YYYY")}).\n\n` +
            `Contoh:\n` +
            `+ngopi 15000 kopi susu`,
        });
        sudah.add(user);
      }
    }
  } catch (err) {
    console.error("❌ Broadcast error:", err.message);
  }
}

/* ======================================================
 * START BOT
 * ====================================================== */
async function startBot() {
  console.log("🚀 Bot starting...");

  ensureAuthDir();

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "info" }),
    browser: ["PengeluaranBot", "Codespaces", "1.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  /* ================= CONNECTION ================= */
  sock.ev.on("connection.update", (update) => {
    console.log("🔄 connection.update:", update.connection || update.qr ? "event" : update);

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 QR DIDAPATKAN — SCAN SEKARANG");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed:", code);

      if (code !== DisconnectReason.loggedOut) {
        console.log("🔁 Reconnecting...");
        startBot();
      } else {
        console.log("⚠️ Logged out. Hapus folder auth untuk login ulang.");
      }
    }
  });

  /* ================= MESSAGE HANDLER ================= */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    try {
      /* ---------- HELP ---------- */
      if (["help", "menu", "panduan", "?"].includes(text.toLowerCase())) {
        await sock.sendMessage(sender, {
          text:
            `📘 *Panduan Bot Pengeluaran*\n\n` +
            `+kategori jumlah deskripsi\n` +
            `Contoh: +ngopi 15000 kopi susu\n\n` +
            `ringkasan\nringkasan 3\nringkasan 05-06\n\n` +
            `hapus pengeluaran\nhapus pengeluaran 05-06\n\n` +
            `set income 5000000 tabungan 1000000\n` +
            `progress tabungan`,
        });
        return;
      }

      /* ---------- INPUT TRANSAKSI ---------- */
      if (text.startsWith("+")) {
        const incomeData = await getIncomeData(sender);
        if (!incomeData) {
          await sock.sendMessage(sender, {
            text: "❗ Set income dulu: set income <jumlah> tabungan <target>",
          });
          return;
        }

        const match = text.substring(1).match(/(.+?)\s+(\d+)(?:\s+(.*))?/);
        if (!match) {
          await sock.sendMessage(sender, { text: "❗ Format salah." });
          return;
        }

        const kategori = match[1].trim();
        const nominal = parseFloat(match[2]);
        const deskripsi = (match[3] || "-").trim();

        await appendTransaksi(sender, kategori, nominal, deskripsi);

        await sock.sendMessage(sender, {
          text: `✅ Dicatat:\n${kategori} - Rp${nominal.toLocaleString()} (${deskripsi})`,
        });
        return;
      }

      /* ---------- SET INCOME ---------- */
      if (text.toLowerCase().startsWith("set income")) {
        const match = text.match(/^set income (\d+)\s+tabungan\s+(\d+)/i);
        if (!match) {
          await sock.sendMessage(sender, {
            text: "❗ Contoh: set income 5000000 tabungan 1000000",
          });
          return;
        }

        await setIncome(
          sender,
          parseInt(match[1]),
          parseInt(match[2]),
          (m) => sock.sendMessage(sender, { text: m })
        );
        return;
      }

      /* ---------- PROGRESS ---------- */
      if (text.toLowerCase() === "progress tabungan") {
        const incomeData = await getIncomeData(sender);
        if (!incomeData) {
          await sock.sendMessage(sender, { text: "❗ Income belum diset." });
          return;
        }

        const income = Number(incomeData.IncomeBulan || 0);
        const target = Number(incomeData.TargetTabungan || 0);
        const keluar = await getTotalPengeluaranBulanIni(sender);

        const tabungan = income - keluar;

        await sock.sendMessage(sender, {
          text:
            `📊 *Progress Bulan Ini*\n\n` +
            `Income: Rp${income.toLocaleString()}\n` +
            `Pengeluaran: Rp${keluar.toLocaleString()}\n` +
            `Tabungan: Rp${tabungan.toLocaleString()}\n` +
            `Target: Rp${target.toLocaleString()}`,
        });
      }
    } catch (err) {
      console.error("❌ Message error:", err);
      await sock.sendMessage(sender, {
        text: "❗ Terjadi kesalahan. Coba lagi.",
      });
    }
  });

  /* ================= SCHEDULE ================= */
  schedule.scheduleJob("0 0 15 * * *", async () => {
    console.log("⏰ Reminder job running...");
    await broadcastReminderPengeluaran(sock);
  });
}

/* ======================================================
 * BOOT
 * ====================================================== */
startBot();
