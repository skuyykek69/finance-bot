require("dotenv").config();
const { initDoc } = require("./googleSheet");

(async () => {
  const doc = await initDoc();
  console.log("✅ Connected:", doc.title);
})();
