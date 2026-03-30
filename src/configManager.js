const axios = require("axios");
const { GOOGLE_SHEET_URL } = require("./config");
const log = require("./logger");

let dynamicConfig = {
  settings: {
    MAX_ORDER_QTY: 10,
    OWNER_PHONE: "0975324568",
    LOW_STOCK_THRESHOLD: 5,
    FREE_SHIP_THRESHOLD: 300000,
    PAYMENT_ONLINE: "false",
    BANK_NAME: "",
    BANK_ACCOUNT: "",
    BANK_OWNER: "",
    BANK_BIN: "",
  },
  products: [],
  shipping: [],
  keywords: {},
  responses: {},
  faqs: []
};

// Helper parse số từ Việt Nam (xử lý dấu chấm phân cách hàng nghìn)
function parseVNNumber(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return Math.round(val);
  const clean = val.toString().replace(/\./g, "").replace(/,/g, "").trim();
  return parseInt(clean) || 0;
}

const GOOGLE_SHEET_URL_ENV = GOOGLE_SHEET_URL;
const DEFAULT_PRODUCTS = [
  { id: 1, name: "Trà Lài 100g", price: 50000, aliases: ["100g", "100 g", "100gram", "gói nhỏ"] },
  { id: 2, name: "Trà Lài 250g", price: 110000, aliases: ["250g", "250 g", "250gram", "gói vừa"] },
  { id: 3, name: "Trà Lài 500g", price: 200000, aliases: ["500g", "500 g", "500gram", "gói lớn"] }
];

async function fetchConfig(isStartup = false) {
  if (!GOOGLE_SHEET_URL) {
    if (dynamicConfig.products.length === 0) dynamicConfig.products = DEFAULT_PRODUCTS;
    return dynamicConfig;
  }

  const maxRetries = isStartup ? 3 : 1;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await axios.post(GOOGLE_SHEET_URL, { action: "get_config" }, { timeout: 10000 });
      if (res.data && res.data.ok) {
        log.info("✅ Cấu hình đã được tải từ Google Sheet.");
        
        if (res.data.settings) {
          dynamicConfig.settings = { ...dynamicConfig.settings, ...res.data.settings };
        }

        if (res.data.products && res.data.products.length > 0) {
          dynamicConfig.products = res.data.products.map((p, index) => ({
            id: index + 1,
            name: p.name,
            price: parseVNNumber(p.price),
            aliases: p.aliases || []
          }));
        } else if (isStartup) {
          dynamicConfig.products = DEFAULT_PRODUCTS;
        }

        if (res.data.shipping && res.data.shipping.length > 0) {
          dynamicConfig.shipping = res.data.shipping;
        }

        if (res.data.keywords) {
          dynamicConfig.keywords = res.data.keywords;
        }

        if (res.data.responses) {
          dynamicConfig.responses = res.data.responses;
        }

        if (res.data.faqs) {
          dynamicConfig.faqs = res.data.faqs;
        }

        return dynamicConfig;
      }
    } catch (err) {
      log.warn(`⚠️ Lỗi tải cấu hình (lần ${i+1}/${maxRetries}): ${err.message}`);
      if (isStartup && i < maxRetries - 1) await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (dynamicConfig.products.length === 0) dynamicConfig.products = DEFAULT_PRODUCTS;
  return dynamicConfig;
}

function getConfig() { return dynamicConfig; }
function getProducts() { return dynamicConfig.products; }
function getSettings() { return dynamicConfig.settings; }
function getShippingZones() { return dynamicConfig.shipping; }
function getKeywords() { return dynamicConfig.keywords; }
function getResponses() { return dynamicConfig.responses; }
function getFaqs() { return dynamicConfig.faqs; }

module.exports = {
  fetchConfig,
  getConfig,
  getProducts,
  getSettings,
  getShippingZones,
  getKeywords,
  getResponses,
  getFaqs,
  parseVNNumber
};
