// ============================================================
// Google Apps Script — Paste vào Apps Script Editor
// ============================================================

var INVENTORY_SHEET_NAME = "Tồn kho";
var ORDER_SHEET_NAME = "Đơn hàng";
var SETTINGS_SHEET_NAME = "Cài đặt";
var SHIPPING_SHEET_NAME = "Phí ship";

// Tồn kho mặc định (Sản phẩm | Tồn kho | Giá | Aliases)
var DEFAULT_INVENTORY = [
  ["Trà Lài 100g", 100, 50000, "100g, 100 g, gói nhỏ"],
  ["Trà Lài 250g", 50, 110000, "250g, 250 g, gói vừa"],
  ["Trà Lài 500g", 30, 200000, "500g, 500 g, gói lớn"],
];

// Phí ship mặc định
var DEFAULT_SHIPPING = [
  ["Bình Long", 0, "Trong ngày", "bình long, binh long, phú riềng, thanh lương"],
  ["Bình Phước", 15000, "1-2 ngày", "bình phước, đồng xoài, phước long"],
  ["Miền Nam", 20000, "2-3 ngày", "hcm, sài gòn, bình dương, đồng nai"],
  ["Miền Trung & Bắc", 30000, "3-5 ngày", "hà nội, đà nẵng, hải phòng"],
];

var DEFAULT_SETTINGS = [
  ["OWNER_PHONE", "0975324568"],
  ["MAX_ORDER_QTY", 10],
  ["FREE_SHIP_THRESHOLD", 300000],
  ["DEFAULT_SHIP_SOUTH_FEE", 20000],
  ["DEFAULT_SHIP_ALL_FEE", 30000],
  ["IMAGE_BANNER", "https://placehold.co/600x400?text=Tra+Lai+Shop+Welcome"],
  ["IMAGE_PRODUCT", "https://placehold.co/600x400?text=Menu+SanPham"],
];

var DEFAULT_KEYWORDS_SHEET = [
  ["greeting", "chào, hello, hi, xin chào, alo, lô"],
  ["price", "giá, bao nhiêu, bảng giá, gia, bao nhieu"],
  ["promo", "khuyến mãi, giảm giá, ưu đãi, khuyen mai, giam gia"],
];

