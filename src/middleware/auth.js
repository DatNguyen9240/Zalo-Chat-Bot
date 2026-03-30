const { ADMIN_SECRET } = require("../config");
const log = require("../logger");

/**
 * Admin Auth Middleware — BẢO VỆ các route /stats và /admin/*
 */
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || ADMIN_SECRET.length < 8) {
    log.error("❌ ADMIN_SECRET chưa được cấu hình hoặc quá ngắn (tối thiểu 8 ký tự)");
    return res.status(503).json({ error: "Lỗi bảo mật server: ADMIN_SECRET không hợp lệ." });
  }
  
  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${ADMIN_SECRET}`) {
    log.warn(`🔒 Unauthorized admin access from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized — cần header: Authorization: Bearer <ADMIN_SECRET>" });
  }
  
  next();
}

module.exports = { requireAdmin };
