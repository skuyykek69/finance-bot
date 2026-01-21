/**
 * ============================================
 * BOT WHATSAPP KEUANGAN PRIBADI
 * ============================================
 */

require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("baileys");

const Pino = require("pino");
const qrcode = require("qrcode-terminal");
const schedule = require("node-schedule");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Jakarta";

/* ================= GOOGLE SHEET ================= */

const {
  appendTransaksi,
  laporanHariIni,
  hapusTransaksiRow,
  setIncome,
  getIncomeData,
  getTotalPengeluaranBulanIni,
} = require("./googleSheet");

/* ================= CONFIG ================= */

const OWNER_JID = process.env.OWNER_JID;
const DEBUG = process.env.DEBUG === "true";

/* ================= UTIL ================= */

function log(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

function formatRupiah(num) {
  return "Rp" + Number(num).toLocaleString("id-ID");
}

function isOwner(sender) {
  return sender === OWNER_JID;
}

/* ================= BOT INIT ================= */

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: Pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        startBot();
      } else {
        console.log("❌ Logged out. Hapus folder auth.");
      }
    }

    if (connection === "open") {
      console.log("✅ Bot WhatsApp aktif");
    }
  });

  /* ================= MESSAGE HANDLER ================= */

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const sender = msg.key.remoteJid;
      if (!isOwner(sender)) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      const input = text.trim();
      const lower = input.toLowerCase();

      log("CMD:", input);

      /* ===== HELP ===== */

      if (lower === "help") {
        return sock.sendMessage(sender, {
          text:
`📌 *Perintah Bot Keuangan*

➕ tambah <kategori> <nominal> <opsional deskripsi>
↩️ refund <nominal>
📊 hari ini
📈 bulan ini
💰 set income <income> <target>
📉 analisis boros

Contoh:
tambah makan 25000 nasi goreng`,
        });
      }

      /* ===== SET INCOME ===== */

      if (lower.startsWith("set income")) {
        const parts = input.split(" ");
        if (parts.length < 4) {
          return sock.sendMessage(sender, {
            text: "❌ Format: set income <income> <target>",
          });
        }

        const income = Number(parts[2]);
        const target = Number(parts[3]);

        if (isNaN(income) || isNaN(target)) {
          return sock.sendMessage(sender, {
            text: "❌ Income & target harus angka",
          });
        }

        await setIncome(sender, income, target, async (msg) => {
          await sock.sendMessage(sender, { text: msg });
        });

        return;
      }

      /* ===== TAMBAH TRANSAKSI ===== */

      if (lower.startsWith("tambah")) {
        const parts = input.split(" ");
        if (parts.length < 3) {
          return sock.sendMessage(sender, {
            text: "❌ Format: tambah <kategori> <nominal> <opsional deskripsi>",
          });
        }

        const kategori = parts[1];
        const nominal = Number(parts[2]);
        const deskripsi = parts.slice(3).join(" ");

        if (isNaN(nominal)) {
          return sock.sendMessage(sender, {
            text: "❌ Nominal harus angka",
          });
        }

        const row = await appendTransaksi(
          sender,
          kategori,
          nominal,
          deskripsi
        );

        return sock.sendMessage(sender, {
          text:
`✅ *Transaksi Dicatat*
📂 ${kategori}
💸 ${formatRupiah(nominal)}
📝 ${deskripsi || "-"}`,
        });
      }

      /* ===== REFUND ===== */

      if (lower.startsWith("refund")) {
        const parts = input.split(" ");
        if (parts.length < 2) {
          return sock.sendMessage(sender, {
            text: "❌ Format: refund <nominal>",
          });
        }

        const nominal = Number(parts[1]);
        if (isNaN(nominal)) {
          return sock.sendMessage(sender, {
            text: "❌ Nominal harus angka",
          });
        }

        const transaksi = await laporanHariIni(sender);
        const target = transaksi
          .slice()
          .reverse()
          .find((t) => t.Nominal === nominal);

        if (!target) {
          return sock.sendMessage(sender, {
            text: "❌ Transaksi tidak ditemukan",
          });
        }

        await hapusTransaksiRow(target);

        return sock.sendMessage(sender, {
          text:
`↩️ *Refund Berhasil*
💸 ${formatRupiah(nominal)}`,
        });
      }

      /* ===== LAPORAN HARI INI ===== */

      if (lower === "hari ini") {
        const data = await laporanHariIni(sender);
        if (data.length === 0) {
          return sock.sendMessage(sender, {
            text: "📭 Belum ada transaksi hari ini",
          });
        }

        let total = 0;
        let msg = "📊 *Pengeluaran Hari Ini*\n\n";

        data.forEach((r, i) => {
          total += r.Nominal;
          msg += `${i + 1}. ${r.Kategori} - ${formatRupiah(r.Nominal)}\n`;
        });

        msg += `\n💸 Total: ${formatRupiah(total)}`;

        return sock.sendMessage(sender, { text: msg });
      }

      /* ===== LAPORAN BULAN INI ===== */

      if (lower === "bulan ini") {
        const income = await getIncomeData(sender);
        if (!income) {
          return sock.sendMessage(sender, {
            text: "❌ Income bulan ini belum diset",
          });
        }

        const total = await getTotalPengeluaranBulanIni(sender);
        const tabungan = income.IncomeBulan - total;

        return sock.sendMessage(sender, {
          text:
`📈 *Ringkasan Bulan Ini*

💰 Income: ${formatRupiah(income.IncomeBulan)}
💸 Pengeluaran: ${formatRupiah(total)}
💼 Tabungan: ${formatRupiah(tabungan)}
🎯 Target: ${formatRupiah(income.TargetTabungan)}`,
        });
      }

      /* ===== ANALISIS BOROS ===== */

      if (lower === "analisis boros") {
        const income = await getIncomeData(sender);
        if (!income) {
          return sock.sendMessage(sender, {
            text: "❌ Income bulan ini belum diset",
          });
        }

        const data = await laporanHariIni(sender);
        const total = data.reduce((a, r) => a + r.Nominal, 0);

        let status = "✅ Aman";
        if (total > income.MaxHarian) status = "⚠️ Melebihi limit harian";

        return sock.sendMessage(sender, {
          text:
`📉 *Analisis Hari Ini*
💸 Total: ${formatRupiah(total)}
🎯 Limit: ${formatRupiah(income.MaxHarian)}

Status: ${status}`,
        });
      }
    } catch (err) {
      console.error("❌ ERROR:", err);
    }
  });

  /* ================= SCHEDULER ================= */

  schedule.scheduleJob("0 0 21 * * *", async () => {
    try {
      const income = await getIncomeData(OWNER_JID);
      if (!income) return;

      const data = await laporanHariIni(OWNER_JID);
      const total = data.reduce((a, r) => a + r.Nominal, 0);
      const sisa = income.MaxHarian - total;

      await sock.sendMessage(OWNER_JID, {
        text:
`📊 *Ringkasan Harian*
🗓 ${dayjs().tz(TZ).format("DD MMMM YYYY")}

💸 Total: ${formatRupiah(total)}
🎯 Limit: ${formatRupiah(income.MaxHarian)}
👛 Sisa: ${formatRupiah(sisa)}`,
      });
    } catch (e) {
      console.error("Scheduler error:", e);
    }
  });
}

startBot();