var DEFAULT_RESPONSES_SHEET = [
  ["WELCOME", "Chào mừng bạn đến với Trà Lài Shop! Chúc bạn một ngày tốt lành nhé! 🍵"],
  ["ORDER_SUCCESS", "Dạ shop đã nhận được đơn hàng của bạn rồi ạ! Cảm ơn bạn rất nhiều! 🙏"],
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!e || !e.postData || !e.postData.contents) return jsonResponse({ ok: false, error: "no_data" });
    var data = JSON.parse(e.postData.contents);

    var settings = getSettings(ss);
    var invSheet = getOrCreateInventorySheet(ss);

    // ── action: "get_config" ──
    if (data.action === "get_config") {
      var invData = invSheet.getDataRange().getValues();
      var invHeaders = getHeaderIndices(invData[0]);
      var products = [];
      for (var i = 1; i < invData.length; i++) {
        var name = invData[i][invHeaders["Sản phẩm"]];
        if (name && name.toString().trim()) {
          products.push({
            name: name,
            stock: invData[i][invHeaders["Tồn kho"]],
            price: invData[i][invHeaders["Giá"]],
            aliases: String(invData[i][invHeaders["Aliases"]] || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean)
          });
        }
      }
      
      var shipSheet = getOrCreateShippingSheet(ss);
      var shipData = shipSheet.getDataRange().getValues();
      var shipHeaders = getHeaderIndices(shipData[0]);
      var shipping = [];
      for (var j = 1; j < shipData.length; j++) {
        var sName = shipData[j][shipHeaders["Khu vực"]];
        if (sName && sName.toString().trim()) {
          shipping.push({
            name: sName,
            fee: parseInt(shipData[j][shipHeaders["Phí ship"]]) || 0,
            time: shipData[j][shipHeaders["Thời gian"]],
            keywords: String(shipData[j][shipHeaders["Keywords"]] || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean)
          });
        }
      }

      // [NEW] Get Keywords
      var kwSheet = getOrCreateKeywordSheet(ss);
      var kwData = kwSheet.getDataRange().getValues();
      var kwHeaders = getHeaderIndices(kwData[0]);
      var keywordsMap = {};
      for (var k = 1; k < kwData.length; k++) {
        var cat = kwData[k][kwHeaders["Danh mục"]];
        if (cat) {
          keywordsMap[cat] = String(kwData[k][kwHeaders["Từ khóa"]] || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);
        }
      }

      // [NEW] Get Responses
      var respSheet = getOrCreateResponseSheet(ss);
      var respData = respSheet.getDataRange().getValues();
      var respHeaders = getHeaderIndices(respData[0]);
      var responsesMap = {};
      for (var l = 1; l < respData.length; l++) {
        var key = respData[l][respHeaders["Mã phản hồi"]];
        if (key) responsesMap[key] = respData[l][respHeaders["Nội dung"]];
      }

      // [NEW] Get FAQ
      var faqSheet = getOrCreateFAQSheet(ss);
      var faqData = faqSheet.getDataRange().getValues();
      var faqHeaders = getHeaderIndices(faqData[0]);
      var faqs = [];
      for (var m = 1; m < faqData.length; m++) {
        var faqq = faqData[m][faqHeaders["Câu hỏi"]];
        if (faqq) {
          faqs.push({
            keywords: String(faqq).split(",").map(function(s) { return s.trim(); }).filter(Boolean),
            reply: faqData[m][faqHeaders["Câu trả lời"]]
          });
        }
      }

      return jsonResponse({ 
        ok: true, 
        settings: settings, 
        products: products, 
        shipping: shipping,
        keywords: keywordsMap || {},
        responses: responsesMap || {},
        faqs: faqs || []
      });
    }

    // ── Tinh toán ──
    var MAX_QTY = parseInt(settings["MAX_ORDER_QTY"]) || 10;
    var OWNER_PHONE = settings["OWNER_PHONE"] || "0975324568";
    var qty = parseInt(data.quantity) || 0;
    
    var invData = invSheet.getDataRange().getValues();
    var invHeaders = getHeaderIndices(invData[0]);
    var productRow = -1;
    var currentStock = -1;
    
    if (data.product) {
      var searchName = data.product.toString().trim();
      for (var i = 1; i < invData.length; i++) {
        var rowName = invData[i][invHeaders["Sản phẩm"]];
        if (rowName && rowName.toString().trim() === searchName) {
          productRow = i + 1;
          currentStock = parseInt(invData[i][invHeaders["Tồn kho"]]) || 0;
          break;
        }
      }
    }

    if (data.action === "check_stock") {
      if (productRow === -1) return jsonResponse({ ok: false, error: "san_pham_khong_ton_tai" });
      if (qty > 0 && currentStock < qty) return jsonResponse({ ok: false, error: "het_hang", available: currentStock });
      return jsonResponse({ ok: true, available: currentStock });
    }

    if (qty < 1 || qty > MAX_QTY) {
       return jsonResponse({ ok: false, error: "so_luong_khong_hop_le", maxQty: MAX_QTY });
    }
    if (productRow !== -1 && currentStock < qty) {
       return jsonResponse({ ok: false, error: "het_hang", available: currentStock });
    }

    // ── Ghi đơn ──
    var orderSheet = getOrCreateOrderSheet(ss);
    var orderData = orderSheet.getDataRange().getValues();
    var orderHeaders = getHeaderIndices(orderData[0]);
    
    if (orderData.length > 1) {
      if (!data.orderId) return jsonResponse({ ok: false, error: "thieu_order_id" });
      var orderIds = orderSheet.getRange(2, orderHeaders["Mã đơn"] + 1, orderSheet.getLastRow() - 1, 1).getValues().flat();
      if (orderIds.indexOf(data.orderId) !== -1 || orderIds.indexOf(Number(data.orderId)) !== -1) {
         return jsonResponse({ ok: true, skipped: true, reason: "duplicate" });
      }
    }

    var nowStr = new Date().toLocaleString("vi-VN");
    var newRow = [];
    var headerRow = orderData[0];
    for (var k = 0; k < headerRow.length; k++) {
      var h = headerRow[k];
      if (h === "Mã đơn") newRow[k] = data.orderId;
      else if (h === "Ngày đặt") newRow[k] = nowStr;
      else if (h === "Khách (Zalo)") newRow[k] = data.displayName || "N/A";
      else if (h === "Sản phẩm") newRow[k] = data.product || "N/A";
      else if (h === "Số lượng") newRow[k] = qty;
      else if (h === "Tổng tiền") newRow[k] = data.totalPrice || 0;
      else if (h === "Người nhận") newRow[k] = data.customerName || "N/A";
      else if (h === "SĐT") newRow[k] = data.phone || "N/A";
      else if (h === "Địa chỉ") newRow[k] = data.address || "N/A";
      else if (h === "Khu vực ship") newRow[k] = data.shippingZone || "";
      else if (h === "Phí ship") newRow[k] = data.shippingFee || 0;
      else if (h === "Trạng thái") newRow[k] = "Mới";
      else newRow[k] = "";
    }
    orderSheet.appendRow(newRow);

    if (data.phone) updateCustomerSheet(ss, data, qty, nowStr);

    if (productRow !== -1) {
      var remaining = currentStock - qty;
      orderSheet.getParent().getSheetByName(INVENTORY_SHEET_NAME).getRange(productRow, invHeaders["Tồn kho"] + 1).setValue(remaining);
      var threshold = parseInt(settings["LOW_STOCK_THRESHOLD"]) || 5;
      var warningCell = orderSheet.getParent().getSheetByName(INVENTORY_SHEET_NAME).getRange(productRow, invHeaders["Cảnh báo"] + 1);
      if (remaining <= threshold) {
        warningCell.setValue("⚠️ SẮP HẾT HÀNG").setBackground("#FF0000").setFontColor("#FFFFFF").setFontWeight("bold");
      } else {
        warningCell.clearContent().setBackground(null);
      }
    }

    return jsonResponse({ ok: true });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function getHeaderIndices(headers) {
  var result = {};
  for (var i = 0; i < headers.length; i++) {
    if (headers[i]) result[headers[i].toString().trim()] = i;
  }
  return result;
}

