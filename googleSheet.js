require("dotenv").config();
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Jakarta";

/* ================= AUTH ================= */

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

async function initDoc() {
  const doc = new GoogleSpreadsheet(
    process.env.GOOGLE_SHEET_ID,
    serviceAccountAuth
  );
  await doc.loadInfo();
  return doc;
}

/* ================= UTIL ================= */

function generateID() {
  return dayjs().tz(TZ).format("YYYYMMDDHHmmssSSS");
}

function mapRow(row) {
  return {
    ID: row._rawData[0],
    Timestamp: row._rawData[1],
    User: row._rawData[2],
    Kategori: row._rawData[3],
    Nominal: Number(row._rawData[4]),
    Deskripsi: row._rawData[5],
  };
}

/* ================= TRANSAKSI ================= */

async function appendTransaksi(user, kategori, nominal, deskripsi) {
  if (!user || !kategori || isNaN(nominal) || nominal === 0) {
    throw new Error("Data transaksi tidak valid");
  }

  const doc = await initDoc();
  const sheet = doc.sheetsByTitle["Transaksi"];

  const row = await sheet.addRow({
    ID: generateID(),
    Timestamp: dayjs().tz(TZ).format("YYYY-MM-DD HH:mm:ss"),
    User: user,
    Kategori: kategori,
    Nominal: nominal,
    Deskripsi: deskripsi || "-",
  });

  return mapRow(row);
}

async function laporanHariIni(user, tanggalInput = null) {
  const doc = await initDoc();
  const sheet = doc.sheetsByTitle["Transaksi"];
  const rows = await sheet.getRows();

  const targetDate = tanggalInput
    ? dayjs(tanggalInput)
    : dayjs().tz(TZ);

  const targetStr = targetDate.format("YYYY-MM-DD");

  return rows
    .filter((r) => {
      const rowUser = r.User || r._rawData[2];
      const timestamp = r.Timestamp || r._rawData[1];
      const rowDate = timestamp?.split(" ")[0];
      return rowUser === user && rowDate === targetStr;
    })
    .map(mapRow);
}

async function hapusTransaksiRow(transaksi) {
  const doc = await initDoc();
  const sheet = doc.sheetsByTitle["Transaksi"];
  const rows = await sheet.getRows();

  const targetID = transaksi.ID;

  const row = rows.find(
    (r) => (r.ID || r._rawData[0]) === targetID
  );

  if (!row) return false;
  await row.delete();
  return true;
}

/* ================= INCOME ================= */

async function setIncome(user, income, target, send) {
  const doc = await initDoc();
  const sheet = doc.sheetsByTitle["Income"];
  const rows = await sheet.getRows();

  const bulan = dayjs().tz(TZ).format("YYYY-MM");
  const days = dayjs().daysInMonth();
  const maxHarian = Math.floor((income - target) / days);

  const existing = rows.find(
    (r) =>
      (r.User || r._rawData[0]) === user &&
      (r.BulanAwal || r._rawData[1]) === bulan
  );

  if (existing) {
    existing.assign({
      IncomeBulan: income,
      TargetTabungan: target,
      MaxHarian: maxHarian,
    });
    await existing.save();
  } else {
    await sheet.addRow({
      User: user,
      BulanAwal: bulan,
      IncomeBulan: income,
      TargetTabungan: target,
      MaxHarian: maxHarian,
    });
  }

  if (send) {
    await send(
      `✅ Income ${bulan}\n💰 Rp${income.toLocaleString()}\n🎯 Target Rp${target.toLocaleString()}\n💸 Limit Harian Rp${maxHarian.toLocaleString()}`
    );
  }
}

async function getIncomeData(user) {
  const doc = await initDoc();
  const sheet = doc.sheetsByTitle["Income"];
  const rows = await sheet.getRows();

  const bulan = dayjs().tz(TZ).format("YYYY-MM");

  const row = rows.find(
    (r) =>
      (r.User || r._rawData[0]) === user &&
      (r.BulanAwal || r._rawData[1]) === bulan
  );

  if (!row) return null;

  return {
    IncomeBulan: Number(row.IncomeBulan || row._rawData[2]),
    TargetTabungan: Number(row.TargetTabungan || row._rawData[3]),
    MaxHarian: Number(row.MaxHarian || row._rawData[4]),
  };
}

async function getTotalPengeluaranBulanIni(user) {
  const doc = await initDoc();
  const sheet = doc.sheetsByTitle["Transaksi"];
  const rows = await sheet.getRows();

  const now = dayjs().tz(TZ);

  return rows.reduce((acc, r) => {
    const rowUser = r.User || r._rawData[2];
    const tgl = dayjs(r.Timestamp);
    if (
      rowUser === user &&
      tgl.month() === now.month() &&
      tgl.year() === now.year()
    ) {
      return acc + Number(r.Nominal || r._rawData[4]);
    }
    return acc;
  }, 0);
}

module.exports = {
  initDoc,
  appendTransaksi,
  laporanHariIni,
  hapusTransaksiRow,
  setIncome,
  getIncomeData,
  getTotalPengeluaranBulanIni,
};
