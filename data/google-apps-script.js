// ============================================================
// Google Apps Script — Paste vào Apps Script Editor
// Hướng dẫn: xem README.md mục "Google Sheets"
// ============================================================

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);

    // Thêm header nếu sheet trống
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Mã đơn", "Ngày đặt", "Khách (Zalo)", "Sản phẩm",
        "Số lượng", "Tổng tiền", "Người nhận", "SĐT", "Địa chỉ", "Trạng thái"
      ]);
      // Bold header
      sheet.getRange(1, 1, 1, 10).setFontWeight("bold");
    }

    // Append đơn hàng
    sheet.appendRow([
      data.orderId,
      new Date().toLocaleString("vi-VN"),
      data.displayName,
      data.product,
      data.quantity,
      data.totalPrice,
      data.customerName,
      data.phone,
      data.address,
      "Mới"
    ]);

    // Auto-resize columns
    sheet.autoResizeColumns(1, 10);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