function getSettings(ss) {
  var sheet = getOrCreateSettingsSheet(ss);
  var data = sheet.getDataRange().getValues();
  var result = {};
  for (var i = 1; i < data.length; i++) { if (data[i][0]) result[data[i][0]] = data[i][1]; }
  return result;
}

function getOrCreateOrderSheet(ss) {
  var sheet = ss.getSheetByName(ORDER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ORDER_SHEET_NAME);
    sheet.appendRow(["Mã đơn", "Ngày đặt", "Khách (Zalo)", "Sản phẩm", "Số lượng", "Tổng tiền", "Người nhận", "SĐT", "Địa chỉ", "Khu vực ship", "Phí ship", "Trạng thái"]);
    sheet.getRange(1, 1, 1, 12).setFontWeight("bold");
  }
  return sheet;
}

function getOrCreateInventorySheet(ss) {
  var sheet = ss.getSheetByName(INVENTORY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(INVENTORY_SHEET_NAME);
    sheet.appendRow(["Sản phẩm", "Tồn kho", "Giá", "Aliases", "Cảnh báo"]);
    sheet.getRange(1, 1, 1, 5).setFontWeight("bold");
    for (var i = 0; i < DEFAULT_INVENTORY.length; i++) { sheet.appendRow(DEFAULT_INVENTORY[i]); }
  }
  return sheet;
}

function getOrCreateSettingsSheet(ss) {
  var sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET_NAME);
    sheet.appendRow(["Cài đặt", "Giá trị"]);
    sheet.getRange(1, 1, 1, 2).setFontWeight("bold");
    for (var i = 0; i < DEFAULT_SETTINGS.length; i++) { sheet.appendRow(DEFAULT_SETTINGS[i]); }
  }
  return sheet;
}

function getOrCreateShippingSheet(ss) {
  var sheet = ss.getSheetByName(SHIPPING_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHIPPING_SHEET_NAME);
    sheet.appendRow(["Khu vực", "Phí ship", "Thời gian", "Keywords"]);
    sheet.getRange(1, 1, 1, 4).setFontWeight("bold");
    for (var i = 0; i < DEFAULT_SHIPPING.length; i++) { sheet.appendRow(DEFAULT_SHIPPING[i]); }
  }
  return sheet;
}

function getOrCreateKeywordSheet(ss) {
  var name = "Từ khóa";
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(["Danh mục", "Từ khóa"]);
    sheet.getRange(1, 1, 1, 2).setFontWeight("bold");
    sheet.appendRow(["greeting", "chào, hi, hello, xin chào, alo"]);
    sheet.appendRow(["price", "giá, bao nhiêu, bảng giá, price"]);
    sheet.appendRow(["promo", "khuyến mãi, giảm giá, ưu đãi, sale, free ship"]);
    sheet.appendRow(["image", "hình, ảnh, xem sản phẩm, cho xem"]);
  }
  return sheet;
}

function getOrCreateResponseSheet(ss) {
  var name = "Phản hồi";
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(["Mã phản hồi", "Nội dung"]);
    sheet.getRange(1, 1, 1, 2).setFontWeight("bold");
    sheet.appendRow(["REPLY_IMAGE", "Tôi đã nhận được hình ảnh! Hiện tại tôi chỉ hỗ trợ tin nhắn text. 😊"]);
    sheet.appendRow(["REPLY_STICKER", "😄"]);
    sheet.appendRow(["REPLY_ERROR", "Xin lỗi, tôi đang gặp sự cố. Vui lòng thử lại sau! 🙏"]);
    sheet.appendRow(["ORDER_REMINDER", "Bạn đang có đơn hàng chờ xác nhận. Vui lòng trả lời OK, Hủy hoặc Sửa."]);
  }
  return sheet;
}

function getOrCreateFAQSheet(ss) {
  var name = "FAQ";
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(["Câu hỏi", "Câu trả lời"]);
    sheet.getRange(1, 1, 1, 2).setFontWeight("bold");
    sheet.appendRow(["chào, hello, hi", "Xin chào! Trà Lài Shop có thể hỗ trợ gì cho bạn ạ?"]);
    sheet.appendRow(["đặt hàng, mua hàng", "Bạn vui lòng cho shop xin: Tên trà, Số lượng, Họ tên, SĐT và Địa chỉ nhé!"]);
    sheet.appendRow(["giá, bao nhiêu", "Shop có các loại: 100g (50k), 250g (110k), 500g (200k). Miễn phí ship đơn từ 300k ạ!"]);
    sheet.appendRow(["ship, giao hàng", "Phí ship: HCM 20k, tỉnh khác 30k. Giao nội thành trong ngày, tỉnh từ 2-4 ngày ạ."]);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function updateCustomerSheet(ss, data, qty, nowStr) {
  var CUSTOMER_SHEET_NAME = "Khách hàng";
  var sheet = ss.getSheetByName(CUSTOMER_SHEET_NAME) || ss.insertSheet(CUSTOMER_SHEET_NAME);
  var headerValues = ["SĐT", "Tên Zalo", "Tên người nhận", "Tổng đơn", "Tổng gói", "Tổng tiền (đ)", "Lần đầu mua", "Lần gần nhất"];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headerValues);
    sheet.getRange(1, 1, 1, 8).setFontWeight("bold");
  }

  var currentData = sheet.getDataRange().getValues();
  var headers = getHeaderIndices(currentData[0]);
  var foundRow = -1;
  var searchPhone = data.phone.toString().trim();
  
  for (var i = 1; i < currentData.length; i++) {
    var p = currentData[i][headers["SĐT"]];
    if (p && p.toString().trim() === searchPhone) {
      foundRow = i + 1;
      break;
    }
  }

  if (foundRow === -1) {
    var newRow = [];
    for (var m = 0; m < headerValues.length; m++) {
      var h = headerValues[m];
      if (h === "SĐT") newRow[m] = data.phone;
      else if (h === "Tên Zalo") newRow[m] = data.displayName;
      else if (h === "Tên người nhận") newRow[m] = data.customerName;
      else if (h === "Tổng đơn") newRow[m] = 1;
      else if (h === "Tổng gói") newRow[m] = qty;
      else if (h === "Tổng tiền (đ)") newRow[m] = data.totalPrice;
      else if (h === "Lần đầu mua") newRow[m] = nowStr;
      else if (h === "Lần gần nhất") newRow[m] = nowStr;
    }
    sheet.appendRow(newRow);
  } else {
    var row = currentData[foundRow - 1];
    var updates = {};
    updates[headers["Tổng đơn"]] = (parseInt(row[headers["Tổng đơn"]]) || 0) + 1;
    updates[headers["Tổng gói"]] = (parseInt(row[headers["Tổng gói"]]) || 0) + qty;
    updates[headers["Tổng tiền (đ)"]] = (parseFloat(row[headers["Tổng tiền (đ)"]]) || 0) + (Number(data.totalPrice) || 0);
    updates[headers["Lần gần nhất"]] = nowStr;

    for (var colIdx in updates) {
      sheet.getRange(foundRow, parseInt(colIdx) + 1).setValue(updates[colIdx]);
    }
  }
  
  if (sheet.getLastRow() > 2) {
    var sortCol = headers["Tổng gói"] + 1;
    sheet.getRange(2, 1, sheet.getLastRow() - 1, currentData[0].length).sort({ column: sortCol, ascending: false });
  }
}
